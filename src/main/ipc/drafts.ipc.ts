import type { DraftService } from '@main/services/DraftService';
import { draftFilterSchema, draftIdSchema, draftInputSchema, draftStatusSchema, mediaRemoveSchema, mediaReorderSchema } from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

export function registerDraftIpc(service: DraftService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [
    registerAuthorizedHandler('drafts:list', allowedSenderIds, (_event, filter: unknown) => service.list(parseOrThrow(draftFilterSchema.safeParse(filter ?? {})))),
    registerAuthorizedHandler('drafts:get', allowedSenderIds, (_event, id: unknown) => service.get(parseOrThrow(draftIdSchema.safeParse(id)))),
    registerAuthorizedHandler('drafts:create', allowedSenderIds, (_event, input: unknown) => service.create(parseOrThrow(draftInputSchema.safeParse(input)))),
    registerAuthorizedHandler('drafts:update', allowedSenderIds, (_event, id: unknown, input: unknown) => service.update(parseOrThrow(draftIdSchema.safeParse(id)), parseOrThrow(draftInputSchema.safeParse(input)))),
    registerAuthorizedHandler('drafts:duplicate', allowedSenderIds, (_event, id: unknown) => service.duplicate(parseOrThrow(draftIdSchema.safeParse(id)))),
    registerAuthorizedHandler('drafts:status', allowedSenderIds, (_event, input: unknown) => { const value = parseOrThrow(draftStatusSchema.safeParse(input)); return service.setStatus(value.draftId, value.status); }),
    registerAuthorizedHandler('drafts:delete', allowedSenderIds, (_event, id: unknown) => service.delete(parseOrThrow(draftIdSchema.safeParse(id)))),
    registerAuthorizedHandler('drafts:add-media', allowedSenderIds, (_event, id: unknown) => service.addMedia(parseOrThrow(draftIdSchema.safeParse(id)))),
    registerAuthorizedHandler('drafts:remove-media', allowedSenderIds, (_event, input: unknown) => { const value = parseOrThrow(mediaRemoveSchema.safeParse(input)); return service.removeMedia(value.draftId, value.mediaId); }),
    registerAuthorizedHandler('drafts:reorder-media', allowedSenderIds, (_event, input: unknown) => service.reorderMedia(parseOrThrow(mediaReorderSchema.safeParse(input))))
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
