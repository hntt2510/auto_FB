import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { join, resolve } from 'node:path';
import { copyFile, rename, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createAppPaths, openDatabase } from './db/database';
import { AccountRepository } from './db/repositories/AccountRepository';
import { AuditLogRepository } from './db/repositories/AuditLogRepository';
import { SettingsRepository } from './db/repositories/SettingsRepository';
import { ProfileManager } from './browser/ProfileManager';
import { SecretStore } from './security/SecretStore';
import { AccountService } from './services/AccountService';
import { broadcastAccounts, registerIpc } from './ipc/accounts.ipc';
import type Database from 'better-sqlite3';
import { isAllowedRendererUrl } from './security/navigationPolicy';
import { registerMediaScheme, registerMediaProtocol } from './services/MediaProtocol';
import { DraftRepository } from './db/repositories/DraftRepository';
import { GroupRepository } from './db/repositories/GroupRepository';
import { QueueRepository } from './db/repositories/QueueRepository';
import { MediaStorageService } from './services/MediaStorageService';
import { GroupService } from './services/GroupService';
import { DraftService } from './services/DraftService';
import { QueueService } from './services/QueueService';
import { DashboardService } from './services/DashboardService';
import { registerWorkspaceIpc } from './ipc/workspace.ipc';
import { PublishRepository } from './db/repositories/PublishRepository';
import { FacebookComposerAdapter } from './publishing/FacebookComposerAdapter';
import { FacebookPublisher } from './publishing/FacebookPublisher';
import { PublishDiagnostics } from './publishing/PublishDiagnostics';
import { PublishExecutor } from './publishing/PublishExecutor';
import { PublishCoordinator } from './publishing/PublishCoordinator';
import { PublishScheduler } from './publishing/PublishScheduler';
import { PublishingSettingsService } from './publishing/PublishingSettingsService';
import { PublishingService } from './publishing/PublishingService';
import { LiveReadinessService } from './publishing/LiveReadinessService';
import { OperationsReportService } from './publishing/OperationsReportService';
import { broadcastPublishingChanged } from './ipc/publishing.ipc';
import { OperationsService } from './services/OperationsService';
import { LATEST_SCHEMA_VERSION } from './db/migrations';

let service: AccountService | undefined;
let cleanupIpc: (() => void) | undefined;
let quitting = false;
let database: Database.Database | undefined;
let scheduler: PublishScheduler | undefined;
let coordinator: PublishCoordinator | undefined;
let publishing: PublishingService | undefined;

registerMediaScheme();

