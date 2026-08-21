import { dialog } from 'electron';
import { copyFile, mkdir, open, rm, stat, lstat } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaType } from '@shared/types';
import { AppError } from '@main/errors';

export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);

export type ManagedMediaFile = { id: string; type: MediaType; originalName: string; storedName: string; localPath: string; mimeType: string; fileSize: number };

export class MediaStorageService {
  constructor(public readonly root: string) {}

  async chooseAndCopy(): Promise<ManagedMediaFile | undefined> {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Media', extensions: ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov', 'webm'] }] });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return this.copyIn(result.filePaths[0]);
  }

  async copyIn(sourcePath: string): Promise<ManagedMediaFile> {
    const source = resolve(sourcePath);
    const sourceInfo = await stat(source).catch(() => undefined);
    if (!sourceInfo?.isFile()) throw new AppError('MEDIA_INVALID', 'Selected media file is unavailable.');
    const extension = extname(source).toLowerCase();
    const type = IMAGE_EXTENSIONS.has(extension) ? 'IMAGE' : VIDEO_EXTENSIONS.has(extension) ? 'VIDEO' : undefined;
    if (!type) throw new AppError('MEDIA_INVALID', 'Unsupported media format.');
    const max = type === 'IMAGE' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
    if (sourceInfo.size > max) throw new AppError('MEDIA_TOO_LARGE', `Media exceeds the ${type === 'IMAGE' ? '25 MiB' : '500 MiB'} limit.`);
    const handle = await open(source, 'r'); const signature = Buffer.alloc(16);
    try { await handle.read(signature, 0, signature.length, 0); } finally { await handle.close(); }
    if (!hasValidSignature(type, extension, signature)) throw new AppError('MEDIA_INVALID', 'Media file signature does not match its extension.');
    const id = randomUUID(); const storedName = `${id}${extension}`; const localPath = join(resolve(this.root), storedName);
    await mkdir(this.root, { recursive: true });
    await copyFile(source, localPath);
    return { id, type, originalName: basename(source).slice(0, 255), storedName, localPath, mimeType: mimeFor(extension), fileSize: sourceInfo.size };
  }

  assertManagedPath(filePath: string): string {
    const root = resolve(this.root); const target = resolve(filePath); const relativePath = relative(root, target);
    if (!relativePath || relativePath.startsWith('..') || relativePath.includes('\\') || relativePath.includes('/') || !existsSync(target)) throw new AppError('INVALID_PROFILE_PATH', 'Media path is outside managed storage.');
    const info = lstatSync(target); if (info.isSymbolicLink() || !info.isFile()) throw new AppError('MEDIA_INVALID', 'Managed media path is not a regular file.');
    return target;
  }

  async deleteManagedFile(filePath: string): Promise<void> {
    const target = this.assertManagedPath(filePath);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new AppError('MEDIA_INVALID', 'Managed media path is not a regular file.');
    await rm(target, { force: false });
  }

  previewUrl(assetId: string): string { return `app-media://asset/${encodeURIComponent(assetId)}`; }
}

export function hasValidSignature(type: MediaType, extension: string, signature: Uint8Array): boolean {
  if (type === 'IMAGE' && (extension === '.jpg' || extension === '.jpeg')) return signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  if (type === 'IMAGE' && extension === '.png') return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => signature[index] === value);
  if (type === 'IMAGE' && extension === '.webp') return text(signature, 0, 4) === 'RIFF' && text(signature, 8, 4) === 'WEBP';
  if (type === 'VIDEO' && (extension === '.mp4' || extension === '.mov')) return text(signature, 4, 4) === 'ftyp';
  if (type === 'VIDEO' && extension === '.webm') return signature[0] === 0x1a && signature[1] === 0x45 && signature[2] === 0xdf && signature[3] === 0xa3;
  return false;
}

function text(bytes: Uint8Array, start: number, length: number): string { return String.fromCharCode(...bytes.slice(start, start + length)); }
function mimeFor(extension: string): string { return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' } as Record<string, string>)[extension] ?? 'application/octet-stream'; }
