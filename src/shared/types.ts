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

export type FacebookAccount = {
  id: string;
  name: string;
  profileName: string;
  profileDirectory: string;
  proxyEnabled: boolean;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPasswordKey?: string;
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
  | 'ENTITY_IN_USE'
  | 'INVALID_STATE'
  | 'PUBLISH_CLAIM_CONFLICT'
  | 'PUBLISH_ENGINE_DISABLED'
  | 'ACCOUNT_LOGIN_REQUIRED'
  | 'ACCOUNT_CHECKPOINT'
  | 'GROUP_UNAVAILABLE'
  | 'GROUP_PERMISSION_DENIED'
  | 'COMPOSER_NOT_FOUND'
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
  | 'LIVE_READINESS_FAILED'
  | 'PREFLIGHT_REQUIRED'
  | 'PREFLIGHT_EXPIRED'
  | 'SCHEDULER_DISARMED'
  | 'OVERDUE_BACKLOG_ACK_REQUIRED'
  | 'PUBLISHING_STOPPED'
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
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
};

export type UpdateAccountInput = {
  accountId: string;
  name: string;
  proxyEnabled: boolean;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  clearProxyPassword?: boolean;
};

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
  onChanged: (listener: (accounts: FacebookAccount[]) => void) => () => void;
};

export type LogApi = {
  list: (filter?: LogFilter) => Promise<AuditLog[]>;
};

export type WindowApi = { accountApi: AccountApi; logApi: LogApi; groupApi: GroupApi; draftApi: DraftApi; queueApi: QueueApi; dashboardApi: DashboardApi; publishApi: PublishApi; settingsApi: PublishingSettingsApi };

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
export type SelectorProbeField = { status: SelectorProbeStatus; count?: number; reason?: string };
export type SelectorProbeResult = { id?: string; accountId: string; groupId: string; selectorVersion: string; status: SelectorProbeStatus; session: SelectorProbeField; group: SelectorProbeField; composerTrigger: SelectorProbeField; composerTextbox: SelectorProbeField; mediaInput: SelectorProbeField; postButton: SelectorProbeField; uploadBusy: SelectorProbeField; approvalSignal: SelectorProbeField; acceptanceSignal: SelectorProbeField; checkedAt: string; warnings: string[] };
export type PreflightResult = SelectorProbeResult & { queueItemId: string; snapshotHash?: string; accountReady: boolean; groupOpened: boolean; composerFound: boolean; textboxFound: boolean; mediaInputFound?: boolean; mediaRequired?: boolean; mediaValidated?: boolean; postButtonFound: boolean; passed: boolean; filledContent: boolean };
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

export type DashboardSummary = {
  accounts: { total: number; ready: number; loginRequired: number; checkpoint: number; error: number };
  groups: { active: number; total: number };
  drafts: { ready: number; total: number };
  queue: { active: number; due: number; cancelled: number };
  publishing: { enabled: boolean; running: number; succeededToday: number; failedToday: number; needsAttention: number };
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
};

export type DashboardApi = { summary: () => Promise<DashboardSummary> };

export type PublishingSettings = { enabled: boolean; executionMode: ExecutionMode; schedulerIntervalSeconds: number; maxConcurrentAccounts: number; videoUploadTimeoutSeconds: number; canaryMode?: boolean };
export type PublishingBlock = { accountId: string; accountName: string; reason: 'LOGIN_REQUIRED' | 'CHECKPOINT'; message: string; blockedAt: string };
export type PublishingRunResult = { requested: number; claimed: number; completed: number; skipped: number };
export type PublishingReadiness = 'NOT_READY' | 'PREFLIGHT_READY' | 'LIVE_ENABLED' | 'DEGRADED';
export type LiveReadinessReason = 'ENGINE_DISABLED' | 'NOT_LIVE_MODE' | 'ACCOUNT_BLOCKED' | 'ACCOUNT_LOGIN_REQUIRED' | 'ACCOUNT_CHECKPOINT' | 'GROUP_INACTIVE' | 'ASSIGNMENT_MISSING' | 'PREFLIGHT_MISSING' | 'PREFLIGHT_EXPIRED' | 'PREFLIGHT_SELECTOR_VERSION_MISMATCH' | 'PREFLIGHT_SNAPSHOT_MISMATCH' | 'MEDIA_INVALID';
export type LiveReadiness = { ready: true; preflightId: string } | { ready: false; reasons: LiveReadinessReason[] };
export type PublishingEngineStatus = { settings: PublishingSettings; schedulerRunning: boolean; schedulerArmed: boolean; tickRunning: boolean; running: QueueItem[]; blockedAccounts: PublishingBlock[]; recentAttempts: PublishAttemptSummary[]; dueCount: number; overdueCount: number; selectorVersion: string; readiness: PublishingReadiness; recentProbes: SelectorProbeResult[] };
export type RequeueInput = { queueId: string; scheduledAt?: string };

export type PublishApi = {
  status: () => Promise<PublishingEngineStatus>;
  run: (queueId: string) => Promise<PublishingRunResult>;
  runSelected: (queueIds: string[]) => Promise<PublishingRunResult>;
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
  deleteDiagnostic: (attemptId: string) => Promise<void>;
  evaluateLiveReadiness: (queueId: string) => Promise<LiveReadiness>;
  armScheduler: (acknowledgeOverdue?: boolean) => Promise<PublishingEngineStatus>;
  disarmScheduler: () => Promise<PublishingEngineStatus>;
  stopPublishing: () => Promise<PublishingEngineStatus>;
  exportReport: () => Promise<string | undefined>;
  onChanged: (listener: () => void) => () => void;
};

export type PublishingSettingsUpdate = PublishingSettings & { confirmLive?: boolean };
export type PublishingSettingsApi = { getPublishing: () => Promise<PublishingSettings>; updatePublishing: (input: PublishingSettingsUpdate) => Promise<PublishingSettings> };

export type WorkspaceApi = { groupApi: GroupApi; draftApi: DraftApi; queueApi: QueueApi; dashboardApi: DashboardApi; publishApi: PublishApi; settingsApi: PublishingSettingsApi };
