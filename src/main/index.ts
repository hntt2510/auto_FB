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
import { CampaignRepository } from './db/repositories/CampaignRepository';
import { CampaignService } from './services/CampaignService';
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
import { ProxyTestService } from './proxy/ProxyTestService';
import { OnboardingRepository } from './db/repositories/OnboardingRepository';
import { OnboardingService } from './services/OnboardingService';
import { broadcastOnboardingChanged } from './ipc/onboarding.ipc';
import { AccountSessionRepository } from './db/repositories/AccountSessionRepository';
import { AccountSessionService, type AccountSessionScheduler } from './services/AccountSessionService';

let service: AccountService | undefined;
let cleanupIpc: (() => void) | undefined;
let quitting = false;
let database: Database.Database | undefined;
let scheduler: PublishScheduler | undefined;
let coordinator: PublishCoordinator | undefined;
let publishing: PublishingService | undefined;
let accountSessions: AccountSessionService | undefined;

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
    const campaigns = new CampaignRepository(database);
    const media = new MediaStorageService(paths.media);
    const publishRepository = new PublishRepository(database);
    const liveReadiness = new LiveReadinessService(accounts, groups, publishRepository, media);
    const diagnostics = new PublishDiagnostics(paths.diagnostics);
    const workspaceNotify = () => { broadcastPublishingChanged(); };
    const onboardingRepository = new OnboardingRepository(database);
    const accountSessionRepository = new AccountSessionRepository(database);
    const onboarding = new OnboardingService(onboardingRepository, accounts, groups, audit, () => { if (service) broadcastAccounts(service); broadcastOnboardingChanged(); workspaceNotify(); });
    service = new AccountService(accounts, audit, profiles, new SecretStore(settings, {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    }), () => { const paused = onboarding?.syncHealthPauses() ?? 0; if (service) broadcastAccounts(service); if (paused) { broadcastOnboardingChanged(); workspaceNotify(); } }, new ProxyTestService(proxyTestEndpoints()), browserHomeUrl());
    const sessionRuntime = accountSessionQaRuntime();
    accountSessions = new AccountSessionService(accountSessionRepository, onboardingRepository, accounts, groups, settings, service, onboarding, audit, () => { if (service) broadcastAccounts(service); broadcastOnboardingChanged(); workspaceNotify(); }, sessionRuntime?.now, sessionRuntime?.scheduler);
    accountSessions.recoverAbandoned();
    service.browser.setContextCloseObserver((accountId) => accountSessions?.handleBrowserClosed(accountId));
    cleanupIpc = registerIpc(service, () => new Set(BrowserWindow.getAllWindows().map((current) => current.webContents.id)));
    registerMediaProtocol(drafts, media);
    const executor = new PublishExecutor(queue, publishRepository, accounts, groups, profiles, service.browser, new FacebookPublisher(new FacebookComposerAdapter(), media), diagnostics, audit, workspaceNotify, liveReadiness);
    const publishingSettings = new PublishingSettingsService(settings, audit, () => { scheduler?.reconfigure(); workspaceNotify(); });
    coordinator = new PublishCoordinator(queue, executor, workspaceNotify, undefined, (event, batch) => audit.add({ eventType: event, message: event === 'PUBLISH_BATCH_STARTED' ? 'Controlled publishing batch started.' : event === 'PUBLISH_BATCH_COMPLETED' ? 'Controlled publishing batch completed.' : 'Controlled publishing batch stopped.', metadata: JSON.stringify({ requestedCount: batch.requested, accountCount: batch.lanes.length, batchPacingSeconds: publishingSettings.get().batchPacingSeconds, claimed: batch.claimed, completed: batch.completed, skipped: batch.skipped }) }));
    scheduler = new PublishScheduler(queue, coordinator, publishingSettings, workspaceNotify, (accountId) => accounts.get(accountId)?.onboardingStatus === 'READY');
    const operationsReport = new OperationsReportService(accounts, queue, publishRepository, publishingSettings, executor.selectorVersion, app.getVersion(), scheduler);
    publishing = new PublishingService(queue, publishRepository, accounts, groups, media, executor, coordinator, scheduler, publishingSettings, diagnostics, audit, workspaceNotify, liveReadiness, operationsReport);
    publishing.recover(); service.setHealthObserver((result) => { publishing?.handleHealthResult(result); accountSessions?.handleHealthResult(result); }); scheduler.start();
    const operations = new OperationsService(database, paths, publishRepository, scheduler, audit, { appName: 'Facebook Account Manager', appVersion: app.getVersion(), databaseSchema: LATEST_SCHEMA_VERSION, selectorVersion: executor.selectorVersion, electronVersion: process.versions.electron, playwrightVersion: dependencyVersion('playwright') }, async (backupPath) => {
      scheduler?.stop(); await accountSessions?.stopAll('APPLICATION_SHUTDOWN'); await service?.browser.closeAll(); cleanupIpc?.(); database?.close(); database = undefined; const temporary = paths.database + '.restore'; await rm(temporary, { force: true }); await copyFile(backupPath, temporary); await rm(paths.database + '-wal', { force: true }); await rm(paths.database + '-shm', { force: true }); await rm(paths.database, { force: true }); await rename(temporary, paths.database); quitting = true; app.relaunch(); app.exit(0);
    });
    const campaignService = new CampaignService(database, campaigns, drafts, accounts, groups, queue, audit, workspaceNotify);
    cleanupIpc = chainCleanup(cleanupIpc, registerWorkspaceIpc({
      groups: new GroupService(groups, accounts, queue, service.browser, audit, workspaceNotify),
      drafts: new DraftService(drafts, queue, media, audit, workspaceNotify),
      campaigns: campaignService,
      queue: new QueueService(queue, drafts, accounts, groups, media, audit, workspaceNotify),
      dashboard: new DashboardService(database, publishingSettings, accountSessionRepository),
      onboarding,
      accountSessions,
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
      await accountSessions?.stopAll('APPLICATION_SHUTDOWN');
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

function proxyTestEndpoints(): string[] | undefined {
  const configured = process.env.FB_PROXY_TEST_ENDPOINTS;
  if (!configured) return undefined;
  const endpoints = configured.split(',').map((value) => value.trim()).filter(Boolean).slice(0, 2);
  if (!endpoints.length || endpoints.some((value) => { try { return !['http:', 'https:'].includes(new URL(value).protocol); } catch { return true; } })) return undefined;
  return endpoints;
}

function browserHomeUrl(): string | undefined { const configured = process.env.FB_BROWSER_HOME_URL; if (!configured) return undefined; try { const url = new URL(configured); return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined; } catch { return undefined; } }

function accountSessionQaRuntime(): { now: () => Date; scheduler: AccountSessionScheduler } | undefined {
  const raw = process.env.FB_ACCOUNT_SESSION_QA_TIME_SCALE; const home = browserHomeUrl(); if (!raw || !home || !process.env.FB_ACCOUNT_MANAGER_USER_DATA) return undefined;
  const scale = Number(raw); const hostname = new URL(home).hostname; if (!Number.isInteger(scale) || scale < 2 || scale > 3600 || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) return undefined;
  const wallStart = Date.now(); const logicalStart = wallStart; return { now: () => new Date(logicalStart + (Date.now() - wallStart) * scale), scheduler: { schedule: (callback, delayMs) => setTimeout(callback, Math.max(1, Math.ceil(delayMs / scale))), cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) } };
}
