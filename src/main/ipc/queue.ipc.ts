import { z } from 'zod';
import type { QueueService } from '@main/services/QueueService';
import { accountIdSchema, draftIdSchema, queueBatchActionSchema, queueBatchRescheduleSchema, queueBatchSchema, queueFilterSchema, queueIdSchema } from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

export const queueOptionsSchema = z.object({ draftId: draftIdSchema, accountIds: z.array(accountIdSchema).max(100) });

export function registerQueueIpc(service: QueueService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [
    registerAuthorizedHandler('queue:options', allowedSenderIds, (_event, input: unknown) => { const value = parseOrThrow(queueOptionsSchema.safeParse(input)); return service.options(value.draftId, value.accountIds); }),
    registerAuthorizedHandler('queue:preview', allowedSenderIds, (_event, input: unknown) => service.preview(parseOrThrow(queueBatchSchema.safeParse(input)))),
    registerAuthorizedHandler('queue:create', allowedSenderIds, (_event, input: unknown) => service.create(parseOrThrow(queueBatchSchema.safeParse(input)))),
    registerAuthorizedHandler('queue:list', allowedSenderIds, (_event, filter: unknown) => service.list(parseOrThrow(queueFilterSchema.safeParse(filter ?? {})))),
    registerAuthorizedHandler('queue:get', allowedSenderIds, (_event, id: unknown) => service.get(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('queue:pause', allowedSenderIds, (_event, id: unknown) => service.pause(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('queue:resume', allowedSenderIds, (_event, id: unknown) => service.resume(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('queue:cancel', allowedSenderIds, (_event, id: unknown) => service.cancel(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('queue:delete', allowedSenderIds, (_event, id: unknown) => service.delete(parseOrThrow(queueIdSchema.safeParse(id)))),
    registerAuthorizedHandler('queue:planner', allowedSenderIds, () => service.planner()),
    registerAuthorizedHandler('queue:batch-action', allowedSenderIds, (_event, input: unknown) => service.batchAction(parseOrThrow(queueBatchActionSchema.safeParse(input)))),
    registerAuthorizedHandler('queue:batch-reschedule', allowedSenderIds, (_event, input: unknown) => service.batchReschedule(parseOrThrow(queueBatchRescheduleSchema.safeParse(input))))
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
