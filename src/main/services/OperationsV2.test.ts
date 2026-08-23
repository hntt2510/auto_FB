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
import { OperationsService } from "./OperationsService";
import type { PublishScheduler } from "@main/publishing/PublishScheduler";

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
      ).toBe(4);
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
      appVersion: "0.7.0",
      databaseSchema: 4,
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
});
