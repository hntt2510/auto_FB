/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const electronRebuild = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild');
const spawnOptions = { stdio: 'inherit', shell: process.platform === 'win32' };
let testExit = 1;
try {
  const nodeBuild = spawnSync(npm, ['rebuild', 'better-sqlite3'], spawnOptions);
  if (nodeBuild.status !== 0) testExit = nodeBuild.status ?? 1;
  else {
    const tests = spawnSync(npm, ['exec', '--', 'vitest', 'run', ...process.argv.slice(2)], spawnOptions);
    testExit = tests.status ?? 1;
  }
} finally {
  // Keep packaged Electron's native ABI usable even when tests fail.
  const restore = spawnSync(electronRebuild, ['-f', '-w', 'better-sqlite3'], spawnOptions);
  if (testExit === 0 && restore.status !== 0) testExit = restore.status ?? 1;
}
process.exitCode = testExit;
