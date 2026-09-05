/* global process, console */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const RELEASE_DIR = 'release';
const OUTPUT = join(RELEASE_DIR, 'release-manifest.json');

async function hashFile(path) {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

async function collectFiles(dir, root = dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(full, root));
    } else if (entry.isFile() && !entry.name.endsWith('.blockmap') && entry.name !== 'release-manifest.json') {
      const info = await stat(full);
      files.push({ path: relative(root, full).replace(/\\/g, '/'), sha256: await hashFile(full), size: info.size });
    }
  }
  return files;
}

async function main() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  console.log(`Generating release manifest for v${pkg.version}...`);
  const files = await collectFiles(RELEASE_DIR);
  if (files.length === 0) {
    console.error('No files found in release/. Run electron-builder first.');
    process.exit(1);
  }
  const manifest = {
    version: pkg.version,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    files: files.sort((a, b) => a.path.localeCompare(b.path))
  };
  await writeFile(OUTPUT, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Wrote ${OUTPUT} with ${files.length} file(s).`);
}

main().catch((error) => { console.error(error); process.exit(1); });
