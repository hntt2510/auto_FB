import { BrowserWindow } from 'electron';
import type { AccountService } from '@main/services/AccountService';
import { accountIdSchema, createAccountSchema, deleteAccountSchema, logFilterSchema, proxyImportSchema, proxyTestSchema, updateAccountSchema } from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

export function registerIpc(service: AccountService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [
    registerAuthorizedHandler('accounts:list', allowedSenderIds, () => service.list()),
    registerAuthorizedHandler('accounts:operations', allowedSenderIds, () => service.operations()),
    registerAuthorizedHandler('accounts:create', allowedSenderIds, (_event, input: unknown) => service.create(parseOrThrow(createAccountSchema.safeParse(input)))),
    registerAuthorizedHandler('accounts:update', allowedSenderIds, (_event, input: unknown) => service.update(parseOrThrow(updateAccountSchema.safeParse(input)))),
    registerAuthorizedHandler('accounts:open', allowedSenderIds, (_event, id: unknown) => service.open(parseOrThrow(accountIdSchema.safeParse(id)))),
    registerAuthorizedHandler('accounts:close', allowedSenderIds, (_event, id: unknown) => service.close(parseOrThrow(accountIdSchema.safeParse(id)))),
    registerAuthorizedHandler('accounts:health', allowedSenderIds, (_event, id: unknown) => service.healthCheck(parseOrThrow(accountIdSchema.safeParse(id)))),
    registerAuthorizedHandler('accounts:test-proxy', allowedSenderIds, (_event, input: unknown) => service.testProxy(parseOrThrow(proxyTestSchema.safeParse(input)))),
    registerAuthorizedHandler('accounts:proxy-import-preview', allowedSenderIds, (_event, input: unknown) => service.previewProxyImport(parseOrThrow(proxyImportSchema.safeParse(input)).text)),
    registerAuthorizedHandler('accounts:delete', allowedSenderIds, (_event, input: unknown) => service.delete(parseOrThrow(deleteAccountSchema.safeParse(input)))),
    registerAuthorizedHandler('accounts:open-profile', allowedSenderIds, (_event, id: unknown) => service.openProfileFolder(parseOrThrow(accountIdSchema.safeParse(id)))),
    registerAuthorizedHandler('logs:list', allowedSenderIds, (_event, filter: unknown) => service.logs(parseOrThrow(logFilterSchema.safeParse(filter ?? {}))))
  ];

  return () => { for (const cleanup of cleanups) cleanup(); };
}

export function broadcastAccounts(service: AccountService): void {
  const accounts = service.list();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    try { window.webContents.send('accounts:changed', accounts); } catch { /* renderer may be closing */ }
  }
}
