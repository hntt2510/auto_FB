import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { CampaignRepository } from '@main/db/repositories/CampaignRepository';
import type { DraftRecord, DraftRepository } from '@main/db/repositories/DraftRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import type { QueueInsert, QueueRepository } from '@main/db/repositories/QueueRepository';
import { AppError } from '@main/errors';
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
import type {
  Campaign,
  CampaignDetail,
  CampaignFilter,
  CampaignInput,
  CampaignPlanItem,
  CampaignPlanItemInput,
  CampaignSimulationIssue,
  CampaignSimulationPlannedRow,
  CampaignSimulationResult,
  CampaignVariant,
  CampaignVariantInput,
  CampaignVariantUpdateInput,
  CommitCampaignInput,
  QueueItem
} from '@shared/types';
import { buildSnapshotHash } from './QueueService';

export class CampaignService {
  constructor(
    private readonly db: Database.Database,
    private readonly campaigns: CampaignRepository,
    private readonly drafts: DraftRepository,
    private readonly accounts: AccountRepository,
    private readonly groups: GroupRepository,
    private readonly queue: QueueRepository,
    private readonly audit: AuditLogRepository,
    private readonly notify: () => void
  ) {}

  list(filter?: CampaignFilter): Campaign[] {
    const parsed = campaignFilterSchema.safeParse(filter ?? {});
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid campaign filter.');
    return this.campaigns.list(parsed.data);
  }

  get(id: string): CampaignDetail {
    const validId = this.requireId(id);
    const hashes = this.getCurrentDraftHashesForCampaign(validId);
    const campaign = this.campaigns.getDetail(validId, hashes);
    if (!campaign) throw new AppError('CAMPAIGN_NOT_FOUND', 'Campaign not found.');
    return campaign;
  }

  create(input: CampaignInput): Campaign {
    const parsed = campaignInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid campaign input.');

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const created = this.campaigns.insert(id, parsed.data, timestamp);

    this.auditSafe('CAMPAIGN_CREATED', `Campaign ${created.name} created.`, JSON.stringify({ campaignId: created.id }));
    this.notifySafe();
    return created;
  }

  update(id: string, input: CampaignInput): Campaign {
    const validId = this.requireId(id);
    const parsed = campaignInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid campaign input.');

    const current = this.requireCampaign(validId);
    if (current.status === 'QUEUED') {
      throw new AppError('INVALID_STATE', 'Queued campaigns cannot be modified.');
    }

    const updated = this.campaigns.update(validId, parsed.data);
    this.auditSafe('CAMPAIGN_UPDATED', `Campaign ${updated.name} updated.`, JSON.stringify({ campaignId: updated.id }));
    this.notifySafe();
    return updated;
  }

  delete(id: string): void {
    const validId = this.requireId(id);
    const current = this.requireCampaign(validId);

    if (current.status === 'QUEUED') {
      throw new AppError('INVALID_STATE', 'Queued campaigns cannot be deleted.');
    }
    if (current.status !== 'DRAFT') {
      throw new AppError('INVALID_STATE', `Campaign in status ${current.status} cannot be deleted. Must be DRAFT.`);
    }
    if (this.campaigns.hasQueueItems(validId)) {
      throw new AppError('ENTITY_IN_USE', 'Campaign has queue items and cannot be deleted.');
    }

    this.campaigns.delete(validId);
    this.auditSafe('CAMPAIGN_DELETED', `Campaign ${current.name} deleted.`, JSON.stringify({ campaignId: validId }));
    this.notifySafe();
  }

  // Lifecycle Transitions
  requestReview(id: string): CampaignDetail {
    const validId = this.requireId(id);
    const campaign = this.get(validId);

    if (campaign.status !== 'DRAFT') {
      throw new AppError('INVALID_STATE', `Campaign cannot enter review from status ${campaign.status}.`);
    }

    this.assertEligibleForReviewOrApproval(campaign);

    this.campaigns.setStatus(validId, 'IN_REVIEW');
    this.auditSafe('CAMPAIGN_IN_REVIEW', `Campaign ${campaign.name} submitted for review.`, JSON.stringify({ campaignId: validId }));
    this.notifySafe();
    return this.get(validId);
  }

