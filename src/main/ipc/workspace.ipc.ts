import type { DashboardService } from '@main/services/DashboardService';
import type { DraftService } from '@main/services/DraftService';
import type { GroupService } from '@main/services/GroupService';
import type { QueueService } from '@main/services/QueueService';
import { registerDashboardIpc } from './dashboard.ipc';
import { registerDraftIpc } from './drafts.ipc';
import { registerGroupIpc } from './groups.ipc';
import { registerQueueIpc } from './queue.ipc';

export function registerWorkspaceIpc(services: { groups: GroupService; drafts: DraftService; queue: QueueService; dashboard: DashboardService }, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [registerGroupIpc(services.groups, allowedSenderIds), registerDraftIpc(services.drafts, allowedSenderIds), registerQueueIpc(services.queue, allowedSenderIds), registerDashboardIpc(services.dashboard, allowedSenderIds)];
  return () => cleanups.forEach((cleanup) => cleanup());
}
