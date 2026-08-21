import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { join } from 'node:path';
import { createAppPaths, openDatabase } from './db/database';
import { AccountRepository } from './db/repositories/AccountRepository';
import { AuditLogRepository } from './db/repositories/AuditLogRepository';
import { SettingsRepository } from './db/repositories/SettingsRepository';
import { ProfileManager } from './browser/ProfileManager';
import { SecretStore } from './security/SecretStore';
import { AccountService } from './services/AccountService';
import { broadcastAccounts, registerIpc } from './ipc/accounts.ipc';
import type Database from 'better-sqlite3';

let service: AccountService | undefined;
let cleanupIpc: (() => void) | undefined;
let quitting = false;
let database: Database.Database | undefined;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { for (const window of BrowserWindow.getAllWindows()) { if (window.isMinimized()) window.restore(); window.focus(); } });
  void app.whenReady().then(async () => {
    const paths = createAppPaths(app.getPath('userData'));
    console.info(`Facebook Account Manager data root: ${paths.dataRoot}`);
    database = openDatabase(paths);
    const accounts = new AccountRepository(database);
    const audit = new AuditLogRepository(database);
    const settings = new SettingsRepository(database);
    const profiles = new ProfileManager(paths.profiles);
    service = new AccountService(accounts, audit, profiles, new SecretStore(settings, {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    }), () => { if (service) broadcastAccounts(service); });
    cleanupIpc = registerIpc(service);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch((error) => {
    console.error('Application startup failed:', error instanceof Error ? error.message : error);
    dialog.showErrorBox('Facebook Account Manager', 'The application could not start. Check the logs for details.');
    app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting || !service) return;
    event.preventDefault();
    quitting = true;
    void service.browser.closeAll().finally(() => { cleanupIpc?.(); database?.close(); app.quit(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f172a',
    webPreferences: { preload: join(__dirname, '../preload/index.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}
