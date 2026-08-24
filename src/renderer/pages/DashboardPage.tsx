import { useCallback, useEffect, useState } from "react";
import type { DashboardSummary } from "@shared/types";

export function DashboardPage({
  onNavigate = (route) => {
    const label = route[0].toUpperCase() + route.slice(1);
    [...document.querySelectorAll<HTMLButtonElement>(".side-link")]
      .find((item) => item.textContent?.includes(label))
      ?.click();
  },
}: {
  onNavigate?: (route: "queue" | "groups" | "accounts" | "onboarding") => void;
}) {
  const [summary, setSummary] = useState<DashboardSummary>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setSummary(await window.dashboardApi.summary());
      setError("");
    } catch (value) {
      setError(
        value instanceof Error ? value.message : "Unable to load dashboard.",
      );
    }
  }, []);
  useEffect(() => {
    void load();
    const unsubscribe = window.publishApi.onChanged(() => void load());
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [load]);
  if (error)
    return (
      <main className="content">
        <div className="page-heading">
          <div>
            <h2>Dashboard</h2>
            <p>Workspace overview.</p>
          </div>
        </div>
        <div className="notice error">{error}</div>
      </main>
    );
  if (!summary)
    return (
      <main className="content">
        <div className="empty-state">Loading dashboard…</div>
      </main>
    );
  const metrics: Array<[string, number, string]> = [
    ["Scheduled today", summary.today.scheduled, "local day"],
    ["Due now", summary.today.due, "held while disarmed"],
    ["Running", summary.today.running, "active claims"],
    ["Submitted", summary.today.submitted, "awaiting evidence"],
    ["Succeeded", summary.today.succeeded, "verified final status"],
    ["Failed", summary.today.failed, "completed today"],
    [
      "Needs attention",
      summary.today.needsAttention,
      "operator review required",
    ],
    ["Onboarding tasks", summary.onboarding.todayTasks, "manual checklist today"],
  ];
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <h2>Operations Dashboard</h2>
          <p>
            Today’s controlled publishing workload, account health, and
            attention center.
          </p>
        </div>
        <button className="secondary" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="stat-grid">
        {metrics.map(([label, value, detail]) => (
          <div className="stat-card" key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
            <span>{detail}</span>
          </div>
        ))}
      </div>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <h3>Account status</h3>
            <span>{summary.accounts.total}</span>
          </div>
          <div className="status-summary">
            <span>
              READY <strong>{summary.accountStatuses.ready}</strong>
            </span>
            <span>
              LOGIN REQUIRED{" "}
              <strong>{summary.accountStatuses.loginRequired}</strong>
            </span>
            <span>
              CHECKPOINT <strong>{summary.accountStatuses.checkpoint}</strong>
            </span>
            <span>
              BLOCKED <strong>{summary.accountStatuses.blocked}</strong>
            </span>
            <span>
              UNKNOWN <strong>{summary.accountStatuses.unknown}</strong>
            </span>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading"><h3>Account onboarding</h3><button className="action-button" onClick={() => onNavigate?.("onboarding")}>Open planner</button></div>
          <div className="status-summary"><span>NEW <strong>{summary.onboarding.new}</strong></span><span>WARMING <strong>{summary.onboarding.warming}</strong></span><span>READY <strong>{summary.onboarding.ready}</strong></span><span>PAUSED <strong>{summary.onboarding.paused}</strong></span></div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h3>Needs Attention</h3>
            <span>{summary.attention.length}</span>
          </div>
          {summary.attention.length ? (
            <div className="stack-list">
              {summary.attention.map((item) => (
                <div className="stack-row" key={item.id}>
                  <div>
                    <strong>
                      {item.accountName} → {item.groupName}
                    </strong>
                    <small>{item.attentionReason ?? item.draftTitle}</small>
                  </div>
                  <div className="actions">
                    <button
                      className="action-button"
                      onClick={() => onNavigate?.("queue")}
                    >
                      Open item
                    </button>
                    <button
                      className="action-button"
                      onClick={() => onNavigate?.("groups")}
                    >
                      Group
                    </button>
                    <button
                      className="action-button"
                      onClick={() => onNavigate?.("accounts")}
                    >
                      Account
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted-block">No items need attention.</div>
          )}
        </section>
      </div>
      <section className="panel operations-recent">
        <div className="panel-heading">
          <h3>Recent publishing activity</h3>
          <span>{summary.recentPublishing.length}</span>
        </div>
        {summary.recentPublishing.length ? (
          <div className="stack-list">
            {summary.recentPublishing.map((row) => (
              <div className="stack-row" key={row.queueId}>
                <time>
                  {new Date(row.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <div>
                  <strong>
                    {row.accountName} → {row.groupName} → {row.finalStatus}
                  </strong>
                  <small>
                    {row.draftTitle} · automation {row.automatedResult ?? "—"} ·
                    verification {row.verificationSource}
                  </small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted-block">No publishing activity yet.</div>
        )}
      </section>
    </main>
  );
}
