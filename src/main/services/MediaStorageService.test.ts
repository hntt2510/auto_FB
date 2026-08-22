import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasValidSignature, MediaStorageService } from './MediaStorageService';

describe('managed media signatures', () => {
  it('accepts matching image/video signatures', () => {
    expect(hasValidSignature('IMAGE', '.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(hasValidSignature('IMAGE', '.jpg', Uint8Array.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect(hasValidSignature('VIDEO', '.mp4', Uint8Array.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]))).toBe(true);
    expect(hasValidSignature('VIDEO', '.webm', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
  });

  it('rejects mismatched signatures', () => {
    expect(hasValidSignature('IMAGE', '.png', Uint8Array.from([0xff, 0xd8, 0xff]))).toBe(false);
    expect(hasValidSignature('VIDEO', '.mp4', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(false);
  });

  it('rejects a managed media root that redirects through a symlink or junction', () => {
    const root = mkdtempSync(join(tmpdir(), 'media-root-')); const target = join(root, 'outside'); const link = join(root, 'media'); mkdirSync(target);
    try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); expect(() => new MediaStorageService(link)).toThrow(/root|redirect/i); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
