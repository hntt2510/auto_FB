import { ipcMain, webContents } from 'electron';
import { toApiError } from '@main/errors';
import type { AccountService } from '@main/services/AccountService';
import { logFilterSchema } from '@shared/schemas';
import type { CreateAccountInput, DeleteAccountInput, UpdateAccountInput } from '@shared/types';

type Response<T> = { ok: true; data: T } | { ok: false; error: ReturnType<typeof toApiError> };
const success = <T>(data: T): Response<T> => ({ ok: true, data });
const failure = <T>(error: unknown): Response<T> => ({ ok: false, error: toApiError(error) });

async function safely<T>(fn: () => T | Promise<T>): Promise<Response<T>> {
  try { return success(await fn()); } catch (error) { return failure<T>(error); }
}

export function registerIpc(service: AccountService): () => void {
  const channels = ['accounts:list', 'accounts:create', 'accounts:update', 'accounts:open', 'accounts:close', 'accounts:health', 'accounts:delete', 'accounts:open-profile', 'logs:list'] as const;
  ipcMain.handle('accounts:list', () => safely(() => service.list()));
  ipcMain.handle('accounts:create', (_event, input: CreateAccountInput) => safely(() => service.create(input)));
  ipcMain.handle('accounts:update', (_event, input: UpdateAccountInput) => safely(() => service.update(input)));
  ipcMain.handle('accounts:open', (_event, id: string) => safely(() => service.open(id)));
  ipcMain.handle('accounts:close', (_event, id: string) => safely(() => service.close(id)));
  ipcMain.handle('accounts:health', (_event, id: string) => safely(() => service.healthCheck(id)));
  ipcMain.handle('accounts:delete', (_event, input: DeleteAccountInput) => safely(() => service.delete(input)));
  ipcMain.handle('accounts:open-profile', (_event, id: string) => safely(() => service.openProfileFolder(id)));
  ipcMain.handle('logs:list', (_event, filter: unknown) => safely(() => {
    const parsed = logFilterSchema.safeParse(filter ?? {});
    if (!parsed.success) throw new Error('Invalid log filter.');
    return service.logs(parsed.data);
  }));

  return () => { for (const channel of channels) ipcMain.removeHandler(channel); };
}

export function broadcastAccounts(service: AccountService): void {
  const accounts = service.list();
  for (const contents of webContents.getAllWebContents()) contents.send('accounts:changed', accounts);
}
