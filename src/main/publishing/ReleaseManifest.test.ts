import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
// @ts-expect-error - external node script without d.ts
import { computeReleaseManifest, hashFile } from '../../../scripts/release-manifest.mjs';

const roots: string[] = [];
function createTestWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'manifest-test-'));
  roots.push(root);
  const releaseDir = join(root, 'release');
  const winUnpacked = join(releaseDir, 'win-unpacked');
  mkdirSync(winUnpacked, { recursive: true });

  const packageJsonPath = join(root, 'package.json');
  writeFileSync(packageJsonPath, JSON.stringify({ name: 'test-app', version: '0.8.0' }));

  return { root, releaseDir, winUnpacked, packageJsonPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('Release Manifest Generation', () => {
  it('calculates deterministic SHA-256 hex hash', async () => {
    const { root } = createTestWorkspace();
    const testFile = join(root, 'sample.txt');
    const content = 'Facebook Account Manager Release Binary Test';
    writeFileSync(testFile, content);

    const expectedHash = createHash('sha256').update(content).digest('hex');
    const actualHash = await hashFile(testFile);
    expect(actualHash).toBe(expectedHash);
  });

  it('selects intentional distributables and ignores stale installers and auxiliary files', async () => {
    const { releaseDir, winUnpacked, packageJsonPath } = createTestWorkspace();

    // Intentional artifacts
    const installerPath = join(releaseDir, 'Facebook Account Manager Setup 0.8.0.exe');
    writeFileSync(installerPath, 'installer-binary-0.8.0');
    const unpackedExePath = join(winUnpacked, 'Facebook Account Manager.exe');
    writeFileSync(unpackedExePath, 'unpacked-executable-0.8.0');

    // Stale installer from older version
    const staleInstallerPath = join(releaseDir, 'Facebook Account Manager Setup 0.7.0.exe');
    writeFileSync(staleInstallerPath, 'stale-installer-0.7.0');

    // Auxiliary files that must not be in the manifest
    writeFileSync(join(releaseDir, 'builder-debug.yml'), 'some-debug-info');
    writeFileSync(join(releaseDir, 'Facebook Account Manager Setup 0.8.0.exe.blockmap'), 'blockmap-data');

    const manifest = await computeReleaseManifest({ releaseDir, packageJsonPath });

    expect(manifest.appVersion).toBe('0.8.0');
    expect(manifest.version).toBe('0.8.0');
    expect(manifest.generatedAt).toBeTruthy();
    expect(manifest.artifacts).toHaveLength(2);

    const artifactPaths = manifest.artifacts.map((a: { path: string }) => a.path);
    expect(artifactPaths).toEqual([
      'Facebook Account Manager Setup 0.8.0.exe',
      'win-unpacked/Facebook Account Manager.exe'
    ]);

    // Ensure stale installer is completely excluded
    expect(artifactPaths).not.toContain('Facebook Account Manager Setup 0.7.0.exe');
    expect(artifactPaths).not.toContain('builder-debug.yml');

    // Check properties of each artifact
    for (const artifact of manifest.artifacts as Array<{ path: string; sha256: string; byteSize: number }>) {
      expect(artifact.path).toBeDefined();
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.byteSize).toBeGreaterThan(0);
    }
  });

  it('fails closed when the installer is missing', async () => {
    const { releaseDir, winUnpacked, packageJsonPath } = createTestWorkspace();
    // Only create unpacked exe, omit installer
    writeFileSync(join(winUnpacked, 'Facebook Account Manager.exe'), 'unpacked-exe');

    await expect(computeReleaseManifest({ releaseDir, packageJsonPath })).rejects.toThrow(
      /Required release artifact is missing.*Setup 0\.8\.0\.exe/
    );
  });

  it('fails closed when the unpacked executable is missing', async () => {
    const { releaseDir, packageJsonPath } = createTestWorkspace();
    // Only create installer, omit unpacked exe
    writeFileSync(join(releaseDir, 'Facebook Account Manager Setup 0.8.0.exe'), 'installer');

    await expect(computeReleaseManifest({ releaseDir, packageJsonPath })).rejects.toThrow(
      /Required release artifact is missing.*win-unpacked/
    );
  });
});