  requestChanges(id: string): CampaignDetail {
    const validId = this.requireId(id);
    const campaign = this.get(validId);

    if (campaign.status !== 'IN_REVIEW' && campaign.status !== 'APPROVED') {
      throw new AppError('INVALID_STATE', `Cannot request changes for campaign in status ${campaign.status}. Must be IN_REVIEW or APPROVED.`);
    }

    this.campaigns.clearVariantApprovalHashes(validId);
    this.campaigns.setStatus(validId, 'DRAFT');
    const auditAction = campaign.status === 'APPROVED' ? 'CAMPAIGN_REOPENED_FOR_CHANGES' : 'CAMPAIGN_CHANGES_REQUESTED';
    const auditMsg = campaign.status === 'APPROVED' ? `Campaign ${campaign.name} reopened for changes.` : `Changes requested for campaign ${campaign.name}.`;
    this.auditSafe(auditAction, auditMsg, JSON.stringify({ campaignId: validId, previousStatus: campaign.status }));
    this.notifySafe();
    return this.get(validId);
  }

  approve(id: string): CampaignDetail {
    const validId = this.requireId(id);
    const campaign = this.get(validId);

    if (campaign.status !== 'IN_REVIEW') {
      throw new AppError('INVALID_STATE', `Campaign must be IN_REVIEW to be approved. Current status: ${campaign.status}.`);
    }

    this.assertEligibleForReviewOrApproval(campaign);

    // Compute and snapshot hash for every enabled variant
    const hashes = new Map<string, string>();
    for (const variant of campaign.variants.filter((v) => v.enabled)) {
      const draft = this.drafts.get(variant.draftId);
      if (!draft) throw new AppError('DRAFT_NOT_FOUND', `Draft for variant "${variant.label}" not found.`);
      hashes.set(variant.id, buildSnapshotHash(draft));
    }

    this.campaigns.setVariantApprovalHashes(validId, hashes);
    this.campaigns.setStatus(validId, 'APPROVED');

    this.auditSafe('CAMPAIGN_APPROVED', `Campaign ${campaign.name} approved.`, JSON.stringify({ campaignId: validId, variantCount: hashes.size }));
    this.notifySafe();
    return this.get(validId);
  }

  archive(id: string): CampaignDetail {
    const validId = this.requireId(id);
    const campaign = this.get(validId);

    if (campaign.status === 'QUEUED') {
      throw new AppError('INVALID_STATE', 'Queued campaigns cannot be archived.');
    }
    if (campaign.status === 'ARCHIVED') {
      return campaign;
    }

    this.campaigns.setStatus(validId, 'ARCHIVED');
    this.auditSafe('CAMPAIGN_ARCHIVED', `Campaign ${campaign.name} archived.`, JSON.stringify({ campaignId: validId }));
    this.notifySafe();
    return this.get(validId);
  }

  // Variants
  addVariant(input: CampaignVariantInput): CampaignVariant {
    const parsed = campaignVariantInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid variant input.');

    const campaign = this.requireCampaign(parsed.data.campaignId);
    if (campaign.status !== 'DRAFT') {
      throw new AppError('INVALID_STATE', 'Variants can only be added when campaign is in DRAFT status.');
    }

    const draft = this.drafts.get(parsed.data.draftId);
    if (!draft) throw new AppError('DRAFT_NOT_FOUND', 'Referenced draft not found.');

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const created = this.campaigns.addVariant(id, parsed.data, timestamp);

    this.auditSafe('CAMPAIGN_VARIANT_ADDED', `Variant ${created.label} added to campaign ${campaign.name}.`, JSON.stringify({ campaignId: campaign.id, variantId: created.id }));
    this.notifySafe();
    return created;
  }

