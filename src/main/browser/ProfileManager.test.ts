import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileManager, ProfilePathError } from './ProfileManager';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('ProfileManager', () => {
  it('accepts safe names and rejects traversal and reserved names', () => {
    const root = mkdtempSync(join(tmpdir(), 'fb-profile-')); roots.push(root); const manager = new ProfileManager(root);
    expect(manager.getProfileDirectory('fb-shop-01')).toBe(join(root, 'fb-shop-01'));
    expect(() => manager.getProfileDirectory('../escape')).toThrow(ProfilePathError);
    expect(() => manager.getProfileDirectory('CON')).toThrow(ProfilePathError);
    expect(() => manager.getProfileDirectory('name.')).toThrow(ProfilePathError);
  });

  it('prevents duplicate profiles and safely removes controlled profiles', () => {
    const root = mkdtempSync(join(tmpdir(), 'fb-profile-')); roots.push(root); const manager = new ProfileManager(root);
    const profile = manager.createProfile('fb01');
    expect(existsSync(profile)).toBe(true);
    expect(() => manager.createProfile('fb01')).toThrow('already exists');
    manager.deleteProfile(profile); expect(existsSync(profile)).toBe(false);
  });
});
