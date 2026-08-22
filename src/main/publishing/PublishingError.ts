import type { ApiErrorCode } from '@shared/types';

export class PublishingError extends Error {
  constructor(public readonly code: Extract<ApiErrorCode, 'ACCOUNT_LOGIN_REQUIRED' | 'ACCOUNT_CHECKPOINT' | 'GROUP_UNAVAILABLE' | 'GROUP_PERMISSION_DENIED' | 'COMPOSER_NOT_FOUND' | 'CONTENT_FILL_FAILED' | 'MEDIA_FILE_MISSING' | 'MEDIA_UPLOAD_FAILED' | 'MEDIA_UPLOAD_TIMEOUT' | 'SUBMIT_FAILED' | 'SUBMISSION_UNKNOWN' | 'NETWORK_ERROR' | 'BROWSER_CLOSED' | 'EXECUTION_CANCELLED'>, message: string, public readonly afterSubmit = false) { super(message); this.name = 'PublishingError'; }
}
