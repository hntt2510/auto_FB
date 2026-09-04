import { contextBridge, ipcRenderer } from 'electron';
import type { AboutInfo, AccountApi, AccountOnboarding, AccountOperationsSummary, AccountSessionDetail, AccountSessionEndInput, AccountSessionNavigationInput, AccountSessionNavigationResult, AccountSessionSettings, AccountSessionStartInput, AssignmentAccount, AssignmentMatrix, AuditLog, BackupInfo, CreateAccountInput, DashboardApi, DashboardSummary, DeleteAccountInput, Draft, DraftApi, DraftFilter, DraftInput, DraftMedia, DraftStatus, FacebookAccount, FacebookGroup, GroupApi, GroupFilter, GroupImportPreview, GroupImportResult, GroupInput, GroupOpenResult, GroupOperationsSummary, HealthCheckResult, LiveReadiness, LogApi, LogFilter, ManualSession, MediaReorderInput, OnboardingApi, OnboardingOverview, OnboardingPlanTemplate, OnboardingStartInput, OnboardingTaskStatusInput, OnboardingTaskUpdateInput, OperationsApi, OrphanMediaScan, PlannerSummary, PreflightResult, ProxyImportPreview, ProxyTestInput, ProxyTestResult, PublishApi, PublishAttempt, PublishBatchPreview, PublishHistoryFilter, PublishingEngineStatus, PublishingHistoryRow, PublishingRunResult, PublishingSettings, PublishingSettingsApi, PublishingSettingsUpdate, QueueApi, QueueBatchActionInput, QueueBatchInput, QueueBatchRescheduleInput, QueueFilter, QueueItem, QueueOptions, QueuePreview, ReconciliationRecord, RequeueInput, SelectorProbeResult, StorageUsage, UpdateAccountInput, WarmUpTask } from '@shared/types';

type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const response = await ipcRenderer.invoke(channel, ...args) as IpcResponse<T>;
  if (!response.ok) {
    const error = new Error(response.error.message) as Error & { code?: string };
    error.code = response.error.code;
    throw error;
  }
  return response.data;
}

const accountApi: AccountApi = {
  list: () => invoke<FacebookAccount[]>('accounts:list'),
  create: (input: CreateAccountInput) => invoke<FacebookAccount>('accounts:create', input),
  update: (input: UpdateAccountInput) => invoke<FacebookAccount>('accounts:update', input),
  open: (accountId: string) => invoke<FacebookAccount>('accounts:open', accountId),
  close: (accountId: string) => invoke<FacebookAccount>('accounts:close', accountId),
  healthCheck: (accountId: string) => invoke<HealthCheckResult>('accounts:health', accountId),
  testProxy: (input: ProxyTestInput) => invoke<ProxyTestResult>('accounts:test-proxy', input),
  previewProxyImport: (text: string) => invoke<ProxyImportPreview>('accounts:proxy-import-preview', { text }),
  delete: (input: DeleteAccountInput) => invoke<void>('accounts:delete', input),
  openProfileFolder: (accountId: string) => invoke<void>('accounts:open-profile', accountId),
  operations: () => invoke<AccountOperationsSummary[]>('accounts:operations'),
  onChanged: (listener: (accounts: FacebookAccount[]) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, accounts: FacebookAccount[]) => listener(accounts);
    ipcRenderer.on('accounts:changed', callback);
    return () => ipcRenderer.removeListener('accounts:changed', callback);
  }
};

const logApi: LogApi = {
  list: (filter?: LogFilter) => invoke<AuditLog[]>('logs:list', filter ?? {})
};

const groupApi: GroupApi = {
  list: (filter?: GroupFilter) => invoke<FacebookGroup[]>('groups:list', filter ?? {}),
  get: (groupId: string) => invoke<FacebookGroup>('groups:get', groupId),
  create: (input: GroupInput) => invoke<FacebookGroup>('groups:create', input),
  update: (groupId: string, input: GroupInput) => invoke<FacebookGroup>('groups:update', groupId, input),
  setActive: (groupId: string, active: boolean) => invoke<FacebookGroup>('groups:activate', groupId, active),
  delete: (groupId: string) => invoke<void>('groups:delete', groupId),
  previewImport: (text: string) => invoke<GroupImportPreview>('groups:import-preview', { text }),
  import: (text: string) => invoke<GroupImportResult>('groups:import-commit', { text }),
  assignments: (groupId: string) => invoke<AssignmentAccount[]>('groups:assignments', groupId),
  replaceAssignments: (groupId: string, accountIds: string[]) => invoke<AssignmentAccount[]>('groups:replace-assignments', { groupId, accountIds }),
  accountGroups: (accountId: string) => invoke<FacebookGroup[]>('groups:account-groups', accountId),
  replaceAccountGroups: (accountId: string, groupIds: string[]) => invoke<FacebookGroup[]>('groups:replace-account-groups', { accountId, groupIds }),
  open: (groupId: string, accountId: string) => invoke<GroupOpenResult>('groups:open', { groupId, accountId }),
  operations: () => invoke<GroupOperationsSummary[]>('groups:operations'),
  assignmentMatrix: () => invoke<AssignmentMatrix>('groups:assignment-matrix')
};

