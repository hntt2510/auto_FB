import { randomUUID } from 'node:crypto';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { BrowserManager } from '@main/browser/BrowserManager';
import { AppError } from '@main/errors';
import { normalizeFacebookGroupUrl, normalizeTags, parseGroupImportLine } from '@shared/groupUrl';
import { accountIdSchema, groupFilterSchema, groupIdSchema, groupInputSchema, groupImportSchema } from '@shared/schemas';
import type { AssignmentAccount, FacebookGroup, GroupFilter, GroupImportPreview, GroupImportResult, GroupInput, GroupOpenResult } from '@shared/types';

export class GroupService {
  constructor(private readonly groups: GroupRepository, private readonly accounts: AccountRepository, private readonly queue: QueueRepository, private readonly browser: BrowserManager, private readonly audit: AuditLogRepository, private readonly notify: () => void) {}

  list(filter?: GroupFilter): FacebookGroup[] {
    const parsed = groupFilterSchema.safeParse(filter ?? {}); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid group filter.');
    return this.groups.list(parsed.data);
  }

  get(groupId: string): FacebookGroup { const group = this.groups.get(this.validId(groupId)); if (!group) throw new AppError('GROUP_NOT_FOUND', 'Group not found.'); return group; }

  create(input: GroupInput): FacebookGroup {
    const data = this.parseInput(input); const normalized = normalizeFacebookGroupUrl(data.url);
    if (this.groups.getByNormalizedUrl(normalized.normalizedUrl)) throw new AppError('DUPLICATE_GROUP', 'A group with this URL already exists.');
    const group = this.groups.insert(randomUUID(), { ...data, url: data.url, tags: normalizeTags(data.tags) }, new Date().toISOString());
    this.auditSafe({ eventType: 'GROUP_CREATED', message: `Group ${group.name} created.`, metadata: JSON.stringify({ groupId: group.id }) }); this.notifySafe(); return group;
  }

  update(groupId: string, input: GroupInput): FacebookGroup {
    const id = this.validId(groupId); this.get(id); const data = this.parseInput(input); const normalized = normalizeFacebookGroupUrl(data.url);
    const duplicate = this.groups.getByNormalizedUrl(normalized.normalizedUrl); if (duplicate && duplicate.id !== id) throw new AppError('DUPLICATE_GROUP', 'A group with this URL already exists.');
    const group = this.groups.update(id, { ...data, tags: normalizeTags(data.tags) }, new Date().toISOString());
    this.auditSafe({ accountId: undefined, eventType: 'GROUP_UPDATED', message: `Group ${group.name} updated.`, metadata: JSON.stringify({ groupId: id }) }); this.notifySafe(); return group;
  }

  setActive(groupId: string, active: boolean): FacebookGroup { const id = this.validId(groupId); this.get(id); const group = this.groups.setActive(id, active); this.auditSafe({ eventType: active ? 'GROUP_ACTIVATED' : 'GROUP_ARCHIVED', message: `${group.name} ${active ? 'activated' : 'archived'}.`, metadata: JSON.stringify({ groupId: group.id }) }); this.notifySafe(); return group; }

  delete(groupId: string): void {
    const group = this.get(groupId); if (this.queue.hasActiveForGroup(group.id)) throw new AppError('ENTITY_IN_USE', 'Cancel or remove active queue items before deleting this group.');
    this.groups.delete(group.id); this.auditSafe({ eventType: 'GROUP_DELETED', message: `Group ${group.name} deleted.`, metadata: JSON.stringify({ groupId: group.id }) }); this.notifySafe();
  }

