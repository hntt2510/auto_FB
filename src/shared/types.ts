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

export type WindowApi = { accountApi: AccountApi; logApi: LogApi; groupApi: GroupApi; draftApi: DraftApi; queueApi: QueueApi; dashboardApi: DashboardApi };

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

export type QueueStatus = 'PENDING' | 'PAUSED' | 'CANCELLED';
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

export type WorkspaceApi = { groupApi: GroupApi; draftApi: DraftApi; queueApi: QueueApi; dashboardApi: DashboardApi };
