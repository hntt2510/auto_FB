import { z } from 'zod';
import { normalizeTags } from './groupUrl';

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export const profileNameSchema = z.string()
  .trim()
  .min(1, 'Profile name is required')
  .max(80, 'Profile name must be 80 characters or fewer')
  .refine((value) => value !== '.' && value !== '..', 'Invalid profile name')
  .refine((value) => !WINDOWS_RESERVED_NAMES.test(value), 'Reserved Windows name')
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[<>:"/\\|?*\u0000-\u001f]/.test(value), 'Profile name contains an invalid character')
  .refine((value) => !/[ .]$/.test(value), 'Profile name cannot end with a space or period');

export const accountNameSchema = z.string().trim().min(1, 'Account name is required').max(120);
export const accountIdSchema = z.string().uuid('Invalid account id');

const proxyFields = {
  proxyHost: z.string().trim().min(1, 'Proxy host is required').max(255),
  proxyPort: z.number().int().min(1).max(65535),
  proxyUsername: z.string().trim().min(1).max(255).optional(),
  proxyPassword: z.string().min(1).max(4096).optional()
};

function validateCredentials(data: { proxyUsername?: string; proxyPassword?: string }, ctx: z.RefinementCtx) {
  if ((data.proxyUsername && !data.proxyPassword) || (!data.proxyUsername && data.proxyPassword)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proxyPassword'], message: 'Proxy username and password must be supplied together' });
  }
}

export const createAccountSchema = z.union([
  z.object({ name: accountNameSchema, profileName: profileNameSchema, proxyEnabled: z.literal(false) }),
  z.object({ name: accountNameSchema, profileName: profileNameSchema, proxyEnabled: z.literal(true), ...proxyFields })
]).superRefine((data, ctx) => { if (data.proxyEnabled) validateCredentials(data, ctx); });

export const updateAccountSchema = z.object({
  accountId: accountIdSchema,
  name: accountNameSchema,
  proxyEnabled: z.boolean(),
  proxyHost: z.string().trim().min(1).max(255).optional(),
  proxyPort: z.number().int().min(1).max(65535).optional(),
  proxyUsername: z.string().trim().min(1).max(255).optional(),
  proxyPassword: z.string().min(1).max(4096).optional(),
  clearProxyPassword: z.boolean().optional()
}).superRefine((data, ctx) => {
  if (!data.proxyEnabled && (data.proxyHost || data.proxyPort || data.proxyUsername || data.proxyPassword || data.clearProxyPassword)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proxyEnabled'], message: 'Proxy fields are not allowed for a direct connection' });
  }
  if (data.proxyEnabled && (!data.proxyHost || !data.proxyPort)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proxyHost'], message: 'Proxy host and port are required' });
  }
  if (data.proxyEnabled && data.proxyUsername && data.clearProxyPassword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clearProxyPassword'], message: 'Choose a password or clear credentials' });
  }
  if (data.proxyPassword && data.clearProxyPassword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proxyPassword'], message: 'Choose a password or clear credentials' });
  }
  if (data.proxyPassword && !data.proxyUsername) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proxyUsername'], message: 'Proxy username is required with a password' });
  }
});

export const deleteAccountSchema = z.object({ accountId: accountIdSchema, deleteProfile: z.boolean() });
export const logFilterSchema = z.object({ accountId: accountIdSchema.optional(), eventType: z.string().trim().max(100).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() });

export const groupIdSchema = accountIdSchema;
export const groupInputSchema = z.object({ name: z.string().trim().min(1).max(160), url: z.string().trim().min(1).max(2048), notes: z.string().max(4000).optional(), tags: z.array(z.string().max(40)).max(30).transform(normalizeTags), active: z.boolean().optional() });
export const groupFilterSchema = z.object({ search: z.string().trim().max(200).optional(), tag: z.string().trim().max(40).optional(), active: z.boolean().optional() });
export const groupImportSchema = z.object({ text: z.string().max(256_000) });
export const assignmentSchema = z.object({ groupId: groupIdSchema, accountIds: z.array(accountIdSchema).max(100) });
export const accountAssignmentSchema = z.object({ accountId: accountIdSchema, groupIds: z.array(groupIdSchema).max(500) });
export const groupOpenSchema = z.object({ groupId: groupIdSchema, accountId: accountIdSchema });

export const draftIdSchema = accountIdSchema;
export const draftInputSchema = z.object({ title: z.string().trim().min(1).max(160), body: z.string().max(63_000), linkUrl: z.string().url().max(2048).optional() });
export const draftFilterSchema = z.object({ search: z.string().trim().max(200).optional(), status: z.enum(['DRAFT', 'READY', 'ARCHIVED']).optional() });
export const draftStatusSchema = z.object({ draftId: draftIdSchema, status: z.enum(['DRAFT', 'READY', 'ARCHIVED']) });
export const mediaIdSchema = accountIdSchema;
export const mediaRemoveSchema = z.object({ draftId: draftIdSchema, mediaId: mediaIdSchema });
export const mediaReorderSchema = z.object({ draftId: draftIdSchema, mediaIds: z.array(mediaIdSchema).max(100) });

export const queueIdSchema = accountIdSchema;
export const queueStatusSchema = z.enum(['PENDING', 'PAUSED', 'RUNNING', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED']);
export const queueTargetSchema = z.object({ accountId: accountIdSchema, groupId: groupIdSchema });
export const queueBatchSchema = z.object({ draftId: draftIdSchema, targets: z.array(queueTargetSchema).min(1).max(500), scheduledAt: z.string().datetime().refine((value) => value.endsWith('Z'), 'Schedule must be a UTC ISO timestamp.').optional() });
export const queueFilterSchema = z.object({ search: z.string().trim().max(200).optional(), status: queueStatusSchema.optional(), accountId: accountIdSchema.optional(), groupId: groupIdSchema.optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() });
export const queueStateSchema = z.object({ queueId: queueIdSchema });
export const publishRunSelectedSchema = z.object({ queueIds: z.array(queueIdSchema).min(1).max(100).transform((ids) => [...new Set(ids)]) });
export const publishRetrySchema = z.object({ queueId: queueIdSchema, acknowledgeDuplicateRisk: z.boolean() });
export const publishRequeueSchema = z.object({ queueId: queueIdSchema, scheduledAt: z.string().datetime().refine((value) => value.endsWith('Z'), 'Schedule must be UTC.').optional() });
export const publishMarkVerifiedSchema = z.object({ queueId: queueIdSchema, evidence: z.string().trim().min(1).max(500).optional() });
export const publishingSettingsSchema = z.object({ enabled: z.boolean(), executionMode: z.enum(['DRY_RUN', 'LIVE']), schedulerIntervalSeconds: z.number().int().min(15).max(300), maxConcurrentAccounts: z.number().int().min(1).max(3), videoUploadTimeoutSeconds: z.number().int().min(60).max(1800) });
export const publishingSettingsUpdateSchema = publishingSettingsSchema.extend({ confirmLive: z.boolean().optional() });

export type CreateAccountData = z.infer<typeof createAccountSchema>;
export type UpdateAccountData = z.infer<typeof updateAccountSchema>;
