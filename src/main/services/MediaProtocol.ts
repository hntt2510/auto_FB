import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import type { DraftRepository } from '@main/db/repositories/DraftRepository';
import { MediaStorageService } from './MediaStorageService';

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app-media', privileges: { secure: true, supportFetchAPI: true, stream: true } }]);
}

export function registerMediaProtocol(drafts: DraftRepository, storage: MediaStorageService): void {
  protocol.handle('app-media', async (request) => {
    try {
      const url = new URL(request.url); if (url.hostname !== 'asset') return new Response('Not found', { status: 404 });
      const asset = drafts.mediaAsset(decodeURIComponent(url.pathname.replace(/^\//, ''))); if (!asset) return new Response('Not found', { status: 404 });
      const safePath = storage.assertManagedPath(asset.local_path);
      return net.fetch(pathToFileURL(safePath).toString());
    } catch { return new Response('Not found', { status: 404 }); }
  });
}
