import { contextBridge, ipcRenderer } from 'electron';
import type { AccountApi, AuditLog, CreateAccountInput, DeleteAccountInput, FacebookAccount, HealthCheckResult, LogApi, LogFilter, UpdateAccountInput } from '@shared/types';

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

contextBridge.exposeInMainWorld('accountApi', accountApi);
contextBridge.exposeInMainWorld('logApi', logApi);
