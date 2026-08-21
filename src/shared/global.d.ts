import type { AccountApi, LogApi } from './types';

declare global {
  interface Window {
    accountApi: AccountApi;
    logApi: LogApi;
  }
}

export {};
