import { randomUUID } from 'node:crypto';
import type { SettingsRepository } from '@main/db/repositories/SettingsRepository';
import type { ApiErrorCode } from '@shared/types';

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export class SecretStoreError extends Error {
  constructor(public readonly code: Extract<ApiErrorCode, 'SECRET_UNAVAILABLE' | 'SECRET_DECRYPT_FAILED'>, message: string) { super(message); }
}

export class SecretStore {
  constructor(private readonly settings: SettingsRepository, private readonly safeStorage: SafeStorageLike) {}

  set(value: string): string {
    if (!this.safeStorage.isEncryptionAvailable()) throw new SecretStoreError('SECRET_UNAVAILABLE', 'Secure secret storage is unavailable on this device.');
    const key = `proxy-password:${randomUUID()}`;
    const encrypted = this.safeStorage.encryptString(value).toString('base64');
    this.settings.set(key, encrypted);
    return key;
  }

  get(key: string): string {
    if (!this.safeStorage.isEncryptionAvailable()) throw new SecretStoreError('SECRET_UNAVAILABLE', 'Secure secret storage is unavailable on this device.');
    const encoded = this.settings.get(key);
    if (!encoded) throw new SecretStoreError('SECRET_DECRYPT_FAILED', 'The stored proxy secret could not be found.');
    try { return this.safeStorage.decryptString(Buffer.from(encoded, 'base64')); }
    catch { throw new SecretStoreError('SECRET_DECRYPT_FAILED', 'The stored proxy secret could not be decrypted.'); }
  }

  delete(key?: string): void { if (key) this.settings.delete(key); }
}
