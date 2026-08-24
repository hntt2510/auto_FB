import { randomUUID } from 'node:crypto';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import { OnboardingRepository, onboardingDay, type NewWarmUpTask } from '@main/db/repositories/OnboardingRepository';
import { AppError } from '@main/errors';
import { accountIdSchema, onboardingNotesSchema, onboardingPauseSchema, onboardingStartSchema, onboardingTaskStatusSchema, onboardingTaskUpdateSchema } from '@shared/schemas';
import type { AccountOnboarding, FacebookAccount, ManualSession, OnboardingOverview, OnboardingPlanTemplate, OnboardingStartInput, OnboardingTaskStatusInput, OnboardingTaskUpdateInput, WarmUpTask } from '@shared/types';

type TemplateTask = Omit<NewWarmUpTask, 'id' | 'accountId'>;
type Template = OnboardingPlanTemplate & { tasks: TemplateTask[] };

const TEMPLATES: Template[] = [
  { id: 'BASIC_3_DAY', name: 'Basic 3-day', days: 3, description: 'A concise operator onboarding checklist with manual activity only.', tasks: [
    task(1, 0, 'HEALTH_CHECK', 'Verify session health', 'Run the existing session health check and resolve any login or checkpoint manually.'),
    task(1, 1, 'OPEN_FACEBOOK', 'Open Facebook', 'Open the account persistent profile. All website interaction remains manual.'),
    task(1, 2, 'MANUAL_TASK', 'Review profile information', 'Review profile information manually and record any local notes.'),
    task(1, 3, 'MANUAL_TASK', 'Manual browsing session', 'Perform an operator-led browsing or reading session.'),
    task(2, 0, 'OPEN_FACEBOOK', 'Open Facebook', 'Open the same persistent account profile.'),
    task(2, 1, 'OPEN_GROUP', 'Open an assigned group', 'Choose an assigned group and continue manually after it opens.'),
    task(2, 2, 'MANUAL_TASK', 'Manual browsing and reading', 'Complete a manual reading session without automated interaction.'),
    task(3, 0, 'MANUAL_TASK', 'Manual account activity', 'Complete the operator-selected manual account activity.'),
    task(3, 1, 'OPEN_FACEBOOK', 'Review notifications manually', 'Open Facebook and review notifications manually.'),
    task(3, 2, 'HEALTH_CHECK', 'Verify session remains healthy', 'Run the existing health check. Challenges require operator action.') ] },
  { id: 'BASIC_5_DAY', name: 'Basic 5-day', days: 5, description: 'An extended operator onboarding checklist with no automated social actions.', tasks: [
    task(1, 0, 'HEALTH_CHECK', 'Verify session health', 'Run the existing session health check and resolve any login or checkpoint manually.'),
    task(1, 1, 'OPEN_FACEBOOK', 'Open Facebook', 'Open the account persistent profile. All website interaction remains manual.'),
    task(1, 2, 'MANUAL_TASK', 'Review profile information', 'Review profile information manually and record local notes.'),
    task(2, 0, 'OPEN_GROUP', 'Open an assigned group', 'Choose an assigned group and continue manually after it opens.'),
    task(2, 1, 'MANUAL_TASK', 'Manual browsing and reading', 'Complete an operator-led reading session.'),
    task(3, 0, 'OPEN_FACEBOOK', 'Review notifications manually', 'Open Facebook and review notifications manually.'),
    task(3, 1, 'HEALTH_CHECK', 'Verify session health', 'Run the existing health check.'),
    task(4, 0, 'OPEN_GROUP', 'Review an assigned group', 'Open an assigned group for manual review.'),
    task(4, 1, 'MANUAL_TASK', 'Review onboarding notes', 'Review and update local onboarding notes.'),
    task(5, 0, 'HEALTH_CHECK', 'Final operator health review', 'Run the existing health check before the operator decides whether to mark READY.'),
    task(5, 1, 'MANUAL_TASK', 'Review plan completion', 'Review completed and skipped tasks. This does not claim the account is safe.') ] }
];

export class OnboardingService {
  constructor(private readonly repository: OnboardingRepository, private readonly accounts: AccountRepository, private readonly groups: GroupRepository, private readonly audit: AuditLogRepository, private readonly notify: () => void, private readonly now: () => Date = () => new Date()) {}

