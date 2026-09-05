import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAppPaths,
  createManagedBackup,
  listManagedBackups,
  openDatabase,
  resolveManagedBackup,
  validateManagedBackup,
} from "@main/db/database";
import { AccountRepository } from "@main/db/repositories/AccountRepository";
import { AuditLogRepository } from "@main/db/repositories/AuditLogRepository";
import { DraftRepository } from "@main/db/repositories/DraftRepository";
import { GroupRepository } from "@main/db/repositories/GroupRepository";
import { PublishRepository } from "@main/db/repositories/PublishRepository";
import { QueueRepository } from "@main/db/repositories/QueueRepository";
import { CampaignRepository } from "@main/db/repositories/CampaignRepository";
import { OperationsService } from "./OperationsService";
import type { PublishScheduler } from "@main/publishing/PublishScheduler";
import { LATEST_SCHEMA_VERSION } from "@main/db/migrations";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "ops-v2-"));
  roots.push(root);
  const paths = createAppPaths(root);
  const db = openDatabase(paths);
  const accounts = new AccountRepository(db);
  const groups = new GroupRepository(db);
  const drafts = new DraftRepository(db);
  const queue = new QueueRepository(db);
  const publishing = new PublishRepository(db);
  const now = new Date().toISOString();
  const accountId = randomUUID();
  accounts.insert({
    id: accountId,
    name: "Operator",
    profileName: randomUUID(),
    profileDirectory: join(paths.profiles, randomUUID()),
    proxyEnabled: false,
    createdAt: now,
    updatedAt: now,
  });
  const group = groups.insert(
    randomUUID(),
    {
      name: "Group",
      url: `https://facebook.com/groups/${randomUUID()}`,
      tags: [],
      active: true,
    },
    now,
  );
  groups.replaceAssignments(group.id, [accountId]);
  const draft = drafts.insert(
    randomUUID(),
    {
      title: "Safe title",
      body: "proxy password cookie token Facebook password session storage SHOULD-NOT-EXPORT",
    },
    now,
  );
  const ids = [randomUUID(), randomUUID()];
  queue.insertBatch(
    ids.map((id, index) => ({
      id,
      draftId: draft.id,
      accountId,
      groupId: group.id,
      draftTitle: draft.title,
      body: draft.body,
      accountName: "Operator",
      groupName: group.name,
      groupUrl: group.normalizedUrl,
      snapshotHash: `hash-${index}`,
      scheduledAt: new Date(Date.now() + index * 60_000).toISOString(),
      createdAt: now,
      media: [],
    })),
  );
  return {
    root,
    paths,
    db,
    accounts,
    groups,
    drafts,
    queue,
    publishing,
    accountId,
    group,
    draft,
    ids,
  };
}

