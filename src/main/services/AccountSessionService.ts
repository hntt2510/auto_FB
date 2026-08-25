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
import type { AccountSessionDetail, AccountSessionEndInput, AccountSessionNavigationInput, AccountSessionNavigationResult, AccountSessionSettings, AccountSessionStartInput, FacebookAccount, HealthCheckResult } from '@shared/types';

const SETTINGS_KEY = 'account-session:settings';
export const DEFAULT_ACCOUNT_SESSION_SETTINGS: AccountSessionSettings = { targetDurationMinutes: 30 };

export class AccountSessionService {
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
    private readonly now: () => Date = () => new Date()
  ) {}

  recoverAbandoned(): number { const timestamp = this.now().toISOString(); const count = this.sessions.recoverAbandoned(timestamp); if (count) { this.auditSafe(undefined, 'ACCOUNT_SESSIONS_RECOVERED', 'Abandoned account sessions were interrupted during startup.', { count }); this.changed(); } return count; }

  settings(): AccountSessionSettings { const raw = this.settingsRepository.get(SETTINGS_KEY); if (!raw) return DEFAULT_ACCOUNT_SESSION_SETTINGS; try { const parsed = accountSessionSettingsSchema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : DEFAULT_ACCOUNT_SESSION_SETTINGS; } catch { return DEFAULT_ACCOUNT_SESSION_SETTINGS; } }
  updateSettings(input: AccountSessionSettings): AccountSessionSettings { const data = parse(accountSessionSettingsSchema.safeParse(input)); this.settingsRepository.set(SETTINGS_KEY, JSON.stringify(data)); this.auditSafe(undefined, 'ACCOUNT_SESSION_SETTINGS_UPDATED', 'Account session target updated.', { targetDurationMinutes: data.targetDurationMinutes }); this.changed(); return data; }

  detail(accountId: string): AccountSessionDetail {
    const id = parse(accountIdSchema.safeParse(accountId)); const account = this.requireAccount(id); const settings = this.settings(); const target = settings.targetDurationMinutes * 60; const planDays = account.onboardingPlanDays ?? 0; const progress = planDays ? this.sessions.dailyProgress(id, planDays, target, this.now().toISOString()) : [];
    return { account: publicAccount(account), activeSession: this.sessions.active(id), sessions: this.sessions.list(id), dailyProgress: progress, eligibility: eligibility(account, progress), settings, assignedGroups: this.groups.forAccount(id).filter((group) => group.active) };
  }

  async start(input: AccountSessionStartInput): Promise<AccountSessionDetail> {
    const data = parse(accountSessionStartSchema.safeParse(input)); const account = this.requireAccount(data.accountId);
    if (!['WARMING', 'READY'].includes(account.onboardingStatus)) throw new AppError('ONBOARDING_INVALID_STATE', 'Start or resume onboarding before starting an account session.');
    if (this.sessions.active(account.id)) throw new AppError('ACCOUNT_SESSION_ACTIVE', 'An account session is already active.');
    if (this.accountService.browser.isRunning(account.id)) throw new AppError('ACCOUNT_ALREADY_RUNNING', 'Close the existing account browser before starting a managed session.');
    if (account.proxyEnabled) {
      const result = await this.accountService.testProxy({ accountId: account.id, proxyProtocol: account.proxyProtocol, proxyHost: account.proxyHost!, proxyPort: account.proxyPort!, proxyUsername: account.proxyUsername });
      if (!result.success) throw new AppError('SESSION_PREFLIGHT_FAILED', result.message ?? 'Fixed proxy preflight failed.');
    }
    const health = await this.accountService.healthCheck(account.id);
    if (health.status !== 'READY') throw new AppError('SESSION_PREFLIGHT_FAILED', health.reason ?? 'Facebook health requires manual action.');
    await this.accountService.open(account.id);
    const timestamp = this.now().toISOString(); const day = onboardingDay(account.onboardingStartedAt, account.onboardingPlanDays, this.now());
    if (!day) { await this.accountService.close(account.id).catch(() => undefined); throw new AppError('ONBOARDING_INVALID_STATE', 'The onboarding day is unavailable.'); }
    try {
      this.sessions.start({ id: randomUUID(), accountId: account.id, onboardingDay: day, targetDurationSeconds: (data.targetDurationMinutes ?? this.settings().targetDurationMinutes) * 60, timestamp });
      this.onboardingRepository.completeSystemTasks(account.id, day, ['HEALTH_CHECK', 'OPEN_FACEBOOK'], timestamp);
    } catch (error) { await this.accountService.close(account.id).catch(() => undefined); if (error instanceof AppError) throw error; throw new AppError('DATABASE_ERROR', 'Unable to start the account session.'); }
    this.auditSafe(account.id, 'ACCOUNT_SESSION_STARTED', 'Operator account session started.', { onboardingDay: day, targetDurationMinutes: data.targetDurationMinutes ?? this.settings().targetDurationMinutes }); this.changed(); return this.detail(account.id);
  }

  pause(accountId: string): AccountSessionDetail { const id = parse(accountIdSchema.safeParse(accountId)); if (!this.sessions.pause(id, this.now().toISOString())) throw new AppError('ACCOUNT_SESSION_INVALID_STATE', 'Only an active account session can be paused.'); this.auditSafe(id, 'ACCOUNT_SESSION_PAUSED', 'Account session timer paused.'); this.changed(); return this.detail(id); }
  resume(accountId: string): AccountSessionDetail { const id = parse(accountIdSchema.safeParse(accountId)); const account = this.requireAccount(id); if (account.lastHealthStatus !== 'READY') throw new AppError('ACCOUNT_SESSION_INVALID_STATE', 'Run a successful health check before resuming the session timer.'); if (!this.sessions.resume(id, this.now().toISOString())) throw new AppError('ACCOUNT_SESSION_INVALID_STATE', 'Only a paused account session can be resumed.'); this.auditSafe(id, 'ACCOUNT_SESSION_RESUMED', 'Account session timer resumed.'); this.changed(); return this.detail(id); }

  end(input: AccountSessionEndInput): AccountSessionDetail { const data = parse(accountSessionEndSchema.safeParse(input)); this.finish(data.accountId, 'COMPLETED', 'OPERATOR_ENDED', data.operatorNote); return this.detail(data.accountId); }

  async navigate(input: AccountSessionNavigationInput): Promise<AccountSessionNavigationResult> {
    const data = parse(accountSessionNavigationSchema.safeParse(input)); this.requireOpenSession(data.accountId); const result = await this.accountService.browser.navigateSessionPage(data.accountId, data.destination, data.url); await this.handleNavigationHealth(result); this.auditSafe(data.accountId, 'ACCOUNT_SESSION_NAVIGATED', 'Operator-triggered session navigation completed.', { destination: data.destination, status: result.status }); return result;
  }

  async openGroup(accountId: string, groupId: string): Promise<AccountSessionNavigationResult> {
    const data = parse(accountSessionGroupSchema.safeParse({ accountId, groupId })); this.requireOpenSession(data.accountId); const group = this.groups.forAccount(data.accountId).find((value) => value.id === data.groupId && value.active); if (!group) throw new AppError('INVALID_ASSIGNMENT', 'Choose an active group assigned to this account.'); const result = await this.accountService.browser.navigateAccountPage(data.accountId, group.normalizedUrl); await this.handleNavigationHealth(result); this.auditSafe(data.accountId, 'ACCOUNT_SESSION_GROUP_OPENED', 'Operator opened an assigned group from the account session.', { groupId: group.id, status: result.status }); return result;
  }

  handleHealthResult(result: HealthCheckResult): void { if (result.status === 'READY' || !this.sessions.active(result.accountId)) return; this.finish(result.accountId, 'INTERRUPTED', 'HEALTH_INTERRUPTED'); }
  handleBrowserClosed(accountId: string): void { if (this.sessions.active(accountId)) this.finish(accountId, 'INTERRUPTED', 'BROWSER_CLOSED'); }

  async stopAll(reason: 'EMERGENCY_STOP' | 'APPLICATION_SHUTDOWN' = 'EMERGENCY_STOP'): Promise<number> {
    const open = this.sessions.openSessions(); const timestamp = this.now().toISOString(); for (const session of open) { this.sessions.finish(session.accountId, 'INTERRUPTED', reason, this.accounts.get(session.accountId)?.lastHealthStatus, undefined, timestamp); this.onboardingRepository.recordSessionEnd(session.accountId, timestamp); this.auditSafe(session.accountId, reason === 'EMERGENCY_STOP' ? 'ACCOUNT_SESSION_EMERGENCY_STOPPED' : 'ACCOUNT_SESSION_SHUTDOWN', 'Account session interrupted.', { sessionId: session.id }); }
    await Promise.allSettled(open.map((session) => this.accountService.close(session.accountId))); if (open.length) this.changed(); return open.length;
  }

  private finish(accountId: string, status: 'COMPLETED' | 'INTERRUPTED', reason: 'OPERATOR_ENDED' | 'BROWSER_CLOSED' | 'HEALTH_INTERRUPTED', operatorNote?: string): void {
    const account = this.requireAccount(accountId); const timestamp = this.now().toISOString(); const session = this.sessions.finish(accountId, status, reason, account.lastHealthStatus, operatorNote, timestamp); if (!session) throw new AppError('ACCOUNT_SESSION_NOT_FOUND', 'No active account session was found.'); this.onboardingRepository.recordSessionEnd(accountId, timestamp); const progress = this.sessions.dailyProgress(accountId, account.onboardingPlanDays ?? session.onboardingDay, session.targetDurationSeconds, timestamp); if (progress.find((day) => day.dayNumber === session.onboardingDay)?.completed) this.onboardingRepository.completeDailySessionTask(accountId, session.onboardingDay, timestamp); if (status === 'INTERRUPTED') this.onboarding.syncHealthPauses(); this.auditSafe(accountId, status === 'COMPLETED' ? 'ACCOUNT_SESSION_COMPLETED' : 'ACCOUNT_SESSION_INTERRUPTED', status === 'COMPLETED' ? 'Operator account session ended.' : 'Account session interrupted by health or browser lifecycle.', { sessionId: session.id, reason, durationSeconds: session.durationSeconds }); this.changed();
  }

  private async handleNavigationHealth(result: AccountSessionNavigationResult): Promise<void> { if (result.status !== 'OPENED') this.accountService.reportHealthResult({ accountId: result.accountId, status: result.status === 'ERROR' ? 'ERROR' : result.status, checkedAt: this.now().toISOString(), reason: result.reason }); }
  private requireOpenSession(accountId: string): void { if (!this.sessions.active(accountId)) throw new AppError('ACCOUNT_SESSION_INVALID_STATE', 'Start an account session before using navigation shortcuts.'); }
  private requireAccount(id: string): FacebookAccount { const account = this.accounts.get(id); if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.'); return account; }
  private auditSafe(accountId: string | undefined, eventType: string, message: string, metadata?: Record<string, unknown>): void { try { this.audit.add({ accountId, eventType, message, metadata: metadata ? JSON.stringify(metadata) : undefined }); } catch { /* best effort */ } }
  private changed(): void { try { this.notify(); } catch { /* renderer may be closing */ } }
}

function eligibility(account: FacebookAccount, progress: Array<{ completed: boolean }>) { const requiredDaysCompleted = Boolean(progress.length && progress.every((day) => day.completed)); const healthReady = account.lastHealthStatus === 'READY'; const proxyReady = !account.proxyEnabled || account.proxyStatus === 'WORKING'; const noActiveCheckpoint = !['LOGIN_REQUIRED', 'CHECKPOINT'].includes(account.lastHealthStatus ?? ''); return { eligible: requiredDaysCompleted && healthReady && proxyReady && noActiveCheckpoint, requiredDaysCompleted, healthReady, proxyReady, noActiveCheckpoint }; }
function publicAccount(account: FacebookAccount): FacebookAccount { return { ...account, proxyPasswordKey: undefined, proxyPasswordSaved: Boolean(account.proxyPasswordKey) }; }
function parse<T>(result: { success: true; data: T } | { success: false; error: { issues: Array<{ message?: string }> } }): T { if (!result.success) throw new AppError('INVALID_REQUEST', result.error.issues[0]?.message ?? 'Invalid account session request.'); return result.data; }
