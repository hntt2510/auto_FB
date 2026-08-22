import type { PublishingSettingsService } from '@main/publishing/PublishingSettingsService';
import { publishingSettingsUpdateSchema } from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

export function registerSettingsIpc(service: PublishingSettingsService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [
    registerAuthorizedHandler('settings:get-publishing', allowedSenderIds, () => service.get()),
    registerAuthorizedHandler('settings:update-publishing', allowedSenderIds, (_event, input: unknown) => service.update(parseOrThrow(publishingSettingsUpdateSchema.safeParse(input))))
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