  previewImport(text: string): GroupImportPreview {
    const parsed = groupImportSchema.safeParse({ text }); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Import text is too large or invalid.');
    const rows = parsed.data.text.split(/\r?\n/); const seen = new Set<string>(); const result: GroupImportPreview = { valid: 0, duplicates: 0, invalid: 0, rows: [] };
    rows.forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const entry = parseGroupImportLine(line); const normalized = normalizeFacebookGroupUrl(entry.url);
        if (seen.has(normalized.normalizedUrl) || this.groups.getByNormalizedUrl(normalized.normalizedUrl)) { result.duplicates++; result.rows.push({ line: index + 1, name: entry.name, url: entry.url, normalizedUrl: normalized.normalizedUrl, status: 'DUPLICATE', reason: 'Duplicate canonical URL.' }); return; }
        seen.add(normalized.normalizedUrl); result.valid++; result.rows.push({ line: index + 1, name: entry.name ?? normalized.identifier, url: entry.url, normalizedUrl: normalized.normalizedUrl, status: 'VALID' });
      } catch (error) { result.invalid++; result.rows.push({ line: index + 1, url: line.trim(), status: 'INVALID', reason: error instanceof Error ? error.message : 'Invalid row.' }); }
    });
    return result;
  }

  import(text: string): GroupImportResult {
    const preview = this.previewImport(text); const valid = preview.rows.filter((row) => row.status === 'VALID').map((row) => ({ name: row.name!, url: row.url, notes: undefined, tags: [], active: true }));
    const createdIds = this.groups.insertMany(valid);
    for (const id of createdIds) this.auditSafe({ eventType: 'GROUP_IMPORTED', message: 'Group imported.', metadata: JSON.stringify({ groupId: id }) });
    this.notifySafe(); return { ...preview, createdIds };
  }

  assignments(groupId: string): AssignmentAccount[] { this.get(groupId); return this.groups.assignments(this.validId(groupId)); }

  replaceAssignments(groupId: string, accountIds: string[]): AssignmentAccount[] {
    const id = this.validId(groupId); const group = this.get(id); const unique = [...new Set(accountIds)];
    for (const accountId of unique) if (!this.accounts.get(accountId)) throw new AppError('ACCOUNT_NOT_FOUND', 'One or more accounts do not exist.');
    const result = this.groups.replaceAssignments(id, unique); this.auditSafe({ eventType: 'GROUP_ACCOUNT_ASSIGNED', message: `Assignments updated for ${group.name}.`, metadata: JSON.stringify({ groupId: id, accountCount: unique.length }) }); this.notifySafe(); return result;
  }

  accountGroups(accountId: string): FacebookGroup[] { if (!this.accounts.get(accountId)) throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.'); return this.groups.forAccount(accountId); }

  replaceAccountGroups(accountId: string, groupIds: string[]): FacebookGroup[] {
    if (!this.accounts.get(accountId)) throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.');
    const unique = [...new Set(groupIds)]; for (const groupId of unique) this.get(groupId);
    const result = this.groups.replaceAccountGroups(accountId, unique); this.auditSafe({ eventType: 'GROUP_ACCOUNT_ASSIGNED', message: 'Account group assignments updated.', metadata: JSON.stringify({ accountId, groupCount: unique.length }) }); this.notifySafe(); return result;
  }

  async open(groupId: string, accountId: string): Promise<GroupOpenResult> {
    const group = this.get(groupId); if (!group.active) throw new AppError('INVALID_STATE', 'Archived groups cannot be opened.');
    const account = accountIdSchema.safeParse(accountId); if (!account.success) throw new AppError('INVALID_REQUEST', 'Invalid account id.');
    const assignments = this.groups.assignments(group.id); if (!assignments.some((item) => item.id === account.data)) throw new AppError('INVALID_ASSIGNMENT', 'The selected account is not assigned to this group.');
    const result = await this.browser.navigateAccountPage(account.data, group.normalizedUrl); this.auditSafe({ eventType: 'GROUP_OPENED', message: `${group.name} opened manually.`, metadata: JSON.stringify({ groupId: group.id, accountId: account.data, status: result.status }) }); this.notifySafe(); return { ...result, groupId: group.id };
  }

  private parseInput(input: GroupInput): GroupInput { const parsed = groupInputSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid group.'); return parsed.data; }
  private validId(value: string): string { const parsed = groupIdSchema.safeParse(value); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid group id.'); return parsed.data; }
  private auditSafe(entry: { accountId?: string; eventType: string; message: string; metadata?: string }): void { try { this.audit.add(entry); } catch { /* audit is best effort */ } }
  private notifySafe(): void { try { this.notify(); } catch { /* renderer may be closing */ } }
}
