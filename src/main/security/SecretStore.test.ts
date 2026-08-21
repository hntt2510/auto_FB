import { describe, expect, it } from 'vitest';
import { SecretStore, SecretStoreError, type SafeStorageLike } from './SecretStore';

function setup(available = true) {
  const values = new Map<string, string>();
  const storage: SafeStorageLike = { isEncryptionAvailable: () => available, encryptString: (value) => Buffer.from(`enc:${value}`), decryptString: (value) => value.toString().replace(/^enc:/, '') };
  return { store: new SecretStore({ get: (key: string) => values.get(key), set: (key: string, value: string) => { values.set(key, value); }, delete: (key: string) => { values.delete(key); } } as never, storage), values };
}

describe('SecretStore', () => {
  it('encrypts, reads, replaces, and deletes secrets through the settings abstraction', () => {
    const { store, values } = setup(); const key = store.set('proxy-password');
    expect(values.get(key)).toBe(Buffer.from('enc:proxy-password').toString('base64')); expect(store.get(key)).toBe('proxy-password');
    store.set('replacement', key); expect(store.get(key)).toBe('replacement'); store.delete(key); expect(values.has(key)).toBe(false);
  });

  it('rejects encryption when safe storage is unavailable', () => {
    const { store } = setup(false); expect(() => store.set('secret')).toThrow(SecretStoreError);
  });
});
