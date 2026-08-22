import type { AccountApi, DashboardApi, DraftApi, GroupApi, LogApi, PublishApi, PublishingSettingsApi, QueueApi } from './types';

declare global {
  interface Window {
    accountApi: AccountApi;
    logApi: LogApi;
    groupApi: GroupApi;
    draftApi: DraftApi;
    queueApi: QueueApi;
    dashboardApi: DashboardApi;
    publishApi: PublishApi;
    settingsApi: PublishingSettingsApi;
  }
}

export {};