  templates(): OnboardingPlanTemplate[] { return TEMPLATES.map((template) => ({ id: template.id, name: template.name, days: template.days, description: template.description })); }
  overview(): OnboardingOverview {
    const accounts = this.accounts.list(); const today = this.now().toISOString().slice(0, 10); const counts = { NEW: 0, WARMING: 0, READY: 0, PAUSED: 0 } as OnboardingOverview['counts']; const todayTasks: WarmUpTask[] = []; let completedToday = 0;
    const summaries = accounts.map((account) => {
      counts[account.onboardingStatus]++; const tasks = this.repository.tasks(account.id); const currentDay = onboardingDay(account.onboardingStartedAt, account.onboardingPlanDays, this.now());
      if (account.onboardingStatus === 'WARMING' && currentDay) todayTasks.push(...tasks.filter((task) => task.dayNumber === currentDay));
      completedToday += tasks.filter((task) => task.status === 'DONE' && task.completedAt?.startsWith(today)).length;
      return { account: publicAccount(account), currentDay, completedTasks: tasks.filter((task) => task.status === 'DONE').length, totalTasks: tasks.length };
    });
    return { counts, todayTasks, completedToday, pausedAccounts: accounts.filter((account) => account.onboardingStatus === 'PAUSED').map(publicAccount), accounts: summaries };
  }

  get(accountId: string): AccountOnboarding { const account = this.requireAccount(accountId); const tasks = this.repository.tasks(account.id); const sessions = this.repository.sessions(account.id); return { account: publicAccount(account), currentDay: onboardingDay(account.onboardingStartedAt, account.onboardingPlanDays, this.now()), completedTasks: tasks.filter((task) => task.status === 'DONE').length, skippedTasks: tasks.filter((task) => task.status === 'SKIPPED').length, pendingTasks: tasks.filter((task) => task.status === 'PENDING').length, tasks, sessions, activeSession: sessions.find((session) => !session.endedAt) }; }

  start(input: OnboardingStartInput): AccountOnboarding {
    const data = parse(onboardingStartSchema.safeParse(input)); const account = this.requireAccount(data.accountId); if (account.onboardingStatus !== 'NEW') throw new AppError('ONBOARDING_INVALID_STATE', 'Only a NEW account can start an onboarding plan.');
    const healthReason = healthPauseReason(account); if (healthReason) throw new AppError('ONBOARDING_INVALID_STATE', healthReason);
    const template = TEMPLATES.find((value) => value.id === data.templateId)!; const timestamp = this.now().toISOString();
    this.repository.startPlan(account.id, template.days, template.tasks.map((value) => ({ ...value, id: randomUUID(), accountId: account.id })), timestamp);
    this.auditSafe(account.id, 'WARMUP_STARTED', 'Operator onboarding plan started.', { templateId: template.id, days: template.days }); this.changed(); return this.get(account.id);
  }

  pause(accountId: string, reason?: string): AccountOnboarding { const data = parse(onboardingPauseSchema.safeParse({ accountId, reason })); const account = this.requireAccount(data.accountId); const message = data.reason || 'Paused by operator.'; if (!this.repository.pause(account.id, message, this.now().toISOString())) throw new AppError('ONBOARDING_INVALID_STATE', 'Only WARMING or READY onboarding can be paused.'); this.auditSafe(account.id, 'WARMUP_PAUSED', 'Operator onboarding paused.', { reason: message }); this.changed(); return this.get(account.id); }
  resume(accountId: string): AccountOnboarding { const account = this.requireAccount(parse(accountIdSchema.safeParse(accountId))); const reason = healthPauseReason(account); if (reason) throw new AppError('ONBOARDING_INVALID_STATE', `Resolve account health and run a successful health check before resuming. ${reason}`); if (!this.repository.resume(account.id, this.now().toISOString())) throw new AppError('ONBOARDING_INVALID_STATE', 'Only PAUSED onboarding can be resumed.'); this.auditSafe(account.id, 'WARMUP_RESUMED', 'Operator onboarding resumed.'); this.changed(); return this.get(account.id); }
  markReady(accountId: string): AccountOnboarding { const account = this.requireAccount(parse(accountIdSchema.safeParse(accountId))); const reason = healthPauseReason(account); if (reason) throw new AppError('ONBOARDING_INVALID_STATE', 'Account health requires manual action before it can be marked READY.'); if (!this.repository.markReady(account.id, this.now().toISOString())) throw new AppError('ONBOARDING_INVALID_STATE', 'Only WARMING onboarding can be explicitly marked READY.'); this.auditSafe(account.id, 'WARMUP_MARKED_READY', 'Operator explicitly marked onboarding READY.'); this.changed(); return this.get(account.id); }
  updateNotes(accountId: string, notes: string): AccountOnboarding { const data = parse(onboardingNotesSchema.safeParse({ accountId, notes })); this.requireAccount(data.accountId); this.repository.updateNotes(data.accountId, data.notes, this.now().toISOString()); this.changed(); return this.get(data.accountId); }

