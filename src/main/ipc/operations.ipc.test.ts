import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(
  () =>
    new Map<
      string,
      (
        event: { sender: { id: number } },
        ...args: unknown[]
      ) => Promise<unknown>
    >(),
);
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (
        event: { sender: { id: number } },
        ...args: unknown[]
      ) => Promise<unknown>,
    ) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

import type { OperationsService } from "@main/services/OperationsService";
import { registerOperationsIpc } from "./operations.ipc";

describe("operations IPC authorization and validation", () => {
  beforeEach(() => handlers.clear());
  it("rejects an unauthorized renderer on every privileged operations channel", async () => {
    const cleanup = registerOperationsIpc(
      {} as OperationsService,
      () => new Set([1]),
    );
    try {
      expect(handlers.size).toBe(10);
      for (const handler of handlers.values())
        await expect(handler({ sender: { id: 99 } })).resolves.toMatchObject({
          ok: false,
          error: { code: "UNAUTHORIZED_IPC" },
        });
    } finally {
      cleanup();
    }
  });
  it("rejects malformed history, backup, and orphan cleanup payloads before services run", async () => {
    const service = {
      history: vi.fn(),
      restoreBackup: vi.fn(),
      cleanOrphanMedia: vi.fn(),
    } as unknown as OperationsService;
    const cleanup = registerOperationsIpc(service, () => new Set([1]));
    try {
      await expect(
        handlers.get("operations:history")!(
          { sender: { id: 1 } },
          { from: "not-a-date" },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      await expect(
        handlers.get("operations:restore-backup")!(
          { sender: { id: 1 } },
          "..\\app.db",
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      await expect(
        handlers.get("operations:clean-orphan-media")!(
          { sender: { id: 1 } },
          { candidateIds: ["bad"] },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      expect(service.history).not.toHaveBeenCalled();
      expect(service.restoreBackup).not.toHaveBeenCalled();
      expect(service.cleanOrphanMedia).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
