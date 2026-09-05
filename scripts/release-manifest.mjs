/* global process, console */
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export async function computeReleaseManifest({ releaseDir = 'release', packageJsonPath = 'package.json' } = {}) {
  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const version = pkg.version;
  if (!version) {
    throw new Error(`Package version missing in ${packageJsonPath}`);
  }

  const expectedArtifacts = [
    `Facebook Account Manager Setup ${version}.exe`,
    join('win-unpacked', 'Facebook Account Manager.exe')
  ];

  const artifacts = [];
  for (const relPath of expectedArtifacts) {
    const fullPath = join(releaseDir, relPath);
    try {
      const fileStat = await stat(fullPath);
      if (!fileStat.isFile()) {
        throw new Error(`Artifact is not a regular file: ${fullPath}`);
      }
      const sha256 = await hashFile(fullPath);
      artifacts.push({
        path: relPath.replace(/\\/g, '/'),
        sha256,
        byteSize: fileStat.size
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Required release artifact is missing: ${fullPath}`);
      }
      throw err;
    }
  }

  return {
    appVersion: version,
    version,
    generatedAt: new Date().toISOString(),
    artifacts
  };
}

export async function main() {
  const releaseDir = process.env.RELEASE_DIR || 'release';
  console.log(`Generating release manifest from ${releaseDir}...`);
  const manifest = await computeReleaseManifest({ releaseDir });
  const outputPath = join(releaseDir, 'release-manifest.json');
  await writeFile(outputPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Wrote release manifest to ${outputPath}:`);
  for (const a of manifest.artifacts) {
    console.log(`  - ${a.path} (${a.byteSize} bytes) sha256: ${a.sha256}`);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    console.error('Failed to generate release manifest:', error.message);
    process.exit(1);
  });
}

