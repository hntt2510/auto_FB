import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('reports deterministic order, missing files, invalid signatures, and root escapes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'media-report-')); const mediaRoot = join(root, 'media'); mkdirSync(mediaRoot); const service = new MediaStorageService(mediaRoot); const valid = join(mediaRoot, 'valid.png'); const invalid = join(mediaRoot, 'invalid.png'); const outside = join(root, 'outside.png'); writeFileSync(valid, Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1])); writeFileSync(invalid, 'not-png'); writeFileSync(outside, Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]));
    try { const report = await service.preflightReport([{ id: crypto.randomUUID(), type: 'IMAGE', originalName: 'missing.png', localPath: join(mediaRoot, 'missing.png'), sortOrder: 3 }, { id: crypto.randomUUID(), type: 'IMAGE', originalName: 'outside.png', localPath: outside, sortOrder: 2 }, { id: crypto.randomUUID(), type: 'IMAGE', originalName: 'invalid.png', localPath: invalid, sortOrder: 1 }, { id: crypto.randomUUID(), type: 'IMAGE', originalName: 'valid.png', localPath: valid, sortOrder: 0 }]); expect(report.items.map((item) => item.originalName)).toEqual(['valid.png','invalid.png','outside.png','missing.png']); expect(report.items.map((item) => item.state)).toEqual(['READY_FOR_UPLOAD','INVALID_SIGNATURE','UNSUPPORTED','MISSING']); expect(report.ready).toBe(false); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
