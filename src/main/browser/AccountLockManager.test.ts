import { describe, expect, it } from 'vitest';
import { AccountLockManager } from './AccountLockManager';

describe('AccountLockManager', () => {
  it('allows one owner and releases it', () => {
    const locks = new AccountLockManager();
    expect(locks.acquire('a')).toBe(true); expect(locks.isLocked('a')).toBe(true); expect(locks.acquire('a')).toBe(false);
    locks.release('a'); expect(locks.isLocked('a')).toBe(false); expect(locks.acquire('a')).toBe(true);
  });
});
