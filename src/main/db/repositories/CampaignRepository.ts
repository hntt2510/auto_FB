import type Database from 'better-sqlite3';
import type {
  Campaign,
  CampaignDetail,
  CampaignFilter,
  CampaignInput,
  CampaignPlanItem,
  CampaignPlanItemInput,
  CampaignStatus,
  CampaignVariant,
  CampaignVariantInput,
  CampaignVariantUpdateInput,
  DraftStatus
} from '@shared/types';

type CampaignRow = {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  variant_count: number;
  plan_item_count: number;
  created_at: string;
  updated_at: string;
};

type VariantRow = {
  id: string;
  campaign_id: string;
  draft_id: string;
  label: string;
  sort_order: number;
  enabled: number;
  approved_snapshot_hash: string | null;
  draft_title: string | null;
  draft_status: DraftStatus | null;
  created_at: string;
  updated_at: string;
};

type PlanItemRow = {
  id: string;
  campaign_id: string;
  variant_id: string;
  variant_label: string | null;
  draft_id: string | null;
  draft_title: string | null;
  account_id: string;
  account_name: string | null;
  group_id: string;
  group_name: string | null;
  group_url: string | null;
  scheduled_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function mapCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status,
    variantCount: row.variant_count,
    planItemCount: row.plan_item_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapVariant(row: VariantRow, currentDraftHash?: string): CampaignVariant {
  let freshness: CampaignVariant['freshness'] = 'NOT_APPROVED';
  if (row.approved_snapshot_hash) {
    freshness = currentDraftHash && currentDraftHash === row.approved_snapshot_hash ? 'CURRENT' : 'STALE';
  }
  return {
    id: row.id,
    campaignId: row.campaign_id,
    draftId: row.draft_id,
    label: row.label,
    sortOrder: row.sort_order,
    enabled: Boolean(row.enabled),
    approvedSnapshotHash: row.approved_snapshot_hash ?? undefined,
    draftTitle: row.draft_title ?? '(Deleted draft)',
    draftStatus: row.draft_status ?? 'DRAFT',
    freshness,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPlanItem(row: PlanItemRow): CampaignPlanItem {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    variantId: row.variant_id,
    variantLabel: row.variant_label ?? '(Unknown variant)',
    draftId: row.draft_id ?? '',
    draftTitle: row.draft_title ?? '(Draft)',
    accountId: row.account_id,
    accountName: row.account_name ?? '(Unknown account)',
    groupId: row.group_id,
    groupName: row.group_name ?? '(Unknown group)',
    groupUrl: row.group_url ?? '',
    scheduledAt: row.scheduled_at ?? undefined,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const campaignSelect = `
  SELECT c.*,
    (SELECT COUNT(*) FROM campaign_variants cv WHERE cv.campaign_id = c.id) AS variant_count,
    (SELECT COUNT(*) FROM campaign_plan_items cpi WHERE cpi.campaign_id = c.id) AS plan_item_count
  FROM campaigns c
`;

const variantSelect = `
  SELECT cv.*, d.title AS draft_title, d.status AS draft_status
  FROM campaign_variants cv
  LEFT JOIN drafts d ON d.id = cv.draft_id
`;

const planItemSelect = `
  SELECT cpi.*,
    cv.label AS variant_label,
    d.id AS draft_id,
    d.title AS draft_title,
    a.name AS account_name,
    g.name AS group_name,
    g.normalized_url AS group_url
  FROM campaign_plan_items cpi
  LEFT JOIN campaign_variants cv ON cv.id = cpi.variant_id
  LEFT JOIN drafts d ON d.id = cv.draft_id
  LEFT JOIN accounts a ON a.id = cpi.account_id
  LEFT JOIN groups g ON g.id = cpi.group_id
`;

export class CampaignRepository {
  constructor(private readonly db: Database.Database) {}

  list(filter: CampaignFilter = {}): Campaign[] {
    const conditions: string[] = [];
    const params: Record<string, string> = {};
    if (filter.search) {
      conditions.push('(c.name LIKE @search OR c.description LIKE @search)');
      params.search = `%${filter.search}%`;
    }
    if (filter.status) {
      conditions.push('c.status = @status');
      params.status = filter.status;
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`${campaignSelect}${where} ORDER BY c.updated_at DESC LIMIT 500`).all(params) as CampaignRow[];
    return rows.map(mapCampaign);
  }

  get(id: string): Campaign | undefined {
    const row = this.db.prepare(`${campaignSelect} WHERE c.id = ?`).get(id) as CampaignRow | undefined;
    return row ? mapCampaign(row) : undefined;
  }

  getDetail(id: string, currentDraftHashes: Map<string, string> = new Map()): CampaignDetail | undefined {
    const campaign = this.get(id);
    if (!campaign) return undefined;

    const variantRows = this.db.prepare(`${variantSelect} WHERE cv.campaign_id = ? ORDER BY cv.sort_order ASC, cv.created_at ASC`).all(id) as VariantRow[];
    const variants = variantRows.map((row) => mapVariant(row, currentDraftHashes.get(row.draft_id)));

    const planItemRows = this.db.prepare(`${planItemSelect} WHERE cpi.campaign_id = ? ORDER BY cpi.sort_order ASC, cpi.created_at ASC`).all(id) as PlanItemRow[];
    const planItems = planItemRows.map(mapPlanItem);

    let freshness: CampaignDetail['freshness'] = 'NOT_APPROVED';
    if (campaign.status === 'APPROVED' || campaign.status === 'QUEUED') {
      const enabledVariants = variants.filter((v) => v.enabled);
      if (enabledVariants.length > 0 && enabledVariants.every((v) => v.freshness === 'CURRENT')) {
        freshness = 'CURRENT';
      } else {
        freshness = 'APPROVAL_STALE';
      }
    }

    return {
      ...campaign,
      variants,
      planItems,
      freshness
    };
  }

  insert(id: string, input: CampaignInput, timestamp: string): Campaign {
    this.db.prepare(`
      INSERT INTO campaigns (id, name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, 'DRAFT', ?, ?)
    `).run(id, input.name.trim(), input.description?.trim() || null, timestamp, timestamp);
    return this.get(id)!;
  }

  update(id: string, input: CampaignInput): Campaign {
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      UPDATE campaigns
      SET name = ?, description = ?, updated_at = ?
      WHERE id = ?
    `).run(input.name.trim(), input.description?.trim() || null, timestamp, id);
    return this.get(id)!;
  }

  setStatus(id: string, status: CampaignStatus): Campaign {
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      UPDATE campaigns
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, timestamp, id);
    return this.get(id)!;
  }

  touch(id: string): void {
    this.db.prepare('UPDATE campaigns SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  }

  hasActiveQueueItems(campaignId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM queue_items WHERE campaign_id = ? AND status IN ('PENDING', 'PAUSED', 'RUNNING', 'NEEDS_ATTENTION') LIMIT 1").get(campaignId)
    );
  }

  hasQueueItems(campaignId: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM queue_items WHERE campaign_id = ? LIMIT 1').get(campaignId)
    );
  }

  isDraftUsed(draftId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM campaign_variants WHERE draft_id = ? LIMIT 1').get(draftId));
  }

  // Variants
  getVariant(id: string): CampaignVariant | undefined {
    const row = this.db.prepare(`${variantSelect} WHERE cv.id = ?`).get(id) as VariantRow | undefined;
    return row ? mapVariant(row) : undefined;
  }

  listVariants(campaignId: string): CampaignVariant[] {
    const rows = this.db.prepare(`${variantSelect} WHERE cv.campaign_id = ? ORDER BY cv.sort_order ASC, cv.created_at ASC`).all(campaignId) as VariantRow[];
    return rows.map((row) => mapVariant(row));
  }

  addVariant(id: string, input: CampaignVariantInput, timestamp: string): CampaignVariant {
    const maxOrder = (this.db.prepare('SELECT MAX(sort_order) AS max_order FROM campaign_variants WHERE campaign_id = ?').get(input.campaignId) as { max_order: number | null }).max_order;
    const sortOrder = input.sortOrder ?? (maxOrder !== null ? maxOrder + 1 : 0);
    const enabled = input.enabled === false ? 0 : 1;

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO campaign_variants (id, campaign_id, draft_id, label, sort_order, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.campaignId, input.draftId, input.label.trim(), sortOrder, enabled, timestamp, timestamp);
      this.touch(input.campaignId);
    })();

    return this.getVariant(id)!;
  }

  updateVariant(id: string, input: CampaignVariantUpdateInput): CampaignVariant {
    const current = this.getVariant(id);
    if (!current) throw new Error('Variant not found.');
    const timestamp = new Date().toISOString();

    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.label !== undefined) {
      updates.push('label = ?');
      params.push(input.label.trim());
    }
    if (input.sortOrder !== undefined) {
      updates.push('sort_order = ?');
      params.push(input.sortOrder);
    }
    if (input.enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(input.enabled ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(timestamp);
      params.push(id);

      this.db.transaction(() => {
        this.db.prepare(`UPDATE campaign_variants SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        this.touch(current.campaignId);
      })();
    }

    return this.getVariant(id)!;
  }

  deleteVariant(id: string): void {
    const current = this.getVariant(id);
    if (!current) return;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM campaign_variants WHERE id = ?').run(id);
      this.touch(current.campaignId);
    })();
  }

  setVariantApprovalHashes(campaignId: string, hashes: Map<string, string>): void {
    const timestamp = new Date().toISOString();
    this.db.transaction(() => {
      const update = this.db.prepare('UPDATE campaign_variants SET approved_snapshot_hash = ?, updated_at = ? WHERE id = ?');
      for (const [variantId, hash] of hashes.entries()) {
        update.run(hash, timestamp, variantId);
      }
    })();
  }

  clearVariantApprovalHashes(campaignId: string): void {
    const timestamp = new Date().toISOString();
    this.db.prepare('UPDATE campaign_variants SET approved_snapshot_hash = NULL, updated_at = ? WHERE campaign_id = ?').run(timestamp, campaignId);
  }

  // Plan Items
  getPlanItem(id: string): CampaignPlanItem | undefined {
    const row = this.db.prepare(`${planItemSelect} WHERE cpi.id = ?`).get(id) as PlanItemRow | undefined;
    return row ? mapPlanItem(row) : undefined;
  }

  listPlanItems(campaignId: string): CampaignPlanItem[] {
    const rows = this.db.prepare(`${planItemSelect} WHERE cpi.campaign_id = ? ORDER BY cpi.sort_order ASC, cpi.created_at ASC`).all(campaignId) as PlanItemRow[];
    return rows.map(mapPlanItem);
  }

  addPlanItem(id: string, input: CampaignPlanItemInput, timestamp: string): CampaignPlanItem {
    const maxOrder = (this.db.prepare('SELECT MAX(sort_order) AS max_order FROM campaign_plan_items WHERE campaign_id = ?').get(input.campaignId) as { max_order: number | null }).max_order;
    const sortOrder = input.sortOrder ?? (maxOrder !== null ? maxOrder + 1 : 0);

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO campaign_plan_items (id, campaign_id, variant_id, account_id, group_id, scheduled_at, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.campaignId, input.variantId, input.accountId, input.groupId, input.scheduledAt ?? null, sortOrder, timestamp, timestamp);
      this.touch(input.campaignId);
    })();

    return this.getPlanItem(id)!;
  }

  deletePlanItem(id: string): void {
    const current = this.getPlanItem(id);
    if (!current) return;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM campaign_plan_items WHERE id = ?').run(id);
      this.touch(current.campaignId);
    })();
  }
}
