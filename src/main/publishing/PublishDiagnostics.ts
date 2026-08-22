import { shell } from 'electron';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Page } from 'playwright';
import { AppError } from '@main/errors';

export class PublishDiagnostics {
  constructor(public readonly root: string, private readonly retention = 50) { this.assertRoot(); }

  async capture(page: Page, attemptId: string, errorCode: string): Promise<string | undefined> {
    try {
      const root = this.assertRoot(); const safeCode = errorCode.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 60); const path = join(root, `${Date.now()}-${attemptId}-${safeCode}.png`);
      await page.screenshot({ path, fullPage: false }); await this.prune(); return path;
    } catch { return undefined; }
  }

  async open(path: string): Promise<void> {
    const safe = this.assertPath(path); const result = await shell.openPath(safe); if (result) throw new AppError('INVALID_PROFILE_PATH', 'Unable to open diagnostic screenshot.');
  }

  async delete(path: string): Promise<void> { const safe = this.assertPath(path); await rm(safe, { force: true }); }

  assertPath(path: string): string {
    const root = this.assertRoot(); const target = resolve(path); const child = relative(root, target);
    if (!child || child.startsWith('..') || child.includes('\\') || child.includes('/') || basename(target) !== child) throw new AppError('INVALID_PROFILE_PATH', 'Diagnostic path is outside managed storage.');
    const info = lstatSync(target); if (info.isSymbolicLink() || !info.isFile()) throw new AppError('INVALID_PROFILE_PATH', 'Diagnostic is not a regular file.'); return target;
  }

  private assertRoot(): string {
    const root = resolve(this.root); mkdirSync(root, { recursive: true }); const info = lstatSync(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError('INVALID_PROFILE_PATH', 'Diagnostic root must be a regular directory.');
    const real = realpathSync.native(root); if (process.platform === 'win32' ? real.toLowerCase() !== root.toLowerCase() : real !== root) throw new AppError('INVALID_PROFILE_PATH', 'Diagnostic root cannot redirect outside application data.');
    return root;
  }

  private async prune(): Promise<void> {
    await mkdir(this.root, { recursive: true }); const entries = await readdir(this.root, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.png')).map((entry) => entry.name).sort().reverse();
    await Promise.all(files.slice(this.retention).map((name) => rm(join(this.root, name), { force: true })));
  }
}
