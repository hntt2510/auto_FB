import { z } from 'zod';

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

export type CreateAccountData = z.infer<typeof createAccountSchema>;
export type UpdateAccountData = z.infer<typeof updateAccountSchema>;