const draftApi: DraftApi = {
  list: (filter?: DraftFilter) => invoke<Draft[]>('drafts:list', filter ?? {}),
  get: (draftId: string) => invoke<Draft>('drafts:get', draftId),
  create: (input: DraftInput) => invoke<Draft>('drafts:create', input),
  update: (draftId: string, input: DraftInput) => invoke<Draft>('drafts:update', draftId, input),
  duplicate: (draftId: string) => invoke<Draft>('drafts:duplicate', draftId),
  setStatus: (draftId: string, status: DraftStatus) => invoke<Draft>('drafts:status', { draftId, status }),
  delete: (draftId: string) => invoke<void>('drafts:delete', draftId),
  addMedia: (draftId: string) => invoke<DraftMedia | undefined>('drafts:add-media', draftId),
  removeMedia: (draftId: string, mediaId: string) => invoke<void>('drafts:remove-media', { draftId, mediaId }),
  reorderMedia: (input: MediaReorderInput) => invoke<Draft>('drafts:reorder-media', input)
};

const queueApi: QueueApi = {
  options: (draftId: string, accountIds: string[]) => invoke<QueueOptions>('queue:options', { draftId, accountIds }),
  preview: (input: QueueBatchInput) => invoke<QueuePreview>('queue:preview', input),
  create: (input: QueueBatchInput) => invoke<QueueItem[]>('queue:create', input),
  list: (filter?: QueueFilter) => invoke<QueueItem[]>('queue:list', filter ?? {}),
  get: (queueId: string) => invoke<QueueItem>('queue:get', queueId),
  pause: (queueId: string) => invoke<QueueItem>('queue:pause', queueId),
  resume: (queueId: string) => invoke<QueueItem>('queue:resume', queueId),
  cancel: (queueId: string) => invoke<QueueItem>('queue:cancel', queueId),
  delete: (queueId: string) => invoke<void>('queue:delete', queueId),
  planner: () => invoke<PlannerSummary>('queue:planner'),
  batchAction: (input: QueueBatchActionInput) => invoke<QueueItem[]>('queue:batch-action', input),
  batchReschedule: (input: QueueBatchRescheduleInput) => invoke<QueueItem[]>('queue:batch-reschedule', input)
};

const dashboardApi: DashboardApi = { summary: () => invoke<DashboardSummary>('dashboard:summary') };
const onboardingApi: OnboardingApi = {
  templates: () => invoke<OnboardingPlanTemplate[]>('onboarding:templates'), overview: () => invoke<OnboardingOverview>('onboarding:overview'), get: (accountId: string) => invoke<AccountOnboarding>('onboarding:get', accountId),
  start: (input: OnboardingStartInput) => invoke<AccountOnboarding>('onboarding:start', input), pause: (accountId: string, reason?: string) => invoke<AccountOnboarding>('onboarding:pause', { accountId, reason }), resume: (accountId: string) => invoke<AccountOnboarding>('onboarding:resume', accountId), markReady: (accountId: string) => invoke<AccountOnboarding>('onboarding:ready', accountId), updateNotes: (accountId: string, notes: string) => invoke<AccountOnboarding>('onboarding:notes', { accountId, notes }),
  updateTask: (input: OnboardingTaskUpdateInput) => invoke<WarmUpTask>('onboarding:update-task', input), setTaskStatus: (input: OnboardingTaskStatusInput) => invoke<WarmUpTask>('onboarding:task-status', input), startSession: (accountId: string) => invoke<ManualSession>('onboarding:start-session', accountId), stopSession: (accountId: string) => invoke<ManualSession>('onboarding:stop-session', accountId),
  sessionDetail: (accountId: string) => invoke<AccountSessionDetail>('onboarding:session-detail', accountId), startAssistedSession: (input: AccountSessionStartInput) => invoke<AccountSessionDetail>('onboarding:start-assisted-session', input), pauseAssistedSession: (accountId: string) => invoke<AccountSessionDetail>('onboarding:pause-assisted-session', accountId), resumeAssistedSession: (accountId: string) => invoke<AccountSessionDetail>('onboarding:resume-assisted-session', accountId), endAssistedSession: (input: AccountSessionEndInput) => invoke<AccountSessionDetail>('onboarding:end-assisted-session', input),
  navigateSession: (input: AccountSessionNavigationInput) => invoke<AccountSessionNavigationResult>('onboarding:navigate-session', input), openSessionGroup: (accountId: string, groupId: string) => invoke<AccountSessionNavigationResult>('onboarding:open-session-group', { accountId, groupId }), updateSessionSettings: (settings: AccountSessionSettings) => invoke<AccountSessionSettings>('onboarding:update-session-settings', settings), stopAllSessions: () => invoke<number>('onboarding:stop-all-sessions'),
  onChanged: (listener: () => void) => { const callback = () => listener(); ipcRenderer.on('onboarding:changed', callback); return () => ipcRenderer.removeListener('onboarding:changed', callback); }
};