  updateVariant(input: CampaignVariantUpdateInput): CampaignVariant {
    const parsed = campaignVariantUpdateSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid variant update.');

    const current = this.campaigns.getVariant(parsed.data.variantId);
    if (!current) throw new AppError('VARIANT_NOT_FOUND', 'Variant not found.');

    const campaign = this.requireCampaign(current.campaignId);
    if (campaign.status !== 'DRAFT') {
      throw new AppError('INVALID_STATE', 'Variants can only be modified when campaign is in DRAFT status.');
    }

    const updated = this.campaigns.updateVariant(parsed.data.variantId, parsed.data);
    this.auditSafe('CAMPAIGN_VARIANT_UPDATED', `Variant ${updated.label} updated in campaign ${campaign.name}.`, JSON.stringify({ campaignId: campaign.id, variantId: updated.id }));
    this.notifySafe();
    return updated;
  }

  deleteVariant(variantId: string): void {
    const validId = this.requireVariantId(variantId);
    const current = this.campaigns.getVariant(validId);
    if (!current) throw new AppError('VARIANT_NOT_FOUND', 'Variant not found.');

    const campaign = this.requireCampaign(current.campaignId);
    if (campaign.status !== 'DRAFT') {
      throw new AppError('INVALID_STATE', 'Variants can only be deleted when campaign is in DRAFT status.');
    }

    this.campaigns.deleteVariant(validId);
    this.auditSafe('CAMPAIGN_VARIANT_DELETED', `Variant ${current.label} removed from campaign ${campaign.name}.`, JSON.stringify({ campaignId: campaign.id, variantId: validId }));
    this.notifySafe();
  }

  // Plan Items
  addPlanItem(input: CampaignPlanItemInput): CampaignPlanItem {
    const parsed = campaignPlanItemInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid plan item input.');

    const campaign = this.requireCampaign(parsed.data.campaignId);
    if (campaign.status !== 'DRAFT') {
      throw new AppError('INVALID_STATE', 'Plan items can only be added when campaign is in DRAFT status.');
    }

    const variant = this.campaigns.getVariant(parsed.data.variantId);
    if (!variant || variant.campaignId !== campaign.id) {
      throw new AppError('VARIANT_NOT_FOUND', 'Variant does not belong to this campaign.');
    }
    if (!variant.enabled) {
      throw new AppError('INVALID_STATE', 'Cannot target a disabled variant.');
    }

    const account = this.accounts.get(parsed.data.accountId);
    if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 'Target account not found.');

    const group = this.groups.get(parsed.data.groupId);
    if (!group) throw new AppError('GROUP_NOT_FOUND', 'Target group not found.');
    if (!group.active) throw new AppError('GROUP_INACTIVE', 'Target group is inactive/archived.');

    const isAssigned = this.groups.assignments(group.id).some((a) => a.id === account.id);
    if (!isAssigned) {
      throw new AppError('INVALID_ASSIGNMENT', 'Account is not assigned to the specified group.');
    }

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const created = this.campaigns.addPlanItem(id, parsed.data, timestamp);

