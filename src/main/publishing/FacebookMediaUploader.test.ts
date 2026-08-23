import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MediaStorageService } from "@main/services/MediaStorageService";
import type { QueueRecord } from "@main/db/repositories/QueueRepository";
import { FacebookMediaUploader } from "./FacebookMediaUploader";
import { FacebookPublisher } from "./FacebookPublisher";
import { PublishingError } from "./PublishingError";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "media-uploader-"));
  const mediaRoot = join(root, "media");
  mkdirSync(mediaRoot);
  const first = join(mediaRoot, `${crypto.randomUUID()}.png`);
  const second = join(mediaRoot, `${crypto.randomUUID()}.png`);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  writeFileSync(first, png);
  writeFileSync(second, png);
  const item: QueueRecord = {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    groupId: crypto.randomUUID(),
    draftTitle: "Media",
    body: "Body",
    accountName: "Account",
    groupName: "Group",
    groupUrl: "https://www.facebook.com/groups/test",
    status: "PENDING",
    snapshotHash: "hash",
    media: [
      {
        id: crypto.randomUUID(),
        type: "IMAGE",
        originalName: "second.png",
        storedName: "second.png",
        localPath: second,
        fileSize: png.length,
        sortOrder: 1,
      },
      {
        id: crypto.randomUUID(),
        type: "IMAGE",
        originalName: "first.png",
        storedName: "first.png",
        localPath: first,
        fileSize: png.length,
        sortOrder: 0,
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    root,
    storage: new MediaStorageService(mediaRoot),
    item,
    first,
    second,
  };
}

describe("FacebookMediaUploader", () => {
  it("prepares multiple files in immutable sort order", async () => {
    const value = fixture();
    try {
      const uploader = new FacebookMediaUploader(
        { uploadMedia: vi.fn() } as never,
        value.storage,
      );
      const prepared = await uploader.prepare(value.item);
      expect(prepared.paths).toEqual([value.first, value.second]);
      expect(prepared.report.items.map((item) => item.sortOrder)).toEqual([
        0, 1,
      ]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
  it("never reaches Post submission when upload readiness times out", async () => {
    const value = fixture();
    const submit = vi.fn();
    const adapter = {
      selectorsVersion: "2026-08-v4",
      openGroup: vi.fn(),
      captureBaseline: vi.fn(() => ({})),
      openComposer: vi.fn(() => ({ container: {} })),
      fillContent: vi.fn(),
      uploadMedia: vi.fn(() => {
        throw new PublishingError("MEDIA_UPLOAD_TIMEOUT", "Upload timed out.");
      }),
      submit,
    } as never;
    try {
      const publisher = new FacebookPublisher(adapter, value.storage);
      await expect(
        publisher.publish(
          {} as never,
          value.item,
          {
            enabled: true,
            executionMode: "LIVE",
            schedulerIntervalSeconds: 30,
            maxConcurrentAccounts: 1,
            videoUploadTimeoutSeconds: 60,
            maxJobsPerSchedulerSession: 20,
          },
          vi.fn(),
        ),
      ).rejects.toMatchObject({ code: "MEDIA_UPLOAD_TIMEOUT" });
      expect(submit).not.toHaveBeenCalled();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});
