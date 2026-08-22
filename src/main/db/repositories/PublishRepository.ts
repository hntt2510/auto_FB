import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ExecutionMode, PreflightResult, PublishAttempt, PublishAttemptEvent, PublishAttemptStatus, PublishAttemptSummary, PublishReceipt, PublishReceiptResult, PublishingBlock, ReconciliationAction, ReconciliationRecord, SelectorProbeResult } from '@shared/types';

type AttemptRow = { id: string; queue_item_id: string; account_id: string | null; group_id: string | null; attempt_number: number; status: PublishAttemptStatus; error_code: string | null; error_message: string | null; diagnostic_path: string | null; diagnostic_created_at: string | null; execution_mode: ExecutionMode; selector_version: string | null; preflight: number; started_at: string; finished_at: string | null; created_at: string };
type EventRow = { id: string; attempt_id: string; sequence: number; event_type: string; message: string | null; created_at: string };
type ReceiptRow = { id: string; queue_item_id: string; attempt_id: string; result: PublishReceiptResult; group_url: string; post_url: string | null; evidence: string | null; submitted_at: string; created_at: string; verification_source: 'AUTOMATED' | 'OPERATOR'; verification_evidence: string | null; verified_at: string | null };

function mapEvent(row: EventRow): PublishAttemptEvent { return { id: row.id, attemptId: row.attempt_id, sequence: row.sequence, eventType: row.event_type, message: row.message ?? undefined, createdAt: row.created_at }; }
function mapReceipt(row: ReceiptRow): PublishReceipt { return { id: row.id, queueItemId: row.queue_item_id, attemptId: row.attempt_id, result: row.result, groupUrl: row.group_url, postUrl: row.post_url ?? undefined, evidence: row.evidence ?? undefined, submittedAt: row.submitted_at, createdAt: row.created_at, verificationSource: row.verification_source ?? 'AUTOMATED', verificationEvidence: row.verification_evidence ?? undefined, verifiedAt: row.verified_at ?? undefined }; }

export class PublishRepository {
  constructor(private readonly db: Database.Database) {}

  claim(queueItemId: string, options: { executionMode?: ExecutionMode; selectorVersion?: string; preflight?: boolean } = {}): { token: string; attempt: PublishAttempt } | undefined {
    return this.db.transaction(() => {
      const token = randomUUID(); const now = new Date().toISOString();
      const row = this.db.prepare('SELECT account_id, group_id FROM queue_items WHERE id = ?').get(queueItemId) as { account_id: string | null; group_id: string | null } | undefined;
      if (!row) return undefined;
      const claimed = this.db.prepare("UPDATE queue_items SET status = 'RUNNING', execution_token = ?, lease_started_at = ?, attention_reason = NULL, updated_at = ? WHERE id = ? AND status = 'PENDING' AND execution_token IS NULL").run(token, now, now, queueItemId);
      if (!claimed.changes) return undefined;
      const attemptNumber = (this.db.prepare('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS value FROM publish_attempts WHERE queue_item_id = ?').get(queueItemId) as { value: number }).value;
      const id = randomUUID();
      this.db.prepare("INSERT INTO publish_attempts (id, queue_item_id, account_id, group_id, attempt_number, status, execution_mode, selector_version, preflight, started_at, created_at) VALUES (?, ?, ?, ?, ?, 'STARTING', ?, ?, ?, ?, ?)").run(id, queueItemId, row.account_id, row.group_id, attemptNumber, options.executionMode ?? 'LIVE', options.selectorVersion ?? null, options.preflight ? 1 : 0, now, now);
      this.insertEvent(id, 'CLAIMED', undefined, now);
      return { token, attempt: this.getAttempt(id)! };
    })();
  }

  addEvent(attemptId: string, eventType: string, message?: string): PublishAttemptEvent {
    const now = new Date().toISOString(); this.insertEvent(attemptId, eventType, message, now);
    const row = this.db.prepare('SELECT * FROM publish_attempt_events WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1').get(attemptId) as EventRow;
    return mapEvent(row);
  }

  setAttemptStatus(attemptId: string, status: PublishAttemptStatus, errorCode?: string, errorMessage?: string, finish = false): void {
    this.db.prepare('UPDATE publish_attempts SET status = ?, error_code = ?, error_message = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?')
      .run(status, errorCode ?? null, errorMessage ?? null, finish ? 1 : 0, new Date().toISOString(), attemptId);
  }

