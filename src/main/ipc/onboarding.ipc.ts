import { BrowserWindow } from 'electron';
import type { OnboardingService } from '@main/services/OnboardingService';
import { accountIdSchema, onboardingNotesSchema, onboardingPauseSchema, onboardingStartSchema, onboardingTaskStatusSchema, onboardingTaskUpdateSchema } from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

export function registerOnboardingIpc(service: OnboardingService, allowedSenderIds: () => ReadonlySet<number>): () => void {
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
    registerAuthorizedHandler('onboarding:stop-session', allowedSenderIds, (_event, accountId: unknown) => service.stopSession(parseOrThrow(accountIdSchema.safeParse(accountId))))
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}

export function broadcastOnboardingChanged(): void { for (const window of BrowserWindow.getAllWindows()) { if (!window.webContents.isDestroyed()) window.webContents.send('onboarding:changed'); } }
