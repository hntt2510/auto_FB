import { contextBridge, ipcRenderer } from 'electron';
import type { AccountApi, AssignmentAccount, AuditLog, CreateAccountInput, DashboardApi, DashboardSummary, DeleteAccountInput, Draft, DraftApi, DraftFilter, DraftInput, DraftMedia, DraftStatus, FacebookAccount, FacebookGroup, GroupApi, GroupFilter, GroupImportPreview, GroupImportResult, GroupInput, GroupOpenResult, HealthCheckResult, LogApi, LogFilter, MediaReorderInput, QueueApi, QueueBatchInput, QueueFilter, QueueItem, QueueOptions, QueuePreview, UpdateAccountInput } from '@shared/types';

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
  delete: (input: DeleteAccountInput) => invoke<void>('accounts:delete', input),
  openProfileFolder: (accountId: string) => invoke<void>('accounts:open-profile', accountId),
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
  open: (groupId: string, accountId: string) => invoke<GroupOpenResult>('groups:open', { groupId, accountId })
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
  delete: (queueId: string) => invoke<void>('queue:delete', queueId)
};

const dashboardApi: DashboardApi = { summary: () => invoke<DashboardSummary>('dashboard:summary') };

contextBridge.exposeInMainWorld('accountApi', accountApi);
contextBridge.exposeInMainWorld('logApi', logApi);
contextBridge.exposeInMainWorld('groupApi', groupApi);
contextBridge.exposeInMainWorld('draftApi', draftApi);
contextBridge.exposeInMainWorld('queueApi', queueApi);
contextBridge.exposeInMainWorld('dashboardApi', dashboardApi);
