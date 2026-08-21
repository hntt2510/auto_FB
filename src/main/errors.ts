import type { ApiErrorCode } from '@shared/types';

export class AppError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string) { super(message); this.name = 'AppError'; }
}

export function toApiError(error: unknown): { code: ApiErrorCode; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
  return { code: 'UNKNOWN_ERROR', message: sanitizeMessage(message) };
}

export function sanitizeMessage(message: string): string {
  return message.replace(/(password|cookie|token|access_token)[^\s]*/gi, '$1 [redacted]').slice(0, 500);
}
