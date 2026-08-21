import { describe, expect, it } from 'vitest';
import { isAuthorizedIpcSender } from './senderPolicy';

describe('IPC sender policy', () => {
  it('accepts only currently registered application renderer ids', () => {
    const allowed = new Set([12, 34]);
    expect(isAuthorizedIpcSender(12, allowed)).toBe(true);
    expect(isAuthorizedIpcSender(99, allowed)).toBe(false);
  });
});
