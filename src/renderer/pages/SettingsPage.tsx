import { useCallback, useEffect, useState } from "react";
import type {
  BackupInfo,
  OrphanMediaScan,
  PublishingSettings,
  StorageUsage,
} from "@shared/types";
import { ActionDialog } from "../components/ActionDialog";

export function SettingsPage({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const [value, setValue] = useState<PublishingSettings>();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [storage, setStorage] = useState<StorageUsage>();
  const [orphan, setOrphan] = useState<OrphanMediaScan>();
  const [dialog, setDialog] = useState<
    "SAVE_LIVE" | "CLEAN_DIAGNOSTICS" | "CLEAN_ORPHANS" | string
  >();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const loadBackups = useCallback(async () => {
    try {
      setBackups(await window.operationsApi.listBackups());
    } catch (error) {
      onError(error);
    }
  }, [onError]);
  useEffect(() => {
    void window.settingsApi.getPublishing().then(setValue).catch(onError);
    void loadBackups();
  }, [loadBackups, onError]);
  async function save(confirmLive = false) {
    if (!value) return;
    if (value.executionMode === "LIVE" && !confirmLive) {
      setDialog("SAVE_LIVE");
      return;
    }
    setSaving(true);
    try {
      setValue(
        await window.settingsApi.updatePublishing({ ...value, confirmLive }),
      );
      setDialog(undefined);
      setNotice("Publishing settings saved. Scheduler remains disarmed.");
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }
  async function createBackup() {
    try {
      await window.operationsApi.createBackup();
      setNotice("Manual SQLite-safe backup created.");
      await loadBackups();
    } catch (error) {
      onError(error);
    }
  }
  async function calculateStorage() {
    try {
      setStorage(await window.operationsApi.storageUsage());
    } catch (error) {
      onError(error);
    }
  }
  async function restore(id: string) {
    try {
      await window.operationsApi.restoreBackup(id);
    } catch (error) {
      onError(error);
    }
  }
  if (!value)
    return (
      <main className="content">
        <div className="empty-state">Loading settings…</div>
      </main>
    );
  const restoreId = dialog?.startsWith("RESTORE:")
    ? dialog.slice(8)
    : undefined;
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <h2>Settings</h2>
          <p>
            Persistent guardrails, managed backups, and local storage
            maintenance.
          </p>
        </div>
        <button
          className="primary"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
      {notice && (
        <div className="notice success">
          <strong>Complete</strong>
          <span>{notice}</span>
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}
      <section className="panel settings-panel">
        <label className="engine-toggle">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) =>
              setValue({ ...value, enabled: event.target.checked })
            }
          />
          <span>
            <strong>Publishing Engine</strong>
            <small>
              Required for scheduler arming. Runtime arming always resets to
              DISARMED on startup.
            </small>
          </span>
          <b>{value.enabled ? "ON" : "OFF"}</b>
        </label>
        <label className="engine-toggle">
          <input
            type="checkbox"
            checked={value.canaryMode !== false}
            onChange={(event) =>
              setValue({ ...value, canaryMode: event.target.checked })
            }
          />
          <span>
            <strong>Canary Mode</strong>
            <small>
              ON permits one explicit LIVE item. Turn it OFF to enable
              controlled multi-item batches and the scheduler.
            </small>
          </span>
          <b>{value.canaryMode !== false ? "ON" : "OFF"}</b>
        </label>
        <label className="engine-toggle">
          <input type="checkbox" checked={value.requireReadyAccounts === true} onChange={(event) => setValue({ ...value, requireReadyAccounts: event.target.checked })} />
          <span><strong>Require READY accounts for scheduler</strong><small>When enabled, scheduled jobs use only accounts explicitly marked READY in the operator onboarding plan. Manual single runs show a warning but remain explicit.</small></span>
          <b>{value.requireReadyAccounts ? "ON" : "OFF"}</b>
        </label>
        <label>
          Execution mode
          <select
            value={value.executionMode}
            onChange={(event) =>
              setValue({
                ...value,
                executionMode: event.target
                  .value as PublishingSettings["executionMode"],
              })
            }
          >
            <option value="DRY_RUN">DRY RUN</option>
            <option value="LIVE">LIVE</option>
          </select>
        </label>
        <div className="settings-grid">
          <label>
            Scheduler interval (seconds)
            <input
              type="number"
              min={15}
              max={300}
              value={value.schedulerIntervalSeconds}
              onChange={(event) =>
                setValue({
                  ...value,
                  schedulerIntervalSeconds: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            Concurrent accounts
            <input
              type="number"
              min={1}
              max={3}
              value={value.maxConcurrentAccounts}
              onChange={(event) =>
                setValue({
                  ...value,
                  maxConcurrentAccounts: Number(event.target.value),
                })
              }
            />
            <small>One operation per account, 1–3 globally.</small>
          </label>
          <label>
            Maximum jobs per scheduler session
            <input
              type="number"
              min={1}
              max={100}
              value={value.maxJobsPerSchedulerSession}
              onChange={(event) =>
                setValue({
                  ...value,
                  maxJobsPerSchedulerSession: Number(event.target.value),
                })
              }
            />
            <small>1–100. Default 20; auto-disarms at the cap.</small>
          </label>
          <label>
            Batch pacing between posts (seconds)
            <input
              type="number"
              min={10}
              max={3600}
              value={value.batchPacingSeconds}
              onChange={(event) =>
                setValue({
                  ...value,
                  batchPacingSeconds: Number(event.target.value),
                })
              }
            />
            <small>{value.batchPacingSeconds} sec · {(value.batchPacingSeconds / 60).toFixed(value.batchPacingSeconds % 60 ? 1 : 0)} min. Fixed cooldown between consecutive LIVE jobs on the same account. This controls workload pacing and does not guarantee platform acceptance.</small>
          </label>
          <label>
            Video readiness timeout (seconds)
            <input
              type="number"
              min={60}
              max={1800}
              value={value.videoUploadTimeoutSeconds}
              onChange={(event) =>
                setValue({
                  ...value,
                  videoUploadTimeoutSeconds: Number(event.target.value),
                })
              }
            />
          </label>
        </div>
      </section>
      <section className="panel operations-recent">
        <div className="panel-heading">
          <div>
            <h3>Database backups</h3>
            <small>
              Managed files only. Five manual and five migration/pre-restore
              backups are retained by policy.
            </small>
          </div>
          <button className="secondary" onClick={() => void createBackup()}>
            Create Backup
          </button>
        </div>
        {backups.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Kind</th>
                  <th>Size</th>
                  <th>Schema</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => (
                  <tr key={backup.id}>
                    <td>{new Date(backup.createdAt).toLocaleString()}</td>
                    <td>{backup.kind}</td>
                    <td>{formatBytes(backup.size)}</td>
                    <td>{backup.schemaVersion}</td>
                    <td>
                      <button
                        className="danger"
                        onClick={() => setDialog(`RESTORE:${backup.id}`)}
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted-block">No managed backups yet.</div>
        )}
      </section>
      <section className="panel operations-recent">
        <div className="panel-heading">
          <div>
            <h3>Storage</h3>
            <small>Calculated only on demand.</small>
          </div>
          <button className="secondary" onClick={() => void calculateStorage()}>
            Calculate usage
          </button>
        </div>
        {storage && (
          <div className="status-summary">
            <span>
              Database <strong>{formatBytes(storage.database)}</strong>
            </span>
            <span>
              Profiles <strong>{formatBytes(storage.profiles)}</strong>
            </span>
            <span>
              Media <strong>{formatBytes(storage.media)}</strong>
            </span>
            <span>
              Diagnostics <strong>{formatBytes(storage.diagnostics)}</strong>
            </span>
            <span>
              Backups <strong>{formatBytes(storage.backups)}</strong>
            </span>
          </div>
        )}
        <div className="heading-actions">
          <button
            className="secondary"
            onClick={() => setDialog("CLEAN_DIAGNOSTICS")}
          >
            Clean old diagnostics
          </button>
          <button
            className="secondary"
            onClick={() =>
              void window.operationsApi
                .scanOrphanMedia()
                .then(setOrphan)
                .catch(onError)
            }
          >
            Scan orphan media
          </button>
          {orphan && (
            <>
              <span>
                {orphan.candidateCount} candidate(s),{" "}
                {formatBytes(orphan.totalBytes)}
              </span>
              <button
                className="danger"
                disabled={!orphan.candidateCount}
                onClick={() => setDialog("CLEAN_ORPHANS")}
              >
                Clean reviewed files
              </button>
            </>
          )}
        </div>
      </section>
      {dialog === "SAVE_LIVE" && (
        <ActionDialog
          title="Enable LIVE settings"
          message="LIVE mode can click Facebook Post. Security challenges are never bypassed, and the scheduler remains disarmed until separately confirmed."
          confirmLabel="Save LIVE settings"
          onCancel={() => setDialog(undefined)}
          onConfirm={() => save(true)}
        />
      )}
      {dialog === "CLEAN_DIAGNOSTICS" && (
        <ActionDialog
          title="Clean old diagnostics"
          message="Delete managed diagnostic files older than the retention period. No profile or browser data is touched."
          confirmLabel="Clean diagnostics"
          onCancel={() => setDialog(undefined)}
          onConfirm={async () => {
            try {
              const count = await window.operationsApi.cleanDiagnostics();
              setNotice(`Removed ${count} old diagnostic file(s).`);
              setDialog(undefined);
            } catch (error) {
              onError(error);
            }
          }}
        />
      )}
      {dialog === "CLEAN_ORPHANS" && orphan && (
        <ActionDialog
          title="Clean reviewed orphan media"
          message={`Delete ${orphan.candidateCount} managed file(s) from the reviewed scan. Database-referenced media is rechecked and preserved.`}
          confirmLabel="Clean files"
          danger
          onCancel={() => setDialog(undefined)}
          onConfirm={async () => {
            try {
              const count = await window.operationsApi.cleanOrphanMedia(
                orphan.candidateIds,
              );
              setNotice(`Removed ${count} orphan media file(s).`);
              setOrphan(undefined);
              setDialog(undefined);
            } catch (error) {
              onError(error);
            }
          }}
        />
      )}
      {restoreId && (
        <ActionDialog
          title="Restore database backup"
          message="Strong confirmation: the scheduler must be DISARMED and no publishing job may be active. A pre-restore backup is created, then the application restarts."
          confirmLabel="Restore and restart"
          danger
          onCancel={() => setDialog(undefined)}
          onConfirm={() => restore(restoreId)}
        />
      )}
    </main>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
