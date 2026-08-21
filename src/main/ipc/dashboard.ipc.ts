import type { DashboardService } from '@main/services/DashboardService';
import { registerAuthorizedHandler } from './authorized';

export function registerDashboardIpc(service: DashboardService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  return registerAuthorizedHandler('dashboard:summary', allowedSenderIds, () => service.summary());
}
