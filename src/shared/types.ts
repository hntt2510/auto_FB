export const ACCOUNT_STATUSES = [
  'STOPPED',
  'STARTING',
  'RUNNING',
  'READY',
  'LOGIN_REQUIRED',
  'CHECKPOINT',
  'ERROR'
] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export type HealthStatus = 'READY' | 'LOGIN_REQUIRED' | 'CHECKPOINT' | 'ERROR';
export type ProxyProtocol = 'HTTP' | 'HTTPS' | 'SOCKS5';
export type ProxyStatus = 'NOT_CONFIGURED' | 'UNTESTED' | 'WORKING' | 'FAILED';
export type OnboardingStatus = 'NEW' | 'WARMING' | 'READY' | 'PAUSED';
export type WarmUpTaskStatus = 'PENDING' | 'DONE' | 'SKIPPED';
export type WarmUpTaskType = 'MANUAL_TASK' | 'OPEN_FACEBOOK' | 'OPEN_GROUP' | 'HEALTH_CHECK';
export type OnboardingTemplateId = 'BASIC_3_DAY' | 'BASIC_5_DAY';
export type AccountSessionStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'INTERRUPTED';
export type AccountSessionCompletionReason = 'TARGET_REACHED' | 'OPERATOR_ENDED' | 'BROWSER_CLOSED' | 'HEALTH_INTERRUPTED' | 'EMERGENCY_STOP' | 'APPLICATION_RESTART' | 'APPLICATION_SHUTDOWN';

