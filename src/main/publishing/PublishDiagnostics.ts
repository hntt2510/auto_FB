import { shell } from 'electron';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Page } from 'playwright';
import { AppError } from '@main/errors';
import type { SelectorProbeResult } from '@shared/types';

export function selectorDiagnosticSummary(probe: SelectorProbeResult, appVersion: string): string {
  const fields = ['session', 'group', 'composerTrigger', 'composerTextbox', 'mediaInput', 'postButton', 'uploadBusy', 'approvalSignal', 'acceptanceSignal'] as const;
  const lines = ['appVersion=' + appVersion, 'selectorVersion=' + probe.selectorVersion, 'status=' + probe.status, 'timestamp=' + probe.checkedAt];
  for (const field of fields) lines.push(field + '=' + probe[field].status + (probe[field].count === undefined ? '' : ' count=' + probe[field].count));
  if (probe.editorType) lines.push('editorType=' + probe.editorType);
  if (probe.contentObserved !== undefined) lines.push('contentObserved=' + (probe.contentObserved ? 'YES' : 'NO'));
  if (probe.observedContentLength !== undefined) lines.push('observedContentLength=' + probe.observedContentLength);
  if (probe.expectedContentLength !== undefined) lines.push('expectedContentLength=' + probe.expectedContentLength);
  if (probe.entryMethod) lines.push('entryMethod=' + probe.entryMethod);
  if (probe.reason) lines.push('reason=' + probe.reason);
  if (probe.triggerStrategy) lines.push('triggerStrategy=' + probe.triggerStrategy);
  if (probe.triggerCandidates?.length) lines.push('triggerCandidates=' + probe.triggerCandidates.map((candidate) => [candidate.role, candidate.ariaLabel, candidate.title, candidate.text].filter(Boolean).join(' ')).join(' | '));
  if (probe.createPostDialog) lines.push('createPostDialog=' + probe.createPostDialog.status + (probe.createPostDialog.count === undefined ? '' : ' count=' + probe.createPostDialog.count));
  if (probe.dialogTitle) lines.push('dialogTitle=' + probe.dialogTitle);
  if (probe.dialogCandidates?.length) lines.push('dialogCandidates=' + probe.dialogCandidates.map((candidate) => [candidate.title, candidate.newAfterTrigger === undefined ? '' : candidate.newAfterTrigger ? 'newAfterTrigger=YES' : 'newAfterTrigger=NO', candidate.changedAfterTrigger ? 'changedAfterTrigger=YES' : '', candidate.visible === undefined ? '' : candidate.visible ? 'visible=YES' : 'visible=NO', candidate.foreground === undefined ? '' : candidate.foreground ? 'foreground=YES' : 'foreground=NO'].filter(Boolean).join(' ')).join(' | '));
  if (probe.rawEditorCount !== undefined) lines.push('rawEditorCount=' + probe.rawEditorCount);
  if (probe.logicalEditorCount !== undefined) lines.push('logicalEditorCount=' + probe.logicalEditorCount);
  if (probe.textboxStrategy) lines.push('textboxStrategy=' + probe.textboxStrategy);
  if (probe.textboxCandidates?.length) lines.push('textboxCandidates=' + probe.textboxCandidates.map((candidate) => [candidate.tag, candidate.role, candidate.contenteditable, candidate.ariaLabel, candidate.placeholder, candidate.ariaMultiline, candidate.lexicalEditor, candidate.groupId === undefined ? '' : 'group=' + candidate.groupId, candidate.focusable === undefined ? '' : candidate.focusable ? 'focusable=YES' : 'focusable=NO', candidate.boundingBox ? `box=${candidate.boundingBox.x},${candidate.boundingBox.y},${candidate.boundingBox.width},${candidate.boundingBox.height}` : '', candidate.visible === undefined ? '' : candidate.visible ? 'visible=YES' : 'visible=NO'].filter(Boolean).join(' ')).join(' | '));
  if (probe.diagnosticPath) lines.push('diagnosticPath=' + probe.diagnosticPath);
  if (probe.warnings.length) lines.push('warnings=' + probe.warnings.join(' | '));
  return lines.join('\n');
}

export class PublishDiagnostics {
  constructor(public readonly root: string, private readonly retention = 50) { this.assertRoot(); }

  async capture(page: Page, attemptId: string, errorCode: string): Promise<string | undefined> {
    try {
      const root = this.assertRoot(); const safeCode = errorCode.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 60); const path = join(root, `${Date.now()}-${attemptId}-${safeCode}.png`);
      await page.screenshot({ path, fullPage: false }); await this.prune(); return path;
    } catch { return undefined; }
  }

  async capturePreflight(page: Page, queueId: string, status: SelectorProbeResult['status']): Promise<string | undefined> {
    try {
      const root = this.assertRoot(); const safeStatus = status.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 20); const path = join(root, `${Date.now()}-preflight-${queueId}-${safeStatus}.png`);
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
    const real = realpathSync(root); if (process.platform === 'win32' ? real.toLowerCase() !== root.toLowerCase() : real !== root) throw new AppError('INVALID_PROFILE_PATH', 'Diagnostic root cannot redirect outside application data.');
    return root;
  }

  private async prune(): Promise<void> {
    await mkdir(this.root, { recursive: true }); const entries = await readdir(this.root, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.png')).map((entry) => entry.name).sort().reverse();
    await Promise.all(files.slice(this.retention).map((name) => rm(join(this.root, name), { force: true })));
  }
}
