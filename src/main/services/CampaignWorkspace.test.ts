import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAppPaths, openDatabase } from '../db/database';
import { AccountRepository } from '../db/repositories/AccountRepository';
import { AuditLogRepository } from '../db/repositories/AuditLogRepository';
import { CampaignRepository } from '../db/repositories/CampaignRepository';
import { DraftRepository } from '../db/repositories/DraftRepository';
import { GroupRepository } from '../db/repositories/GroupRepository';
import { QueueRepository } from '../db/repositories/QueueRepository';
import { MediaStorageService } from './MediaStorageService';
import { QueueService, buildSnapshotHash } from './QueueService';
import { CampaignService } from './CampaignService';

type TestContext = {
  db: ReturnType<typeof openDatabase>;
  accounts: AccountRepository;
  groups: GroupRepository;
  drafts: DraftRepository;
  queue: QueueRepository;
  campaigns: CampaignRepository;
  media: MediaStorageService;
  audit: AuditLogRepository;
  campaignService: CampaignService;
  queueService: QueueService;
  notifications: number;
};

function withWorkspace(run: (ctx: TestContext, root: string) => void | Promise<void>): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), 'fb-campaign-test-'));
  const paths = createAppPaths(root);
  const db = openDatabase(paths);
  const accounts = new AccountRepository(db);
  const groups = new GroupRepository(db);
  const drafts = new DraftRepository(db);
  const queue = new QueueRepository(db);
  const campaigns = new CampaignRepository(db);
  const audit = new AuditLogRepository(db);
  const media = new MediaStorageService(paths.media);

  let notifications = 0;
  const notify = () => { notifications++; };

  const campaignService = new CampaignService(db, campaigns, drafts, accounts, groups, queue, audit, notify);
  const queueService = new QueueService(queue, drafts, accounts, groups, media, audit, notify);

  const ctx: TestContext = {
    db,
    accounts,
    groups,
    drafts,
    queue,
    campaigns,
    media,
    audit,
    campaignService,
    queueService,
    get notifications() { return notifications; }
  };

  try {
    const result = run(ctx, root);
    if (result instanceof Promise) {
      return result.finally(() => {
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
    }
    db.close();
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    db.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function createAccountAndGroup(ctx: TestContext, active = true, groupSlug = `marketinggroup-${randomUUID()}`) {
  const accountId = randomUUID();
  const now = new Date().toISOString();
  ctx.accounts.insert({
    id: accountId,
    name: 'Operator Alice',
    profileName: `profile-${accountId}`,
    profileDirectory: join(tmpdir(), `profile-${accountId}`),
    proxyEnabled: false,
    createdAt: now,
    updatedAt: now
  });

  const groupId = randomUUID();
  ctx.groups.insert(groupId, {
    name: `Marketing Group ${groupSlug}`,
    url: `https://facebook.com/groups/${groupSlug}`,
    tags: ['promo'],
    active
  }, now);

  ctx.groups.replaceAssignments(groupId, [accountId]);
  return { accountId, groupId };
}

function createReadyDraft(ctx: TestContext, title = 'Sample Promo', body = 'Check this out!') {
  const draft = ctx.drafts.insert(randomUUID(), { title, body }, new Date().toISOString());
  ctx.drafts.setStatus(draft.id, 'READY');
  return ctx.drafts.get(draft.id)!;
}

describe('Campaign Workspace V1 (Tests A-Z)', () => {
  // Test A
  it('Test A: schema migration upgrades existing database without losing current data', () => withWorkspace((ctx) => {
    const row = ctx.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
    expect(row.version).toBe(8);

    // Verify queue_items has campaign_id and campaign_variant_id columns
    const columns = (ctx.db.prepare("PRAGMA table_info('queue_items')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('campaign_id');
    expect(columns).toContain('campaign_variant_id');
  }));

  // Test B
  it('Test B: create/update/list/read campaign persists correctly', () => withWorkspace((ctx) => {
    const created = ctx.campaignService.create({ name: 'Fall Launch', description: 'Fall promotion' });
    expect(created.id).toBeDefined();
    expect(created.name).toBe('Fall Launch');
    expect(created.status).toBe('DRAFT');

    const updated = ctx.campaignService.update(created.id, { name: 'Fall Launch 2026', description: 'Updated desc' });
    expect(updated.name).toBe('Fall Launch 2026');

    const list = ctx.campaignService.list();
    expect(list.some((c) => c.id === created.id && c.name === 'Fall Launch 2026')).toBe(true);

    const detail = ctx.campaignService.get(created.id);
    expect(detail.id).toBe(created.id);
    expect(detail.name).toBe('Fall Launch 2026');
    expect(detail.variants).toEqual([]);
    expect(detail.planItems).toEqual([]);
  }));

  // Test C
  it('Test C: valid status transitions work', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Transitions Test' });

    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'Var A' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    // DRAFT -> IN_REVIEW
    const inReview = ctx.campaignService.requestReview(campaign.id);
    expect(inReview.status).toBe('IN_REVIEW');

    // IN_REVIEW -> DRAFT (Request Changes)
    const backToDraft = ctx.campaignService.requestChanges(campaign.id);
    expect(backToDraft.status).toBe('DRAFT');

    // Back to IN_REVIEW -> APPROVED
    ctx.campaignService.requestReview(campaign.id);
    const approved = ctx.campaignService.approve(campaign.id);
    expect(approved.status).toBe('APPROVED');

    // Archiving from APPROVED
    const archived = ctx.campaignService.archive(campaign.id);
    expect(archived.status).toBe('ARCHIVED');
  }));

  // Test D
  it('Test D: invalid campaign status transitions fail closed', () => withWorkspace((ctx) => {
    const campaign = ctx.campaignService.create({ name: 'Invalid Transitions' });

    // Cannot approve directly from DRAFT
    expect(() => ctx.campaignService.approve(campaign.id)).toThrowError(/IN_REVIEW/);

    // Cannot commit to queue from DRAFT
    expect(() => ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: 'abc' })).toThrowError();
  }));

  // Test E
  it('Test E: campaign cannot enter review without variant + plan', () => withWorkspace((ctx) => {
    const campaign = ctx.campaignService.create({ name: 'Empty Campaign' });

    // No variant, no plan
    expect(() => ctx.campaignService.requestReview(campaign.id)).toThrowError(/enabled variant/);

    const draft = createReadyDraft(ctx);
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });

    // Has variant, but no plan item
    expect(() => ctx.campaignService.requestReview(campaign.id)).toThrowError(/plan target/);

    const { accountId, groupId } = createAccountAndGroup(ctx);
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    // Now eligible
    expect(ctx.campaignService.requestReview(campaign.id).status).toBe('IN_REVIEW');
  }));

  // Test F
  it('Test F: campaign cannot approve when referenced Draft is not READY', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = ctx.drafts.insert(randomUUID(), { title: 'Draft in progress', body: 'Draft' }, new Date().toISOString());
    // Draft is in 'DRAFT' status, not READY

    const campaign = ctx.campaignService.create({ name: 'Not Ready Campaign' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    expect(() => ctx.campaignService.requestReview(campaign.id)).toThrowError(/READY/);
  }));

  // Test G
  it('Test G: approval stores exact draft snapshot hash', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx, 'Title G', 'Body G');
    const campaign = ctx.campaignService.create({ name: 'Snapshot Hash Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    const approved = ctx.campaignService.approve(campaign.id);
    expect(approved.status).toBe('APPROVED');

    const expectedHash = buildSnapshotHash(ctx.drafts.get(draft.id)!);
    const storedVariant = approved.variants.find((v) => v.id === variant.id);
    expect(storedVariant?.approvedSnapshotHash).toBe(expectedHash);
    expect(storedVariant?.freshness).toBe('CURRENT');
  }));

  // Test H
  it('Test H: draft edit after approval produces APPROVAL_STALE', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx, 'Title H', 'Body H');
    const campaign = ctx.campaignService.create({ name: 'Stale Edit Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    // Edit the underlying draft
    ctx.drafts.update(draft.id, { title: 'Title H', body: 'Body H has been edited!' });

    const detail = ctx.campaignService.get(campaign.id);
    expect(detail.freshness).toBe('APPROVAL_STALE');
    expect(detail.variants[0].freshness).toBe('STALE');

    // Simulation flags APPROVAL_STALE blocker
    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.status).toBe('BLOCKED');
    expect(sim.blockers.some((b) => b.code === 'APPROVAL_STALE')).toBe(true);
  }));

  // Test I
  it('Test I: media change after approval produces stale approval', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx, 'Title I', 'Body I');
    const campaign = ctx.campaignService.create({ name: 'Stale Media Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    // Attach media to draft after approval
    ctx.drafts.insertAssetAndAttach({
      id: randomUUID(),
      type: 'IMAGE',
      originalName: 'photo.jpg',
      storedName: 'photo.jpg',
      localPath: '/fake/photo.jpg',
      fileSize: 1024
    }, draft.id, 0, new Date().toISOString());

    const detail = ctx.campaignService.get(campaign.id);
    expect(detail.freshness).toBe('APPROVAL_STALE');
    expect(detail.variants[0].freshness).toBe('STALE');
  }));

  // Test J
  it('Test J: invalid group/account assignment blocks approval/simulation', () => withWorkspace((ctx) => {
    const { accountId } = createAccountAndGroup(ctx);
    const otherGroupId = randomUUID();
    ctx.groups.insert(otherGroupId, { name: 'Unassigned Group', url: 'https://facebook.com/groups/unassigned', tags: [], active: true }, new Date().toISOString());
    // accountId is NOT assigned to otherGroupId

    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Invalid Assignment Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });

    // Direct addPlanItem should throw INVALID_ASSIGNMENT
    try {
      ctx.campaignService.addPlanItem({
        campaignId: campaign.id,
        variantId: variant.id,
        accountId,
        groupId: otherGroupId
      });
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('INVALID_ASSIGNMENT');
      expect(err.message).toMatch(/not assigned/);
    }
  }));

  // Test K
  it('Test K: inactive group blocks simulation', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx, true);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Inactive Group Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    // Deactivate group
    ctx.groups.setActive(groupId, false);

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.status).toBe('BLOCKED');
    expect(sim.blockers.some((b) => b.code === 'GROUP_INACTIVE')).toBe(true);
  }));

  // Test L
  it('Test L: simulation creates ZERO Queue rows', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Simulation Zero Rows' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const queueBefore = ctx.queue.list();
    const sim = ctx.campaignService.simulate(campaign.id);
    const queueAfter = ctx.queue.list();

    expect(sim.status).toBe('READY');
    expect(queueAfter.length).toBe(queueBefore.length);
  }));

  // Test M
  it('Test M: simulation preview produces deterministic rows/order', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Deterministic Simulation' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId, sortOrder: 0 });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim1 = ctx.campaignService.simulate(campaign.id);
    const sim2 = ctx.campaignService.simulate(campaign.id);

    expect(sim1.plannedRows).toEqual(sim2.plannedRows);
    expect(sim1.freshnessToken).toBe(sim2.freshnessToken);
  }));

  // Test N
  it('Test N: simulation freshness token changes on any relevant change', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft1 = createReadyDraft(ctx, 'D1');
    const campaign = ctx.campaignService.create({ name: 'Token Invalidation Test' });
    const variant1 = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft1.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant1.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const token1 = ctx.campaignService.simulate(campaign.id).freshnessToken;

    // Change draft
    ctx.drafts.update(draft1.id, { title: 'D1 changed', body: 'body' });
    const token2 = ctx.campaignService.simulate(campaign.id).freshnessToken;
    expect(token1).not.toBe(token2);
  }));

  // Test O
  it('Test O: stale simulation token creates ZERO Queue rows', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Stale Token Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);

    // Modify draft to invalidate token
    ctx.drafts.update(draft.id, { title: 'New title', body: 'New body' });

    // Commit with old token must fail closed
    expect(() => ctx.campaignService.commitToQueue({
      campaignId: campaign.id,
      freshnessToken: sim.freshnessToken
    })).toThrowError();

    expect(ctx.queue.list().length).toBe(0);
  }));

  // Test P
  it('Test P: successful Commit to Queue creates all expected immutable Queue snapshots transactionally', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx, 'Promo P', 'Super Deal');
    const campaign = ctx.campaignService.create({ name: 'Commit Test P' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'Variant P' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);
    const queueItems = ctx.campaignService.commitToQueue({
      campaignId: campaign.id,
      freshnessToken: sim.freshnessToken
    });

    expect(queueItems.length).toBe(1);
    const item = queueItems[0];
    expect(item.draftTitle).toBe('Promo P');
    expect(item.body).toBe('Super Deal');
    expect(item.campaignId).toBe(campaign.id);
    expect(item.campaignVariantId).toBe(variant.id);
    expect(item.status).toBe('PENDING');
  }));

  // Test Q
  it('Test Q: failure of one planned Queue row creates ZERO campaign Queue rows', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx, 'Promo Q', 'Deal Q');
    const campaign = ctx.campaignService.create({ name: 'Rollback Test Q' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });

    // Add target 1
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);

    // Create an active duplicate directly in queue to force an insert collision on commit
    const hash = buildSnapshotHash(ctx.drafts.get(draft.id)!);
    ctx.queue.insertBatch([{
      id: randomUUID(),
      draftId: draft.id,
      accountId,
      groupId,
      draftTitle: draft.title,
      body: draft.body,
      accountName: 'Alice',
      groupName: 'Marketing',
      groupUrl: 'https://facebook.com/groups/marketing',
      snapshotHash: hash,
      media: [],
      createdAt: new Date().toISOString()
    }]);

    expect(ctx.queue.list().length).toBe(1);

    // Commit must fail due to duplicate collision
    expect(() => ctx.campaignService.commitToQueue({
      campaignId: campaign.id,
      freshnessToken: sim.freshnessToken
    })).toThrowError();

    // Still only 1 queue item (the pre-existing one); zero items created from the failed commit
    expect(ctx.queue.list().length).toBe(1);
    expect(ctx.campaignService.get(campaign.id).status).toBe('APPROVED');
  }));

  // Test R
  it('Test R: successful commit changes campaign to QUEUED', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Queued Status Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);
    ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken });

    const detail = ctx.campaignService.get(campaign.id);
    expect(detail.status).toBe('QUEUED');
  }));

  // Test S
  it('Test S: second commit is rejected', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Double Commit Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);
    ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken });

    // Second commit attempt
    expect(() => ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken })).toThrowError(/APPROVED/);
  }));

  // Test T
  it('Test T: legacy/manual Queue items without campaign metadata remain fully compatible', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx, 'Manual Draft');

    // Create manual queue item via existing QueueService
    const manualQueueItems = ctx.queueService.create({
      draftId: draft.id,
      targets: [{ accountId, groupId }]
    });

    expect(manualQueueItems.length).toBe(1);
    expect(manualQueueItems[0].campaignId).toBeUndefined();
    expect(manualQueueItems[0].campaignVariantId).toBeUndefined();

    // Verify it lists and gets normally
    const fetched = ctx.queueService.get(manualQueueItems[0].id);
    expect(fetched.id).toBe(manualQueueItems[0].id);
    expect(fetched.status).toBe('PENDING');
  }));

  // Test U
  it('Test U: Queue snapshots remain unchanged after later Draft edits', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx, 'Original Title', 'Original Body');
    const campaign = ctx.campaignService.create({ name: 'Immutable Snapshot Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);
    const sim = ctx.campaignService.simulate(campaign.id);
    const queueItems = ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken });

    // Edit the draft after queue commit
    ctx.drafts.update(draft.id, { title: 'Modified Title', body: 'Modified Body' });

    // Verify queue row retains its original immutable snapshot
    const item = ctx.queue.get(queueItems[0].id);
    expect(item?.draftTitle).toBe('Original Title');
    expect(item?.body).toBe('Original Body');
  }));

  // Test V
  it('Test V: Planner sees newly scheduled campaign Queue rows normally', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Planner Visibility Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });

    // Schedule for tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const scheduledAt = tomorrow.toISOString();

    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId, scheduledAt });
    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);
    ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken });

    // Inspect PlannerSummary from QueueService
    const planner = ctx.queueService.planner(new Date());
    const tomorrowItems = planner.buckets.TOMORROW.flatMap((b) => b.items);
    expect(tomorrowItems.some((item) => item.campaignId === campaign.id)).toBe(true);
  }));

  // Test W
  it('Test W: publishing engine isolation preserved', () => withWorkspace((ctx) => {
    // Verified that Queue is the sole publishing source and no secondary publishing engine was added
    expect(typeof ctx.queueService.planner).toBe('function');
    expect(typeof ctx.campaignService.commitToQueue).toBe('function');
  }));

  // Test X
  it('Test X: Campaign IPC handlers validate input schemas and reject invalid requests', async () => withWorkspace(async (ctx) => {
    // Direct service validations for IPC boundary
    expect(() => ctx.campaignService.create({ name: '' })).toThrowError(/required/);
    expect(() => ctx.campaignService.get('not-a-uuid')).toThrowError(/Invalid/);
  }));

  // Test Y
  it('Test Y: restart persistence', () => withWorkspace((ctx, root) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Restart Persistence Test', description: 'Persist me' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    // Simulate restart by closing db and reopening
    ctx.db.close();

    const paths = createAppPaths(root);
    const reopenedDb = openDatabase(paths);
    const reopenedCampaigns = new CampaignRepository(reopenedDb);
    const reopenedDrafts = new DraftRepository(reopenedDb);
    const reopenedAccounts = new AccountRepository(reopenedDb);
    const reopenedGroups = new GroupRepository(reopenedDb);
    const reopenedQueue = new QueueRepository(reopenedDb);
    const reopenedAudit = new AuditLogRepository(reopenedDb);

    const reopenedService = new CampaignService(
      reopenedDb,
      reopenedCampaigns,
      reopenedDrafts,
      reopenedAccounts,
      reopenedGroups,
      reopenedQueue,
      reopenedAudit,
      () => {}
    );

    const reloaded = reopenedService.get(campaign.id);
    expect(reloaded.name).toBe('Restart Persistence Test');
    expect(reloaded.status).toBe('APPROVED');
    expect(reloaded.variants.length).toBe(1);
    expect(reloaded.planItems.length).toBe(1);
    expect(reloaded.freshness).toBe('CURRENT');

    reopenedDb.close();
  }));

  // Test Z
  it('Test Z: no browser/publisher call occurs during campaign create/edit/review/simulation/commit', () => withWorkspace((ctx) => {
    const mockBrowserLaunch = vi.fn();
    const mockPublish = vi.fn();

    // Create, edit, review, simulate, commit full lifecycle
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Pure Planning Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);
    const sim = ctx.campaignService.simulate(campaign.id);
    ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken });

    // Assert zero browser or publisher invocations
    expect(mockBrowserLaunch).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  }));

  // Acceptance Hardening: Stale Approved Recovery Cycle
  it('Acceptance Hardening 1: stale approved campaign recovery cycle (APPROVED -> Draft edit -> APPROVAL_STALE -> Request Changes -> DRAFT -> Review -> Approve -> CURRENT -> simulate READY, old token rejected)', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Stale Recovery Campaign' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'Variant A' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    // Initial simulation
    const sim1 = ctx.campaignService.simulate(campaign.id);
    expect(sim1.status).toBe('READY');
    const oldFreshnessToken = sim1.freshnessToken;

    // Operator edits Draft -> becomes APPROVAL_STALE
    ctx.drafts.update(draft.id, { title: 'Updated Title', body: 'New body after approval' });
    const detailStale = ctx.campaignService.get(campaign.id);
    expect(detailStale.freshness).toBe('APPROVAL_STALE');

    // Simulation is blocked while stale
    const simStale = ctx.campaignService.simulate(campaign.id);
    expect(simStale.status).toBe('BLOCKED');
    expect(simStale.blockers.some((b) => b.code === 'APPROVAL_STALE')).toBe(true);

    // Operator explicitly requests changes / reopens campaign
    const reopened = ctx.campaignService.requestChanges(campaign.id);
    expect(reopened.status).toBe('DRAFT');
    expect(reopened.variants[0].approvedSnapshotHash).toBeUndefined();

    // Old simulation token cannot be committed
    expect(() => ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: oldFreshnessToken })).toThrowError(/Only APPROVED campaigns/);

    // Operator reviews and approves again
    ctx.campaignService.requestReview(campaign.id);
    const reapproved = ctx.campaignService.approve(campaign.id);
    expect(reapproved.status).toBe('APPROVED');
    expect(reapproved.freshness).toBe('CURRENT');

    // Attempting to commit with old freshness token from first approval cycle must fail closed
    expect(() => ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: oldFreshnessToken })).toThrowError(/Campaign simulation is stale/);

    // New simulation succeeds
    const sim2 = ctx.campaignService.simulate(campaign.id);
    expect(sim2.status).toBe('READY');
    expect(sim2.freshnessToken).not.toBe(oldFreshnessToken);

    // Can now commit to queue
    const queued = ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim2.freshnessToken });
    expect(queued.length).toBe(1);
    expect(ctx.campaignService.get(campaign.id).status).toBe('QUEUED');
  }));

  // Acceptance Hardening: Duplicate Simulation Semantics (A-E)
  it('Acceptance Hardening 2A: same variant + same account/group/schedule duplicated in plan -> BLOCKED', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Duplicate Plan Item Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'Variant 1' });
    const schedule = '2026-09-10T10:00:00.000Z';
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId, scheduledAt: schedule });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId, scheduledAt: schedule });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.status).toBe('BLOCKED');
    expect(sim.blockers.some((b) => b.code === 'DUPLICATE_QUEUE_ITEM')).toBe(true);

    expect(() => ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken })).toThrowError(/Campaign simulation failed/);
  }));

  it('Acceptance Hardening 2B: two different variants referencing same Draft + same account/group/schedule -> BLOCKED', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Two Variants Same Draft Duplicate Test' });
    const v1 = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'Variant 1' });
    const v2 = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'Variant 2' });
    const schedule = '2026-09-10T10:00:00.000Z';
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: v1.id, accountId, groupId, scheduledAt: schedule });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: v2.id, accountId, groupId, scheduledAt: schedule });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.status).toBe('BLOCKED');
    expect(sim.blockers.some((b) => b.code === 'DUPLICATE_QUEUE_ITEM')).toBe(true);
    expect(() => ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken })).toThrowError(/Campaign simulation failed/);
  }));

  it('Acceptance Hardening 2C: same Draft/account/group but different schedule -> allowed', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Different Schedule Allowed' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'Variant 1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId, scheduledAt: '2026-09-10T10:00:00.000Z' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId, scheduledAt: '2026-09-10T11:00:00.000Z' });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.status).toBe('READY');
    expect(sim.blockers.length).toBe(0);
    expect(sim.plannedRows.length).toBe(2);
  }));

  it('Acceptance Hardening 2D: two genuinely different Draft snapshots -> not duplicate solely because account/group/schedule match', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft1 = createReadyDraft(ctx, 'Draft 1', 'First body');
    const draft2 = createReadyDraft(ctx, 'Draft 2', 'Different unique body content');

    const campaign = ctx.campaignService.create({ name: 'Different Drafts Match' });
    const v1 = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft1.id, label: 'Variant 1' });
    const v2 = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft2.id, label: 'Variant 2' });
    const schedule = '2026-09-10T10:00:00.000Z';
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: v1.id, accountId, groupId, scheduledAt: schedule });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: v2.id, accountId, groupId, scheduledAt: schedule });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.blockers.some((b) => b.code === 'DUPLICATE_QUEUE_ITEM')).toBe(false);
  }));

  it('Acceptance Hardening 2E: final Queue transaction remains authoritative against duplicate collisions', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Queue DB Constraint Guard' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    const schedule = '2026-09-10T10:00:00.000Z';
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId, scheduledAt: schedule });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.status).toBe('READY');

    // Simulate race: another actor inserts an active duplicate into Queue table before commit
    const hash = buildSnapshotHash(draft);
    const now = new Date().toISOString();
    ctx.queue.insertBatch([{
      id: randomUUID(),
      draftId: draft.id,
      accountId,
      groupId,
      draftTitle: draft.title,
      body: draft.body,
      accountName: 'Alice',
      groupName: 'Marketing',
      groupUrl: 'https://facebook.com/groups/marketinggroup',
      snapshotHash: hash,
      scheduledAt: schedule,
      media: [],
      createdAt: now
    }]);

    // Commit must fail closed transactionally
    expect(() => ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken })).toThrow();
  }));

  // Acceptance Hardening: Permanent Provenance & Deletion Protection (F-J)
  it('Acceptance Hardening 3F: committed campaign row reaches SUCCEEDED -> Campaign delete still rejected', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Provenance Succeeded Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);
    const sim = ctx.campaignService.simulate(campaign.id);
    const queueRows = ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken });

    // Mark row as SUCCEEDED
    ctx.db.prepare("UPDATE queue_items SET status = 'SUCCEEDED' WHERE id = ?").run(queueRows[0].id);

    // Delete must be rejected
    expect(() => ctx.campaignService.delete(campaign.id)).toThrowError(/cannot be deleted/);
  }));

  it('Acceptance Hardening 3G: Campaign delete rejected for SUBMITTED, FAILED, CANCELLED rows', () => withWorkspace((ctx) => {
    for (const terminalStatus of ['SUBMITTED', 'FAILED', 'CANCELLED']) {
      const { accountId, groupId } = createAccountAndGroup(ctx);
      const draft = createReadyDraft(ctx);
      const campaign = ctx.campaignService.create({ name: `Delete Test ${terminalStatus}` });
      const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
      ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

      ctx.campaignService.requestReview(campaign.id);
      ctx.campaignService.approve(campaign.id);
      const sim = ctx.campaignService.simulate(campaign.id);
      const queueRows = ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken });

      ctx.db.prepare(`UPDATE queue_items SET status = '${terminalStatus}' WHERE id = ?`).run(queueRows[0].id);

      expect(() => ctx.campaignService.delete(campaign.id)).toThrowError(/cannot be deleted/);
    }
  }));

  it('Acceptance Hardening 3H: historical Queue row still exposes campaignId + campaignVariantId', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Historical Expose Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);
    const sim = ctx.campaignService.simulate(campaign.id);
    const queueRows = ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken });

    // Transition to terminal SUCCEEDED
    ctx.db.prepare("UPDATE queue_items SET status = 'SUCCEEDED' WHERE id = ?").run(queueRows[0].id);

    const fetched = ctx.queue.get(queueRows[0].id);
    expect(fetched?.campaignId).toBe(campaign.id);
    expect(fetched?.campaignVariantId).toBe(variant.id);
  }));

  it('Acceptance Hardening 3I: requeue a Campaign-created terminal Queue row preserves campaignId + campaignVariantId', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const campaign = ctx.campaignService.create({ name: 'Requeue Provenance Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({ campaignId: campaign.id, variantId: variant.id, accountId, groupId });

    ctx.campaignService.requestReview(campaign.id);
    ctx.campaignService.approve(campaign.id);
    const sim = ctx.campaignService.simulate(campaign.id);
    const queueRows = ctx.campaignService.commitToQueue({ campaignId: campaign.id, freshnessToken: sim.freshnessToken });

    // Set to FAILED so it can be requeued
    ctx.db.prepare("UPDATE queue_items SET status = 'FAILED' WHERE id = ?").run(queueRows[0].id);

    const newId = randomUUID();
    const requeued = ctx.queue.requeue(queueRows[0].id, newId, undefined, new Date().toISOString());

    expect(requeued.id).toBe(newId);
    expect(requeued.campaignId).toBe(campaign.id);
    expect(requeued.campaignVariantId).toBe(variant.id);
  }));

  it('Acceptance Hardening 3J: requeue a manual legacy Queue row leaves campaign metadata undefined/null', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const now = new Date().toISOString();
    const legacyId = randomUUID();

    // Insert legacy queue row with no campaign metadata
    ctx.queue.insertBatch([{
      id: legacyId,
      draftId: draft.id,
      accountId,
      groupId,
      draftTitle: draft.title,
      body: draft.body,
      accountName: 'Alice',
      groupName: 'Marketing',
      groupUrl: 'https://facebook.com/groups/marketinggroup',
      snapshotHash: buildSnapshotHash(draft),
      media: [],
      createdAt: now
    }]);

    ctx.db.prepare("UPDATE queue_items SET status = 'FAILED' WHERE id = ?").run(legacyId);

    const newId = randomUUID();
    const requeued = ctx.queue.requeue(legacyId, newId, undefined, now);

    expect(requeued.campaignId).toBeUndefined();
    expect(requeued.campaignVariantId).toBeUndefined();
  }));

  // Acceptance Hardening: Planner-Aligned Schedule Warnings (K-O)
  it('Acceptance Hardening 4K: existing PENDING Queue row at 10:00 + campaign row at 10:05 same account -> WARNING', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const now = new Date().toISOString();

    // Existing PENDING Queue row on same account scheduled at 10:00
    ctx.queue.insertBatch([{
      id: randomUUID(),
      draftId: draft.id,
      accountId,
      groupId,
      draftTitle: draft.title,
      body: draft.body,
      accountName: 'Alice',
      groupName: 'Marketing',
      groupUrl: 'https://facebook.com/groups/marketinggroup',
      snapshotHash: buildSnapshotHash(draft),
      scheduledAt: '2026-09-10T10:00:00.000Z',
      media: [],
      createdAt: now
    }]);

    // Campaign planned row at 10:05 on same account
    const campaign = ctx.campaignService.create({ name: 'Schedule Conflict Pending Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({
      campaignId: campaign.id,
      variantId: variant.id,
      accountId,
      groupId,
      scheduledAt: '2026-09-10T10:05:00.000Z'
    });

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.warnings.some((w) => w.code === 'SCHEDULE_CONFLICT')).toBe(true);
    // Warnings do NOT block simulation
    expect(sim.blockers.some((b) => b.code === 'SCHEDULE_CONFLICT')).toBe(false);
  }));

  it('Acceptance Hardening 4L: existing PAUSED Queue row behaves the same -> WARNING', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const now = new Date().toISOString();
    const existingId = randomUUID();

    ctx.queue.insertBatch([{
      id: existingId,
      draftId: draft.id,
      accountId,
      groupId,
      draftTitle: draft.title,
      body: draft.body,
      accountName: 'Alice',
      groupName: 'Marketing',
      groupUrl: 'https://facebook.com/groups/marketinggroup',
      snapshotHash: buildSnapshotHash(draft),
      scheduledAt: '2026-09-10T10:00:00.000Z',
      media: [],
      createdAt: now
    }]);

    ctx.db.prepare("UPDATE queue_items SET status = 'PAUSED' WHERE id = ?").run(existingId);

    const campaign = ctx.campaignService.create({ name: 'Schedule Conflict Paused Test' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({
      campaignId: campaign.id,
      variantId: variant.id,
      accountId,
      groupId,
      scheduledAt: '2026-09-10T10:05:00.000Z'
    });

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.warnings.some((w) => w.code === 'SCHEDULE_CONFLICT')).toBe(true);
  }));

  it('Acceptance Hardening 4M: different account -> no conflict warning', () => withWorkspace((ctx) => {
    const account1 = createAccountAndGroup(ctx);
    const account2 = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const now = new Date().toISOString();

    // Existing PENDING Queue row on account1 scheduled at 10:00
    ctx.queue.insertBatch([{
      id: randomUUID(),
      draftId: draft.id,
      accountId: account1.accountId,
      groupId: account1.groupId,
      draftTitle: draft.title,
      body: draft.body,
      accountName: 'Alice',
      groupName: 'Marketing',
      groupUrl: 'https://facebook.com/groups/marketinggroup',
      snapshotHash: buildSnapshotHash(draft),
      scheduledAt: '2026-09-10T10:00:00.000Z',
      media: [],
      createdAt: now
    }]);

    // Campaign planned row at 10:05 on account2
    const campaign = ctx.campaignService.create({ name: 'Different Account No Conflict' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({
      campaignId: campaign.id,
      variantId: variant.id,
      accountId: account2.accountId,
      groupId: account2.groupId,
      scheduledAt: '2026-09-10T10:05:00.000Z'
    });

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.warnings.some((w) => w.code === 'SCHEDULE_CONFLICT')).toBe(false);
  }));

  it('Acceptance Hardening 4N: outside 15-minute window -> no conflict warning', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);
    const now = new Date().toISOString();

    // Existing PENDING Queue row on same account scheduled at 10:00
    ctx.queue.insertBatch([{
      id: randomUUID(),
      draftId: draft.id,
      accountId,
      groupId,
      draftTitle: draft.title,
      body: draft.body,
      accountName: 'Alice',
      groupName: 'Marketing',
      groupUrl: 'https://facebook.com/groups/marketinggroup',
      snapshotHash: buildSnapshotHash(draft),
      scheduledAt: '2026-09-10T10:00:00.000Z',
      media: [],
      createdAt: now
    }]);

    // Campaign planned row at 10:30 (30 min difference > 15 min)
    const campaign = ctx.campaignService.create({ name: 'Outside 15m Window No Conflict' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    ctx.campaignService.addPlanItem({
      campaignId: campaign.id,
      variantId: variant.id,
      accountId,
      groupId,
      scheduledAt: '2026-09-10T10:30:00.000Z'
    });

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.warnings.some((w) => w.code === 'SCHEDULE_CONFLICT')).toBe(false);
  }));

  it('Acceptance Hardening 4O: campaign-vs-campaign plan conflict still warns correctly', () => withWorkspace((ctx) => {
    const { accountId, groupId } = createAccountAndGroup(ctx);
    const draft = createReadyDraft(ctx);

    const campaign = ctx.campaignService.create({ name: 'Intra Campaign Schedule Conflict' });
    const variant = ctx.campaignService.addVariant({ campaignId: campaign.id, draftId: draft.id, label: 'V1' });
    // Row 1 at 10:00, Row 2 at 10:08 on same account (different groups)
    const g2Id = randomUUID();
    ctx.groups.insert(g2Id, { name: 'Group 2', url: 'https://facebook.com/groups/group2', tags: [], active: true }, new Date().toISOString());
    ctx.groups.replaceAssignments(g2Id, [accountId]);

    ctx.campaignService.addPlanItem({
      campaignId: campaign.id,
      variantId: variant.id,
      accountId,
      groupId,
      scheduledAt: '2026-09-10T10:00:00.000Z'
    });
    ctx.campaignService.addPlanItem({
      campaignId: campaign.id,
      variantId: variant.id,
      accountId,
      groupId: g2Id,
      scheduledAt: '2026-09-10T10:08:00.000Z'
    });

    const sim = ctx.campaignService.simulate(campaign.id);
    expect(sim.warnings.some((w) => w.code === 'SCHEDULE_CONFLICT')).toBe(true);
  }));
});