  updateTask(input: OnboardingTaskUpdateInput): WarmUpTask { const data = parse(onboardingTaskUpdateSchema.safeParse(input)); const current = this.requireTask(data.taskId); if (data.groupId && current.type !== 'OPEN_GROUP') throw new AppError('INVALID_REQUEST', 'Only an Open Group task can reference a group.'); if (data.groupId && !this.groups.forAccount(current.accountId).some((group) => group.id === data.groupId && group.active)) throw new AppError('INVALID_ASSIGNMENT', 'Choose an active group assigned to this account.'); const task = this.repository.updateTask(data.taskId, data.title, data.description, data.groupId, this.now().toISOString()); if (!task) throw new AppError('ONBOARDING_TASK_NOT_FOUND', 'Onboarding task not found.'); this.changed(); return task; }
  setTaskStatus(input: OnboardingTaskStatusInput): WarmUpTask { const data = parse(onboardingTaskStatusSchema.safeParse(input)); const current = this.requireTask(data.taskId); if (this.requireAccount(current.accountId).onboardingStatus !== 'WARMING') throw new AppError('ONBOARDING_INVALID_STATE', 'Resume onboarding before changing checklist tasks.'); const task = this.repository.setTaskStatus(data.taskId, data.status, data.note, this.now().toISOString()); if (!task) throw new AppError('ONBOARDING_TASK_NOT_FOUND', 'Onboarding task not found.'); const event = data.status === 'DONE' ? 'WARMUP_TASK_DONE' : data.status === 'SKIPPED' ? 'WARMUP_TASK_SKIPPED' : 'WARMUP_TASK_RESET'; this.auditSafe(current.accountId, event, `Onboarding task marked ${data.status}.`, { taskId: data.taskId }); this.changed(); return task; }

  startSession(accountId: string): ManualSession { const account = this.requireAccount(parse(accountIdSchema.safeParse(accountId))); if (account.onboardingStatus !== 'WARMING') throw new AppError('ONBOARDING_INVALID_STATE', 'Resume onboarding before starting a manual session.'); if (this.repository.activeSession(account.id)) throw new AppError('MANUAL_SESSION_ACTIVE', 'A manual session is already active for this account.'); const session = this.repository.startSession(randomUUID(), account.id, this.now().toISOString()); this.auditSafe(account.id, 'MANUAL_SESSION_STARTED', 'Operator started a manual onboarding session.', { sessionId: session.id }); this.changed(); return session; }
  stopSession(accountId: string): ManualSession { const account = this.requireAccount(parse(accountIdSchema.safeParse(accountId))); const session = this.repository.stopSession(account.id, this.now().toISOString()); if (!session) throw new AppError('ONBOARDING_INVALID_STATE', 'No active manual session was found.'); this.auditSafe(account.id, 'MANUAL_SESSION_ENDED', 'Operator ended a manual onboarding session.', { sessionId: session.id, durationSeconds: session.durationSeconds }); this.changed(); return session; }

  syncHealthPauses(): number { let paused = 0; for (const account of this.accounts.list()) { if (!['WARMING', 'READY'].includes(account.onboardingStatus)) continue; const reason = healthPauseReason(account); if (!reason || !this.repository.pause(account.id, reason, this.now().toISOString())) continue; paused++; this.auditSafe(account.id, 'WARMUP_PAUSED', 'Onboarding paused because account health requires manual action.', { reason }); } return paused; }

  private requireAccount(id: string): FacebookAccount { const account = this.accounts.get(id); if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.'); return account; }
  private requireTask(id: string): WarmUpTask { const task = this.repository.task(id); if (!task) throw new AppError('ONBOARDING_TASK_NOT_FOUND', 'Onboarding task not found.'); return task; }
  private auditSafe(accountId: string, eventType: string, message: string, metadata?: Record<string, unknown>): void { try { this.audit.add({ accountId, eventType, message, metadata: metadata ? JSON.stringify(metadata) : undefined }); } catch { /* best effort */ } }
  private changed(): void { try { this.notify(); } catch { /* renderer may be closing */ } }
}

function task(dayNumber: number, sortOrder: number, type: TemplateTask['type'], title: string, description: string): TemplateTask { return { dayNumber, sortOrder, type, title, description }; }
function healthPauseReason(account: FacebookAccount): string | undefined { if (account.lastHealthStatus === 'LOGIN_REQUIRED') return 'Facebook login is required.'; if (account.lastHealthStatus === 'CHECKPOINT') return 'Facebook checkpoint requires manual action.'; if (account.proxyEnabled && account.proxyStatus === 'FAILED') return 'Fixed proxy health failed.'; if (account.status === 'ERROR' || account.lastHealthStatus === 'ERROR') return 'Browser or session health requires manual action.'; return undefined; }
function publicAccount(account: FacebookAccount): FacebookAccount { return { ...account, proxyPasswordKey: undefined, proxyPasswordSaved: Boolean(account.proxyPasswordKey) }; }
function parse<T>(result: { success: true; data: T } | { success: false; error: { issues: Array<{ message?: string }> } }): T { if (!result.success) throw new AppError('INVALID_REQUEST', result.error.issues[0]?.message ?? 'Invalid onboarding request.'); return result.data; }
