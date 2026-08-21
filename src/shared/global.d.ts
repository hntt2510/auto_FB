import type { AccountApi, DashboardApi, DraftApi, GroupApi, LogApi, QueueApi } from './types';

declare global {
  interface Window {
    accountApi: AccountApi;
    logApi: LogApi;
    groupApi: GroupApi;
    draftApi: DraftApi;
    queueApi: QueueApi;
    dashboardApi: DashboardApi;
  }
}

export {};