  createReceipt(queueItemId: string, attemptId: string, result: PublishReceiptResult, groupUrl: string, postUrl?: string, evidence?: string): PublishReceipt {
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare('INSERT INTO publish_receipts (id, queue_item_id, attempt_id, result, group_url, post_url, evidence, submitted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, queueItemId, attemptId, result, groupUrl, postUrl ?? null, evidence ?? null, now, now);
    return mapReceipt(this.db.prepare('SELECT * FROM publish_receipts WHERE id = ?').get(id) as ReceiptRow);
  }

  finalizeSuccess(queueItemId: string, token: string, attemptId: string, groupUrl: string, postUrl: string, evidence: string): void {
    this.finalizeTerminal({ queueItemId, token, attemptId, queueStatus: 'SUCCEEDED', attemptStatus: 'SUCCEEDED', receipt: { result: 'VERIFIED_PUBLISHED', groupUrl, postUrl, evidence }, event: ['VERIFIED', evidence] });
  }

  finalizeSubmission(queueItemId: string, token: string, attemptId: string, groupUrl: string, result: 'SUBMITTED' | 'SUBMITTED_PENDING_APPROVAL', evidence: string): void {
    this.finalizeTerminal({ queueItemId, token, attemptId, queueStatus: 'SUBMITTED', attemptStatus: 'SUBMITTED', receipt: { result, groupUrl, evidence }, event: ['SUBMITTED', evidence] });
  }

  finalizeUnknown(queueItemId: string, token: string, attemptId: string, groupUrl: string, reason: string): void {
    this.finalizeNeedsAttention(queueItemId, token, attemptId, reason, { result: 'UNKNOWN', groupUrl, evidence: reason });
  }

  finalizeNeedsAttention(queueItemId: string, token: string, attemptId: string, reason: string, receipt?: { result: PublishReceiptResult; groupUrl: string; evidence?: string }): void {
    this.finalizeTerminal({ queueItemId, token, attemptId, queueStatus: 'NEEDS_ATTENTION', attemptStatus: 'NEEDS_ATTENTION', reason, receipt, event: receipt ? ['SUBMISSION_UNKNOWN', reason] : undefined });
  }

  finalizeFailure(queueItemId: string, token: string, attemptId: string, errorCode: string, errorMessage: string): void {
    this.finalizeTerminal({ queueItemId, token, attemptId, queueStatus: 'FAILED', attemptStatus: 'FAILED', errorCode, errorMessage });
  }

  markSubmitted(queueItemId: string, evidence = 'MANUAL_CONFIRMATION'): ReconciliationRecord {
    return this.reconcile(queueItemId, 'MARK_SUBMITTED', evidence, 'SUBMITTED');
  }

  markVerified(queueItemId: string, evidence = 'MANUAL_CONFIRMATION'): ReconciliationRecord {
    return this.reconcile(queueItemId, 'MARK_VERIFIED', evidence, 'SUCCEEDED');
  }

  reconciliations(queueItemId: string): ReconciliationRecord[] {
    return (this.db.prepare('SELECT * FROM publish_reconciliations WHERE queue_item_id = ? ORDER BY created_at DESC').all(queueItemId) as Array<{ id: string; queue_item_id: string; attempt_id: string | null; action: ReconciliationAction; evidence: string; created_at: string }>).map((row) => ({ id: row.id, queueItemId: row.queue_item_id, attemptId: row.attempt_id ?? undefined, action: row.action, evidence: row.evidence, createdAt: row.created_at }));
  }

  recordSelectorProbe(result: SelectorProbeResult): SelectorProbeResult {
    const id = result.id ?? randomUUID(); const now = result.checkedAt || new Date().toISOString();
    this.db.prepare('INSERT INTO selector_probes (id, account_id, group_id, selector_version, status, details_json, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, result.accountId, result.groupId, result.selectorVersion, result.status, JSON.stringify(result), now, now);
    return { ...result, id };
  }

  recentProbes(limit = 20): SelectorProbeResult[] {
    const rows = this.db.prepare('SELECT * FROM selector_probes ORDER BY checked_at DESC LIMIT ?').all(limit) as Array<{ id: string; account_id: string | null; group_id: string | null; selector_version: string; status: SelectorProbeResult['status']; details_json: string; checked_at: string }>;
    return rows.map((row) => { try { return { ...(JSON.parse(row.details_json) as SelectorProbeResult), id: row.id, accountId: row.account_id ?? '', groupId: row.group_id ?? '', selectorVersion: row.selector_version, status: row.status, checkedAt: row.checked_at }; } catch { return { id: row.id, accountId: row.account_id ?? '', groupId: row.group_id ?? '', selectorVersion: row.selector_version, status: row.status, session: { status: 'NOT_TESTED' }, group: { status: 'NOT_TESTED' }, composerTrigger: { status: 'NOT_TESTED' }, composerTextbox: { status: 'NOT_TESTED' }, mediaInput: { status: 'NOT_TESTED' }, postButton: { status: 'NOT_TESTED' }, uploadBusy: { status: 'NOT_TESTED' }, approvalSignal: { status: 'NOT_TESTED' }, acceptanceSignal: { status: 'NOT_TESTED' }, checkedAt: row.checked_at, warnings: ['Probe details could not be decoded.'] }; } });
  }

  recordPreflight(result: PreflightResult): void {
    const now = result.checkedAt || new Date().toISOString();
    this.db.prepare('INSERT INTO publish_preflights (id, queue_item_id, account_id, group_id, execution_mode, selector_version, status, details_json, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), result.queueItemId, result.accountId, result.groupId, 'DRY_RUN', result.selectorVersion, result.passed ? 'PASSED' : result.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'FAILED', JSON.stringify(result), now, now);
  }

  diagnostic(attemptId: string): string | undefined { return this.diagnosticPath(attemptId); }
  clearDiagnostic(attemptId: string): void { this.db.prepare('UPDATE publish_attempts SET diagnostic_path = NULL, diagnostic_created_at = NULL WHERE id = ?').run(attemptId); }

  attempts(queueItemId: string): PublishAttempt[] {
    return (this.db.prepare('SELECT * FROM publish_attempts WHERE queue_item_id = ? ORDER BY attempt_number DESC').all(queueItemId) as AttemptRow[]).map((row) => this.mapAttempt(row));
  }

  getAttempt(id: string): PublishAttempt | undefined { const row = this.db.prepare('SELECT * FROM publish_attempts WHERE id = ?').get(id) as AttemptRow | undefined; return row ? this.mapAttempt(row) : undefined; }

  recent(limit = 25): PublishAttemptSummary[] {
    const rows = this.db.prepare(`SELECT pa.*, pr.result FROM publish_attempts pa LEFT JOIN publish_receipts pr ON pr.attempt_id = pa.id ORDER BY pa.started_at DESC LIMIT ?`).all(limit) as Array<AttemptRow & { result: PublishReceiptResult | null }>;
    return rows.map((row) => ({ id: row.id, queueItemId: row.queue_item_id, accountId: row.account_id ?? undefined, groupId: row.group_id ?? undefined, attemptNumber: row.attempt_number, status: row.status, errorCode: row.error_code ?? undefined, errorMessage: row.error_message ?? undefined, startedAt: row.started_at, finishedAt: row.finished_at ?? undefined, irreversibleReached: this.irreversibleReached(row.id, row.status), result: row.result ?? undefined, executionMode: row.execution_mode, selectorVersion: row.selector_version ?? undefined, preflight: Boolean(row.preflight) }));
  }

  recoverRunning(reason: string): number {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const running = this.db.prepare("SELECT id FROM queue_items WHERE status = 'RUNNING'").all() as { id: string }[];
      for (const item of running) {
        const irreversible = Boolean(this.db.prepare("SELECT 1 FROM publish_attempts pa JOIN publish_attempt_events pae ON pae.attempt_id = pa.id WHERE pa.queue_item_id = ? AND pae.event_type IN ('SUBMITTING', 'POST_CLICKED', 'SUBMITTED', 'VERIFIED') LIMIT 1").get(item.id));
        const detail = irreversible ? `${reason} Submission may have begun. Do not retry without checking Facebook.` : `${reason} Interrupted before submit.`;
        this.db.prepare("UPDATE publish_attempts SET status = 'NEEDS_ATTENTION', error_code = 'EXECUTION_CANCELLED', error_message = ?, finished_at = ? WHERE queue_item_id = ? AND finished_at IS NULL").run(detail, now, item.id);
        this.db.prepare("UPDATE queue_items SET status = 'NEEDS_ATTENTION', execution_token = NULL, lease_started_at = NULL, attention_reason = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'RUNNING'").run(detail, now, now, item.id);
      }
      return running.length;
    })();
  }

  blockAccount(accountId: string, accountName: string, reason: PublishingBlock['reason'], message: string): PublishingBlock {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO account_publish_blocks (account_id, reason, message, blocked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET reason = excluded.reason, message = excluded.message, blocked_at = excluded.blocked_at`).run(accountId, reason, message, now);
    return { accountId, accountName, reason, message, blockedAt: now };
  }

  clearBlock(accountId: string): boolean { return this.db.prepare('DELETE FROM account_publish_blocks WHERE account_id = ?').run(accountId).changes === 1; }
  isBlocked(accountId: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM account_publish_blocks WHERE account_id = ?').get(accountId)); }
  blocks(): PublishingBlock[] { return (this.db.prepare('SELECT b.*, a.name AS account_name FROM account_publish_blocks b JOIN accounts a ON a.id = b.account_id ORDER BY b.blocked_at DESC').all() as Array<{ account_id: string; account_name: string; reason: PublishingBlock['reason']; message: string; blocked_at: string }>).map((row) => ({ accountId: row.account_id, accountName: row.account_name, reason: row.reason, message: row.message, blockedAt: row.blocked_at })); }

  setDiagnostic(attemptId: string, path: string): void { this.db.prepare('UPDATE publish_attempts SET diagnostic_path = ?, diagnostic_created_at = ? WHERE id = ?').run(path, new Date().toISOString(), attemptId); }
  diagnosticPath(attemptId: string): string | undefined { return (this.db.prepare('SELECT diagnostic_path AS path FROM publish_attempts WHERE id = ?').get(attemptId) as { path: string | null } | undefined)?.path ?? undefined; }

  private finalizeTerminal(input: { queueItemId: string; token: string; attemptId: string; queueStatus: 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'NEEDS_ATTENTION'; attemptStatus: PublishAttemptStatus; errorCode?: string; errorMessage?: string; reason?: string; receipt?: { result: PublishReceiptResult; groupUrl: string; postUrl?: string; evidence?: string }; event?: [string, string] }): void {
    this.db.transaction(() => {
      const now = new Date().toISOString(); const submittedAt = input.queueStatus === 'SUBMITTED' || input.queueStatus === 'SUCCEEDED' ? now : null; const completedAt = input.queueStatus === 'SUBMITTED' ? null : now;
      const queue = this.db.prepare('UPDATE queue_items SET status = ?, execution_token = NULL, lease_started_at = NULL, attention_reason = ?, submitted_at = COALESCE(?, submitted_at), completed_at = ?, updated_at = ? WHERE id = ? AND status = \'RUNNING\' AND execution_token = ?').run(input.queueStatus, input.reason ?? null, submittedAt, completedAt, now, input.queueItemId, input.token);
      if (!queue.changes) throw new Error('Queue execution lease is no longer valid.');
      if (input.receipt) this.db.prepare('INSERT INTO publish_receipts (id, queue_item_id, attempt_id, result, group_url, post_url, evidence, submitted_at, created_at, verification_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'AUTOMATED\')').run(randomUUID(), input.queueItemId, input.attemptId, input.receipt.result, input.receipt.groupUrl, input.receipt.postUrl ?? null, input.receipt.evidence ?? null, now, now);
      if (input.event) this.insertEvent(input.attemptId, input.event[0], input.event[1], now);
      const attempt = this.db.prepare('UPDATE publish_attempts SET status = ?, error_code = ?, error_message = ?, finished_at = ? WHERE id = ? AND queue_item_id = ? AND finished_at IS NULL').run(input.attemptStatus, input.errorCode ?? null, input.errorMessage ?? input.reason ?? null, now, input.attemptId, input.queueItemId);
      if (!attempt.changes) throw new Error('Publish attempt is no longer active.');
    })();
  }

  private reconcile(queueItemId: string, action: ReconciliationAction, evidence: string, queueStatus: 'SUBMITTED' | 'SUCCEEDED'): ReconciliationRecord {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const item = this.db.prepare('SELECT status FROM queue_items WHERE id = ?').get(queueItemId) as { status: string } | undefined;
      if (!item || !['SUBMITTED', 'NEEDS_ATTENTION'].includes(item.status)) throw new Error('Queue item is not awaiting reconciliation.');
      const latest = this.db.prepare('SELECT id FROM publish_attempts WHERE queue_item_id = ? ORDER BY attempt_number DESC LIMIT 1').get(queueItemId) as { id: string } | undefined;
      if (!latest) throw new Error('No publish attempt exists for reconciliation.');
      if (action === 'MARK_VERIFIED' && !this.db.prepare('SELECT 1 FROM publish_receipts WHERE attempt_id = ?').get(latest.id)) throw new Error('No submission receipt exists for manual verification.');
      const id = randomUUID();
      this.db.prepare('INSERT INTO publish_reconciliations (id, queue_item_id, attempt_id, action, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, queueItemId, latest.id, action, evidence, now);
      this.db.prepare('UPDATE queue_items SET status = ?, attention_reason = NULL, completed_at = ?, updated_at = ? WHERE id = ?').run(queueStatus, queueStatus === 'SUBMITTED' ? null : now, now, queueItemId);
      this.db.prepare('UPDATE publish_attempts SET status = ?, error_code = NULL, error_message = NULL, finished_at = COALESCE(finished_at, ?) WHERE id = ?').run(queueStatus === 'SUCCEEDED' ? 'SUCCEEDED' : 'SUBMITTED', now, latest.id);
      if (action === 'MARK_VERIFIED') this.db.prepare("UPDATE publish_receipts SET verification_source = 'OPERATOR', verification_evidence = ?, verified_at = ? WHERE attempt_id = ?").run(evidence, now, latest.id);
      return { id, queueItemId, attemptId: latest.id, action, evidence, createdAt: now };
    })();
  }

  private insertEvent(attemptId: string, eventType: string, message: string | undefined, now: string): void {
    const sequence = (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM publish_attempt_events WHERE attempt_id = ?').get(attemptId) as { value: number }).value;
    this.db.prepare('INSERT INTO publish_attempt_events (id, attempt_id, sequence, event_type, message, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), attemptId, sequence, eventType, message ?? null, now);
  }

  private mapAttempt(row: AttemptRow): PublishAttempt {
    const events = (this.db.prepare('SELECT * FROM publish_attempt_events WHERE attempt_id = ? ORDER BY sequence').all(row.id) as EventRow[]).map(mapEvent);
    const receiptRow = this.db.prepare('SELECT * FROM publish_receipts WHERE attempt_id = ?').get(row.id) as ReceiptRow | undefined;
    return { id: row.id, queueItemId: row.queue_item_id, accountId: row.account_id ?? undefined, groupId: row.group_id ?? undefined, attemptNumber: row.attempt_number, status: row.status, errorCode: row.error_code ?? undefined, errorMessage: row.error_message ?? undefined, diagnosticAvailable: Boolean(row.diagnostic_path), startedAt: row.started_at, finishedAt: row.finished_at ?? undefined, createdAt: row.created_at, events, receipt: receiptRow ? mapReceipt(receiptRow) : undefined, irreversibleReached: this.irreversibleReached(row.id, row.status), executionMode: row.execution_mode, selectorVersion: row.selector_version ?? undefined, preflight: Boolean(row.preflight) };
  }

  private irreversibleReached(attemptId: string, status: PublishAttemptStatus): boolean {
    if (['SUBMITTING', 'SUBMITTED', 'SUCCEEDED', 'NEEDS_ATTENTION'].includes(status)) return Boolean(this.db.prepare("SELECT 1 FROM publish_attempt_events WHERE attempt_id = ? AND event_type IN ('SUBMITTING', 'POST_CLICKED', 'SUBMITTED', 'VERIFIED') LIMIT 1").get(attemptId)) || status !== 'NEEDS_ATTENTION';
    return false;
  }
}