describe("Production Operations V2 persistence", () => {
  it("applies queue batches all-or-nothing and reschedules eligible items", () => {
    const value = setup();
    try {
      value.queue.updateState(value.ids[1], "PAUSE");
      expect(() => value.queue.batchAction(value.ids, "PAUSE")).toThrow();
      expect(value.queue.get(value.ids[0])?.status).toBe("PENDING");
      expect(value.queue.get(value.ids[1])?.status).toBe("PAUSED");
      const cleared = value.queue.batchReschedule({
        queueIds: value.ids,
        mode: "CLEAR",
      });
      expect(cleared.every((item) => item.scheduledAt === undefined)).toBe(
        true,
      );
    } finally {
      value.db.close();
    }
  });

  it("derives final status, automated result, and operator verification independently", () => {
    const value = setup();
    try {
      const claim = value.publishing.claim(value.ids[0])!;
      value.publishing.finalizeUnknown(
        value.ids[0],
        claim.token,
        claim.attempt.id,
        value.group.normalizedUrl,
        "Ambiguous automated result.",
      );
      value.publishing.markVerified(
        value.ids[0],
        "Operator confirmed public post.",
      );
      const outcome = value.queue.get(value.ids[0])?.outcome;
      expect(outcome).toEqual({
        finalStatus: "SUCCEEDED",
        automatedResult: "UNKNOWN",
        verificationSource: "OPERATOR",
        reconciliationAction: "MARK_VERIFIED",
      });
      const history = value.publishing
        .history()
        .find((row) => row.queueId === value.ids[0]);
      expect(history).toMatchObject({
        finalStatus: "SUCCEEDED",
        automatedResult: "UNKNOWN",
        verificationSource: "OPERATOR",
      });
    } finally {
      value.db.close();
    }
  });

  it("never exposes post bodies or forbidden secret markers in publishing history", () => {
    const value = setup();
    try {
      const serialized = JSON.stringify(
        value.publishing.history(),
      ).toLowerCase();
      for (const forbidden of [
        "should-not-export",
        "proxy password",
        "cookie",
        "token",
        "facebook password",
        "session storage",
      ])
        expect(serialized).not.toContain(forbidden);
    } finally {
      value.db.close();
    }
  });

  it("creates, validates, retains, and confines managed backups", async () => {
    const value = setup();
    try {
      for (let index = 0; index < 6; index++)
        await createManagedBackup(
          value.db,
          value.paths.backups,
          "MANUAL",
          new Date(Date.UTC(2026, 0, index + 1)),
        );
      const listed = listManagedBackups(value.paths.backups).filter(
        (item) => item.kind === "MANUAL",
      );
      expect(listed).toHaveLength(5);
      expect(
        validateManagedBackup(value.paths.backups, listed[0].id).schemaVersion,
      ).toBe(LATEST_SCHEMA_VERSION);
      expect(() =>
        resolveManagedBackup(value.paths.backups, "..\\app.db"),
      ).toThrow();
      writeFileSync(
        join(value.paths.backups, "manual-corrupt.db"),
        "not sqlite",
      );
      expect(() =>
        validateManagedBackup(value.paths.backups, "manual-corrupt.db"),
      ).toThrow();
    } finally {
      value.db.close();
    }
  });

  it("creates a pre-restore backup and rejects restore while scheduler is active", async () => {
    const value = setup();
    const restore = vi.fn(async () => undefined);
    const appInfo = {
      appName: "Facebook Account Manager",
      appVersion: "0.8.0",
      databaseSchema: 8,
      selectorVersion: "2026-08-v4",
      electronVersion: "36",
      playwrightVersion: "1.52",
    };
    try {
      const manual = await createManagedBackup(
        value.db,
        value.paths.backups,
        "MANUAL",
      );
      const armed = new OperationsService(
        value.db,
        value.paths,
        value.publishing,
        { runtimeState: () => "ARMED" } as PublishScheduler,
        new AuditLogRepository(value.db),
        appInfo,
        restore,
      );
      await expect(armed.restoreBackup(manual.id)).rejects.toMatchObject({
        code: "RESTORE_NOT_SAFE",
      });
      const disarmed = new OperationsService(
        value.db,
        value.paths,
        value.publishing,
        { runtimeState: () => "DISARMED" } as PublishScheduler,
        new AuditLogRepository(value.db),
        appInfo,
        restore,
      );
      expect(value.publishing.claim(value.ids[0])).toBeDefined();
      await expect(disarmed.restoreBackup(manual.id)).rejects.toMatchObject({
        code: "RESTORE_NOT_SAFE",
      });
      value.publishing.recoverRunning("Test cleanup.");
      await disarmed.restoreBackup(manual.id);
      expect(restore).toHaveBeenCalledWith(
        join(value.paths.backups, manual.id),
      );
      expect(
        readdirSync(value.paths.backups).some((name) =>
          name.startsWith("pre-restore-"),
        ),
      ).toBe(true);
    } finally {
      value.db.close();
    }
  });

  it("schema 8 managed backup and restore preserves campaign workspace entities and queue provenance", async () => {
    const value = setup();
    const campaigns = new CampaignRepository(value.db);
    const now = new Date().toISOString();
    const campaignId = randomUUID();
    const variantId = randomUUID();
    const planItemId = randomUUID();
    const queueItemId = randomUUID();

    // 1. Create campaign, variant with approval hash, plan item, and linked queue item
    campaigns.insert(campaignId, { name: "Summer Campaign 2026", description: "Summer promo" }, now);
    campaigns.addVariant(variantId, { campaignId, draftId: value.draft.id, label: "Variant A", sortOrder: 0, enabled: true }, now);
    campaigns.setVariantApprovalHashes(campaignId, new Map([[variantId, "hash-variant-a-12345"]]));
    campaigns.setStatus(campaignId, "APPROVED");
    campaigns.addPlanItem(planItemId, { campaignId, variantId, accountId: value.accountId, groupId: value.group.id, sortOrder: 0 }, now);

    value.queue.insertBatch([{
      id: queueItemId,
      draftId: value.draft.id,
      accountId: value.accountId,
      groupId: value.group.id,
      draftTitle: "Campaign Post",
      body: "Post body",
      accountName: "Operator",
      groupName: "Group",
      groupUrl: "https://facebook.com/groups/test",
      snapshotHash: "hash-variant-a-12345",
      campaignId,
      campaignVariantId: variantId,
      media: [],
      createdAt: now,
    }]);

    try {
      // 2. Create managed backup
      const backup = await createManagedBackup(value.db, value.paths.backups, "MANUAL");
      expect(backup.schemaVersion).toBe(8);
      expect(backup.kind).toBe("MANUAL");

      const validated = validateManagedBackup(value.paths.backups, backup.id);
      expect(validated.schemaVersion).toBe(8);

      // 3. Mutate database (delete campaign and linked entities)
      value.db.prepare("DELETE FROM queue_items WHERE id = ?").run(queueItemId);
      value.db.prepare("DELETE FROM campaign_plan_items WHERE id = ?").run(planItemId);
      value.db.prepare("DELETE FROM campaign_variants WHERE id = ?").run(variantId);
      value.db.prepare("DELETE FROM campaigns WHERE id = ?").run(campaignId);

      expect(campaigns.get(campaignId)).toBeUndefined();
      expect(value.queue.get(queueItemId)).toBeUndefined();

      // 4. Restore database from backup
      value.db.close();
      const backupPath = resolveManagedBackup(value.paths.backups, backup.id);
      const BetterSqlite3 = (await import("better-sqlite3")).default;
      const backupCandidate = new BetterSqlite3(backupPath, { readonly: true });
      await backupCandidate.backup(value.paths.database);
      backupCandidate.close();

      // 5. Reopen database and verify all campaign + variant + plan item + queue item provenance survived
      const reopenedDb = openDatabase(value.paths);
      try {
        const reopenedCampaigns = new CampaignRepository(reopenedDb);
        const reopenedQueue = new QueueRepository(reopenedDb);

        const camp = reopenedCampaigns.get(campaignId);
        expect(camp).toBeDefined();
        expect(camp?.name).toBe("Summer Campaign 2026");
        expect(camp?.status).toBe("APPROVED");

        const variant = reopenedCampaigns.getVariant(variantId);
        expect(variant).toBeDefined();
        expect(variant?.label).toBe("Variant A");
        expect(variant?.approvedSnapshotHash).toBe("hash-variant-a-12345");

        const planItem = reopenedCampaigns.getPlanItem(planItemId);
        expect(planItem).toBeDefined();
        expect(planItem?.campaignId).toBe(campaignId);
        expect(planItem?.variantId).toBe(variantId);

        const qItem = reopenedQueue.get(queueItemId);
        expect(qItem).toBeDefined();
        expect(qItem?.campaignId).toBe(campaignId);
        expect(qItem?.campaignVariantId).toBe(variantId);
        expect(qItem?.campaignName).toBe("Summer Campaign 2026");
        expect(qItem?.campaignVariantLabel).toBe("Variant A");
      } finally {
        reopenedDb.close();
      }
    } finally {
      // closed in try/finally
    }
  });
});
