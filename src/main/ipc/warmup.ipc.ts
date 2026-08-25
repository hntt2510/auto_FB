import type { BrowserWindow as BW } from "electron";
import { BrowserWindow } from "electron";
import { registerAuthorizedHandler } from "./authorized";
import { warmupStartSchema, warmupAccountIdSchema, warmupConfigUpdateSchema, warmupListLogsSchema } from "@shared/schemas";
import type { WarmupService } from "@main/warmup/WarmupService";

export function broadcastWarmupChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("warmup:changed");
  }
}

export function registerWarmupIpc(service: WarmupService, allowedSenderIds?: () => ReadonlySet<number>): () => void {
  const senders = allowedSenderIds ?? (() => new Set((BrowserWindow.getAllWindows() as BW[]).map((w) => w.webContents.id)));

  const cleanups = [
    registerAuthorizedHandler("warmup:get-progress", senders, (_e, accountId) => {
      const { accountId: id } = parseOrThrow(warmupAccountIdSchema.safeParse({ accountId }));
      return service.getProgress(id);
    }),
    registerAuthorizedHandler("warmup:list-all", senders, () => service.listAll()),
    registerAuthorizedHandler("warmup:start", senders, async (_e, input) => service.start(parseOrThrow(warmupStartSchema.safeParse(input)))),
    registerAuthorizedHandler("warmup:stop", senders, (_e, accountId) => {
      const { accountId: id } = parseOrThrow(warmupAccountIdSchema.safeParse({ accountId }));
      return service.stop(id);
    }),
    registerAuthorizedHandler("warmup:pause", senders, (_e, accountId) => {
      const { accountId: id } = parseOrThrow(warmupAccountIdSchema.safeParse({ accountId }));
      return service.pause(id);
    }),
    registerAuthorizedHandler("warmup:resume", senders, async (_e, accountId) => {
      const { accountId: id } = parseOrThrow(warmupAccountIdSchema.safeParse({ accountId }));
      return service.resume(id);
    }),
    registerAuthorizedHandler("warmup:update-config", senders, (_e, input) => {
      const data = parseOrThrow(warmupConfigUpdateSchema.safeParse(input));
      return service.updateConfig(data.accountId, data.config);
    }),
    registerAuthorizedHandler("warmup:get-logs", senders, (_e, input) => {
      const data = parseOrThrow(warmupListLogsSchema.safeParse(input));
      return service.getLogs(data);
    }),
  ];

  return () => { for (const fn of cleanups) fn(); };
}

function parseOrThrow<T>(result: { success: true; data: T } | { success: false; error: { issues: Array<{ message?: string }> } }): T {
  if (!result.success) {
    const { AppError } = require("@main/errors") as typeof import("@main/errors");
    throw new AppError("INVALID_REQUEST", result.error.issues[0]?.message ?? "Invalid warmup request.");
  }
  return result.data;
}