const publishApi: PublishApi = {
  status: () => invoke<PublishingEngineStatus>('publishing:status'),
  run: (queueId: string) => invoke<PublishingRunResult>('publishing:run', queueId),
  runSelected: (queueIds: string[]) => invoke<PublishingRunResult>('publishing:run-selected', { queueIds }),
  previewBatch: (queueIds: string[]) => invoke<PublishBatchPreview>('publishing:preview-batch', { queueIds }),
  prepareBatch: (queueIds: string[]) => invoke<PublishBatchPreview>('publishing:prepare-batch', { queueIds }),
  prepareAndRunBatch: (queueIds: string[]) => invoke<PublishingRunResult>('publishing:prepare-and-run-batch', { queueIds }),
  runDue: () => invoke<PublishingRunResult>('publishing:run-due'),
  attempts: (queueId: string) => invoke<PublishAttempt[]>('publishing:attempts', queueId),
  retry: (queueId: string, acknowledgeDuplicateRisk: boolean) => invoke<QueueItem>('publishing:retry', { queueId, acknowledgeDuplicateRisk }),
  requeue: (input: RequeueInput) => invoke<QueueItem>('publishing:requeue', input),
  resolve: (queueId: string) => invoke<QueueItem>('publishing:resolve', queueId),
  markSubmitted: (queueId: string) => invoke<QueueItem>('publishing:mark-submitted', queueId),
  markVerified: (queueId: string, evidence?: string) => invoke<QueueItem>('publishing:mark-verified', { queueId, evidence }),
  preflight: (queueId: string) => invoke<PreflightResult>('publishing:preflight', queueId),
  probe: (accountId: string, groupId: string) => invoke<SelectorProbeResult>('publishing:probe', { accountId, groupId }),
  reconciliations: (queueId: string) => invoke<ReconciliationRecord[]>('publishing:reconciliations', queueId),
  openDiagnostic: (attemptId: string) => invoke<void>('publishing:open-diagnostic', attemptId),
  openPreflightDiagnostic: (queueId: string) => invoke<void>('publishing:open-preflight-diagnostic', queueId),
  deleteDiagnostic: (attemptId: string) => invoke<void>('publishing:delete-diagnostic', attemptId),
  evaluateLiveReadiness: (queueId: string) => invoke<LiveReadiness>('publishing:live-readiness', queueId),
  armScheduler: (acknowledgeOverdue = false) => invoke<PublishingEngineStatus>('publishing:arm-scheduler', { acknowledgeOverdue }),
  disarmScheduler: () => invoke<PublishingEngineStatus>('publishing:disarm-scheduler'),
  stopPublishing: () => invoke<PublishingEngineStatus>('publishing:stop'),
  stopAfterCurrent: () => invoke<PublishingEngineStatus>('publishing:stop-after-current'),
  exportReport: () => invoke<string | undefined>('publishing:export-report'),
  onChanged: (listener: () => void) => { const callback = () => listener(); ipcRenderer.on('publishing:changed', callback); return () => ipcRenderer.removeListener('publishing:changed', callback); }
};

const settingsApi: PublishingSettingsApi = {
  getPublishing: () => invoke<PublishingSettings>('settings:get-publishing'),
  updatePublishing: (input: PublishingSettingsUpdate) => invoke<PublishingSettings>('settings:update-publishing', input)
};

const operationsApi: OperationsApi = {
  history: (filter?: PublishHistoryFilter) => invoke<PublishingHistoryRow[]>('operations:history', filter ?? {}),
  exportHistoryCsv: (filter?: PublishHistoryFilter) => invoke<string | undefined>('operations:export-history', filter ?? {}),
  listBackups: () => invoke<BackupInfo[]>('operations:list-backups'),
  createBackup: () => invoke<BackupInfo>('operations:create-backup'),
  restoreBackup: (backupId: string) => invoke<void>('operations:restore-backup', backupId),
  storageUsage: () => invoke<StorageUsage>('operations:storage'),
  cleanDiagnostics: () => invoke<number>('operations:clean-diagnostics'),
  scanOrphanMedia: () => invoke<OrphanMediaScan>('operations:scan-orphan-media'),
  cleanOrphanMedia: (candidateIds: string[]) => invoke<number>('operations:clean-orphan-media', { candidateIds }),
  about: () => invoke<AboutInfo>('operations:about')
};

contextBridge.exposeInMainWorld('accountApi', accountApi);
contextBridge.exposeInMainWorld('appBridge', { available: true, version: '1' });
contextBridge.exposeInMainWorld('logApi', logApi);
contextBridge.exposeInMainWorld('groupApi', groupApi);
contextBridge.exposeInMainWorld('draftApi', draftApi);
contextBridge.exposeInMainWorld('queueApi', queueApi);
contextBridge.exposeInMainWorld('dashboardApi', dashboardApi);
contextBridge.exposeInMainWorld('onboardingApi', onboardingApi);
contextBridge.exposeInMainWorld('publishApi', publishApi);
contextBridge.exposeInMainWorld('settingsApi', settingsApi);
contextBridge.exposeInMainWorld('operationsApi', operationsApi);
