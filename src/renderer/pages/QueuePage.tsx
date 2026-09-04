import { type FormEvent, useCallback, useEffect, useState } from "react";
import type {
  Draft,
  FacebookAccount,
  FacebookGroup,
  PreflightResult,
  PublishBatchRuntime,
  PublishBatchPreview,
  PublishingEngineStatus,
  PublishAttempt,
  QueueItem,
  QueuePreview,
  QueueStatus,
  QueueTarget,
  ReconciliationRecord,
} from "@shared/types";
import {
  submitVerificationEvidence,
  verificationEvidenceError,
} from "../verificationEvidence";
import { ActionDialog } from "../components/ActionDialog";

type Props = { accounts: FacebookAccount[]; onError: (error: unknown) => void };
const queueStatuses: QueueStatus[] = [
  "PENDING",
  "PAUSED",
  "RUNNING",
  "SUBMITTED",
  "SUCCEEDED",
  "FAILED",
  "NEEDS_ATTENTION",
  "CANCELLED",
];

export function QueuePage({ accounts, onError }: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [groups, setGroups] = useState<FacebookGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [filterAccount, setFilterAccount] = useState("");
  const [filterGroup, setFilterGroup] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [builder, setBuilder] = useState(false);
  const [draftId, setDraftId] = useState("");
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [targets, setTargets] = useState<QueueTarget[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [preview, setPreview] = useState<QueuePreview>();
  const [detail, setDetail] = useState<QueueItem>();
  const [attempts, setAttempts] = useState<PublishAttempt[]>([]);
  const [reconciliations, setReconciliations] = useState<
    ReconciliationRecord[]
  >([]);
  const [verificationItem, setVerificationItem] = useState<QueueItem>();
  const [busy, setBusy] = useState(false);
  const [publishStatus, setPublishStatus] = useState<PublishingEngineStatus>();
  const [batchPreview, setBatchPreview] = useState<PublishBatchPreview>();
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [cooldownNow, setCooldownNow] = useState(Date.now());
  const [batchAction, setBatchAction] = useState<
    "PAUSE" | "RESUME" | "CANCEL"
  >();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [queue, draftList, groupList, engine] = await Promise.all([
        window.queueApi.list({
          search: search || undefined,
          status: status ? (status as QueueStatus) : undefined,
          accountId: filterAccount || undefined,
          groupId: filterGroup || undefined,
          from: fromDate ? new Date(fromDate).toISOString() : undefined,
          to: toDate ? new Date(toDate).toISOString() : undefined,
        }),
        window.draftApi.list({ status: "READY" }),
        window.groupApi.list({}),
        window.publishApi.status(),
      ]);
      setItems(queue);
      setDrafts(draftList);
      setGroups(groupList);
      setPublishStatus(engine);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [filterAccount, filterGroup, fromDate, onError, search, status, toDate]);
  useEffect(() => {
    void load();
    const unsubscribe = window.publishApi.onChanged(() => void load());
    return unsubscribe;
  }, [load]);
  useEffect(() => {
    if (!publishStatus?.batch?.lanes.some((lane) => lane.state === 'COOLDOWN')) return;
    const timer = window.setInterval(() => setCooldownNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [publishStatus?.batch]);

  function toggleTarget(accountId: string, groupId: string) {
    setTargets((current) =>
      current.some(
        (target) =>
          target.accountId === accountId && target.groupId === groupId,
      )
        ? current.filter(
            (target) =>
              target.accountId !== accountId || target.groupId !== groupId,
          )
        : [...current, { accountId, groupId }],
    );
  }
  async function inspect() {
    try {
      setPreview(
        await window.queueApi.preview({
          draftId,
          targets,
          scheduledAt: scheduledAt
            ? new Date(scheduledAt).toISOString()
            : undefined,
        }),
      );
    } catch (error) {
      onError(error);
    }
  }
  async function create() {
    try {
      await window.queueApi.create({
        draftId,
        targets,
        scheduledAt: scheduledAt
          ? new Date(scheduledAt).toISOString()
          : undefined,
      });
      setBuilder(false);
      setPreview(undefined);
      setTargets([]);
      await load();
    } catch (error) {
      onError(error);
    }
  }
  async function openDetail(item: QueueItem) {
    setDetail(item);
    try {
      const [history, reconciliation] = await Promise.all([
        window.publishApi.attempts(item.id),
        window.publishApi.reconciliations(item.id),
      ]);
      setAttempts(history);
      setReconciliations(reconciliation);
    } catch (error) {
      onError(error);
    }
  }
  async function runItems(ids: string[]) {
    const chosen = items.filter((item) => ids.includes(item.id));
    const accountCount = new Set(chosen.map((item) => item.accountId)).size;
    const groupCount = new Set(chosen.map((item) => item.groupId)).size;
    let mode: "DRY_RUN" | "LIVE"; let requireReadyAccounts = false; let canaryMode = true;
    try {
      const engine = await window.publishApi.status(); setPublishStatus(engine); mode = engine.settings.executionMode; requireReadyAccounts = engine.settings.requireReadyAccounts === true; canaryMode = engine.settings.canaryMode !== false;
    } catch (error) {
      onError(error);
      return;
    }
    if (mode === "LIVE" && canaryMode && ids.length > 1) {
      onError(new Error("Disable Canary Mode to run more than one LIVE item."));
      return;
    }
    if (mode === "LIVE" && ids.length > 1) {
      try { setBatchIds(ids); setBatchPreview(await window.publishApi.previewBatch(ids)); }
      catch (error) { onError(error); }
      return;
    }
    const action =
      mode === "DRY_RUN"
        ? "run a preflight and stop before Post"
        : "click Facebook Post once per job";
    const notReady = requireReadyAccounts ? chosen.filter((item) => accounts.find((account) => account.id === item.accountId)?.onboardingStatus !== "READY") : [];
    const onboardingWarning = notReady.length ? `\n\nWarning: ${notReady.length} selected job(s) use accounts not marked READY in the operator onboarding plan. The READY setting gates scheduler claims only; this manual run is an explicit override.` : "";
    if (
      !window.confirm(
        `Run ${chosen.length} job(s) across ${accountCount} account(s) and ${groupCount} group(s)? This will ${action}.${onboardingWarning}`,
      )
    )
      return;
    await executeRun(ids);
  }
  async function executeRun(ids: string[], prepareFirst = false) {
    setBusy(true);
    try {
      if (prepareFirst) {
        await window.publishApi.prepareAndRunBatch(ids);
      } else {
        await window.publishApi.runSelected(ids);
      }
      setSelected(new Set());
      setBatchPreview(undefined);
      setBatchIds([]);
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  async function action(item: QueueItem, kind: string) {
    if (kind === "mark-verified") {
      setVerificationItem(item);
      return;
    }
    setBusy(true);
    try {
      if (kind === "pause") await window.queueApi.pause(item.id);
      if (kind === "resume") await window.queueApi.resume(item.id);
      if (kind === "cancel") await window.queueApi.cancel(item.id);
      if (
        kind === "delete" &&
        window.confirm("Delete this cancelled queue item and its history?")
      )
        await window.queueApi.delete(item.id);
      if (kind === "open-group") {
        if (!item.groupId || !item.accountId)
          throw new Error(
            "The original account or group is no longer available.",
          );
        await window.groupApi.open(item.groupId, item.accountId);
      }
      if (kind === "preflight") {
        const result = await window.publishApi.preflight(item.id);
        const message = formatPreflightResult(result);
        if (
          result.diagnosticPath &&
          !result.passed &&
          window.confirm(
            `${message}\n\nOpen the local composer diagnostic screenshot?`,
          )
        )
          await window.publishApi.openPreflightDiagnostic(item.id);
        else window.alert(message);
      }
      if (kind === "retry") {
        const history = await window.publishApi.attempts(item.id);
        const risky = history[0]?.irreversibleReached ?? false;
        if (
          !window.confirm(
            risky
              ? "Facebook may already have accepted the previous post. Retry may publish a duplicate. Continue?"
              : "Retry this failed queue item?",
          )
        )
          return;
        await window.publishApi.retry(item.id, risky);
      }
      if (kind === "resolve") {
        if (
          !window.confirm(
            "Mark this item submitted without claiming verified publication?",
          )
        )
          return;
        await window.publishApi.resolve(item.id);
      }
      if (kind === "mark-submitted") {
        if (
          !window.confirm(
            "Mark this item SUBMITTED? This records operator reconciliation but does not verify public publication.",
          )
        )
          return;
        await window.publishApi.markSubmitted(item.id);
      }
      if (kind === "requeue") {
        if (
          !window.confirm(
            "Create a new queue item from this immutable snapshot?",
          )
        )
          return;
        await window.publishApi.requeue({ queueId: item.id });
      }
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  async function applyBatch() {
    if (!batchAction) return;
    try {
      await window.queueApi.batchAction({
        queueIds: [...selected],
        action: batchAction,
      });
      setSelected(new Set());
      setBatchAction(undefined);
      await load();
    } catch (error) {
      onError(error);
    }
  }

  const runnable = items.filter(
    (item) => selected.has(item.id) && item.status === "PENDING",
  );
  const canaryBatchBlocked = publishStatus?.settings.executionMode === "LIVE" && publishStatus.settings.canaryMode !== false && runnable.length > 1;
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <h2>Queue</h2>
          <p>
            Immutable snapshots, controlled execution, and publishing evidence.
          </p>
        </div>
        <div className="heading-actions">
          {selected.size > 0 && (
            <>
              <button
                className="secondary"
                onClick={() => setBatchAction("PAUSE")}
              >
                Pause selected
              </button>
              <button
                className="secondary"
                onClick={() => setBatchAction("RESUME")}
              >
                Resume selected
              </button>
              <button
                className="danger"
                onClick={() => setBatchAction("CANCEL")}
              >
                Cancel selected
              </button>
            </>
          )}
          {runnable.length > 0 && (
            <>
              <button
                className="secondary"
                title="Run all checked groups"
                disabled={busy || canaryBatchBlocked}
                onClick={() => void runItems(runnable.map((item) => item.id))}
              >
                Run selected ({runnable.length})
              </button>
              {canaryBatchBlocked && <small className="inline-warning">Disable Canary Mode to run more than one LIVE item.</small>}
            </>
          )}
          <button className="primary" onClick={() => setBuilder(true)}>
            ＋ Build queue
          </button>
        </div>
      </div>
      {publishStatus?.batch && <BatchProgress batch={publishStatus.batch} now={cooldownNow}/>}
      <div className="filters">
        <label>
          Search
          <input
            placeholder="Draft, account, or group"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            {queueStatuses.map((value) => (
              <option value={value} key={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Account
          <select
            value={filterAccount}
            onChange={(event) => setFilterAccount(event.target.value)}
          >
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option value={account.id} key={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Group
          <select
            value={filterGroup}
            onChange={(event) => setFilterGroup(event.target.value)}
          >
            <option value="">All groups</option>
            {groups.map((group) => (
              <option value={group.id} key={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="datetime-local"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
          />
        </label>
      </div>
      {loading ? (
        <div className="empty-state">Loading queue…</div>
      ) : !items.length ? (
        <div className="empty-state">
          <strong>Queue is empty</strong>
          <p>Build a queue batch from a READY draft and active assignments.</p>
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrap">
            <table className="queue-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Status</th>
                  <th>Scheduled</th>
                  <th>Account / Group</th>
                  <th>Draft</th>
                  <th>Automation</th>
                  <th>Verification</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={
                          !["PENDING", "PAUSED", "NEEDS_ATTENTION"].includes(
                            item.status,
                          )
                        }
                        checked={selected.has(item.id)}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>
                      <span
                        className={`status-badge status-${item.status.toLowerCase()}`}
                      >
                        {item.outcome?.finalStatus ?? item.status}
                      </span>
                      {item.attentionReason && (
                        <small
                          className="error-text"
                          title={item.attentionReason}
                        >
                          {item.attentionReason}
                        </small>
                      )}
                    </td>
                    <td>
                      {item.scheduledAt
                        ? new Date(item.scheduledAt).toLocaleString()
                        : "Manual"}
                      {item.scheduledAt &&
                        new Date(item.scheduledAt) <= new Date() &&
                        item.status === "PENDING" && (
                          <small className="due-label">Due</small>
                        )}
                    </td>
                    <td>
                      <strong>{item.accountName}</strong>
                      <small>{item.groupName}</small>
                    </td>
                    <td>
                      <button
                        className="link-button"
                        onClick={() => void openDetail(item)}
                      >
                        <strong>{item.draftTitle}</strong>
                      </button>
                      <small>
                        {item.media.length} media · {item.body.length} chars
                      </small>
                    </td>
                    <td>{item.outcome?.automatedResult ?? "—"}</td>
                    <td>
                      {item.outcome?.verificationSource === "OPERATOR"
                        ? "OPERATOR VERIFIED"
                        : (item.outcome?.verificationSource ?? "NONE")}
                    </td>
                    <td>
                      <QueueActions
                        item={item}
                        busy={busy}
                        onRun={() => void runItems([item.id])}
                        onAction={(kind) => void action(item, kind)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {builder && (
        <QueueBuilder
          drafts={drafts}
          accounts={accounts}
          groups={groups}
          draftId={draftId}
          selectedAccounts={selectedAccounts}
          targets={targets}
          scheduledAt={scheduledAt}
          preview={preview}
          onDraft={setDraftId}
          onAccounts={setSelectedAccounts}
          onTarget={toggleTarget}
          onSchedule={setScheduledAt}
          onPreview={() => void inspect()}
          onCreate={() => void create()}
          onCancel={() => {
            setBuilder(false);
            setPreview(undefined);
          }}
        />
      )}
      {detail && (
        <QueueDetail
          item={detail}
          attempts={attempts}
          reconciliations={reconciliations}
          pendingDraftCount={
            detail.draftId
              ? items.filter(
                  (i) => i.draftId === detail.draftId && i.status === 'PENDING'
                ).length
              : 0
          }
          onRunDraftPending={() => {
            const pendingIds = detail.draftId
              ? items
                  .filter(
                    (i) =>
                      i.draftId === detail.draftId && i.status === 'PENDING'
                  )
                  .map((i) => i.id)
              : [];
            if (pendingIds.length > 0) {
              void runItems(pendingIds);
            }
          }}
          onClose={() => {
            setDetail(undefined);
            setAttempts([]);
            setReconciliations([]);
          }}
          onDiagnostic={(id) =>
            void window.publishApi.openDiagnostic(id).catch(onError)
          }
          onDeleteDiagnostic={(id) =>
            void window.publishApi
              .deleteDiagnostic(id)
              .then(() => openDetail(detail))
              .catch(onError)
          }
        />
      )}
      {verificationItem && (
        <MarkVerifiedDialog
          item={verificationItem}
          onCancel={() => setVerificationItem(undefined)}
          onConfirm={async (evidence) => {
            await window.publishApi.markVerified(verificationItem.id, evidence);
            await load();
          }}
          onError={onError}
        />
      )}
      {batchAction && (
        <ActionDialog
          title={`${batchAction} selected queue items`}
          message={`All ${selected.size} items must be in a valid state or no item will change.`}
          confirmLabel={batchAction}
          danger={batchAction === "CANCEL"}
          onCancel={() => setBatchAction(undefined)}
          onConfirm={applyBatch}
        />
      )}
      {batchPreview && (
        <ActionDialog
          title="Run controlled batch"
          message={`Run ${batchPreview.requested} selected queue items? Accounts: ${batchPreview.accountCount}. Groups: ${batchPreview.groupCount}. Pacing: ${batchPreview.batchPacingSeconds} sec between posts/account. Minimum pacing time: ${formatBatchDuration(batchPreview.minimumPacingSeconds)}.`}
          confirmLabel={batchPreview.canPrepare ? "Prepare & Run Batch" : "Run controlled batch"}
          confirmDisabled={batchPreview.blocked > 0 && !batchPreview.canPrepare}
          onCancel={() => { setBatchPreview(undefined); setBatchIds([]); }}
          onConfirm={() => executeRun(batchIds, Boolean(batchPreview.canPrepare))}
        >
          {batchPreview.canPrepare ? (
            <div className="notice warning">
              Preflight: {batchPreview.ready} READY · {batchPreview.needPreparation} NEED PREPARATION.
            </div>
          ) : batchPreview.blocked > 0 ? (
            <div className="inline-warning">
              Blocked: {batchPreview.blocked}. Fix or remove every blocked item before starting. {batchPreview.items.filter((item) => item.reasons.length).map((item) => `${item.accountName ?? item.queueId}: ${item.reasons.join(', ')}`).join(' · ')}
            </div>
          ) : (
            <div className="notice success">
              Ready: {batchPreview.ready} of {batchPreview.requested}. Facebook loading, upload, and verification time are not included in the minimum pacing time.
            </div>
          )}
        </ActionDialog>
      )}
    </main>
  );
}

function BatchProgress({ batch, now }: { batch: PublishBatchRuntime; now: number }) {
  const cooldown = batch.lanes.find((lane) => lane.state === 'COOLDOWN');
  const remaining = cooldown?.cooldownUntil ? Math.max(0, Math.ceil((Date.parse(cooldown.cooldownUntil) - now) / 1000)) : cooldown?.remainingSeconds;
  return <section className="panel operations-recent"><div className="panel-heading"><div><h3>Controlled batch · {batch.state}</h3><small>{batch.processed} / {batch.requested} processed · {batch.source}</small></div>{remaining !== undefined && <strong>Cooldown: {formatBatchDuration(remaining)}</strong>}</div>{batch.current && <p>Current: {batch.current.accountName} → {batch.current.groupName ?? 'group'}</p>}{batch.next && <p>Next: {batch.next.accountName} → {batch.next.groupName ?? 'group'}</p>}{batch.reason && <small>{batch.reason}</small>}</section>;
}

function formatBatchDuration(seconds: number): string { const minutes = Math.floor(seconds / 60); return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; }

export function MarkVerifiedDialog({
  item,
  onCancel,
  onConfirm,
  onError,
}: {
  item: QueueItem;
  onCancel: () => void;
  onConfirm: (evidence: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [evidence, setEvidence] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel, saving]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const issue = verificationEvidenceError(evidence);
    if (issue) {
      setError(issue);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await submitVerificationEvidence(
        item.id,
        evidence,
        async (_queueId, trimmed) => onConfirm(trimmed),
      );
      setSaving(false);
      onCancel();
    } catch (submitError) {
      setSaving(false);
      setError("Unable to mark this item verified.");
      onError(submitError);
    }
  }
  return (
    <div className="modal-backdrop">
      <form
        className="modal form-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mark-verified-title"
        onSubmit={(event) => void submit(event)}
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow">OPERATOR VERIFICATION</div>
            <h2 id="mark-verified-title">Mark verified</h2>
            <p>
              {item.accountName} → {item.groupName}
            </p>
          </div>
          <button
            type="button"
            className="close-button"
            disabled={saving}
            aria-label="Close"
            onClick={onCancel}
          >
            ×
          </button>
        </div>
        <label>
          Verification evidence
          <textarea
            autoFocus
            maxLength={500}
            value={evidence}
            placeholder="Confirmed the post is visible in the target Facebook group."
            onChange={(event) => {
              setEvidence(event.target.value);
              setError(undefined);
            }}
          />
        </label>
        <small className="counter">{evidence.length}/500</small>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={saving || !evidence.trim()}
          >
            {saving ? "Marking verified…" : "Mark verified"}
          </button>
        </div>
      </form>
    </div>
  );
}

function formatPreflightResult(result: PreflightResult): string {
  const postFound =
    (result.postButton.count ?? 0) > 0 || result.postButtonFound;
  const postEnabled = result.postButton.enabled === true;
  const mediaDetail = result.mediaReport?.items
    .map(
      (item, index) =>
        `${index + 1}. ${item.originalName} · managed ${item.managedPath ? "PASS" : "FAIL"} · signature ${item.signature ? "PASS" : "FAIL"} · exists ${item.exists ? "PASS" : "FAIL"} · Facebook input ${item.facebookMediaInput ?? "NOT_TESTED"}`,
    )
    .join("\n");
  const reason = [
    result.reason ?? result.postButton.reason ?? result.warnings[0],
    mediaDetail
      ? `Media count: ${result.mediaReport?.count}\n${mediaDetail}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const candidates = result.triggerCandidates
    ?.slice(0, 5)
    .map(
      (candidate, index) =>
        `${index + 1}. role=${candidate.role ?? "unknown"}${candidate.ariaLabel ? ` aria-label="${candidate.ariaLabel}"` : ""}${candidate.text ? ` text="${candidate.text}"` : ""}`,
    )
    .join("\n");
  const textboxCandidates = result.textboxCandidates
    ?.slice(0, 5)
    .map(
      (candidate, index) =>
        `${index + 1}. group=${candidate.groupId ?? "unknown"} tag=${candidate.tag ?? "unknown"} role=${candidate.role ?? "unknown"} contenteditable=${candidate.contenteditable ?? "unknown"}${candidate.ariaLabel ? ` aria-label="${candidate.ariaLabel}"` : ""}${candidate.placeholder ? ` placeholder="${candidate.placeholder}"` : ""}${candidate.ariaMultiline ? ` aria-multiline=${candidate.ariaMultiline}` : ""}${candidate.lexicalEditor ? ` lexical=${candidate.lexicalEditor}` : ""}${candidate.focusable === undefined ? "" : ` focusable=${candidate.focusable ? "YES" : "NO"}`}${candidate.visible === undefined ? "" : ` visible=${candidate.visible ? "YES" : "NO"}`}`,
    )
    .join("\n");
  const dialogs = result.dialogCandidates
    ?.slice(0, 5)
    .map(
      (candidate, index) =>
        `${index + 1}. title=${candidate.title ?? "unknown"}${candidate.newAfterTrigger === undefined ? "" : ` newAfterTrigger=${candidate.newAfterTrigger ? "YES" : "NO"}`}${candidate.changedAfterTrigger ? " changedAfterTrigger=YES" : ""}${candidate.visible === undefined ? "" : ` visible=${candidate.visible ? "YES" : "NO"}`}${candidate.foreground === undefined ? "" : ` foreground=${candidate.foreground ? "YES" : "NO"}`}`,
    )
    .join("\n");
  return [
    `Preflight ${result.passed ? "PASSED" : "FAILED"}`,
    `Selector: ${result.selectorVersion}`,
    `Group: ${result.group.status}`,
    `Composer: ${result.composerTrigger.status}`,
    result.triggerStrategy ? `Trigger strategy: ${result.triggerStrategy}` : "",
    candidates && result.composerTrigger.status !== "FOUND"
      ? `Trigger candidates:\n${candidates}`
      : "",
    `Create Post dialog: ${result.createPostDialog?.status ?? "NOT TESTED"}${result.createPostDialog?.count === undefined ? "" : ` (${result.createPostDialog.count})`}`,
    result.dialogTitle ? `Dialog title: ${result.dialogTitle}` : "",
    dialogs && result.createPostDialog?.status !== "FOUND"
      ? `Dialog candidates:\n${dialogs}`
      : "",
    `Textbox: ${result.composerTextbox.status}`,
    result.textboxStrategy ? `Textbox strategy: ${result.textboxStrategy}` : "",
    result.rawEditorCount !== undefined
      ? `Raw editor candidates: ${result.rawEditorCount}`
      : "",
    result.logicalEditorCount !== undefined
      ? `Collapsed editor groups: ${result.logicalEditorCount}`
      : "",
    textboxCandidates && result.composerTextbox.status !== "FOUND"
      ? `Textbox candidates:\n${textboxCandidates}`
      : "",
    `Editor: ${result.editorType ?? "UNKNOWN"}`,
    `Content: ${result.contentObserved ? "OBSERVED" : "NOT OBSERVED"}`,
    `Entry: ${result.entryMethod ?? "NOT USED"}`,
    `Post control: ${postFound ? "FOUND" : "NOT FOUND"}`,
    `Post enabled: ${postEnabled ? "YES" : "NO"}`,
    reason ? `Reason: ${reason}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function QueueActions({
  item,
  busy,
  onRun,
  onAction,
}: {
  item: QueueItem;
  busy: boolean;
  onRun: () => void;
  onAction: (kind: string) => void;
}) {
  return (
    <div className="row-actions">
      {item.status === "PENDING" && (
        <button
          className="action-button"
          title="Run this group only"
          disabled={busy}
          onClick={onRun}
        >
          Run
        </button>
      )}
      <details className="action-menu">
        <summary>More ▾</summary>
        <div>
          {item.status === "PENDING" && (
            <>
              <button onClick={() => onAction("preflight")}>Preflight</button>
              <button onClick={() => onAction("pause")}>Pause</button>
            </>
          )}
          {item.status === "PAUSED" && (
            <button onClick={() => onAction("resume")}>Resume</button>
          )}
          {(item.status === "SUBMITTED" || item.status === "NEEDS_ATTENTION") &&
            item.accountId &&
            item.groupId && (
              <button onClick={() => onAction("open-group")}>Open group</button>
            )}
          {item.status === "NEEDS_ATTENTION" && (
            <button onClick={() => onAction("mark-submitted")}>
              Mark submitted
            </button>
          )}
          {(item.status === "SUBMITTED" ||
            item.status === "NEEDS_ATTENTION") && (
            <button onClick={() => onAction("mark-verified")}>
              Mark verified
            </button>
          )}
          {["PENDING", "PAUSED", "NEEDS_ATTENTION"].includes(item.status) && (
            <button onClick={() => onAction("cancel")}>Cancel</button>
          )}
          {["FAILED", "NEEDS_ATTENTION"].includes(item.status) && (
            <button onClick={() => onAction("retry")}>Retry</button>
          )}
          {["SUBMITTED", "FAILED", "SUCCEEDED", "CANCELLED"].includes(
            item.status,
          ) && <button onClick={() => onAction("requeue")}>Requeue</button>}
          {item.status === "CANCELLED" && (
            <button className="danger-text" onClick={() => onAction("delete")}>
              Delete
            </button>
          )}
        </div>
      </details>
    </div>
  );
}

function QueueBuilder({
  drafts,
  accounts,
  groups,
  draftId,
  selectedAccounts,
  targets,
  scheduledAt,
  preview,
  onDraft,
  onAccounts,
  onTarget,
  onSchedule,
  onPreview,
  onCreate,
  onCancel,
}: {
  drafts: Draft[];
  accounts: FacebookAccount[];
  groups: FacebookGroup[];
  draftId: string;
  selectedAccounts: string[];
  targets: QueueTarget[];
  scheduledAt: string;
  preview?: QueuePreview;
  onDraft: (id: string) => void;
  onAccounts: (ids: string[]) => void;
  onTarget: (accountId: string, groupId: string) => void;
  onSchedule: (value: string) => void;
  onPreview: () => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal form-modal wide-modal">
        <div className="modal-header">
          <div>
            <h3>Build queue batch</h3>
            <p>Every target is revalidated immediately before execution.</p>
          </div>
          <button className="close-button" onClick={onCancel}>
            ×
          </button>
        </div>
        <label>
          READY draft
          <select
            value={draftId}
            onChange={(event) => onDraft(event.target.value)}
          >
            <option value="">Choose a draft</option>
            {drafts.map((draft) => (
              <option key={draft.id} value={draft.id}>
                {draft.title}
              </option>
            ))}
          </select>
        </label>
        <div className="queue-builder-grid">
          <div>
            <h4>Accounts</h4>
            <div className="check-list compact">
              {accounts.map((account) => (
                <label className="check-row" key={account.id}>
                  <input
                    type="checkbox"
                    checked={selectedAccounts.includes(account.id)}
                    onChange={() =>
                      onAccounts(
                        selectedAccounts.includes(account.id)
                          ? selectedAccounts.filter((id) => id !== account.id)
                          : [...selectedAccounts, account.id],
                      )
                    }
                  />
                  {account.name}
                </label>
              ))}
            </div>
          </div>
          <div>
            <h4>Active groups</h4>
            <div className="check-list compact">
              {groups
                .filter((group) => group.active)
                .map((group) => (
                  <div className="target-group" key={group.id}>
                    <strong>{group.name}</strong>
                    {selectedAccounts.map((accountId) => (
                      <label className="check-row" key={accountId}>
                        <input
                          type="checkbox"
                          checked={targets.some(
                            (target) =>
                              target.accountId === accountId &&
                              target.groupId === group.id,
                          )}
                          onChange={() => onTarget(accountId, group.id)}
                        />
                        {
                          accounts.find((account) => account.id === accountId)
                            ?.name
                        }
                      </label>
                    ))}
                  </div>
                ))}
            </div>
          </div>
        </div>
        <label>
          Schedule (local time; blank means manual)
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(event) => onSchedule(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="secondary"
            disabled={!draftId || !targets.length}
            onClick={onPreview}
          >
            Preview
          </button>
          <button
            className="primary"
            disabled={!preview || Boolean(preview.issues.length)}
            onClick={onCreate}
          >
            Create {targets.length} item(s)
          </button>
        </div>
        {preview && (
          <div
            className={`preview-box ${preview.issues.length ? "has-errors" : ""}`}
          >
            <strong>
              {preview.issues.length
                ? "Review validation issues"
                : `${preview.targets.length} items ready`}
            </strong>
            {preview.issues.map((issue, index) => (
              <div key={`${issue.code}-${index}`}>
                {issue.code}: {issue.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function QueueDetail({
  item,
  attempts,
  reconciliations,
  pendingDraftCount,
  onRunDraftPending,
  onClose,
  onDiagnostic,
  onDeleteDiagnostic,
}: {
  item: QueueItem;
  attempts: PublishAttempt[];
  reconciliations: ReconciliationRecord[];
  pendingDraftCount?: number;
  onRunDraftPending?: () => void;
  onClose: () => void;
  onDiagnostic: (attemptId: string) => void;
  onDeleteDiagnostic: (attemptId: string) => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal form-modal wide-modal queue-detail">
        <div className="modal-header">
          <div>
            <h3>Queue snapshot</h3>
            <p>Immutable content and execution history.</p>
          </div>
          <button className="close-button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="outcome-grid">
          <div><small>Final Status</small><strong>{item.outcome?.finalStatus ?? item.status}</strong></div>
          <div><small>Automated Result</small><strong>{item.outcome?.automatedResult ?? "—"}</strong></div>
          <div><small>Verification</small><strong>{item.outcome?.verificationSource === "OPERATOR" ? "OPERATOR VERIFIED" : item.outcome?.verificationSource ?? "NONE"}</strong></div>
        </div>
        <div className="snapshot-meta">
          <span>{item.accountName}</span>
          <span>→</span>
          <span>{item.groupName}</span>
          <span className={`status-badge status-${item.status.toLowerCase()}`}>
            {item.status}
          </span>
        </div>
        <h4>{item.draftTitle}</h4>
        <pre className="snapshot-body">{item.body}</pre>
        {item.linkUrl && <div className="snapshot-link">{item.linkUrl}</div>}
        <div className="media-grid">
          {item.media.map((media) => (
            <div className="media-card compact-media" key={media.id}>
              <strong>{media.originalName}</strong>
              <small>
                {media.type} · #{media.sortOrder + 1}
              </small>
            </div>
          ))}
        </div>
        {reconciliations.length > 0 && (
          <>
            <h4 className="timeline-title">Operator reconciliation</h4>
            <div className="stack-list">
              {reconciliations.map((record) => (
                <div className="stack-row" key={record.id}>
                  <div>
                    <strong>{record.action}</strong>
                    <small>{record.evidence}</small>
                  </div>
                  <time>{new Date(record.createdAt).toLocaleString()}</time>
                </div>
              ))}
            </div>
          </>
        )}
        <h4 className="timeline-title">Execution history</h4>
        {attempts.length ? (
          attempts.map((attempt) => (
            <section className="attempt-card" key={attempt.id}>
              <div className="panel-heading">
                <strong>
                  Attempt {attempt.attemptNumber} · {attempt.executionMode}
                </strong>
                <span
                  className={`status-badge status-${attempt.status.toLowerCase()}`}
                >
                  {attempt.status}
                </span>
              </div>
              {attempt.events.map((event) => (
                <div className="timeline-row" key={event.id}>
                  <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                  <strong>{event.eventType}</strong>
                  <span>{event.message ?? ""}</span>
                </div>
              ))}
              {attempt.receipt && (
                <div className="receipt">
                  <strong>
                    Receipt: {attempt.receipt.result} (
                    {attempt.receipt.verificationSource})
                  </strong>
                  <span>{attempt.receipt.evidence}</span>
                  {attempt.receipt.verificationEvidence && (
                    <span>
                      Operator: {attempt.receipt.verificationEvidence}
                    </span>
                  )}
                  {attempt.receipt.postUrl && (
                    <span>{attempt.receipt.postUrl}</span>
                  )}
                </div>
              )}
              {attempt.errorMessage && (
                <div className="inline-error">
                  {attempt.errorCode}: {attempt.errorMessage}
                </div>
              )}
              {attempt.diagnosticAvailable && (
                <div className="heading-actions">
                  <button
                    className="secondary"
                    onClick={() => onDiagnostic(attempt.id)}
                  >
                    Open diagnostic
                  </button>
                  <button
                    className="secondary"
                    onClick={() => onDeleteDiagnostic(attempt.id)}
                  >
                    Delete diagnostic
                  </button>
                </div>
              )}
            </section>
          ))
        ) : (
          <div className="muted-block">No attempts yet.</div>
        )}
        <div className="modal-actions">
          {Boolean(pendingDraftCount && pendingDraftCount > 0 && onRunDraftPending) && (
            <button
              className="primary"
              onClick={() => {
                onClose();
                onRunDraftPending!();
              }}
            >
              Run all pending for this draft ({pendingDraftCount})
            </button>
          )}
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
