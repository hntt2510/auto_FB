import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { AppError, toApiError } from '@main/errors';
import { isAuthorizedIpcSender } from './senderPolicy';

export type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: ReturnType<typeof toApiError> };

export function registerAuthorizedHandler<TArgs extends unknown[], TResult>(
  channel: string,
  allowedSenderIds: () => ReadonlySet<number>,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>
): () => void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!isAuthorizedIpcSender(event.sender.id, allowedSenderIds())) {
        throw new AppError('UNAUTHORIZED_IPC', 'Unauthorized renderer.');
      }
      return { ok: true, data: await handler(event, ...(args as TArgs)) } satisfies IpcResponse<TResult>;
    } catch (error) {
      return { ok: false, error: toApiError(error) } satisfies IpcResponse<TResult>;
    }
  });
  return () => ipcMain.removeHandler(channel);
}

export function parseOrThrow<T>(result: { success: true; data: T } | { success: false; error: { issues: Array<{ message?: string }> } }): T {
  if (!result.success) throw new AppError('INVALID_REQUEST', result.error.issues[0]?.message ?? 'Invalid request.');
  return result.data;
}