    this.auditSafe('CAMPAIGN_PLAN_ITEM_ADDED', `Target added to campaign ${campaign.name}.`, JSON.stringify({ campaignId: campaign.id, planItemId: created.id }));
    this.notifySafe();
    return created;
  }

  deletePlanItem(planItemId: string): void {
    const validId = this.requirePlanItemId(planItemId);
    const current = this.campaigns.getPlanItem(validId);
    if (!current) throw new AppError('PLAN_ITEM_NOT_FOUND', 'Plan item not found.');

    const campaign = this.requireCampaign(current.campaignId);
    if (campaign.status !== 'DRAFT') {
      throw new AppError('INVALID_STATE', 'Plan items can only be removed when campaign is in DRAFT status.');
    }

    this.campaigns.deletePlanItem(validId);
    this.auditSafe('CAMPAIGN_PLAN_ITEM_DELETED', `Target removed from campaign ${campaign.name}.`, JSON.stringify({ campaignId: campaign.id, planItemId: validId }));
    this.notifySafe();
  }

  // Simulation (READ-ONLY)
  simulate(campaignId: string): CampaignSimulationResult {
    const validId = this.requireId(campaignId);
    const campaign = this.get(validId);

    const warnings: CampaignSimulationIssue[] = [];
    const blockers: CampaignSimulationIssue[] = [];
    const plannedRows: CampaignSimulationPlannedRow[] = [];

    const enabledVariants = campaign.variants.filter((v) => v.enabled);
    if (enabledVariants.length === 0) {
      blockers.push({ code: 'NO_ENABLED_VARIANTS', message: 'Campaign has no enabled content variants.' });
    }

    const variantDrafts = new Map<string, DraftRecord>();
    const variantHashes = new Map<string, string>();

    for (const variant of enabledVariants) {
      const draft = this.drafts.get(variant.draftId);
      if (!draft) {
        blockers.push({
          code: 'DRAFT_NOT_FOUND',
          message: `Referenced draft for variant "${variant.label}" no longer exists.`,
          target: { variantId: variant.id }
        });
        continue;
      }
      variantDrafts.set(variant.id, draft);

      if (draft.status !== 'READY') {
        blockers.push({
          code: 'DRAFT_NOT_READY',
          message: `Draft "${draft.title}" for variant "${variant.label}" must be READY.`,
          target: { variantId: variant.id }
        });
      }

      if (!draft.body.trim() && !draft.linkUrl?.trim() && draft.media.length === 0) {
        blockers.push({
          code: 'EMPTY_PUBLISH_CONTENT',
          message: `Draft "${draft.title}" has no body, link, or media.`,
          target: { variantId: variant.id }
        });
      }

      const currentHash = buildSnapshotHash(draft);
      variantHashes.set(variant.id, currentHash);

      if (campaign.status === 'APPROVED') {
        if (!variant.approvedSnapshotHash || variant.approvedSnapshotHash !== currentHash) {
          blockers.push({
            code: 'APPROVAL_STALE',
            message: `Draft content or media for variant "${variant.label}" has changed since approval.`,
            target: { variantId: variant.id }
          });
        }
      } else if (campaign.status !== 'QUEUED') {
        blockers.push({
          code: 'APPROVAL_MISSING',
          message: `Campaign is in ${campaign.status} status. It must be APPROVED before it can be committed to the Queue.`
        });
      }
    }

    if (campaign.planItems.length === 0) {
      blockers.push({ code: 'NO_PLAN_ITEMS', message: 'Campaign scheduling plan has no target items.' });
    }

    const seenQueueKeys = new Set<string>();
    const scheduledByAccount = new Map<string, Array<{ id: string; time: number }>>();

    const existingQueueItems = this.queue.list().filter(
      (item) => ['PENDING', 'PAUSED'].includes(item.status) && Boolean(item.scheduledAt) && Boolean(item.accountId)
    );
    const existingScheduledByAccount = new Map<string, Array<{ id: string; time: number; scheduledAt: string }>>();
    for (const item of existingQueueItems) {
      const list = existingScheduledByAccount.get(item.accountId!) ?? [];
      list.push({ id: item.id, time: new Date(item.scheduledAt!).getTime(), scheduledAt: item.scheduledAt! });
      existingScheduledByAccount.set(item.accountId!, list);
    }

    for (const item of campaign.planItems) {
      const variant = campaign.variants.find((v) => v.id === item.variantId);
      if (!variant) {
        blockers.push({
          code: 'VARIANT_NOT_FOUND',
          message: 'Target references a non-existent variant.',
          target: { variantId: item.variantId, accountId: item.accountId, groupId: item.groupId }
        });
        continue;
      }
      if (!variant.enabled) {
        blockers.push({
          code: 'VARIANT_DISABLED',
          message: `Variant "${variant.label}" is disabled.`,
          target: { variantId: item.variantId, accountId: item.accountId, groupId: item.groupId }
        });
      }

      const account = this.accounts.get(item.accountId);
      if (!account) {
        blockers.push({
          code: 'ACCOUNT_NOT_FOUND',
          message: 'Target account does not exist.',
          target: { variantId: item.variantId, accountId: item.accountId, groupId: item.groupId }
        });
        continue;
      }

      const group = this.groups.get(item.groupId);
      if (!group) {
        blockers.push({
          code: 'GROUP_NOT_FOUND',
          message: 'Target group does not exist.',
          target: { variantId: item.variantId, accountId: item.accountId, groupId: item.groupId }
        });
        continue;
      }

      if (!group.active) {
        blockers.push({
          code: 'GROUP_INACTIVE',
          message: `Target group "${group.name}" is inactive/archived.`,
          target: { variantId: item.variantId, accountId: item.accountId, groupId: item.groupId }
        });
      }

      const isAssigned = this.groups.assignments(group.id).some((a) => a.id === account.id);
      if (!isAssigned) {
        blockers.push({
          code: 'INVALID_ASSIGNMENT',
          message: `Account "${account.name}" is not assigned to group "${group.name}".`,
          target: { variantId: item.variantId, accountId: item.accountId, groupId: item.groupId }
        });
      }

      const draft = variantDrafts.get(variant.id);
      const hash = variantHashes.get(variant.id) ?? '';

      if (draft && hash) {
        const normalizedScheduledAt = item.scheduledAt ? new Date(item.scheduledAt).toISOString() : '';
        const queueDuplicateKey = `${draft.id}:${hash}:${account.id}:${group.id}:${normalizedScheduledAt}`;

        // Check active queue duplicate against existing queue items
        if (this.queue.hasDuplicate(draft.id, hash, account.id, group.id, item.scheduledAt)) {
          blockers.push({
            code: 'DUPLICATE_QUEUE_ITEM',
            message: `An equivalent active queue item already exists for draft "${draft.title}" and target "${account.name} -> ${group.name}".`,
            target: { variantId: item.variantId, accountId: item.accountId, groupId: item.groupId }
          });
        }

        // Intra-campaign duplicate queue item check
        if (seenQueueKeys.has(queueDuplicateKey)) {
          blockers.push({
            code: 'DUPLICATE_QUEUE_ITEM',
            message: `Duplicate planned item would create equivalent active queue item for draft "${draft.title}" and target "${account.name} -> ${group.name}".`,
            target: { variantId: item.variantId, accountId: item.accountId, groupId: item.groupId }
          });
        } else {
          seenQueueKeys.add(queueDuplicateKey);
        }

        // Schedule conflict warning (within 15 minutes for same account)
        if (item.scheduledAt) {
          const time = new Date(item.scheduledAt).getTime();

          // Check against existing PENDING/PAUSED Queue items on same account
          const existingOnAccount = existingScheduledByAccount.get(account.id) ?? [];
          for (const existing of existingOnAccount) {
            if (Math.abs(existing.time - time) <= 15 * 60_000) {
              warnings.push({
                code: 'SCHEDULE_CONFLICT',
                message: `Account "${account.name}" has an existing queue item scheduled within 15 minutes (${existing.scheduledAt}).`,
                target: { variantId: item.variantId, accountId: item.accountId, groupId: item.groupId }
              });
              break;
            }
          }

          // Check against intra-campaign planned items on same account
          const list = scheduledByAccount.get(account.id) ?? [];
          for (const prev of list) {
            if (Math.abs(prev.time - time) <= 15 * 60_000) {
              warnings.push({
                code: 'SCHEDULE_CONFLICT',
                message: `Account "${account.name}" has another item scheduled within 15 minutes (${item.scheduledAt}).`,
                target: { variantId: item.variantId, accountId: item.accountId, groupId: item.groupId }
              });
              break;
            }
          }
          list.push({ id: item.id, time });
          scheduledByAccount.set(account.id, list);
        }

        plannedRows.push({
          variantId: variant.id,
          variantLabel: variant.label,
          draftId: draft.id,
          draftTitle: draft.title,
          accountId: account.id,
          accountName: account.name,
          groupId: group.id,
          groupName: group.name,
          groupUrl: group.normalizedUrl,
          scheduledAt: item.scheduledAt,
          snapshotHash: hash,
          mediaCount: draft.media.length
        });
      }
    }

    const distinctAccounts = new Set(campaign.planItems.map((p) => p.accountId)).size;
    const distinctGroups = new Set(campaign.planItems.map((p) => p.groupId)).size;
    const scheduledCount = campaign.planItems.filter((p) => Boolean(p.scheduledAt)).length;
    const unscheduledCount = campaign.planItems.length - scheduledCount;

    const status = blockers.length > 0 ? 'BLOCKED' : warnings.length > 0 ? 'WARNING' : 'READY';

    // Deterministic freshness token
    const freshnessPayload = {
      campaignId: campaign.id,
      updatedAt: campaign.updatedAt,
      status: campaign.status,
      variants: campaign.variants.map((v) => ({
        id: v.id,
        draftId: v.draftId,
        label: v.label,
        enabled: v.enabled,
        approvedSnapshotHash: v.approvedSnapshotHash ?? null,
        currentHash: variantHashes.get(v.id) ?? null
      })),
      planItems: campaign.planItems.map((p) => ({
        id: p.id,
        variantId: p.variantId,
        accountId: p.accountId,
        groupId: p.groupId,
        scheduledAt: p.scheduledAt ?? null,
        sortOrder: p.sortOrder
      }))
    };
    const freshnessToken = createHash('sha256').update(JSON.stringify(freshnessPayload)).digest('hex');

    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      status,
      variantCount: enabledVariants.length,
      targetCount: campaign.planItems.length,
      accountCount: distinctAccounts,
      groupCount: distinctGroups,
      scheduledCount,
      unscheduledCount,
      plannedRows,
      warnings,
      blockers,
      freshnessToken,
      simulatedAt: new Date().toISOString()
    };
  }

  // Commit Campaign to Queue (Atomic all-or-nothing)
  commitToQueue(input: CommitCampaignInput): QueueItem[] {
    const parsed = commitCampaignSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid commit payload.');

    const campaign = this.requireCampaign(parsed.data.campaignId);
    if (campaign.status !== 'APPROVED') {
      throw new AppError('INVALID_STATE', `Only APPROVED campaigns can be committed to the Queue. Current status: ${campaign.status}.`);
    }

    // Main process authoritative re-simulation
    const simulation = this.simulate(campaign.id);
    if (simulation.status === 'BLOCKED' || simulation.blockers.length > 0) {
      throw new AppError('QUEUE_VALIDATION_FAILED', `Campaign simulation failed: ${simulation.blockers.map((b) => b.message).join(' ')}`);
    }

    if (simulation.freshnessToken !== parsed.data.freshnessToken) {
      throw new AppError('CAMPAIGN_SIMULATION_STALE', 'Campaign simulation is stale. Re-simulate before committing to the Queue.');
    }

    const detail = this.get(campaign.id);
    const timestamp = new Date().toISOString();

    const queueRows: QueueInsert[] = [];
    for (const item of detail.planItems) {
      const variant = detail.variants.find((v) => v.id === item.variantId);
      if (!variant) throw new AppError('INVALID_STATE', 'Variant missing from plan item.');
      const draft = this.drafts.get(variant.draftId);
      if (!draft) throw new AppError('DRAFT_NOT_FOUND', 'Draft missing for variant.');

      const hash = buildSnapshotHash(draft);
      queueRows.push({
        id: randomUUID(),
        draftId: draft.id,
        accountId: item.accountId,
        groupId: item.groupId,
        draftTitle: draft.title,
        body: draft.body,
        linkUrl: draft.linkUrl,
        accountName: item.accountName,
        groupName: item.groupName,
        groupUrl: item.groupUrl,
        snapshotHash: hash,
        scheduledAt: item.scheduledAt,
        campaignId: campaign.id,
        campaignVariantId: variant.id,
        media: draft.media.map((m) => ({
          id: m.id,
          type: m.type,
          originalName: m.originalName,
          storedName: '',
          localPath: '',
          mimeType: m.mimeType,
          fileSize: m.fileSize,
          sortOrder: m.sortOrder
        })),
        createdAt: timestamp
      });
    }

    let created: QueueItem[] = [];
    try {
      this.db.transaction(() => {
        const records = this.queue.insertBatch(queueRows);
        this.campaigns.setStatus(campaign.id, 'QUEUED');
        created = records.map((rec) => ({
          ...rec,
          media: rec.media.map((m) => ({
            id: m.id,
            type: m.type,
            originalName: m.originalName,
            mimeType: m.mimeType,
            fileSize: m.fileSize,
            sortOrder: m.sortOrder,
            previewUrl: ''
          }))
        }));
      })();
    } catch (error) {
      if (String(error).toLowerCase().includes('unique')) {
        throw new AppError('DUPLICATE_QUEUE_ITEM', 'An equivalent active queue item already exists.');
      }
      throw new AppError('QUEUE_VALIDATION_FAILED', 'Failed to commit campaign to Queue. Transaction rolled back.');
    }

    this.auditSafe('CAMPAIGN_QUEUED', `Committed ${created.length} queue item(s) from campaign ${campaign.name}.`, JSON.stringify({ campaignId: campaign.id, count: created.length }));
    this.notifySafe();
    return created;
  }

  // Helpers
  private assertEligibleForReviewOrApproval(campaign: CampaignDetail): void {
    const enabledVariants = campaign.variants.filter((v) => v.enabled);
    if (enabledVariants.length === 0) {
      throw new AppError('INVALID_STATE', 'Campaign must have at least one enabled variant.');
    }
    if (campaign.planItems.length === 0) {
      throw new AppError('INVALID_STATE', 'Campaign must have at least one plan target.');
    }

    for (const variant of enabledVariants) {
      const draft = this.drafts.get(variant.draftId);
      if (!draft) throw new AppError('DRAFT_NOT_FOUND', `Referenced draft for variant "${variant.label}" not found.`);
      if (draft.status !== 'READY') throw new AppError('INVALID_STATE', `Referenced draft "${draft.title}" must be READY.`);
      if (!draft.body.trim() && !draft.linkUrl?.trim() && draft.media.length === 0) {
        throw new AppError('EMPTY_PUBLISH_CONTENT', `Draft "${draft.title}" has no body, link, or media.`);
      }
    }

    for (const item of campaign.planItems) {
      const variant = campaign.variants.find((v) => v.id === item.variantId);
      if (!variant || !variant.enabled) {
        throw new AppError('INVALID_STATE', 'Plan item targets a missing or disabled variant.');
      }
      const account = this.accounts.get(item.accountId);
      if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 'Target account not found.');
      const group = this.groups.get(item.groupId);
      if (!group) throw new AppError('GROUP_NOT_FOUND', 'Target group not found.');
      if (!group.active) throw new AppError('INVALID_STATE', `Target group "${group.name}" is not active.`);

      const isAssigned = this.groups.assignments(group.id).some((a) => a.id === account.id);
      if (!isAssigned) {
        throw new AppError('INVALID_ASSIGNMENT', `Account "${account.name}" is not assigned to group "${group.name}".`);
      }
    }
  }

  private getCurrentDraftHashesForCampaign(campaignId: string): Map<string, string> {
    const variants = this.campaigns.listVariants(campaignId);
    const hashes = new Map<string, string>();
    for (const variant of variants) {
      const draft = this.drafts.get(variant.draftId);
      if (draft) {
        hashes.set(draft.id, buildSnapshotHash(draft));
      }
    }
    return hashes;
  }

  private requireCampaign(id: string): Campaign {
    const campaign = this.campaigns.get(id);
    if (!campaign) throw new AppError('CAMPAIGN_NOT_FOUND', 'Campaign not found.');
    return campaign;
  }

  private requireId(value: string): string {
    const parsed = campaignIdSchema.safeParse(value);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid campaign id.');
    return parsed.data;
  }

  private requireVariantId(value: string): string {
    const parsed = campaignVariantIdSchema.safeParse(value);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid variant id.');
    return parsed.data;
  }

  private requirePlanItemId(value: string): string {
    const parsed = campaignPlanItemIdSchema.safeParse(value);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid plan item id.');
    return parsed.data;
  }

  private auditSafe(eventType: string, message: string, metadata: string): void {
    try {
      this.audit.add({ eventType, message, metadata });
    } catch {
      // Best effort audit
    }
  }

  private notifySafe(): void {
    try {
      this.notify();
    } catch {
      // Renderer window might be closing
    }
  }
}
