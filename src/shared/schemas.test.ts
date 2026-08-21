import { describe, expect, it } from 'vitest';
import { createAccountSchema, updateAccountSchema } from './schemas';

describe('account schemas', () => {
  it('accepts direct and authenticated fixed proxy accounts', () => {
    expect(createAccountSchema.safeParse({ name: 'FB01', profileName: 'fb01', proxyEnabled: false }).success).toBe(true);
    expect(createAccountSchema.safeParse({ name: 'FB02', profileName: 'fb02', proxyEnabled: true, proxyHost: '127.0.0.1', proxyPort: 8080, proxyUsername: 'user', proxyPassword: 'secret' }).success).toBe(true);
  });

  it('rejects invalid ports, missing proxy host, and incomplete credentials', () => {
    expect(createAccountSchema.safeParse({ name: 'FB', profileName: 'fb', proxyEnabled: true, proxyHost: 'host', proxyPort: 70000 }).success).toBe(false);
    expect(createAccountSchema.safeParse({ name: 'FB', profileName: 'fb', proxyEnabled: true, proxyPort: 80 }).success).toBe(false);
    expect(createAccountSchema.safeParse({ name: 'FB', profileName: 'fb', proxyEnabled: true, proxyHost: 'host', proxyPort: 80, proxyUsername: 'user' }).success).toBe(false);
  });

  it('does not allow a password without a username on update', () => {
    expect(updateAccountSchema.safeParse({ accountId: '00000000-0000-0000-0000-000000000000', name: 'FB', proxyEnabled: true, proxyHost: 'host', proxyPort: 80, proxyPassword: 'secret' }).success).toBe(false);
  });
});
