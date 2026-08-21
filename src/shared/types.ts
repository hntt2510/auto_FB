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

export type WindowApi = { accountApi: AccountApi; logApi: LogApi };
