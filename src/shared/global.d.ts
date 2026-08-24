import type { AccountApi, AppBridge, DashboardApi, DraftApi, GroupApi, LogApi, OnboardingApi, OperationsApi, PublishApi, PublishingSettingsApi, QueueApi } from './types';

declare global {
  interface Window {
    appBridge: AppBridge;
    accountApi: AccountApi;
    logApi: LogApi;
    groupApi: GroupApi;
    draftApi: DraftApi;
    queueApi: QueueApi;
    dashboardApi: DashboardApi;
    onboardingApi: OnboardingApi;
    publishApi: PublishApi;
    settingsApi: PublishingSettingsApi;
    operationsApi: OperationsApi;
  }
}

export {};
