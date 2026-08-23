import { z } from 'zod';
import type { GroupService } from '@main/services/GroupService';
import { accountAssignmentSchema, accountIdSchema, assignmentSchema, groupFilterSchema, groupIdSchema, groupImportSchema, groupInputSchema, groupOpenSchema } from '@shared/schemas';
import { parseOrThrow, registerAuthorizedHandler } from './authorized';

const activeSchema = z.boolean();

export function registerGroupIpc(service: GroupService, allowedSenderIds: () => ReadonlySet<number>): () => void {
  const cleanups = [
    registerAuthorizedHandler('groups:operations', allowedSenderIds, () => service.operations()),
    registerAuthorizedHandler('groups:assignment-matrix', allowedSenderIds, () => service.assignmentMatrix()),
    registerAuthorizedHandler('groups:list', allowedSenderIds, (_event, filter: unknown) => service.list(parseOrThrow(groupFilterSchema.safeParse(filter ?? {})))),
    registerAuthorizedHandler('groups:get', allowedSenderIds, (_event, id: unknown) => service.get(parseOrThrow(groupIdSchema.safeParse(id)))),
    registerAuthorizedHandler('groups:create', allowedSenderIds, (_event, input: unknown) => service.create(parseOrThrow(groupInputSchema.safeParse(input)))),
    registerAuthorizedHandler('groups:update', allowedSenderIds, (_event, id: unknown, input: unknown) => service.update(parseOrThrow(groupIdSchema.safeParse(id)), parseOrThrow(groupInputSchema.safeParse(input)))),
    registerAuthorizedHandler('groups:activate', allowedSenderIds, (_event, id: unknown, active: unknown) => service.setActive(parseOrThrow(groupIdSchema.safeParse(id)), parseOrThrow(activeSchema.safeParse(active)))),
    registerAuthorizedHandler('groups:delete', allowedSenderIds, (_event, id: unknown) => service.delete(parseOrThrow(groupIdSchema.safeParse(id)))),
    registerAuthorizedHandler('groups:import-preview', allowedSenderIds, (_event, input: unknown) => service.previewImport(parseOrThrow(groupImportSchema.safeParse(input)).text)),
    registerAuthorizedHandler('groups:import-commit', allowedSenderIds, (_event, input: unknown) => service.import(parseOrThrow(groupImportSchema.safeParse(input)).text)),
    registerAuthorizedHandler('groups:assignments', allowedSenderIds, (_event, id: unknown) => service.assignments(parseOrThrow(groupIdSchema.safeParse(id)))),
    registerAuthorizedHandler('groups:replace-assignments', allowedSenderIds, (_event, input: unknown) => { const value = parseOrThrow(assignmentSchema.safeParse(input)); return service.replaceAssignments(value.groupId, value.accountIds); }),
    registerAuthorizedHandler('groups:account-groups', allowedSenderIds, (_event, id: unknown) => service.accountGroups(parseOrThrow(accountIdSchema.safeParse(id)))),
    registerAuthorizedHandler('groups:replace-account-groups', allowedSenderIds, (_event, input: unknown) => { const value = parseOrThrow(accountAssignmentSchema.safeParse(input)); return service.replaceAccountGroups(value.accountId, value.groupIds); }),
    registerAuthorizedHandler('groups:open', allowedSenderIds, (_event, input: unknown) => { const value = parseOrThrow(groupOpenSchema.safeParse(input)); return service.open(value.groupId, value.accountId); })
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
