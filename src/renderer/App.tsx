import { useEffect, useState } from "react";
import type {
  AccountOperationsSummary,
  CreateAccountInput,
  FacebookAccount,
  HealthCheckResult,
  UpdateAccountInput,
} from "@shared/types";
import { AccountForm } from "./components/AccountForm";
import { AccountTable } from "./components/AccountTable";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { LogsPage } from "./pages/LogsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { GroupsPage } from "./pages/GroupsPage";
import { DraftsPage } from "./pages/DraftsPage";
import { QueuePage } from "./pages/QueuePage";
import { PlannerPage } from "./pages/PlannerPage";
import { PublishingPage } from "./pages/PublishingPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AboutPage } from "./pages/AboutPage";

type Route =
  | "dashboard"
  | "accounts"
  | "groups"
  | "drafts"
  | "queue"
  | "planner"
  | "publishing"
  | "history"
  | "settings"
  | "logs"
  | "about";
type UiError = { message: string; code?: string };

export default function App() {
  const [route, setRoute] = useState<Route>("dashboard");
  const [accounts, setAccounts] = useState<FacebookAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{
    mode: "create" | "edit";
    account?: FacebookAccount;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FacebookAccount | null>(
    null,
  );
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [error, setError] = useState<UiError | null>(null);
  const [health, setHealth] = useState<HealthCheckResult | null>(null);
  const refresh = async () => {
    try {
      setAccounts(await window.accountApi.list());
    } catch (value) {
      setError(asUiError(value));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    return window.accountApi.onChanged(setAccounts);
  }, []);
  async function run(id: string, action: string, fn: () => Promise<unknown>) {
    setBusy((current) => ({ ...current, [id]: action }));
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (value) {
      setError(asUiError(value));
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  }
  async function submitCreate(input: CreateAccountInput) {
    setError(null);
    try {
      await window.accountApi.create(input);
      setForm(null);
      await refresh();
    } catch (value) {
      setError(asUiError(value));
    }
  }
  async function submitUpdate(input: UpdateAccountInput) {
    setError(null);
    try {
      await window.accountApi.update(input);
      setForm(null);
      await refresh();
    } catch (value) {
      setError(asUiError(value));
    }
  }
  async function confirmDelete(deleteProfile: boolean) {
    if (!deleteTarget) return;
    await run(deleteTarget.id, "Deleting…", async () =>
      window.accountApi.delete({ accountId: deleteTarget.id, deleteProfile }),
    );
    setDeleteTarget(null);
  }
  const onError = (value: unknown) => setError(asUiError(value));
  const page =
    route === "dashboard" ? (
      <DashboardPage />
    ) : route === "accounts" ? (
      <AccountsPage
        accounts={accounts}
        loading={loading}
        busy={busy}
        onHealth={setHealth}
        onRun={run}
        onEdit={(account) => setForm({ mode: "edit", account })}
        onDelete={setDeleteTarget}
        onAdd={() => setForm({ mode: "create" })}
      />
    ) : route === "groups" ? (
      <GroupsPage accounts={accounts} onError={onError} />
    ) : route === "drafts" ? (
      <DraftsPage onError={onError} />
    ) : route === "queue" ? (
      <QueuePage accounts={accounts} onError={onError} />
    ) : route === "planner" ? (
      <PlannerPage onError={onError} />
    ) : route === "publishing" ? (
      <PublishingPage onError={onError} />
    ) : route === "history" ? (
      <HistoryPage accounts={accounts} onError={onError} />
    ) : route === "settings" ? (
      <SettingsPage onError={onError} />
    ) : route === "about" ? (
      <AboutPage onError={onError} />
    ) : (
      <LogsPage accounts={accounts} />
    );
  const navigation: Array<[Route, string, string]> = [
    ["dashboard", "Dashboard", "⌂"],
    ["accounts", "Accounts", "◉"],
    ["groups", "Groups", "◎"],
    ["drafts", "Drafts", "▤"],
    ["queue", "Queue", "↝"],
    ["planner", "Planner", "◫"],
    ["publishing", "Publishing", "▶"],
    ["history", "History", "◷"],
    ["settings", "Settings", "⚙"],
    ["logs", "Audit Logs", "≡"],
    ["about", "About", "ⓘ"],
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">f</div>
          <div>
            <div className="eyebrow">LOCAL WORKSPACE</div>
            <strong>Facebook Ops</strong>
          </div>
        </div>
        <nav className="side-nav" aria-label="Primary navigation">
          {navigation.map(([id, label, icon]) => (
            <button
              key={id}
              className={route === id ? "side-link active" : "side-link"}
              onClick={() => setRoute(id)}
            >
              <span>{icon}</span>
              {label}
              {id === "accounts" && <small>{accounts.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          Visible-browser publishing only.
          <br />
          Security challenges require manual action.
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">CONTENT OPERATIONS</div>
            <h1>Facebook Account Manager</h1>
          </div>
          <div className="topbar-meta">
            {accounts.filter((account) => account.status === "RUNNING").length}{" "}
            browser session(s) active
          </div>
        </header>
        {error && (
          <div className="notice error">
            <strong>{error.code ?? "ERROR"}</strong>
            <span>{error.message}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {health && (
          <div
            className={`notice ${health.status === "ERROR" || health.status === "CHECKPOINT" ? "error" : "success"}`}
          >
            <strong>Health check: {health.status}</strong>
            <span>
              {health.reason ?? "Session state classified successfully."}
            </span>
            <button onClick={() => setHealth(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {page}
      </section>
      {form && (
        <AccountForm
          mode={form.mode}
          account={form.account}
          onCancel={() => setForm(null)}
          onCreate={submitCreate}
          onUpdate={submitUpdate}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          account={deleteTarget}
          busy={Boolean(busy[deleteTarget.id])}
          onCancel={() => setDeleteTarget(null)}
          onDeleteRecord={() => void confirmDelete(false)}
          onDeleteProfile={() => void confirmDelete(true)}
        />
      )}
    </div>
  );
}

function AccountsPage({
  accounts,
  loading,
  busy,
  onHealth,
  onRun,
  onEdit,
  onDelete,
  onAdd,
}: {
  accounts: FacebookAccount[];
  loading: boolean;
  busy: Record<string, string>;
  onHealth: (health: HealthCheckResult) => void;
  onRun: (
    id: string,
    action: string,
    fn: () => Promise<unknown>,
  ) => Promise<void>;
  onEdit: (account: FacebookAccount) => void;
  onDelete: (account: FacebookAccount) => void;
  onAdd: () => void;
}) {
  const [operations, setOperations] = useState<AccountOperationsSummary[]>([]);
  useEffect(() => {
    void window.accountApi.operations().then(setOperations);
  }, [accounts]);
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <h2>Accounts</h2>
          <p>One Facebook account per isolated persistent browser profile.</p>
        </div>
        <button className="primary" onClick={onAdd}>
          ＋ Add account
        </button>
      </div>
      <AccountTable
        accounts={accounts}
        loading={loading}
        busy={busy}
        onOpen={(id) =>
          void onRun(id, "Opening…", async () => window.accountApi.open(id))
        }
        onClose={(id) =>
          void onRun(id, "Closing…", async () => window.accountApi.close(id))
        }
        onHealth={(id) =>
          void onRun(id, "Checking…", async () => {
            onHealth(await window.accountApi.healthCheck(id));
          })
        }
        onEdit={onEdit}
        onDelete={onDelete}
        onOpenFolder={(id) =>
          void onRun(id, "Opening folder…", async () =>
            window.accountApi.openProfileFolder(id),
          )
        }
      />
      <section className="panel operations-recent">
        <div className="panel-heading">
          <h3>Operational health</h3>
          <span>{operations.length}</span>
        </div>
        {operations.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Browser</th>
                  <th>Facebook Session</th>
                  <th>Publishing Block</th>
                  <th>Proxy</th>
                  <th>Last success / failure</th>
                  <th>Queue</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((item) => (
                  <tr key={item.accountId}>
                    <td>
                      <strong>{item.accountName}</strong>
                    </td>
                    <td>{item.browser}</td>
                    <td>
                      <span
                        className={`status-badge status-${item.facebookSession.toLowerCase()}`}
                      >
                        {item.facebookSession}
                      </span>
                    </td>
                    <td>
                      {item.publishingBlock ? (
                        <>
                          <strong>{item.publishingBlock.reason}</strong>
                          <small>
                            Since{" "}
                            {new Date(
                              item.publishingBlock.blockedAt,
                            ).toLocaleString()}
                          </small>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{item.proxyConfigured ? "Configured" : "Direct"}</td>
                    <td>
                      <small>
                        {item.lastSuccessfulPublish
                          ? `Success ${new Date(item.lastSuccessfulPublish).toLocaleString()}`
                          : "No success"}
                      </small>
                      <small>
                        {item.lastFailure
                          ? `Failure ${new Date(item.lastFailure).toLocaleString()}`
                          : "No failure"}
                      </small>
                    </td>
                    <td>
                      {item.pendingQueue} pending · {item.dueQueue} due ·{" "}
                      {item.needsAttention} attention
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted-block">No account health data.</div>
        )}
      </section>
      <div className="safety-card">
        <div className="safety-icon">✓</div>
        <div>
          <strong>Safety boundary</strong>
          <p>
            Facebook login happens manually in the browser. This application
            never stores Facebook passwords, cookies, access tokens, or bypasses
            checkpoints.
          </p>
        </div>
      </div>
    </main>
  );
}

function asUiError(error: unknown): UiError {
  const value = error as { message?: string; code?: string };
  return {
    message: value?.message ?? "An unexpected error occurred.",
    code: value?.code,
  };
}