if (process.env.FB_ACCOUNT_MANAGER_USER_DATA) app.setPath('userData', resolve(process.env.FB_ACCOUNT_MANAGER_USER_DATA));

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
    const groups = new GroupRepository(database);
    const drafts = new DraftRepository(database);
    const queue = new QueueRepository(database);
    const media = new MediaStorageService(paths.media);
    const publishRepository = new PublishRepository(database);
    const liveReadiness = new LiveReadinessService(accounts, groups, publishRepository, media);
    const diagnostics = new PublishDiagnostics(paths.diagnostics);
    service = new AccountService(accounts, audit, profiles, new SecretStore(settings, {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    }), () => { if (service) broadcastAccounts(service); });
    cleanupIpc = registerIpc(service, () => new Set(BrowserWindow.getAllWindows().map((current) => current.webContents.id)));
    registerMediaProtocol(drafts, media);
    const workspaceNotify = () => { broadcastPublishingChanged(); };
    const executor = new PublishExecutor(queue, publishRepository, accounts, groups, profiles, service.browser, new FacebookPublisher(new FacebookComposerAdapter(), media), diagnostics, audit, workspaceNotify, liveReadiness);
    coordinator = new PublishCoordinator(queue, executor);
    const publishingSettings = new PublishingSettingsService(settings, audit, () => { scheduler?.reconfigure(); workspaceNotify(); });
    scheduler = new PublishScheduler(queue, coordinator, publishingSettings, workspaceNotify);
    const operationsReport = new OperationsReportService(accounts, queue, publishRepository, publishingSettings, executor.selectorVersion, app.getVersion(), scheduler);
    publishing = new PublishingService(queue, publishRepository, accounts, groups, media, executor, coordinator, scheduler, publishingSettings, diagnostics, audit, workspaceNotify, liveReadiness, operationsReport);
    publishing.recover(); service.setHealthObserver((result) => publishing?.handleHealthResult(result)); scheduler.start();
    const operations = new OperationsService(database, paths, publishRepository, scheduler, audit, { appName: 'Facebook Account Manager', appVersion: app.getVersion(), databaseSchema: LATEST_SCHEMA_VERSION, selectorVersion: executor.selectorVersion, electronVersion: process.versions.electron, playwrightVersion: dependencyVersion('playwright') }, async (backupPath) => {
      scheduler?.stop(); await service?.browser.closeAll(); cleanupIpc?.(); database?.close(); database = undefined; const temporary = paths.database + '.restore'; await rm(temporary, { force: true }); await copyFile(backupPath, temporary); await rm(paths.database + '-wal', { force: true }); await rm(paths.database + '-shm', { force: true }); await rm(paths.database, { force: true }); await rename(temporary, paths.database); quitting = true; app.relaunch(); app.exit(0);
    });
    cleanupIpc = chainCleanup(cleanupIpc, registerWorkspaceIpc({
      groups: new GroupService(groups, accounts, queue, service.browser, audit, workspaceNotify),
      drafts: new DraftService(drafts, queue, media, audit, workspaceNotify),
      queue: new QueueService(queue, drafts, accounts, groups, media, audit, workspaceNotify),
      dashboard: new DashboardService(database, publishingSettings),
      publishing,
      settings: publishingSettings,
      operations
    }, () => new Set(BrowserWindow.getAllWindows().map((current) => current.webContents.id))));
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
    scheduler?.stop();
    void (async () => {
      const drained = await coordinator?.stopAndDrain(20000) ?? true;
      if (!drained) { await service!.browser.abortRunningContexts(); await coordinator?.stopAndDrain(5000); publishing?.recover(); }
      await service!.browser.closeAll();
    })().finally(() => { cleanupIpc?.(); database?.close(); app.quit(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

function chainCleanup(first: () => void | undefined, second: () => void): () => void {
  return () => { first?.(); second(); };
}

function createWindow(): BrowserWindow {
  const rendererPath = join(__dirname, '../renderer/index.html');
  const applicationUrl = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(rendererPath).toString();
  const preloadPath = join(__dirname, '../preload/index.cjs');
  if (!existsSync(preloadPath)) throw new Error('Preload bridge bundle is missing: ' + preloadPath);
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f172a',
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.on('preload-error', (_event, preload, error) => console.error('Preload failed:', sanitizeRuntimeMessage(preload + ': ' + error.message)));
  window.webContents.on('console-message', (details) => { if (details.level === 'error') console.error('Renderer console:', sanitizeRuntimeMessage(details.message)); });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => console.error('Renderer load failed:', errorCode, sanitizeRuntimeMessage(errorDescription)));
  const denyUnexpectedNavigation = (event: Electron.Event, url: string) => {
    if (!isAllowedRendererUrl(url, applicationUrl)) event.preventDefault();
  };
  window.webContents.on('will-navigate', denyUnexpectedNavigation);
  window.webContents.on('will-redirect', denyUnexpectedNavigation);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(applicationUrl);
  else void window.loadFile(rendererPath);
  return window;
}

function sanitizeRuntimeMessage(message: string): string {
  return message.replace(/(password|cookie|token|access_token|secret)[^\s]*/gi, '$1 [redacted]').slice(0, 500);
}

function dependencyVersion(name: string): string { try { const value = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }; return value.dependencies?.[name]?.replace(/^[^0-9]*/, '') ?? 'unknown'; } catch { return 'unknown'; } }
