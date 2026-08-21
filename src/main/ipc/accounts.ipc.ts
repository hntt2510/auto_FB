import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { AppError, toApiError } from '@main/errors';
import type { AccountService } from '@main/services/AccountService';
import { logFilterSchema } from '@shared/schemas';
import type { CreateAccountInput, DeleteAccountInput, UpdateAccountInput } from '@shared/types';
import { isAuthorizedIpcSender } from './senderPolicy';

type Response<T> = { ok: true; data: T } | { ok: false; error: ReturnType<typeof toApiError> };
const success = <T>(data: T): Response<T> => ({ ok: true, data });
const failure = <T>(error: unknown): Response<T> => ({ ok: false, error: toApiError(error) });

async function safely<T>(fn: () => T | Promise<T>): Promise<Response<T>> {
  try { return success(await fn()); } catch (error) { return failure<T>(error); }
}

async function safelyFrom<T>(event: IpcMainInvokeEvent, allowedSenderIds: () => ReadonlySet<number>, fn: () => T | Promise<T>): Promise<Response<T>> {
  return safely(() => {
    if (!isAuthorizedIpcSender(event.sender.id, allowedSenderIds())) throw new AppError('UNAUTHORIZED_IPC', 'Unauthorized renderer.');
    return fn();
  });
}

export function registerIpc(service: AccountService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const channels = ['accounts:list', 'accounts:create', 'accounts:update', 'accounts:open', 'accounts:close', 'accounts:health', 'accounts:delete', 'accounts:open-profile', 'logs:list'] as const;
  ipcMain.handle('accounts:list', (event) => safelyFrom(event, allowedSenderIds, () => service.list()));
  ipcMain.handle('accounts:create', (event, input: CreateAccountInput) => safelyFrom(event, allowedSenderIds, () => service.create(input)));
  ipcMain.handle('accounts:update', (event, input: UpdateAccountInput) => safelyFrom(event, allowedSenderIds, () => service.update(input)));
  ipcMain.handle('accounts:open', (event, id: string) => safelyFrom(event, allowedSenderIds, () => service.open(id)));
  ipcMain.handle('accounts:close', (event, id: string) => safelyFrom(event, allowedSenderIds, () => service.close(id)));
  ipcMain.handle('accounts:health', (event, id: string) => safelyFrom(event, allowedSenderIds, () => service.healthCheck(id)));
  ipcMain.handle('accounts:delete', (event, input: DeleteAccountInput) => safelyFrom(event, allowedSenderIds, () => service.delete(input)));
  ipcMain.handle('accounts:open-profile', (event, id: string) => safelyFrom(event, allowedSenderIds, () => service.openProfileFolder(id)));
  ipcMain.handle('logs:list', (event, filter: unknown) => safelyFrom(event, allowedSenderIds, () => {
    const parsed = logFilterSchema.safeParse(filter ?? {});
    if (!parsed.success) throw new Error('Invalid log filter.');
    return service.logs(parsed.data);
  }));

  return () => { for (const channel of channels) ipcMain.removeHandler(channel); };
}

export function broadcastAccounts(service: AccountService): void {
  const accounts = service.list();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    try { window.webContents.send('accounts:changed', accounts); } catch { /* renderer may be closing */ }
  }
}
