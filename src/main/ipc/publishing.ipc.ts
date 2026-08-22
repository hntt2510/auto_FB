import type { PublishingService } from '@main/publishing/PublishingService';
import { BrowserWindow } from 'electron';
import { publishRequeueSchema, publishRetrySchema, publishRunSelectedSchema, queueIdSchema } from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

export function registerPublishingIpc(service: PublishingService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [
    registerAuthorizedHandler('publishing:status', allowedSenderIds, () => service.status()),
    registerAuthorizedHandler('publishing:run', allowedSenderIds, (_event, id: unknown) => service.run(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('publishing:run-selected', allowedSenderIds, (_event, input: unknown) => service.runSelected(parseOrThrow(publishRunSelectedSchema.safeParse(input)).queueIds)),
    registerAuthorizedHandler('publishing:run-due', allowedSenderIds, () => service.runDue()),
    registerAuthorizedHandler('publishing:attempts', allowedSenderIds, (_event, id: unknown) => service.attempts(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('publishing:retry', allowedSenderIds, (_event, input: unknown) => { const value = parseOrThrow(publishRetrySchema.safeParse(input)); return service.retry(value.queueId, value.acknowledgeDuplicateRisk); }),
    registerAuthorizedHandler('publishing:requeue', allowedSenderIds, (_event, input: unknown) => service.requeue(parseOrThrow(publishRequeueSchema.safeParse(input)))),
    registerAuthorizedHandler('publishing:resolve', allowedSenderIds, (_event, id: unknown) => service.resolve(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('publishing:open-diagnostic', allowedSenderIds, (_event, id: unknown) => service.openDiagnostic(parseOrThrow(queueIdSchema.safeParse(id))))
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}

export function broadcastPublishingChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) { try { window.webContents.send('publishing:changed'); } catch { /* renderer may be closing */ } }
}
