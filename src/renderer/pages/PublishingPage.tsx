import { useCallback, useEffect, useState } from "react";
import type { PublishingEngineStatus } from "@shared/types";
import { ActionDialog } from "../components/ActionDialog";

export function PublishingPage({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const [status, setStatus] = useState<PublishingEngineStatus>();
  const [dialog, setDialog] = useState<"ARM" | "STOP" | "STOP_AFTER">();
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      setStatus(await window.publishApi.status());
    } catch (error) {
      onError(error);
    }
  }, [onError]);
  useEffect(() => {
    void load();
    const unsubscribe = window.publishApi.onChanged(() => void load());
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [load]);
  async function perform(action: "ARM" | "STOP" | "STOP_AFTER") {
    try {
      if (action === "ARM") await window.publishApi.armScheduler(true);
      if (action === "STOP") await window.publishApi.stopPublishing();
      if (action === "STOP_AFTER") await window.publishApi.stopAfterCurrent();
      setNotice(
        action === "ARM"
          ? "Scheduler armed for this application session."
          : action === "STOP_AFTER"
            ? "Scheduler stopped after current work."
            : "Publishing stopped and scheduler disarmed.",
      );
      setDialog(undefined);
      await load();
    } catch (error) {
      onError(error);
    }
  }
  async function exportReport() {
    try {
      const path = await window.publishApi.exportReport();
      if (path) setNotice("Sanitized operations report exported.");
    } catch (error) {
      onError(error);
    }
  }
  if (!status)
    return (
      <main className="content">
        <div className="empty-state">Loading publishing…</div>
      </main>
    );
  const preview = status.armPreview;
  const canArm =
    status.schedulerState === "DISARMED" &&
    status.settings.enabled &&
    status.settings.executionMode === "LIVE" &&
    status.settings.canaryMode === false;
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <h2>Publishing Operations</h2>
          <p>
            Scheduler runtime state never persists across application restarts.
          </p>
        </div>
        <div className="heading-actions">
          <span
            className={`engine-badge ${status.settings.enabled ? "on" : "off"}`}
          >
            ENGINE {status.settings.enabled ? "ON" : "OFF"}
          </span>
          <span className="engine-badge off">
            {status.settings.executionMode}
          </span>
          <span
            className={`engine-badge ${status.settings.canaryMode !== false ? "on" : "off"}`}
          >
            CANARY {status.settings.canaryMode !== false ? "ON" : "OFF"}
          </span>
          <button className="secondary" onClick={() => void exportReport()}>
            Export report
          </button>
          <button
            className="primary"
            disabled={!canArm}
            onClick={() => setDialog("ARM")}
          >
            Arm Scheduler
          </button>
          <button
            className="secondary"
            disabled={status.schedulerState !== "ARMED" && !["RUNNING", "COOLDOWN", "STOPPING"].includes(status.batch?.state ?? "")}
            onClick={() => setDialog("STOP_AFTER")}
          >
            Stop after current
          </button>
          <button
            className="danger"
            disabled={
              status.schedulerState === "DISARMED" && !status.running.length && !["RUNNING", "COOLDOWN", "STOPPING"].includes(status.batch?.state ?? "")
            }
            onClick={() => setDialog("STOP")}
          >
            Stop Publishing
          </button>
        </div>
      </div>
      {notice && (
        <div className="notice success">
          <strong>Operation complete</strong>
          <span>{notice}</span>
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}
      {status.schedulerReason && (
        <div className="notice warning">
          <strong>Scheduler reason</strong>
          <span>{status.schedulerReason}</span>
        </div>
      )}
      {preview.overdueJobs > 0 && status.schedulerState === "DISARMED" && (
        <div className="safety-card">
          <div className="safety-icon">!</div>
          <div>
            <strong>Overdue backlog · {preview.overdueJobs} items</strong>
            <p>
              Oldest:{" "}
              {preview.oldestOverdueAt
                ? new Date(preview.oldestOverdueAt).toLocaleString()
                : "—"}
              . No item is claimed until explicit arming.
            </p>
          </div>
        </div>
      )}
      <div className="stat-grid">
        <Stat
          label="Scheduler"
          value={status.schedulerState}
          detail={status.schedulerReason ?? "runtime only"}
        />
        <Stat
          label="Due jobs"
          value={String(preview.dueJobs)}
          detail={`${preview.accountsInvolved} accounts · ${preview.groupsInvolved} groups`}
        />
        <Stat
          label="Session progress"
          value={`${status.sessionCompleted}/${status.sessionLimit}`}
          detail="auto-disarms at cap"
        />
        <Stat
          label="Executing"
          value={String(status.running.length)}
          detail={`max ${status.settings.maxConcurrentAccounts} accounts`}
        />
        <Stat
          label="Blocked accounts"
          value={String(status.blockedAccounts.length)}
          detail="login/checkpoint circuits"
        />
        <Stat
          label="Readiness"
          value={status.readiness.replaceAll("_", " ")}
          detail={`selectors ${status.selectorVersion}`}
        />
      </div>
      {status.batch && <section className="panel operations-recent"><div className="panel-heading"><div><h3>Controlled batch · {status.batch.state}</h3><small>{status.batch.processed} / {status.batch.requested} processed</small></div></div>{status.batch.current && <p>Current: {status.batch.current.accountName} → {status.batch.current.groupName ?? 'group'}</p>}{status.batch.next && <p>Next: {status.batch.next.accountName} → {status.batch.next.groupName ?? 'group'}</p>}{status.batch.lanes.filter((lane) => lane.state === 'COOLDOWN').map((lane) => <p key={lane.accountId}>Cooldown: {lane.accountName} · {lane.remainingSeconds ?? 0}s remaining</p>)}</section>}
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <h3>Currently executing</h3>
            <span>{status.running.length}</span>
          </div>
          {status.running.length ? (
            <div className="stack-list">
              {status.running.map((item) => (
                <div className="stack-row" key={item.id}>
                  <div>
                    <strong>
                      {item.accountName} → {item.groupName}
                    </strong>
                    <small>{item.draftTitle}</small>
                  </div>
                  <span className="status-badge status-running">RUNNING</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted-block">No active publishing operations.</div>
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h3>Blocked accounts</h3>
            <span>{status.blockedAccounts.length}</span>
          </div>
          {status.blockedAccounts.length ? (
            <div className="stack-list">
              {status.blockedAccounts.map((block) => (
                <div className="stack-row" key={block.accountId}>
                  <div>
                    <strong>{block.accountName}</strong>
                    <small>{block.message}</small>
                    <small>
                      Blocked since {new Date(block.blockedAt).toLocaleString()}
                    </small>
                  </div>
                  <span className="status-badge status-checkpoint">
                    {block.reason}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted-block">No blocked accounts.</div>
          )}
        </section>
      </div>
      <section className="panel operations-recent">
        <div className="panel-heading">
          <h3>Recent attempts</h3>
          <span>{status.recentAttempts.length}</span>
        </div>
        {status.recentAttempts.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Queue</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Automated result</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {status.recentAttempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <td>{new Date(attempt.startedAt).toLocaleString()}</td>
                    <td>{attempt.queueItemId.slice(0, 8)}</td>
                    <td>{attempt.executionMode}</td>
                    <td>{attempt.status}</td>
                    <td>{attempt.result ?? "—"}</td>
                    <td>{attempt.errorMessage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted-block">No publishing attempts yet.</div>
        )}
      </section>
      {dialog === "ARM" && (
        <ActionDialog
          title="Arm Scheduler"
          message={`Due jobs: ${preview.dueJobs} · Accounts: ${preview.accountsInvolved} · Groups: ${preview.groupsInvolved}. LIVE mode, Canary OFF. This explicitly acknowledges ${preview.overdueJobs} overdue item(s). Session cap: ${preview.sessionLimit}.`}
          confirmLabel="Arm Scheduler"
          onCancel={() => setDialog(undefined)}
          onConfirm={() => perform("ARM")}
        />
      )}
      {dialog === "STOP_AFTER" && (
        <ActionDialog
          title="Stop after current"
          message="Current executions may finish. No new queue item will be claimed, then the scheduler will disarm."
          confirmLabel="Stop after current"
          onCancel={() => setDialog(undefined)}
          onConfirm={() => perform("STOP_AFTER")}
        />
      )}
      {dialog === "STOP" && (
        <ActionDialog
          title="Stop Publishing"
          message="Stop claiming new items and request safe cancellation before irreversible submit. Work after a Post click is never reset automatically."
          confirmLabel="Stop Publishing"
          danger
          onCancel={() => setDialog(undefined)}
          onConfirm={() => perform("STOP")}
        />
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="stat-card">
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}
