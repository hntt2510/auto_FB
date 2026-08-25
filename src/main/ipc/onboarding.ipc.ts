import { BrowserWindow } from 'electron';
import type { OnboardingService } from '@main/services/OnboardingService';
import type { AccountSessionService } from '@main/services/AccountSessionService';
import { accountIdSchema, accountSessionEndSchema, accountSessionGroupSchema, accountSessionNavigationSchema, accountSessionSettingsSchema, accountSessionStartSchema, onboardingNotesSchema, onboardingPauseSchema, onboardingStartSchema, onboardingTaskStatusSchema, onboardingTaskUpdateSchema } from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

export function registerOnboardingIpc(service: OnboardingService, sessions: AccountSessionService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [
    registerAuthorizedHandler('onboarding:templates', allowedSenderIds, () => service.templates()),
    registerAuthorizedHandler('onboarding:overview', allowedSenderIds, () => service.overview()),
    registerAuthorizedHandler('onboarding:get', allowedSenderIds, (_event, accountId: unknown) => service.get(parseOrThrow(accountIdSchema.safeParse(accountId)))),
    registerAuthorizedHandler('onboarding:start', allowedSenderIds, (_event, input: unknown) => service.start(parseOrThrow(onboardingStartSchema.safeParse(input)))),
    registerAuthorizedHandler('onboarding:pause', allowedSenderIds, (_event, input: unknown) => { const value = parseOrThrow(onboardingPauseSchema.safeParse(input)); return service.pause(value.accountId, value.reason); }),
    registerAuthorizedHandler('onboarding:resume', allowedSenderIds, (_event, accountId: unknown) => service.resume(parseOrThrow(accountIdSchema.safeParse(accountId)))),
    registerAuthorizedHandler('onboarding:ready', allowedSenderIds, (_event, accountId: unknown) => service.markReady(parseOrThrow(accountIdSchema.safeParse(accountId)))),
    registerAuthorizedHandler('onboarding:notes', allowedSenderIds, (_event, input: unknown) => { const value = parseOrThrow(onboardingNotesSchema.safeParse(input)); return service.updateNotes(value.accountId, value.notes); }),
    registerAuthorizedHandler('onboarding:update-task', allowedSenderIds, (_event, input: unknown) => service.updateTask(parseOrThrow(onboardingTaskUpdateSchema.safeParse(input)))),
    registerAuthorizedHandler('onboarding:task-status', allowedSenderIds, (_event, input: unknown) => service.setTaskStatus(parseOrThrow(onboardingTaskStatusSchema.safeParse(input)))),
    registerAuthorizedHandler('onboarding:start-session', allowedSenderIds, (_event, accountId: unknown) => service.startSession(parseOrThrow(accountIdSchema.safeParse(accountId)))),
    registerAuthorizedHandler('onboarding:stop-session', allowedSenderIds, (_event, accountId: unknown) => service.stopSession(parseOrThrow(accountIdSchema.safeParse(accountId)))),
    registerAuthorizedHandler('onboarding:session-detail', allowedSenderIds, (_event, accountId: unknown) => sessions.detail(parseOrThrow(accountIdSchema.safeParse(accountId)))),
    registerAuthorizedHandler('onboarding:start-assisted-session', allowedSenderIds, (_event, input: unknown) => sessions.start(parseOrThrow(accountSessionStartSchema.safeParse(input)))),
    registerAuthorizedHandler('onboarding:pause-assisted-session', allowedSenderIds, (_event, accountId: unknown) => sessions.pause(parseOrThrow(accountIdSchema.safeParse(accountId)))),
    registerAuthorizedHandler('onboarding:resume-assisted-session', allowedSenderIds, (_event, accountId: unknown) => sessions.resume(parseOrThrow(accountIdSchema.safeParse(accountId)))),
    registerAuthorizedHandler('onboarding:end-assisted-session', allowedSenderIds, (_event, input: unknown) => sessions.end(parseOrThrow(accountSessionEndSchema.safeParse(input)))),
    registerAuthorizedHandler('onboarding:navigate-session', allowedSenderIds, (_event, input: unknown) => sessions.navigate(parseOrThrow(accountSessionNavigationSchema.safeParse(input)))),
    registerAuthorizedHandler('onboarding:open-session-group', allowedSenderIds, (_event, input: unknown) => { const data = parseOrThrow(accountSessionGroupSchema.safeParse(input)); return sessions.openGroup(data.accountId, data.groupId); }),
    registerAuthorizedHandler('onboarding:update-session-settings', allowedSenderIds, (_event, input: unknown) => sessions.updateSettings(parseOrThrow(accountSessionSettingsSchema.safeParse(input)))),
    registerAuthorizedHandler('onboarding:stop-all-sessions', allowedSenderIds, () => sessions.stopAll())
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}

export function broadcastOnboardingChanged(): void { for (const window of BrowserWindow.getAllWindows()) { if (!window.webContents.isDestroyed()) window.webContents.send('onboarding:changed'); } }
