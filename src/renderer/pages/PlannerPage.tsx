import { useCallback, useEffect, useState } from "react";
import type {
  PlannerBucket,
  PlannerSummary,
  QueueBatchAction,
  QueueRescheduleMode,
} from "@shared/types";
import { ActionDialog } from "../components/ActionDialog";

const bucketLabels: Record<PlannerBucket, string> = {
  TODAY: "Today",
  TOMORROW: "Tomorrow",
  LATER: "Later",
  UNSCHEDULED: "Unscheduled",
};

export function PlannerPage({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const [planner, setPlanner] = useState<PlannerSummary>();
  const [selected, setSelected] = useState(new Set<string>());
  const [confirmAction, setConfirmAction] = useState<QueueBatchAction>();
  const [reschedule, setReschedule] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      setPlanner(await window.queueApi.planner());
    } catch (error) {
      onError(error);
    }
  }, [onError]);
  useEffect(() => {
    void load();
    const unsubscribe = window.publishApi.onChanged(() => void load());
    return unsubscribe;
  }, [load]);
  async function applyAction(action: QueueBatchAction) {
    try {
      await window.queueApi.batchAction({ queueIds: [...selected], action });
      setSelected(new Set());
      setConfirmAction(undefined);
      setNotice(`${action.toLowerCase()} applied to the selected queue items.`);
      await load();
    } catch (error) {
      onError(error);
    }
  }
  if (!planner)
    return (
      <main className="content">
        <div className="empty-state">Loading planner…</div>
      </main>
    );
  const count = [...selected].length;
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <h2>Planner</h2>
          <p>
            Upcoming workload grouped by local day and account. Conflicts are
            warnings only.
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="secondary"
            disabled={!count}
            onClick={() => setReschedule(true)}
          >
            Reschedule
          </button>
          <button
            className="secondary"
            disabled={!count}
            onClick={() => setConfirmAction("PAUSE")}
          >
            Pause selected
          </button>
          <button
            className="secondary"
            disabled={!count}
            onClick={() => setConfirmAction("RESUME")}
          >
            Resume selected
          </button>
          <button
            className="danger"
            disabled={!count}
            onClick={() => setConfirmAction("CANCEL")}
          >
            Cancel selected
          </button>
        </div>
      </div>
      {notice && (
        <div className="notice success">
          <strong>Updated</strong>
          <span>{notice}</span>
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}
      {(["TODAY", "TOMORROW", "LATER", "UNSCHEDULED"] as PlannerBucket[]).map(
        (bucket) => (
          <section className="panel planner-section" key={bucket}>
            <div className="panel-heading">
              <h3>{bucketLabels[bucket]}</h3>
              <span>
                {planner.buckets[bucket].reduce(
                  (sum, group) => sum + group.items.length,
                  0,
                )}
              </span>
            </div>
            {planner.buckets[bucket].length ? (
              planner.buckets[bucket].map((group) => (
                <div
                  className="planner-account"
                  key={`${bucket}-${group.accountId ?? group.accountName}`}
                >
                  <h4>{group.accountName}</h4>
                  {group.items.map((item) => (
                    <label className="planner-row" key={item.id}>
                      <input
                        type="checkbox"
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
                      <time>
                        {item.scheduledAt
                          ? new Date(item.scheduledAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "Manual"}
                      </time>
                      <span>
                        <strong>{item.groupName}</strong> — {item.draftTitle}
                      </span>
                      <span
                        className={`status-badge status-${item.status.toLowerCase()}`}
                      >
                        {item.status}
                      </span>
                      {item.accountScheduleConflict && (
                        <span className="conflict-badge">
                          ACCOUNT SCHEDULE CONFLICT
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              ))
            ) : (
              <div className="muted-block">No items in this bucket.</div>
            )}
          </section>
        ),
      )}
      {confirmAction && (
        <ActionDialog
          title={`${confirmAction[0]}${confirmAction.slice(1).toLowerCase()} selected items`}
          message={`All ${count} items must be in a valid state or no item will change.`}
          confirmLabel={confirmAction}
          danger={confirmAction === "CANCEL"}
          onCancel={() => setConfirmAction(undefined)}
          onConfirm={() => applyAction(confirmAction)}
        />
      )}
      {reschedule && (
        <RescheduleDialog
          count={count}
          onCancel={() => setReschedule(false)}
          onSave={async (mode, scheduledAt, shiftMinutes) => {
            try {
              await window.queueApi.batchReschedule({
                queueIds: [...selected],
                mode,
                scheduledAt,
                shiftMinutes,
              });
              setSelected(new Set());
              setReschedule(false);
              setNotice("Schedule updated transactionally.");
              await load();
            } catch (error) {
              onError(error);
            }
          }}
        />
      )}
    </main>
  );
}

function RescheduleDialog({
  count,
  onCancel,
  onSave,
}: {
  count: number;
  onCancel: () => void;
  onSave: (
    mode: QueueRescheduleMode,
    scheduledAt?: string,
    shiftMinutes?: number,
  ) => Promise<void>;
}) {
  const [mode, setMode] = useState<QueueRescheduleMode>("SET_TIME");
  const [time, setTime] = useState("");
  const [shift, setShift] = useState(30);
  return (
    <div className="modal-backdrop">
      <div className="modal form-modal">
        <div className="modal-header">
          <div>
            <h3>Reschedule {count} items</h3>
            <p>
              Only PENDING and PAUSED items are eligible. The batch is
              all-or-nothing.
            </p>
          </div>
          <button className="close-button" onClick={onCancel}>
            ×
          </button>
        </div>
        <label>
          Mode
          <select
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as QueueRescheduleMode)
            }
          >
            <option value="SET_TIME">Set same time</option>
            <option value="SHIFT">Shift by duration</option>
            <option value="CLEAR">Clear schedule → Manual</option>
          </select>
        </label>
        {mode === "SET_TIME" && (
          <label>
            Local time
            <input
              type="datetime-local"
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
        )}
        {mode === "SHIFT" && (
          <label>
            Shift minutes
            <input
              type="number"
              value={shift}
              onChange={(event) => setShift(Number(event.target.value))}
            />
          </label>
        )}
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={mode === "SET_TIME" && !time}
            onClick={() =>
              void onSave(
                mode,
                mode === "SET_TIME" ? new Date(time).toISOString() : undefined,
                mode === "SHIFT" ? shift : undefined,
              )
            }
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
