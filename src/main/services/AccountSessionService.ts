import { randomUUID } from 'node:crypto';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AccountSessionRepository } from '@main/db/repositories/AccountSessionRepository';
import { onboardingDay, type OnboardingRepository } from '@main/db/repositories/OnboardingRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { SettingsRepository } from '@main/db/repositories/SettingsRepository';
import type { AccountService } from './AccountService';
import type { OnboardingService } from './OnboardingService';
import { AppError } from '@main/errors';
import { accountIdSchema, accountSessionEndSchema, accountSessionGroupSchema, accountSessionNavigationSchema, accountSessionSettingsSchema, accountSessionStartSchema } from '@shared/schemas';
import type { AccountSession, AccountSessionCompletionReason, AccountSessionDetail, AccountSessionEndInput, AccountSessionNavigationInput, AccountSessionNavigationResult, AccountSessionSettings, AccountSessionStartInput, FacebookAccount, HealthCheckResult } from '@shared/types';

const SETTINGS_KEY = 'account-session:settings';
export const DEFAULT_ACCOUNT_SESSION_SETTINGS: AccountSessionSettings = { targetDurationMinutes: 30, autoCloseBrowserAfterTarget: false };
export type AccountSessionScheduler = { schedule: (callback: () => void, delayMs: number) => unknown; cancel: (handle: unknown) => void };
const DEFAULT_SCHEDULER: AccountSessionScheduler = { schedule: (callback, delayMs) => setTimeout(callback, delayMs), cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
type Watchdog = { sessionId: string; handle: unknown };

export class AccountSessionService {
  private readonly watchdogs = new Map<string, Watchdog>();

  constructor(
    private readonly sessions: AccountSessionRepository,
    private readonly onboardingRepository: OnboardingRepository,
    private readonly accounts: AccountRepository,
    private readonly groups: GroupRepository,
    private readonly settingsRepository: SettingsRepository,
    private readonly accountService: AccountService,
    private readonly onboarding: OnboardingService,
    private readonly audit: AuditLogRepository,
    private readonly notify: () => void,
    private readonly now: () => Date = () => new Date(),
    private readonly scheduler: AccountSessionScheduler = DEFAULT_SCHEDULER
  ) {}

  recoverAbandoned(): number {
    const timestamp = this.now().toISOString(); const recovered = this.sessions.recoverAbandoned(timestamp);
    for (const session of recovered.finalized) { this.onboardingRepository.recordSessionEnd(session.accountId, timestamp); if (session.completionReason === 'TARGET_REACHED') this.onboardingRepository.completeDailySessionTask(session.accountId, session.onboardingDay, timestamp); this.auditFinalization(session); }
    if (recovered.count) { this.auditSafe(undefined, 'ACCOUNT_SESSIONS_RECOVERED', 'Abandoned account sessions were reconciled during startup.', { count: recovered.count, targetCompleted: recovered.completed.length }); this.changed(); }
    return recovered.count;
  }

  settings(): AccountSessionSettings { const raw = this.settingsRepository.get(SETTINGS_KEY); if (!raw) return DEFAULT_ACCOUNT_SESSION_SETTINGS; try { const parsed = accountSessionSettingsSchema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : DEFAULT_ACCOUNT_SESSION_SETTINGS; } catch { return DEFAULT_ACCOUNT_SESSION_SETTINGS; } }
  updateSettings(input: AccountSessionSettings): AccountSessionSettings { const data = parse(accountSessionSettingsSchema.safeParse(input)); this.settingsRepository.set(SETTINGS_KEY, JSON.stringify(data)); this.auditSafe(undefined, 'ACCOUNT_SESSION_SETTINGS_UPDATED', 'Account session settings updated.', { targetDurationMinutes: data.targetDurationMinutes, autoCloseBrowserAfterTarget: data.autoCloseBrowserAfterTarget }); this.changed(); return data; }

  detail(accountId: string): AccountSessionDetail {
    const id = parse(accountIdSchema.safeParse(accountId)); const account = this.requireAccount(id); const settings = this.settings(); const target = settings.targetDurationMinutes * 60; const planDays = account.onboardingPlanDays ?? 0; const progress = planDays ? this.sessions.dailyProgress(id, planDays, target, this.now().toISOString()) : [];
    return { account: publicAccount(account), activeSession: this.sessions.active(id), sessions: this.sessions.list(id), dailyProgress: progress, eligibility: eligibility(account, progress), settings, assignedGroups: this.groups.forAccount(id).filter((group) => group.active) };
  }

  async start(input: AccountSessionStartInput): Promise<AccountSessionDetail> {
    const data = parse(accountSessionStartSchema.safeParse(input)); const account = this.requireAccount(data.accountId); const currentTime = this.now(); const day = onboardingDay(account.onboardingStartedAt, account.onboardingPlanDays, currentTime); const configuredTarget = (data.targetDurationMinutes ?? this.settings().targetDurationMinutes) * 60;
    if (!['WARMING', 'READY'].includes(account.onboardingStatus)) throw new AppError('ONBOARDING_INVALID_STATE', 'Start or resume onboarding before starting an account session.');
    if (!day) throw new AppError('ONBOARDING_INVALID_STATE', 'The onboarding day is unavailable.');
    if (this.sessions.dayProgress(account.id, day, configuredTarget, currentTime.toISOString()).completed) throw new AppError('DAILY_SESSION_TARGET_ALREADY_REACHED', "Today's account session target is already complete.");
    if (this.sessions.active(account.id)) throw new AppError('ACCOUNT_SESSION_ACTIVE', 'An account session is already active.');
    if (this.accountService.browser.isRunning(account.id)) throw new AppError('ACCOUNT_ALREADY_RUNNING', 'Close the existing account browser before starting a managed session.');
    if (account.proxyEnabled) { const result = await this.accountService.testProxy({ accountId: account.id, proxyProtocol: account.proxyProtocol, proxyHost: account.proxyHost!, proxyPort: account.proxyPort!, proxyUsername: account.proxyUsername }); if (!result.success) throw new AppError('SESSION_PREFLIGHT_FAILED', result.message ?? 'Fixed proxy preflight failed.'); }
    const health = await this.accountService.healthCheck(account.id); if (health.status !== 'READY') throw new AppError('SESSION_PREFLIGHT_FAILED', health.reason ?? 'Facebook health requires manual action.'); await this.accountService.open(account.id);
    const timestamp = this.now().toISOString(); let started: AccountSession;
    try { started = this.sessions.start({ id: randomUUID(), accountId: account.id, onboardingDay: day, targetDurationSeconds: configuredTarget, timestamp }); this.onboardingRepository.completeSystemTasks(account.id, day, ['HEALTH_CHECK', 'OPEN_FACEBOOK'], timestamp); }
    catch (error) { await this.accountService.close(account.id).catch(() => undefined); if (error instanceof AppError) throw error; throw new AppError('DATABASE_ERROR', 'Unable to start the account session.'); }
    this.auditSafe(account.id, 'ACCOUNT_SESSION_STARTED', 'Operator account session started.', { onboardingDay: day, targetDurationMinutes: configuredTarget / 60 }); this.scheduleWatchdog(started); this.changed(); return this.detail(account.id);
  }

  pause(accountId: string): AccountSessionDetail {
    const id = parse(accountIdSchema.safeParse(accountId)); const active = this.sessions.active(id); if (!active || active.status !== 'ACTIVE') throw new AppError('ACCOUNT_SESSION_INVALID_STATE', 'Only an active account session can be paused.'); const paused = this.sessions.pause(id, this.now().toISOString()); if (!paused) throw new AppError('ACCOUNT_SESSION_INVALID_STATE', 'Only an active account session can be paused.'); this.cancelWatchdog(id, active.id); const day = this.sessions.dayProgress(id, paused.onboardingDay, paused.targetDurationSeconds, this.now().toISOString()); if (day.completed) this.finalize(id, paused.id, 'COMPLETED', 'TARGET_REACHED', undefined, false); else { this.auditSafe(id, 'ACCOUNT_SESSION_PAUSED', 'Account session timer paused.'); this.changed(); } return this.detail(id);
  }

  resume(accountId: string): AccountSessionDetail {
    const id = parse(accountIdSchema.safeParse(accountId)); const account = this.requireAccount(id); if (account.lastHealthStatus !== 'READY') throw new AppError('ACCOUNT_SESSION_INVALID_STATE', 'Run a successful health check before resuming the session timer.'); const resumed = this.sessions.resume(id, this.now().toISOString()); if (!resumed) throw new AppError('ACCOUNT_SESSION_INVALID_STATE', 'Only a paused account session can be resumed.'); this.auditSafe(id, 'ACCOUNT_SESSION_RESUMED', 'Account session timer resumed.'); this.scheduleWatchdog(resumed); this.changed(); return this.detail(id);
  }

  end(input: AccountSessionEndInput): AccountSessionDetail { const data = parse(accountSessionEndSchema.safeParse(input)); const active = this.sessions.active(data.accountId); if (!active) throw new AppError('ACCOUNT_SESSION_NOT_FOUND', 'No active account session was found.'); this.finalize(data.accountId, active.id, 'COMPLETED', 'OPERATOR_ENDED', data.operatorNote, true); return this.detail(data.accountId); }

  async navigate(input: AccountSessionNavigationInput): Promise<AccountSessionNavigationResult> { const data = parse(accountSessionNavigationSchema.safeParse(input)); this.requireOpenSession(data.accountId); const result = await this.accountService.browser.navigateSessionPage(data.accountId, data.destination, data.url); await this.handleNavigationHealth(result); this.auditSafe(data.accountId, 'ACCOUNT_SESSION_NAVIGATED', 'Operator-triggered session navigation completed.', { destination: data.destination, status: result.status }); return result; }
  async openGroup(accountId: string, groupId: string): Promise<AccountSessionNavigationResult> { const data = parse(accountSessionGroupSchema.safeParse({ accountId, groupId })); this.requireOpenSession(data.accountId); const group = this.groups.forAccount(data.accountId).find((value) => value.id === data.groupId && value.active); if (!group) throw new AppError('INVALID_ASSIGNMENT', 'Choose an active group assigned to this account.'); const result = await this.accountService.browser.navigateAccountPage(data.accountId, group.normalizedUrl); await this.handleNavigationHealth(result); this.auditSafe(data.accountId, 'ACCOUNT_SESSION_GROUP_OPENED', 'Operator opened an assigned group from the account session.', { groupId: group.id, status: result.status }); return result; }

  handleHealthResult(result: HealthCheckResult): void { if (result.status === 'READY') return; const active = this.sessions.active(result.accountId); if (active) this.finalize(result.accountId, active.id, 'INTERRUPTED', 'HEALTH_INTERRUPTED', undefined, false); this.onboarding.syncHealthPauses(); }
  handleBrowserClosed(accountId: string): void { const active = this.sessions.active(accountId); if (active) this.finalize(accountId, active.id, 'INTERRUPTED', 'BROWSER_CLOSED', undefined, false, false); }

  async stopAll(reason: 'EMERGENCY_STOP' | 'APPLICATION_SHUTDOWN' = 'EMERGENCY_STOP'): Promise<number> {
    const open = this.sessions.openSessions(); for (const session of open) this.finalize(session.accountId, session.id, 'INTERRUPTED', reason, undefined, false, false); await Promise.allSettled(open.map((session) => this.accountService.close(session.accountId))); return open.length;
  }

  private scheduleWatchdog(session: AccountSession): void {
    this.cancelWatchdog(session.accountId); const current = this.sessions.active(session.accountId); if (!current || current.id !== session.id || current.status !== 'ACTIVE') return; const day = this.sessions.dayProgress(session.accountId, session.onboardingDay, session.targetDurationSeconds, this.now().toISOString()); const remainingSeconds = day.targetDurationSeconds - day.durationSeconds;
    if (remainingSeconds <= 0) { void this.onTarget(session.accountId, session.id); return; }
    const handle = this.scheduler.schedule(() => { void this.onTarget(session.accountId, session.id).catch(() => undefined); }, remainingSeconds * 1000); this.watchdogs.set(session.accountId, { sessionId: session.id, handle });
  }

  private async onTarget(accountId: string, sessionId: string): Promise<void> {
    const watchdog = this.watchdogs.get(accountId); if (watchdog?.sessionId === sessionId) this.watchdogs.delete(accountId); const active = this.sessions.active(accountId); if (!active || active.id !== sessionId || active.status !== 'ACTIVE') return; const day = this.sessions.dayProgress(accountId, active.onboardingDay, active.targetDurationSeconds, this.now().toISOString()); if (!day.completed) { this.scheduleWatchdog(active); return; } this.finalize(accountId, sessionId, 'COMPLETED', 'TARGET_REACHED', undefined, false);
  }

  private finalize(accountId: string, sessionId: string, requestedStatus: 'COMPLETED' | 'INTERRUPTED', requestedReason: AccountSessionCompletionReason, operatorNote: string | undefined, explicit: boolean, allowAutoClose = true): AccountSession | undefined {
    const active = this.sessions.active(accountId); if (!active || active.id !== sessionId) { if (explicit) throw new AppError('ACCOUNT_SESSION_NOT_FOUND', 'No active account session was found.'); return undefined; }
    const account = this.requireAccount(accountId); const timestamp = this.now().toISOString(); const dayBefore = this.sessions.dayProgress(accountId, active.onboardingDay, active.targetDurationSeconds, timestamp); const targetReached = dayBefore.completed; const status = targetReached ? 'COMPLETED' : requestedStatus; const reason = targetReached ? 'TARGET_REACHED' : requestedReason; const session = this.sessions.finishById(sessionId, status, reason, account.lastHealthStatus, operatorNote, timestamp);
    if (!session) { if (explicit) throw new AppError('ACCOUNT_SESSION_NOT_FOUND', 'No active account session was found.'); return undefined; }
    this.cancelWatchdog(accountId, sessionId); this.onboardingRepository.recordSessionEnd(accountId, timestamp); if (targetReached) this.onboardingRepository.completeDailySessionTask(accountId, session.onboardingDay, timestamp); if (requestedStatus === 'INTERRUPTED') this.onboarding.syncHealthPauses(); this.auditFinalization(session); this.changed();
    if (targetReached && allowAutoClose && this.settings().autoCloseBrowserAfterTarget) void this.accountService.close(accountId).catch(() => undefined);
    return session;
  }

  private auditFinalization(session: AccountSession): void { const target = session.completionReason === 'TARGET_REACHED'; this.auditSafe(session.accountId, target ? 'ACCOUNT_SESSION_TARGET_REACHED' : session.status === 'COMPLETED' ? 'ACCOUNT_SESSION_COMPLETED' : 'ACCOUNT_SESSION_INTERRUPTED', target ? 'Daily account session target reached.' : session.status === 'COMPLETED' ? 'Operator account session ended.' : 'Account session interrupted by health or browser lifecycle.', { sessionId: session.id, reason: session.completionReason, durationSeconds: session.durationSeconds }); }
  private cancelWatchdog(accountId: string, sessionId?: string): void { const watchdog = this.watchdogs.get(accountId); if (!watchdog || (sessionId && watchdog.sessionId !== sessionId)) return; this.scheduler.cancel(watchdog.handle); this.watchdogs.delete(accountId); }
  private async handleNavigationHealth(result: AccountSessionNavigationResult): Promise<void> { if (result.status !== 'OPENED') this.accountService.reportHealthResult({ accountId: result.accountId, status: result.status === 'ERROR' ? 'ERROR' : result.status, checkedAt: this.now().toISOString(), reason: result.reason }); }
  private requireOpenSession(accountId: string): void { if (!this.sessions.active(accountId)) throw new AppError('ACCOUNT_SESSION_INVALID_STATE', 'Start an account session before using navigation shortcuts.'); }
  private requireAccount(id: string): FacebookAccount { const account = this.accounts.get(id); if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.'); return account; }
  private auditSafe(accountId: string | undefined, eventType: string, message: string, metadata?: Record<string, unknown>): void { try { this.audit.add({ accountId, eventType, message, metadata: metadata ? JSON.stringify(metadata) : undefined }); } catch { /* best effort */ } }
  private changed(): void { try { this.notify(); } catch { /* renderer may be closing */ } }
}

function eligibility(account: FacebookAccount, progress: Array<{ completed: boolean }>) { const requiredDaysCompleted = Boolean(progress.length && progress.every((day) => day.completed)); const healthReady = account.lastHealthStatus === 'READY'; const proxyReady = !account.proxyEnabled || account.proxyStatus === 'WORKING'; const noActiveCheckpoint = !['LOGIN_REQUIRED', 'CHECKPOINT'].includes(account.lastHealthStatus ?? ''); return { eligible: requiredDaysCompleted && healthReady && proxyReady && noActiveCheckpoint, requiredDaysCompleted, healthReady, proxyReady, noActiveCheckpoint }; }
function publicAccount(account: FacebookAccount): FacebookAccount { return { ...account, proxyPasswordKey: undefined, proxyPasswordSaved: Boolean(account.proxyPasswordKey) }; }
function parse<T>(result: { success: true; data: T } | { success: false; error: { issues: Array<{ message?: string }> } }): T { if (!result.success) throw new AppError('INVALID_REQUEST', result.error.issues[0]?.message ?? 'Invalid account session request.'); return result.data; }
