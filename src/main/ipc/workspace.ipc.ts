import type { DashboardService } from '@main/services/DashboardService';
import type { DraftService } from '@main/services/DraftService';
import type { GroupService } from '@main/services/GroupService';
import type { QueueService } from '@main/services/QueueService';
import { registerDashboardIpc } from './dashboard.ipc';
import { registerDraftIpc } from './drafts.ipc';
import { registerGroupIpc } from './groups.ipc';
import { registerQueueIpc } from './queue.ipc';
import type { PublishingService } from '@main/publishing/PublishingService';
import type { PublishingSettingsService } from '@main/publishing/PublishingSettingsService';
import { registerPublishingIpc } from './publishing.ipc';
import { registerSettingsIpc } from './settings.ipc';
import type { OperationsService } from '@main/services/OperationsService';
import { registerOperationsIpc } from './operations.ipc';
import type { OnboardingService } from '@main/services/OnboardingService';
import { registerOnboardingIpc } from './onboarding.ipc';
import type { AccountSessionService } from '@main/services/AccountSessionService';

export function registerWorkspaceIpc(services: { groups: GroupService; drafts: DraftService; queue: QueueService; dashboard: DashboardService; onboarding: OnboardingService; accountSessions: AccountSessionService; publishing: PublishingService; settings: PublishingSettingsService; operations: OperationsService }, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [registerGroupIpc(services.groups, allowedSenderIds), registerDraftIpc(services.drafts, allowedSenderIds), registerQueueIpc(services.queue, allowedSenderIds), registerDashboardIpc(services.dashboard, allowedSenderIds), registerOnboardingIpc(services.onboarding, services.accountSessions, allowedSenderIds), registerPublishingIpc(services.publishing, allowedSenderIds), registerSettingsIpc(services.settings, allowedSenderIds), registerOperationsIpc(services.operations, allowedSenderIds)];
  return () => cleanups.forEach((cleanup) => cleanup());
}
