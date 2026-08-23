import { useCallback, useEffect, useState } from "react";
import type {
  FacebookAccount,
  FacebookGroup,
  PublishHistoryFilter,
  PublishingHistoryRow,
} from "@shared/types";

export function HistoryPage({
  accounts,
  onError,
}: {
  accounts: FacebookAccount[];
  onError: (error: unknown) => void;
}) {
  const [rows, setRows] = useState<PublishingHistoryRow[]>([]);
  const [groups, setGroups] = useState<FacebookGroup[]>([]);
  const [filter, setFilter] = useState<PublishHistoryFilter>({});
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [history, values] = await Promise.all([
        window.operationsApi.history(filter),
        window.groupApi.list({}),
      ]);
      setRows(history);
      setGroups(values);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [filter, onError]);
  useEffect(() => {
    void load();
  }, [load]);
  async function exportCsv() {
    try {
      const path = await window.operationsApi.exportHistoryCsv(filter);
      if (path) setNotice("Sanitized history CSV exported.");
    } catch (error) {
      onError(error);
    }
  }
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <h2>Publish History</h2>
          <p>
            Automated evidence and final operator reconciliation are shown
            separately.
          </p>
        </div>
        <button className="secondary" onClick={() => void exportCsv()}>
          Export CSV
        </button>
      </div>
      {notice && (
        <div className="notice success">
          <strong>Export complete</strong>
          <span>{notice}</span>
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}
      <div className="filters">
        <label>
          Search
          <input
            value={filter.search ?? ""}
            onChange={(event) =>
              setFilter({ ...filter, search: event.target.value || undefined })
            }
          />
        </label>
        <label>
          Account
          <select
            value={filter.accountId ?? ""}
            onChange={(event) =>
              setFilter({
                ...filter,
                accountId: event.target.value || undefined,
              })
            }
          >
            <option value="">All</option>
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
            value={filter.groupId ?? ""}
            onChange={(event) =>
              setFilter({ ...filter, groupId: event.target.value || undefined })
            }
          >
            <option value="">All</option>
            {groups.map((group) => (
              <option value={group.id} key={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <input
            value={filter.outcome ?? ""}
            onChange={(event) =>
              setFilter({ ...filter, outcome: event.target.value || undefined })
            }
            placeholder="SUCCEEDED / UNKNOWN"
          />
        </label>
        <label>
          Verification
          <select
            value={filter.verificationSource ?? ""}
            onChange={(event) =>
              setFilter({
                ...filter,
                verificationSource: (event.target.value ||
                  undefined) as PublishHistoryFilter["verificationSource"],
              })
            }
          >
            <option value="">All</option>
            <option>AUTOMATED</option>
            <option>OPERATOR</option>
            <option>NONE</option>
          </select>
        </label>
        <label>
          From
          <input type="datetime-local" value={toLocalInput(filter.from)} onChange={(event) => setFilter({ ...filter, from: event.target.value ? new Date(event.target.value).toISOString() : undefined })} />
        </label>
        <label>
          To
          <input type="datetime-local" value={toLocalInput(filter.to)} onChange={(event) => setFilter({ ...filter, to: event.target.value ? new Date(event.target.value).toISOString() : undefined })} />
        </label>
      </div>
      {loading ? (
        <div className="empty-state">Loading history…</div>
      ) : !rows.length ? (
        <div className="empty-state">
          No publishing history matches these filters.
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Account / Group</th>
                  <th>Draft</th>
                  <th>Automated Result</th>
                  <th>Final Status</th>
                  <th>Verification</th>
                  <th>Post URL</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.queueId}>
                    <td>{new Date(row.timestamp).toLocaleString()}</td>
                    <td>
                      <strong>{row.accountName}</strong>
                      <small>{row.groupName}</small>
                    </td>
                    <td>{row.draftTitle}</td>
                    <td>{row.automatedResult ?? "—"}</td>
                    <td>
                      <span
                        className={`status-badge status-${row.finalStatus.toLowerCase()}`}
                      >
                        {row.finalStatus}
                      </span>
                    </td>
                    <td>
                      {row.verificationSource}
                      {row.reconciliationAction
                        ? ` · ${row.reconciliationAction}`
                        : ""}
                    </td>
                    <td>
                      {row.postUrl ? (
                        <code className="url-cell">{row.postUrl}</code>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}

function toLocalInput(value?: string): string { if (!value) return ""; const date = new Date(value); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
