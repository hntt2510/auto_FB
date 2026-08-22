import type { AccountApi, AppBridge, DashboardApi, DraftApi, GroupApi, LogApi, PublishApi, PublishingSettingsApi, QueueApi } from './types';

declare global {
  interface Window {
    appBridge: AppBridge;
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
