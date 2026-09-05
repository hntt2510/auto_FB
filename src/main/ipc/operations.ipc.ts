import type { OperationsService } from '@main/services/OperationsService';
import { backupIdSchema, orphanCleanupSchema, publishHistoryFilterSchema } from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

export function registerOperationsIpc(service: OperationsService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [
    registerAuthorizedHandler('operations:history', allowedSenderIds, (_event, filter: unknown) => service.history(parseOrThrow(publishHistoryFilterSchema.safeParse(filter ?? {})))),
    registerAuthorizedHandler('operations:export-history', allowedSenderIds, (_event, filter: unknown) => service.exportHistoryCsv(parseOrThrow(publishHistoryFilterSchema.safeParse(filter ?? {})))),
    registerAuthorizedHandler('operations:list-backups', allowedSenderIds, () => service.listBackups()),
    registerAuthorizedHandler('operations:create-backup', allowedSenderIds, () => service.createBackup()),
    registerAuthorizedHandler('operations:restore-backup', allowedSenderIds, (_event, id: unknown) => service.restoreBackup(parseOrThrow(backupIdSchema.safeParse(id)))),
    registerAuthorizedHandler('operations:storage', allowedSenderIds, () => service.storageUsage()),
    registerAuthorizedHandler('operations:clean-diagnostics', allowedSenderIds, () => service.cleanDiagnostics()),
    registerAuthorizedHandler('operations:scan-orphan-media', allowedSenderIds, () => service.scanOrphanMedia()),
    registerAuthorizedHandler('operations:clean-orphan-media', allowedSenderIds, (_event, input: unknown) => service.cleanOrphanMedia(parseOrThrow(orphanCleanupSchema.safeParse(input)).candidateIds)),
    registerAuthorizedHandler('operations:about', allowedSenderIds, () => service.about()),
    registerAuthorizedHandler('operations:integrity-check', allowedSenderIds, () => service.integrityCheck())
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
