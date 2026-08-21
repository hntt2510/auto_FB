import { z } from 'zod';
import type { QueueService } from '@main/services/QueueService';
import { accountIdSchema, queueBatchSchema, queueFilterSchema, queueIdSchema } from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

const optionsSchema = z.object({ draftId: queueIdSchema, accountIds: z.array(accountIdSchema).max(100) });

export function registerQueueIpc(service: QueueService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [
    registerAuthorizedHandler('queue:options', allowedSenderIds, (_event, input: unknown) => { const value = parseOrThrow(optionsSchema.safeParse(input)); return service.options(value.draftId, value.accountIds); }),
    registerAuthorizedHandler('queue:preview', allowedSenderIds, (_event, input: unknown) => service.preview(parseOrThrow(queueBatchSchema.safeParse(input)))),
    registerAuthorizedHandler('queue:create', allowedSenderIds, (_event, input: unknown) => service.create(parseOrThrow(queueBatchSchema.safeParse(input)))),
    registerAuthorizedHandler('queue:list', allowedSenderIds, (_event, filter: unknown) => service.list(parseOrThrow(queueFilterSchema.safeParse(filter ?? {})))),
    registerAuthorizedHandler('queue:get', allowedSenderIds, (_event, id: unknown) => service.get(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('queue:pause', allowedSenderIds, (_event, id: unknown) => service.pause(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('queue:resume', allowedSenderIds, (_event, id: unknown) => service.resume(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('queue:cancel', allowedSenderIds, (_event, id: unknown) => service.cancel(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('queue:delete', allowedSenderIds, (_event, id: unknown) => service.delete(parseOrThrow(queueIdSchema.safeParse(id))))
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
