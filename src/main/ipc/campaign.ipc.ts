import { z } from 'zod';
import type { CampaignService } from '@main/services/CampaignService';
import {
  campaignFilterSchema,
  campaignIdSchema,
  campaignInputSchema,
  campaignPlanItemIdSchema,
  campaignPlanItemInputSchema,
  campaignVariantIdSchema,
  campaignVariantInputSchema,
  campaignVariantUpdateSchema,
  commitCampaignSchema
} from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

const campaignUpdatePayloadSchema = z.object({
  campaignId: campaignIdSchema,
  name: campaignInputSchema.shape.name,
  description: campaignInputSchema.shape.description
});

export function registerCampaignIpc(service: CampaignService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [
    registerAuthorizedHandler('campaigns:list', allowedSenderIds, (_event, filter: unknown) =>
      service.list(parseOrThrow(campaignFilterSchema.safeParse(filter ?? {})))
    ),
    registerAuthorizedHandler('campaigns:get', allowedSenderIds, (_event, id: unknown) =>
      service.get(parseOrThrow(campaignIdSchema.safeParse(id)))
    ),
    registerAuthorizedHandler('campaigns:create', allowedSenderIds, (_event, input: unknown) =>
      service.create(parseOrThrow(campaignInputSchema.safeParse(input)))
    ),
    registerAuthorizedHandler('campaigns:update', allowedSenderIds, (_event, input: unknown) => {
      const parsed = parseOrThrow(campaignUpdatePayloadSchema.safeParse(input));
      return service.update(parsed.campaignId, { name: parsed.name, description: parsed.description });
    }),
    registerAuthorizedHandler('campaigns:delete', allowedSenderIds, (_event, id: unknown) =>
      service.delete(parseOrThrow(campaignIdSchema.safeParse(id)))
    ),
    registerAuthorizedHandler('campaigns:request-review', allowedSenderIds, (_event, id: unknown) =>
      service.requestReview(parseOrThrow(campaignIdSchema.safeParse(id)))
    ),
    registerAuthorizedHandler('campaigns:request-changes', allowedSenderIds, (_event, id: unknown) =>
      service.requestChanges(parseOrThrow(campaignIdSchema.safeParse(id)))
    ),
    registerAuthorizedHandler('campaigns:approve', allowedSenderIds, (_event, id: unknown) =>
      service.approve(parseOrThrow(campaignIdSchema.safeParse(id)))
    ),
    registerAuthorizedHandler('campaigns:archive', allowedSenderIds, (_event, id: unknown) =>
      service.archive(parseOrThrow(campaignIdSchema.safeParse(id)))
    ),
    registerAuthorizedHandler('campaigns:add-variant', allowedSenderIds, (_event, input: unknown) =>
      service.addVariant(parseOrThrow(campaignVariantInputSchema.safeParse(input)))
    ),
    registerAuthorizedHandler('campaigns:update-variant', allowedSenderIds, (_event, input: unknown) =>
      service.updateVariant(parseOrThrow(campaignVariantUpdateSchema.safeParse(input)))
    ),
    registerAuthorizedHandler('campaigns:delete-variant', allowedSenderIds, (_event, id: unknown) =>
      service.deleteVariant(parseOrThrow(campaignVariantIdSchema.safeParse(id)))
    ),
    registerAuthorizedHandler('campaigns:add-plan-item', allowedSenderIds, (_event, input: unknown) =>
      service.addPlanItem(parseOrThrow(campaignPlanItemInputSchema.safeParse(input)))
    ),
    registerAuthorizedHandler('campaigns:delete-plan-item', allowedSenderIds, (_event, id: unknown) =>
      service.deletePlanItem(parseOrThrow(campaignPlanItemIdSchema.safeParse(id)))
    ),
    registerAuthorizedHandler('campaigns:simulate', allowedSenderIds, (_event, id: unknown) =>
      service.simulate(parseOrThrow(campaignIdSchema.safeParse(id)))
    ),
    registerAuthorizedHandler('campaigns:commit-queue', allowedSenderIds, (_event, input: unknown) =>
      service.commitToQueue(parseOrThrow(commitCampaignSchema.safeParse(input)))
    )
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