export type FacebookAccount = {
  id: string;
  name: string;
  profileName: string;
  profileDirectory: string;
  proxyEnabled: boolean;
  proxyProtocol: ProxyProtocol;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPasswordKey?: string;
  proxyPasswordSaved?: boolean;
  proxyStatus: ProxyStatus;
  lastProxyTestAt?: string;
  lastProxyTestIp?: string;
  lastProxyLatencyMs?: number;
  lastProxyError?: string;
  onboardingStatus: OnboardingStatus;
  onboardingStartedAt?: string;
  onboardingPlanDays?: number;
  onboardingPausedReason?: string;
  onboardingNotes?: string;
  lastManualSessionAt?: string;
  status: AccountStatus;
  lastHealthStatus?: HealthStatus;
  lastOpenedAt?: string;
  lastHealthCheckAt?: string;
  lastSuccessfulLoginAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type AuditLog = {
  id: string;
  accountId?: string;
  accountName?: string;
  eventType: string;
  message: string;
  metadata?: string;
  createdAt: string;
};

export type HealthCheckResult = {
  accountId: string;
  status: HealthStatus;
  checkedAt: string;
  reason?: string;
};

export type ApiErrorCode =
  | 'ACCOUNT_ALREADY_RUNNING'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_RUNNING'
  | 'INVALID_PROFILE_PATH'
  | 'DUPLICATE_PROFILE'
  | 'SECRET_UNAVAILABLE'
  | 'SECRET_DECRYPT_FAILED'
  | 'PROXY_AUTH_FAILED'
  | 'PROXY_CONNECTION_FAILED'
  | 'PROXY_TIMEOUT'
  | 'PROXY_DNS_FAILED'
  | 'PROXY_UNSUPPORTED'
  | 'PROXY_TEST_FAILED'
  | 'ONBOARDING_NOT_FOUND'
  | 'ONBOARDING_INVALID_STATE'
  | 'ONBOARDING_TASK_NOT_FOUND'
  | 'MANUAL_SESSION_ACTIVE'
  | 'ACCOUNT_SESSION_ACTIVE'
  | 'ACCOUNT_SESSION_NOT_FOUND'
  | 'ACCOUNT_SESSION_INVALID_STATE'
  | 'SESSION_PREFLIGHT_FAILED'
  | 'DAILY_SESSION_TARGET_ALREADY_REACHED'
  | 'BROWSER_LAUNCH_FAILED'
  | 'BROWSER_NAVIGATION_FAILED'
  | 'DATABASE_ERROR'
  | 'INVALID_REQUEST'
  | 'PROFILE_DELETE_FAILED'
  | 'UNAUTHORIZED_IPC'
  | 'GROUP_NOT_FOUND'
  | 'DUPLICATE_GROUP'
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_NOT_READY'
  | 'MEDIA_INVALID'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_NOT_FOUND'
  | 'QUEUE_ITEM_NOT_FOUND'
  | 'QUEUE_VALIDATION_FAILED'
  | 'DUPLICATE_QUEUE_ITEM'
  | 'INVALID_ASSIGNMENT'
  | 'GROUP_INACTIVE'
  | 'CAMPAIGN_NOT_FOUND'
  | 'VARIANT_NOT_FOUND'
  | 'PLAN_ITEM_NOT_FOUND'
  | 'CAMPAIGN_SIMULATION_STALE'
  | 'ENTITY_IN_USE'
  | 'INVALID_STATE'
  | 'PUBLISH_CLAIM_CONFLICT'
  | 'PUBLISH_ENGINE_DISABLED'
  | 'ACCOUNT_LOGIN_REQUIRED'
  | 'ACCOUNT_CHECKPOINT'
  | 'GROUP_UNAVAILABLE'
  | 'GROUP_PERMISSION_DENIED'
  | 'COMPOSER_NOT_FOUND'
  | 'COMPOSER_TRIGGER_NOT_FOUND'
  | 'COMPOSER_TRIGGER_AMBIGUOUS'
  | 'COMPOSER_TRIGGER_CLICK_FAILED'
  | 'COMPOSER_TRIGGER_CLICK_NO_COMPOSER'
  | 'COMPOSER_CONTAINER_NOT_FOUND'
  | 'COMPOSER_CONTAINER_AMBIGUOUS'
  | 'COMPOSER_TEXTBOX_NOT_FOUND'
  | 'COMPOSER_TEXTBOX_AMBIGUOUS'
  | 'CONTENT_FILL_FAILED'
  | 'MEDIA_FILE_MISSING'
  | 'MEDIA_UPLOAD_FAILED'
  | 'MEDIA_UPLOAD_TIMEOUT'
  | 'SUBMIT_FAILED'
  | 'SUBMISSION_UNKNOWN'
  | 'NETWORK_ERROR'
  | 'BROWSER_CLOSED'
  | 'EXECUTION_CANCELLED'
  | 'CANARY_LIMIT'
  | 'BATCH_LIMIT'
  | 'BATCH_NOT_READY'
  | 'PUBLISHING_BUSY'
  | 'LIVE_READINESS_FAILED'
  | 'PREFLIGHT_REQUIRED'
  | 'PREFLIGHT_EXPIRED'
  | 'EMPTY_PUBLISH_CONTENT'
  | 'SCHEDULER_DISARMED'
  | 'OVERDUE_BACKLOG_ACK_REQUIRED'
  | 'PUBLISHING_STOPPED'
  | 'SCHEDULER_INVALID_STATE'
  | 'SESSION_JOB_LIMIT_REACHED'
  | 'BACKUP_INVALID'
  | 'RESTORE_NOT_SAFE'
  | 'UNKNOWN_ERROR';

export type ApiError = { code: ApiErrorCode; message: string };

export type LogFilter = {
  accountId?: string;
  eventType?: string;
  from?: string;
  to?: string;
};

export type CreateAccountInput = {
  name: string;
  profileName: string;
  proxyEnabled: boolean;
  proxyProtocol?: ProxyProtocol;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
};

export type UpdateAccountInput = {
  accountId: string;
  name: string;
  proxyEnabled: boolean;
  proxyProtocol?: ProxyProtocol;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  clearProxyPassword?: boolean;
};

export type ProxyConfigurationInput = { proxyProtocol: ProxyProtocol; proxyHost: string; proxyPort: number; proxyUsername?: string; proxyPassword?: string };
export type ProxyTestInput = ProxyConfigurationInput & { accountId?: string };
export type ProxyTestResult = { success: boolean; latencyMs?: number; ip?: string; errorCode?: Extract<ApiErrorCode, 'PROXY_CONNECTION_FAILED' | 'PROXY_AUTH_FAILED' | 'PROXY_TIMEOUT' | 'PROXY_DNS_FAILED' | 'PROXY_UNSUPPORTED' | 'PROXY_TEST_FAILED'>; message?: string; testedAt: string };
export type ParsedProxyInput = ProxyConfigurationInput;
export type ProxyImportRow = { line: number; display: string; status: 'VALID' | 'INVALID'; proxy?: Omit<ParsedProxyInput, 'proxyPassword'> & { hasPassword: boolean }; reason?: string };
export type ProxyImportPreview = { valid: number; invalid: number; rows: ProxyImportRow[] };

export type WarmUpTask = { id: string; accountId: string; dayNumber: number; sortOrder: number; type: WarmUpTaskType; groupId?: string; groupName?: string; title: string; description: string; status: WarmUpTaskStatus; completedAt?: string; note?: string; createdAt: string; updatedAt: string };
export type ManualSession = { id: string; accountId: string; startedAt: string; endedAt?: string; durationSeconds?: number };
export type OnboardingPlanTemplate = { id: OnboardingTemplateId; name: string; days: number; description: string };
export type AccountOnboarding = { account: FacebookAccount; currentDay?: number; completedTasks: number; skippedTasks: number; pendingTasks: number; tasks: WarmUpTask[]; sessions: ManualSession[]; activeSession?: ManualSession };
export type OnboardingOverview = { counts: Record<OnboardingStatus, number>; todayTasks: WarmUpTask[]; completedToday: number; pausedAccounts: FacebookAccount[]; accounts: Array<{ account: FacebookAccount; currentDay?: number; completedTasks: number; totalTasks: number }> };
export type OnboardingStartInput = { accountId: string; templateId: OnboardingTemplateId };
export type OnboardingTaskUpdateInput = { taskId: string; title: string; description: string; groupId?: string };
export type OnboardingTaskStatusInput = { taskId: string; status: WarmUpTaskStatus; note?: string };
export type AccountSession = { id: string; accountId: string; onboardingDay: number; status: AccountSessionStatus; targetDurationSeconds: number; startedAt: string; activeStartedAt?: string; endedAt?: string; durationSeconds: number; completionReason?: AccountSessionCompletionReason; endingHealthStatus?: HealthStatus; operatorNote?: string; createdAt: string; updatedAt: string };
export type AccountSessionSettings = { targetDurationMinutes: number; autoCloseBrowserAfterTarget: boolean };
export type DailySessionProgress = { dayNumber: number; durationSeconds: number; targetDurationSeconds: number; completed: boolean };
export type ReadyEligibility = { eligible: boolean; requiredDaysCompleted: boolean; healthReady: boolean; proxyReady: boolean; noActiveCheckpoint: boolean };
export type AccountSessionDetail = { account: FacebookAccount; activeSession?: AccountSession; sessions: AccountSession[]; dailyProgress: DailySessionProgress[]; eligibility: ReadyEligibility; settings: AccountSessionSettings; assignedGroups: FacebookGroup[] };
export type AccountSessionStartInput = { accountId: string; targetDurationMinutes?: number };
export type AccountSessionEndInput = { accountId: string; operatorNote?: string };
export type AccountSessionNavigationInput = { accountId: string; destination: 'HOME' | 'NOTIFICATIONS' | 'URL'; url?: string };
export type AccountSessionNavigationResult = { accountId: string; status: 'OPENED' | 'LOGIN_REQUIRED' | 'CHECKPOINT' | 'ERROR'; reason?: string };
export type AccountSessionDashboard = { sessionsToday: number; activeNow: number; minutesToday: number; dailyTargetsCompleted: number; requiringManualAction: number };
export type OnboardingApi = { templates: () => Promise<OnboardingPlanTemplate[]>; overview: () => Promise<OnboardingOverview>; get: (accountId: string) => Promise<AccountOnboarding>; start: (input: OnboardingStartInput) => Promise<AccountOnboarding>; pause: (accountId: string, reason?: string) => Promise<AccountOnboarding>; resume: (accountId: string) => Promise<AccountOnboarding>; markReady: (accountId: string) => Promise<AccountOnboarding>; updateNotes: (accountId: string, notes: string) => Promise<AccountOnboarding>; updateTask: (input: OnboardingTaskUpdateInput) => Promise<WarmUpTask>; setTaskStatus: (input: OnboardingTaskStatusInput) => Promise<WarmUpTask>; startSession: (accountId: string) => Promise<ManualSession>; stopSession: (accountId: string) => Promise<ManualSession>; sessionDetail: (accountId: string) => Promise<AccountSessionDetail>; startAssistedSession: (input: AccountSessionStartInput) => Promise<AccountSessionDetail>; pauseAssistedSession: (accountId: string) => Promise<AccountSessionDetail>; resumeAssistedSession: (accountId: string) => Promise<AccountSessionDetail>; endAssistedSession: (input: AccountSessionEndInput) => Promise<AccountSessionDetail>; navigateSession: (input: AccountSessionNavigationInput) => Promise<AccountSessionNavigationResult>; openSessionGroup: (accountId: string, groupId: string) => Promise<AccountSessionNavigationResult>; updateSessionSettings: (settings: AccountSessionSettings) => Promise<AccountSessionSettings>; stopAllSessions: () => Promise<number>; onChanged: (listener: () => void) => () => void };

export type DeleteAccountInput = {
  accountId: string;
  deleteProfile: boolean;
};

export type AccountApi = {
  list: () => Promise<FacebookAccount[]>;
  create: (input: CreateAccountInput) => Promise<FacebookAccount>;
  update: (input: UpdateAccountInput) => Promise<FacebookAccount>;
  open: (accountId: string) => Promise<FacebookAccount>;
  close: (accountId: string) => Promise<FacebookAccount>;
  healthCheck: (accountId: string) => Promise<HealthCheckResult>;
  delete: (input: DeleteAccountInput) => Promise<void>;
  openProfileFolder: (accountId: string) => Promise<void>;
  operations: () => Promise<AccountOperationsSummary[]>;
  testProxy: (input: ProxyTestInput) => Promise<ProxyTestResult>;
  previewProxyImport: (text: string) => Promise<ProxyImportPreview>;
  onChanged: (listener: (accounts: FacebookAccount[]) => void) => () => void;
};

export type LogApi = {
  list: (filter?: LogFilter) => Promise<AuditLog[]>;
};

export type WindowApi = { accountApi: AccountApi; logApi: LogApi; groupApi: GroupApi; draftApi: DraftApi; campaignApi: CampaignApi; queueApi: QueueApi; dashboardApi: DashboardApi; onboardingApi: OnboardingApi; publishApi: PublishApi; settingsApi: PublishingSettingsApi; operationsApi: OperationsApi };
export type AppBridge = { available: true; version: string };

export type FacebookGroup = {
  id: string;
  name: string;
  url: string;
  normalizedUrl: string;
  facebookGroupId?: string;
  notes?: string;
  tags: string[];
  active: boolean;
  assignedAccountsCount: number;
  createdAt: string;
  updatedAt: string;
};

export type GroupFilter = { search?: string; tag?: string; active?: boolean };
export type GroupInput = { name: string; url: string; notes?: string; tags: string[]; active?: boolean };
export type GroupImportRow = { line: number; name?: string; url: string; normalizedUrl?: string; status: 'VALID' | 'DUPLICATE' | 'INVALID'; reason?: string };
export type GroupImportPreview = { valid: number; duplicates: number; invalid: number; rows: GroupImportRow[] };
export type GroupImportResult = GroupImportPreview & { createdIds: string[] };
export type AssignmentAccount = Pick<FacebookAccount, 'id' | 'name' | 'status' | 'lastHealthStatus'>;
export type GroupOpenResult = { groupId: string; accountId: string; status: 'OPENED' | 'LOGIN_REQUIRED' | 'CHECKPOINT' | 'ERROR'; reason?: string };

export type DraftStatus = 'DRAFT' | 'READY' | 'ARCHIVED';
export type Draft = { id: string; title: string; body: string; linkUrl?: string; status: DraftStatus; media: DraftMedia[]; createdAt: string; updatedAt: string };
export type DraftFilter = { search?: string; status?: DraftStatus };
export type DraftInput = { title: string; body: string; linkUrl?: string };
export type MediaType = 'IMAGE' | 'VIDEO';
export type DraftMedia = { id: string; draftId: string; type: MediaType; originalName: string; mimeType?: string; fileSize: number; sortOrder: number; previewUrl: string; createdAt: string };
export type MediaReorderInput = { draftId: string; mediaIds: string[] };

export type QueueStatus = 'PENDING' | 'PAUSED' | 'RUNNING' | 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'NEEDS_ATTENTION' | 'CANCELLED';
export type PublishAttemptStatus = 'STARTING' | 'COMPOSER_OPENED' | 'CONTENT_FILLED' | 'MEDIA_UPLOADED' | 'SUBMITTING' | 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'NEEDS_ATTENTION';
export type PublishReceiptResult = 'SUBMITTED' | 'SUBMITTED_PENDING_APPROVAL' | 'VERIFIED_PUBLISHED' | 'UNKNOWN';
export type ExecutionMode = 'DRY_RUN' | 'LIVE';
export type SelectorProbeStatus = 'FOUND' | 'MISSING' | 'AMBIGUOUS' | 'NOT_TESTED';
export type ComposerEditorType = 'CONTENTEDITABLE' | 'TEXTAREA' | 'INPUT' | 'UNKNOWN';
export type ComposerEntryMethod = 'FILL' | 'KEYBOARD_INSERT';
export type TriggerCandidateSummary = { strategy?: string; role?: string; tag?: string; ariaLabel?: string; title?: string; text?: string };
export type DialogCandidateSummary = { title?: string; newAfterTrigger?: boolean; changedAfterTrigger?: boolean; visible?: boolean; foreground?: boolean };
export type TextboxCandidateSummary = { strategy?: string; tag?: string; role?: string; contenteditable?: string; ariaLabel?: string; placeholder?: string; ariaMultiline?: string; lexicalEditor?: string; visible?: boolean; boundingBox?: { x: number; y: number; width: number; height: number }; focusable?: boolean; groupId?: number };
export type SelectorProbeField = { status: SelectorProbeStatus; count?: number; enabled?: boolean; reason?: string };
export type SelectorProbeResult = { id?: string; accountId: string; groupId: string; selectorVersion: string; status: SelectorProbeStatus; session: SelectorProbeField; group: SelectorProbeField; composerTrigger: SelectorProbeField; composerTextbox: SelectorProbeField; mediaInput: SelectorProbeField; postButton: SelectorProbeField; uploadBusy: SelectorProbeField; approvalSignal: SelectorProbeField; acceptanceSignal: SelectorProbeField; checkedAt: string; warnings: string[]; reason?: string; editorType?: ComposerEditorType; contentObserved?: boolean; observedContentLength?: number; expectedContentLength?: number; entryMethod?: ComposerEntryMethod; diagnosticPath?: string; triggerStrategy?: string; triggerCandidates?: TriggerCandidateSummary[]; textboxStrategy?: string; textboxCandidates?: TextboxCandidateSummary[]; createPostDialog?: SelectorProbeField; dialogTitle?: string; dialogCandidates?: DialogCandidateSummary[]; rawEditorCount?: number; logicalEditorCount?: number };
export type PreflightResult = SelectorProbeResult & { queueItemId: string; snapshotHash?: string; accountReady: boolean; groupOpened: boolean; composerFound: boolean; textboxFound: boolean; mediaInputFound?: boolean; mediaRequired?: boolean; mediaValidated?: boolean; mediaReport?: MediaPreflightReport; postButtonFound: boolean; passed: boolean; filledContent: boolean };
export type ReconciliationAction = 'MARK_SUBMITTED' | 'MARK_VERIFIED';
export type ReconciliationRecord = { id: string; queueItemId: string; attemptId?: string; action: ReconciliationAction; evidence: string; createdAt: string };
export type PublishAttemptEvent = { id: string; attemptId: string; sequence: number; eventType: string; message?: string; createdAt: string };
export type PublishReceipt = { id: string; queueItemId: string; attemptId: string; result: PublishReceiptResult; groupUrl: string; postUrl?: string; evidence?: string; submittedAt: string; createdAt: string; verificationSource: 'AUTOMATED' | 'OPERATOR'; verificationEvidence?: string; verifiedAt?: string };
export type PublishAttempt = { id: string; queueItemId: string; accountId?: string; groupId?: string; attemptNumber: number; status: PublishAttemptStatus; errorCode?: string; errorMessage?: string; diagnosticAvailable: boolean; startedAt: string; finishedAt?: string; createdAt: string; events: PublishAttemptEvent[]; receipt?: PublishReceipt; irreversibleReached: boolean; executionMode: ExecutionMode; selectorVersion?: string; preflight: boolean };
export type PublishAttemptSummary = Pick<PublishAttempt, 'id' | 'queueItemId' | 'accountId' | 'groupId' | 'attemptNumber' | 'status' | 'errorCode' | 'errorMessage' | 'startedAt' | 'finishedAt' | 'irreversibleReached' | 'executionMode' | 'selectorVersion' | 'preflight'> & { result?: PublishReceiptResult };
export type QueueTarget = { accountId: string; groupId: string };
export type QueueItem = {
  id: string;
  draftId?: string;
  accountId?: string;
  groupId?: string;
  draftTitle: string;
  body: string;
  linkUrl?: string;
  accountName: string;
  groupName: string;
  groupUrl: string;
  status: QueueStatus;
  scheduledAt?: string;
  attentionReason?: string;
  submittedAt?: string;
  completedAt?: string;
  latestAttempt?: PublishAttemptSummary;
  outcome?: QueueOutcomeSummary;
  campaignId?: string;
  campaignVariantId?: string;
  media: Array<Pick<DraftMedia, 'id' | 'type' | 'originalName' | 'mimeType' | 'fileSize' | 'sortOrder' | 'previewUrl'>>;
  createdAt: string;
  updatedAt: string;
};
export type QueueFilter = { search?: string; status?: QueueStatus; accountId?: string; groupId?: string; from?: string; to?: string };
export type QueueOptions = { accounts: AssignmentAccount[]; groupsByAccount: Record<string, FacebookGroup[]> };
export type QueueBatchInput = { draftId: string; targets: QueueTarget[]; scheduledAt?: string };
export type QueueValidationIssue = { target?: QueueTarget; code: string; message: string };
export type QueuePreview = { draft: Pick<Draft, 'id' | 'title' | 'body' | 'linkUrl' | 'media'>; targets: Array<QueueTarget & { accountName: string; groupName: string; groupUrl: string }>; scheduledAt?: string; issues: QueueValidationIssue[]; duplicateTargets: QueueTarget[] };
export type QueueState = { id: string; status: QueueStatus };
export type QueueOutcomeSummary = { finalStatus: QueueStatus; automatedResult?: PublishReceiptResult | 'FAILED'; verificationSource: 'AUTOMATED' | 'OPERATOR' | 'NONE'; reconciliationAction?: ReconciliationAction };
export type QueueBatchAction = 'PAUSE' | 'RESUME' | 'CANCEL';
export type QueueRescheduleMode = 'SET_TIME' | 'SHIFT' | 'CLEAR';
export type QueueBatchActionInput = { queueIds: string[]; action: QueueBatchAction };
export type QueueBatchRescheduleInput = { queueIds: string[]; mode: QueueRescheduleMode; scheduledAt?: string; shiftMinutes?: number };
export type PlannerBucket = 'TODAY' | 'TOMORROW' | 'LATER' | 'UNSCHEDULED';
export type PlannerItem = QueueItem & { bucket: PlannerBucket; accountScheduleConflict: boolean };
export type PlannerSummary = { generatedAt: string; conflictWindowMinutes: number; buckets: Record<PlannerBucket, Array<{ accountId?: string; accountName: string; items: PlannerItem[] }>> };

export type DashboardSummary = {
  accounts: { total: number; ready: number; loginRequired: number; checkpoint: number; error: number };
  groups: { active: number; total: number };
  drafts: { ready: number; total: number };
  queue: { active: number; due: number; cancelled: number };
  publishing: { enabled: boolean; running: number; succeededToday: number; failedToday: number; needsAttention: number };
  today: { scheduled: number; due: number; running: number; submitted: number; succeeded: number; failed: number; needsAttention: number };
  accountStatuses: { ready: number; loginRequired: number; checkpoint: number; blocked: number; unknown: number };
  onboarding: { new: number; warming: number; ready: number; paused: number; todayTasks: number };
  accountSessions: AccountSessionDashboard;
  recentPublishing: PublishingHistoryRow[];
  attention: QueueItem[];
  recentQueue: QueueItem[];
  recentLogs: AuditLog[];
};

export type GroupApi = {
  list: (filter?: GroupFilter) => Promise<FacebookGroup[]>;
  get: (groupId: string) => Promise<FacebookGroup>;
  create: (input: GroupInput) => Promise<FacebookGroup>;
  update: (groupId: string, input: GroupInput) => Promise<FacebookGroup>;
  setActive: (groupId: string, active: boolean) => Promise<FacebookGroup>;
  delete: (groupId: string) => Promise<void>;
  previewImport: (text: string) => Promise<GroupImportPreview>;
  import: (text: string) => Promise<GroupImportResult>;
  assignments: (groupId: string) => Promise<AssignmentAccount[]>;
  replaceAssignments: (groupId: string, accountIds: string[]) => Promise<AssignmentAccount[]>;
  accountGroups: (accountId: string) => Promise<FacebookGroup[]>;
  replaceAccountGroups: (accountId: string, groupIds: string[]) => Promise<FacebookGroup[]>;
  open: (groupId: string, accountId: string) => Promise<GroupOpenResult>;
  operations: () => Promise<GroupOperationsSummary[]>;
  assignmentMatrix: () => Promise<AssignmentMatrix>;
};

export type DraftApi = {
  list: (filter?: DraftFilter) => Promise<Draft[]>;
  get: (draftId: string) => Promise<Draft>;
  create: (input: DraftInput) => Promise<Draft>;
  update: (draftId: string, input: DraftInput) => Promise<Draft>;
  duplicate: (draftId: string) => Promise<Draft>;
  setStatus: (draftId: string, status: DraftStatus) => Promise<Draft>;
  delete: (draftId: string) => Promise<void>;
  addMedia: (draftId: string) => Promise<DraftMedia | undefined>;
  removeMedia: (draftId: string, mediaId: string) => Promise<void>;
  reorderMedia: (input: MediaReorderInput) => Promise<Draft>;
};

export type QueueApi = {
  options: (draftId: string, accountIds: string[]) => Promise<QueueOptions>;
  preview: (input: QueueBatchInput) => Promise<QueuePreview>;
  create: (input: QueueBatchInput) => Promise<QueueItem[]>;
  list: (filter?: QueueFilter) => Promise<QueueItem[]>;
  get: (queueId: string) => Promise<QueueItem>;
  pause: (queueId: string) => Promise<QueueItem>;
  resume: (queueId: string) => Promise<QueueItem>;
  cancel: (queueId: string) => Promise<QueueItem>;
  delete: (queueId: string) => Promise<void>;
  planner: () => Promise<PlannerSummary>;
  batchAction: (input: QueueBatchActionInput) => Promise<QueueItem[]>;
  batchReschedule: (input: QueueBatchRescheduleInput) => Promise<QueueItem[]>;
};

export type DashboardApi = { summary: () => Promise<DashboardSummary> };

export type PublishingSettings = { enabled: boolean; executionMode: ExecutionMode; schedulerIntervalSeconds: number; maxConcurrentAccounts: number; videoUploadTimeoutSeconds: number; maxJobsPerSchedulerSession: number; batchPacingSeconds: number; canaryMode?: boolean; requireReadyAccounts?: boolean };
export type PublishingBlock = { accountId: string; accountName: string; reason: 'LOGIN_REQUIRED' | 'CHECKPOINT'; message: string; blockedAt: string };
export type PublishingRunResult = { requested: number; claimed: number; completed: number; skipped: number };
export type BatchItemIssue = { queueId: string; accountId?: string; accountName?: string; groupName?: string; reasons: string[] };
export type PublishBatchPreview = { requested: number; ready: number; blocked: number; needPreparation?: number; nonRecoverable?: number; canPrepare?: boolean; accountCount: number; groupCount: number; batchPacingSeconds: number; minimumPacingSeconds: number; items: BatchItemIssue[] };
export type PublishBatchSource = 'MANUAL' | 'SCHEDULER';
export type PublishBatchState = 'RUNNING' | 'COOLDOWN' | 'STOPPING' | 'COMPLETED' | 'INTERRUPTED';
export type PublishBatchLane = { accountId: string; accountName: string; total: number; processed: number; state: 'RUNNING' | 'COOLDOWN' | 'BLOCKED' | 'COMPLETED' | 'STOPPED'; currentQueueId?: string; currentGroupName?: string; nextQueueId?: string; nextGroupName?: string; cooldownUntil?: string; remainingSeconds?: number };
export type PublishBatchRuntime = { id: string; source: PublishBatchSource; state: PublishBatchState; requested: number; claimed: number; completed: number; skipped: number; processed: number; startedAt: string; endedAt?: string; reason?: string; current?: { queueId: string; accountId: string; accountName: string; groupName?: string }; next?: { queueId: string; accountId: string; accountName: string; groupName?: string }; lanes: PublishBatchLane[] };
export type PublishingReadiness = 'NOT_READY' | 'PREFLIGHT_READY' | 'LIVE_ENABLED' | 'DEGRADED';
export type LiveReadinessReason = 'ENGINE_DISABLED' | 'NOT_LIVE_MODE' | 'ACCOUNT_BLOCKED' | 'ACCOUNT_LOGIN_REQUIRED' | 'ACCOUNT_CHECKPOINT' | 'GROUP_INACTIVE' | 'ASSIGNMENT_MISSING' | 'PREFLIGHT_MISSING' | 'PREFLIGHT_EXPIRED' | 'PREFLIGHT_SELECTOR_VERSION_MISMATCH' | 'PREFLIGHT_SNAPSHOT_MISMATCH' | 'MEDIA_INVALID';
export type LiveReadiness = { ready: true; preflightId: string } | { ready: false; reasons: LiveReadinessReason[] };
export type SchedulerRuntimeState = 'DISARMED' | 'ARMED' | 'STOPPING';
export type SchedulerStopReason = 'OPERATOR_DISARMED' | 'STOP_AFTER_CURRENT' | 'STOP_DRAIN_TIMEOUT' | 'STOP_DRAIN_FAILED' | 'SESSION_JOB_LIMIT_REACHED' | 'APPLICATION_SHUTDOWN';
export type SchedulerArmPreview = { dueJobs: number; overdueJobs: number; oldestOverdueAt?: string; accountsInvolved: number; groupsInvolved: number; executionMode: ExecutionMode; canaryMode: boolean; sessionLimit: number };
export type PublishingEngineStatus = { settings: PublishingSettings; schedulerRunning: boolean; schedulerArmed: boolean; schedulerState: SchedulerRuntimeState; schedulerReason?: SchedulerStopReason; sessionCompleted: number; sessionLimit: number; armPreview: SchedulerArmPreview; tickRunning: boolean; running: QueueItem[]; blockedAccounts: PublishingBlock[]; recentAttempts: PublishAttemptSummary[]; dueCount: number; overdueCount: number; selectorVersion: string; readiness: PublishingReadiness; recentProbes: SelectorProbeResult[]; batch?: PublishBatchRuntime };
export type RequeueInput = { queueId: string; scheduledAt?: string };

export type PublishApi = {
  status: () => Promise<PublishingEngineStatus>;
  run: (queueId: string) => Promise<PublishingRunResult>;
  runSelected: (queueIds: string[]) => Promise<PublishingRunResult>;
  previewBatch: (queueIds: string[]) => Promise<PublishBatchPreview>;
  prepareBatch: (queueIds: string[]) => Promise<PublishBatchPreview>;
  prepareAndRunBatch: (queueIds: string[]) => Promise<PublishingRunResult>;
  runDue: () => Promise<PublishingRunResult>;
  attempts: (queueId: string) => Promise<PublishAttempt[]>;
  retry: (queueId: string, acknowledgeDuplicateRisk: boolean) => Promise<QueueItem>;
  requeue: (input: RequeueInput) => Promise<QueueItem>;
  resolve: (queueId: string) => Promise<QueueItem>;
  markSubmitted: (queueId: string) => Promise<QueueItem>;
  markVerified: (queueId: string, evidence?: string) => Promise<QueueItem>;
  preflight: (queueId: string) => Promise<PreflightResult>;
  probe: (accountId: string, groupId: string) => Promise<SelectorProbeResult>;
  reconciliations: (queueId: string) => Promise<ReconciliationRecord[]>;
  openDiagnostic: (attemptId: string) => Promise<void>;
  openPreflightDiagnostic: (queueId: string) => Promise<void>;
  deleteDiagnostic: (attemptId: string) => Promise<void>;
  evaluateLiveReadiness: (queueId: string) => Promise<LiveReadiness>;
  armScheduler: (acknowledgeOverdue?: boolean) => Promise<PublishingEngineStatus>;
  disarmScheduler: () => Promise<PublishingEngineStatus>;
  stopPublishing: () => Promise<PublishingEngineStatus>;
  stopAfterCurrent: () => Promise<PublishingEngineStatus>;
  exportReport: () => Promise<string | undefined>;
  onChanged: (listener: () => void) => () => void;
};

export type PublishingSettingsUpdate = PublishingSettings & { confirmLive?: boolean };
export type PublishingSettingsApi = { getPublishing: () => Promise<PublishingSettings>; updatePublishing: (input: PublishingSettingsUpdate) => Promise<PublishingSettings> };

export type OperationalHealthStatus = 'READY' | 'LOGIN_REQUIRED' | 'CHECKPOINT' | 'PROXY_ERROR' | 'BROWSER_ERROR' | 'BLOCKED' | 'UNKNOWN';
export type AccountOperationsSummary = { accountId: string; accountName: string; browser: string; facebookSession: OperationalHealthStatus; publishingBlock?: PublishingBlock; proxyConfigured: boolean; proxyProtocol?: ProxyProtocol; proxyStatus: ProxyStatus; lastProxyTestAt?: string; lastProxyTestIp?: string; lastProxyLatencyMs?: number; lastProxyError?: string; lastSuccessfulPublish?: string; lastFailure?: string; pendingQueue: number; dueQueue: number; needsAttention: number };
export type GroupOperationsSummary = { groupId: string; groupName: string; status: 'ACTIVE' | 'ARCHIVED' | 'NEEDS_ATTENTION'; lastOpened?: string; lastSuccessfulPublish?: string; lastFailedPublish?: string; lastAccountUsed?: string; activeQueueCount: number };
export type AssignmentMatrix = { accounts: Array<{ id: string; name: string }>; groups: Array<{ id: string; name: string }>; assignments: Array<{ accountId: string; groupId: string }> };
export type PublishHistoryFilter = { from?: string; to?: string; accountId?: string; groupId?: string; outcome?: string; verificationSource?: 'AUTOMATED' | 'OPERATOR' | 'NONE'; search?: string };
export type PublishingHistoryRow = { timestamp: string; queueId: string; accountId?: string; groupId?: string; accountName: string; groupName: string; draftTitle: string; automatedResult?: PublishReceiptResult | 'FAILED'; finalStatus: QueueStatus; verificationSource: 'AUTOMATED' | 'OPERATOR' | 'NONE'; reconciliationAction?: ReconciliationAction; errorCode?: string; postUrl?: string };
export type MediaPreparationState = 'VALID' | 'MISSING' | 'INVALID_SIGNATURE' | 'UNSUPPORTED' | 'READY_FOR_UPLOAD' | 'UPLOAD_PENDING';
export type MediaPreflightItem = { id: string; originalName: string; type: MediaType; sortOrder: number; state: MediaPreparationState; managedPath: boolean; signature: boolean; exists: boolean; facebookMediaInput?: 'FOUND' | 'MISSING' | 'NOT_TESTED'; reason?: string };
export type MediaPreflightReport = { count: number; ready: boolean; items: MediaPreflightItem[] };
export type BackupKind = 'MANUAL' | 'MIGRATION' | 'PRE_RESTORE';
export type BackupInfo = { id: string; kind: BackupKind; createdAt: string; size: number; schemaVersion: number };
export type StorageUsage = { database: number; profiles: number; media: number; diagnostics: number; backups: number; calculatedAt: string };
export type OrphanMediaScan = { candidateIds: string[]; candidateCount: number; totalBytes: number; scannedAt: string };
export type AboutInfo = { appName: string; appVersion: string; databaseSchema: number; selectorVersion: string; electronVersion: string; playwrightVersion: string };
export type OperationsApi = { history: (filter?: PublishHistoryFilter) => Promise<PublishingHistoryRow[]>; exportHistoryCsv: (filter?: PublishHistoryFilter) => Promise<string | undefined>; listBackups: () => Promise<BackupInfo[]>; createBackup: () => Promise<BackupInfo>; restoreBackup: (backupId: string) => Promise<void>; storageUsage: () => Promise<StorageUsage>; cleanDiagnostics: () => Promise<number>; scanOrphanMedia: () => Promise<OrphanMediaScan>; cleanOrphanMedia: (candidateIds: string[]) => Promise<number>; about: () => Promise<AboutInfo> };

export type CampaignStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'QUEUED' | 'ARCHIVED';
export type CampaignVariantFreshness = 'CURRENT' | 'STALE' | 'NOT_APPROVED';

export type Campaign = {
  id: string;
  name: string;
  description?: string;
  status: CampaignStatus;
  variantCount: number;
  planItemCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CampaignFilter = {
  search?: string;
  status?: CampaignStatus;
};

export type CampaignInput = {
  name: string;
  description?: string;
};

export type CampaignVariant = {
  id: string;
  campaignId: string;
  draftId: string;
  label: string;
  sortOrder: number;
  enabled: boolean;
  approvedSnapshotHash?: string;
  draftTitle: string;
  draftStatus: DraftStatus;
  freshness: CampaignVariantFreshness;
  createdAt: string;
  updatedAt: string;
};

export type CampaignVariantInput = {
  campaignId: string;
  draftId: string;
  label: string;
  sortOrder?: number;
  enabled?: boolean;
};

export type CampaignVariantUpdateInput = {
  variantId: string;
  label?: string;
  sortOrder?: number;
  enabled?: boolean;
};

export type CampaignPlanItem = {
  id: string;
  campaignId: string;
  variantId: string;
  variantLabel: string;
  draftId: string;
  draftTitle: string;
  accountId: string;
  accountName: string;
  groupId: string;
  groupName: string;
  groupUrl: string;
  scheduledAt?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type CampaignPlanItemInput = {
  campaignId: string;
  variantId: string;
  accountId: string;
  groupId: string;
  scheduledAt?: string;
  sortOrder?: number;
};

export type CampaignDetail = Campaign & {
  variants: CampaignVariant[];
  planItems: CampaignPlanItem[];
  freshness: 'CURRENT' | 'APPROVAL_STALE' | 'NOT_APPROVED';
};

export type CampaignSimulationPlannedRow = {
  variantId: string;
  variantLabel: string;
  draftId: string;
  draftTitle: string;
  accountId: string;
  accountName: string;
  groupId: string;
  groupName: string;
  groupUrl: string;
  scheduledAt?: string;
  snapshotHash: string;
  mediaCount: number;
};

export type CampaignSimulationIssue = {
  code: string;
  message: string;
  target?: { variantId?: string; accountId?: string; groupId?: string };
};

export type CampaignSimulationResult = {
  campaignId: string;
  campaignName: string;
  status: 'READY' | 'WARNING' | 'BLOCKED';
  variantCount: number;
  targetCount: number;
  accountCount: number;
  groupCount: number;
  scheduledCount: number;
  unscheduledCount: number;
  plannedRows: CampaignSimulationPlannedRow[];
  warnings: CampaignSimulationIssue[];
  blockers: CampaignSimulationIssue[];
  freshnessToken: string;
  simulatedAt: string;
};

export type CommitCampaignInput = {
  campaignId: string;
  freshnessToken: string;
};

export type CampaignApi = {
  list: (filter?: CampaignFilter) => Promise<Campaign[]>;
  get: (campaignId: string) => Promise<CampaignDetail>;
  create: (input: CampaignInput) => Promise<Campaign>;
  update: (campaignId: string, input: CampaignInput) => Promise<Campaign>;
  delete: (campaignId: string) => Promise<void>;
  requestReview: (campaignId: string) => Promise<CampaignDetail>;
  requestChanges: (campaignId: string) => Promise<CampaignDetail>;
  approve: (campaignId: string) => Promise<CampaignDetail>;
  archive: (campaignId: string) => Promise<CampaignDetail>;
  addVariant: (input: CampaignVariantInput) => Promise<CampaignVariant>;
  updateVariant: (input: CampaignVariantUpdateInput) => Promise<CampaignVariant>;
  deleteVariant: (variantId: string) => Promise<void>;
  addPlanItem: (input: CampaignPlanItemInput) => Promise<CampaignPlanItem>;
  deletePlanItem: (planItemId: string) => Promise<void>;
  simulate: (campaignId: string) => Promise<CampaignSimulationResult>;
  commitToQueue: (input: CommitCampaignInput) => Promise<QueueItem[]>;
  onChanged: (listener: () => void) => () => void;
};

export type WorkspaceApi = { groupApi: GroupApi; draftApi: DraftApi; campaignApi: CampaignApi; queueApi: QueueApi; dashboardApi: DashboardApi; onboardingApi: OnboardingApi; publishApi: PublishApi; settingsApi: PublishingSettingsApi; operationsApi: OperationsApi };
