import { useCallback, useEffect, useState } from "react";
import type {
  AssignmentAccount,
  AssignmentMatrix,
  FacebookAccount,
  FacebookGroup,
  GroupImportPreview,
  GroupInput,
  GroupOperationsSummary,
} from "@shared/types";
import { AssignmentMatrixModal } from "../components/AssignmentMatrixModal";

type Props = { accounts: FacebookAccount[]; onError: (error: unknown) => void };
const blank: GroupInput = {
  name: "",
  url: "",
  notes: "",
  tags: [],
  active: true,
};

export function GroupsPage({ accounts, onError }: Props) {
  const [groups, setGroups] = useState<FacebookGroup[]>([]);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id?: string; value: GroupInput }>();
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [preview, setPreview] = useState<GroupImportPreview>();
  const [assigning, setAssigning] = useState<FacebookGroup>();
  const [assigned, setAssigned] = useState<AssignmentAccount[]>([]);
  const [openGroup, setOpenGroup] = useState<FacebookGroup>();
  const [operations, setOperations] = useState<GroupOperationsSummary[]>([]);
  const [matrix, setMatrix] = useState<AssignmentMatrix>();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setGroups(
        await window.groupApi.list({
          search: search || undefined,
          active: active === "" ? undefined : active === "true",
        }),
      );
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [search, active, onError]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void window.groupApi.operations().then(setOperations).catch(onError);
  }, [groups, onError]);
  useEffect(() => {
    if (openGroup)
      void window.groupApi
        .assignments(openGroup.id)
        .then(setAssigned)
        .catch(onError);
  }, [openGroup, onError]);
  async function save() {
    if (!editing) return;
    try {
      if (editing.id) await window.groupApi.update(editing.id, editing.value);
      else await window.groupApi.create(editing.value);
      setEditing(undefined);
      await load();
    } catch (e) {
      onError(e);
    }
  }
  async function toggle(group: FacebookGroup) {
    try {
      await window.groupApi.setActive(group.id, !group.active);
      await load();
    } catch (e) {
      onError(e);
    }
  }
  async function remove(group: FacebookGroup) {
    if (!window.confirm(`Delete ${group.name}?`)) return;
    try {
      await window.groupApi.delete(group.id);
      await load();
    } catch (e) {
      onError(e);
    }
  }
  async function showAssignments(group: FacebookGroup) {
    try {
      setAssigned(await window.groupApi.assignments(group.id));
      setAssigning(group);
    } catch (e) {
      onError(e);
    }
  }
  async function saveAssignments(ids: string[]) {
    if (!assigning) return;
    try {
      await window.groupApi.replaceAssignments(assigning.id, ids);
      setAssigning(undefined);
      await load();
    } catch (e) {
      onError(e);
    }
  }
  async function open(group: FacebookGroup, accountId: string) {
    try {
      const result = await window.groupApi.open(group.id, accountId);
      setOpenGroup(undefined);
      if (result.status !== "OPENED")
        onError({
          message: result.reason ?? `Group navigation: ${result.status}`,
          code: result.status,
        });
    } catch (e) {
      onError(e);
    }
  }
  async function validateUi(accountId: string) {
    if (!openGroup) return;
    try {
      const result = await window.publishApi.probe(accountId, openGroup.id);
      window.alert(
        "Selector validation: " +
          result.status +
          "\nVersion: " +
          result.selectorVersion +
          "\nSession: " +
          result.session.status +
          "\nGroup: " +
          result.group.status +
          "\nComposer: " +
          result.composerTrigger.status +
          "\nTextbox: " +
          result.composerTextbox.status +
          "\nMedia input: " +
          result.mediaInput.status +
          "\nPost button: " +
          result.postButton.status,
      );
    } catch (e) {
      onError(e);
    }
  }
  async function inspectImport() {
    try {
      setPreview(await window.groupApi.previewImport(importText));
    } catch (e) {
      onError(e);
    }
  }
  async function commitImport() {
    try {
      await window.groupApi.import(importText);
      setImportText("");
      setPreview(undefined);
      await load();
    } catch (e) {
      onError(e);
    }
  }
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <h2>Groups</h2>
          <p>
            Manage canonical Facebook group destinations and account
            assignments.
          </p>
        </div>
        <div className="heading-actions">
          <button className="secondary" onClick={() => setImportOpen(true)}>
            Bulk import
          </button>
          <button
            className="primary"
            onClick={() => setEditing({ value: blank })}
          >
            ＋ Add group
          </button>
        </div>
      </div>
      <div className="filters">
        <label>
          Search
          <input
            placeholder="Name or URL"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          Status
          <select value={active} onChange={(e) => setActive(e.target.value)}>
            <option value="">All groups</option>
            <option value="true">Active</option>
            <option value="false">Archived</option>
          </select>
        </label>
        <button
          className="secondary filter-refresh"
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>
      {loading ? (
        <div className="empty-state">Loading groups…</div>
      ) : !groups.length ? (
        <div className="empty-state">
          <strong>No groups yet</strong>
          <p>Add a group or import a list of URLs.</p>
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>URL</th>
                  <th>Tags</th>
                  <th>Assignments</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id}>
                    <td>
                      <strong>{group.name}</strong>
                      {group.notes && <small>{group.notes}</small>}
                    </td>
                    <td>
                      <code className="url-cell">{group.normalizedUrl}</code>
                    </td>
                    <td>
                      <div className="tag-list">
                        {group.tags.map((tag) => (
                          <span className="tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{group.assignedAccountsCount}</td>
                    <td>
                      <span
                        className={`status-badge ${group.active ? "status-ready" : ""}`}
                      >
                        {group.active ? "ACTIVE" : "ARCHIVED"}
                      </span>
                    </td>
                    <td>
                      <div className="actions">
                        <button
                          className="action-button"
                          onClick={() => setOpenGroup(group)}
                        >
                          Open
                        </button>
                        <button
                          className="action-button"
                          onClick={() => void showAssignments(group)}
                        >
                          Assign
                        </button>
                        <button
                          className="icon-button"
                          onClick={() =>
                            setEditing({
                              id: group.id,
                              value: {
                                name: group.name,
                                url: group.url,
                                notes: group.notes ?? "",
                                tags: group.tags,
                                active: group.active,
                              },
                            })
                          }
                        >
                          Edit
                        </button>
                        <button
                          className="icon-button"
                          onClick={() => void toggle(group)}
                        >
                          {group.active ? "Archive" : "Activate"}
                        </button>
                        <button
                          className="icon-button danger-text"
                          onClick={() => void remove(group)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <section className="panel operations-recent">
        <div className="panel-heading">
          <div>
            <h3>Group operations</h3>
            <small>
              Local facts only; no member or private group data is scraped.
            </small>
          </div>
          <button
            className="secondary"
            onClick={() =>
              void window.groupApi
                .assignmentMatrix()
                .then(setMatrix)
                .catch(onError)
            }
          >
            Assignment matrix
          </button>
        </div>
        {operations.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Status</th>
                  <th>Last opened</th>
                  <th>Last success</th>
                  <th>Last failure</th>
                  <th>Last account</th>
                  <th>Active queue</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((item) => (
                  <tr key={item.groupId}>
                    <td>{item.groupName}</td>
                    <td>
                      <span
                        className={`status-badge status-${item.status.toLowerCase()}`}
                      >
                        {item.status}
                      </span>
                    </td>
                    <td>
                      {item.lastOpened
                        ? new Date(item.lastOpened).toLocaleString()
                        : "—"}
                    </td>
                    <td>
                      {item.lastSuccessfulPublish
                        ? new Date(item.lastSuccessfulPublish).toLocaleString()
                        : "—"}
                    </td>
                    <td>
                      {item.lastFailedPublish
                        ? new Date(item.lastFailedPublish).toLocaleString()
                        : "—"}
                    </td>
                    <td>{item.lastAccountUsed ?? "—"}</td>
                    <td>{item.activeQueueCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted-block">No group operations yet.</div>
        )}
      </section>
      {editing && (
        <GroupModal
          value={editing.value}
          title={editing.id ? "Edit group" : "Add group"}
          onChange={(value) => setEditing({ ...editing, value })}
          onCancel={() => setEditing(undefined)}
          onSave={() => void save()}
        />
      )}
      {importOpen && (
        <ImportModal
          text={importText}
          preview={preview}
          onChange={setImportText}
          onPreview={() => void inspectImport()}
          onCommit={() => void commitImport()}
          onCancel={() => {
            setImportOpen(false);
            setImportText("");
            setPreview(undefined);
          }}
        />
      )}
      {assigning && (
        <AssignmentModal
          group={assigning}
          accounts={accounts}
          assigned={assigned}
          onCancel={() => setAssigning(undefined)}
          onSave={(ids) => void saveAssignments(ids)}
        />
      )}
      {openGroup && (
        <OpenGroupModal
          group={openGroup}
          accounts={accounts}
          assigned={assigned}
          onCancel={() => setOpenGroup(undefined)}
          onOpen={(id) => void open(openGroup, id)}
          onProbe={(id) => void validateUi(id)}
        />
      )}
      {matrix && (
        <AssignmentMatrixModal
          value={matrix}
          onCancel={() => setMatrix(undefined)}
          onToggle={async (accountId, groupId) => {
            const assignedGroups = matrix.assignments
              .filter((entry) => entry.accountId === accountId)
              .map((entry) => entry.groupId);
            const next = assignedGroups.includes(groupId)
              ? assignedGroups.filter((id) => id !== groupId)
              : [...assignedGroups, groupId];
            try {
              await window.groupApi.replaceAccountGroups(accountId, next);
              setMatrix(await window.groupApi.assignmentMatrix());
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

function GroupModal({
  value,
  title,
  onChange,
  onCancel,
  onSave,
}: {
  value: GroupInput;
  title: string;
  onChange: (value: GroupInput) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal form-modal">
        <div className="modal-header">
          <div>
            <h3>{title}</h3>
            <p>Only facebook.com group URLs are accepted.</p>
          </div>
          <button className="close-button" onClick={onCancel}>
            ×
          </button>
        </div>
        <label>
          Name
          <input
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </label>
        <label>
          URL
          <input
            value={value.url}
            onChange={(e) => onChange({ ...value, url: e.target.value })}
            placeholder="https://www.facebook.com/groups/example"
          />
        </label>
        <label>
          Tags
          <input
            value={value.tags.join(", ")}
            onChange={(e) =>
              onChange({
                ...value,
                tags: e.target.value
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
        <label>
          Notes
          <textarea
            value={value.notes ?? ""}
            onChange={(e) => onChange({ ...value, notes: e.target.value })}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={value.active !== false}
            onChange={(e) => onChange({ ...value, active: e.target.checked })}
          />{" "}
          Active
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={!value.name.trim() || !value.url.trim()}
            onClick={onSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
function ImportModal({
  text,
  preview,
  onChange,
  onPreview,
  onCommit,
  onCancel,
}: {
  text: string;
  preview?: GroupImportPreview;
  onChange: (text: string) => void;
  onPreview: () => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal form-modal import-modal">
        <div className="modal-header">
          <div>
            <h3>Bulk import groups</h3>
            <p>
              One URL per line, or <code>Name | URL</code>.
            </p>
          </div>
          <button className="close-button" onClick={onCancel}>
            ×
          </button>
        </div>
        <textarea
          className="import-text"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Photography | https://www.facebook.com/groups/photography"
        />
        <div className="modal-actions">
          <button
            className="secondary"
            onClick={onPreview}
            disabled={!text.trim()}
          >
            Inspect
          </button>
          {preview && (
            <button
              className="primary"
              onClick={onCommit}
              disabled={!preview.valid}
            >
              Import {preview.valid}
            </button>
          )}
        </div>
        {preview && (
          <div className="import-summary">
            <strong>
              {preview.valid} valid · {preview.duplicates} duplicates ·{" "}
              {preview.invalid} invalid
            </strong>
            {preview.rows.map((row) => (
              <div
                key={row.line}
                className={`import-row ${row.status.toLowerCase()}`}
              >
                <span>Line {row.line}</span>
                <code>{row.url}</code>
                <span>
                  {row.status}
                  {row.reason ? ` — ${row.reason}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
function AssignmentModal({
  group,
  accounts,
  assigned,
  onCancel,
  onSave,
}: {
  group: FacebookGroup;
  accounts: FacebookAccount[];
  assigned: AssignmentAccount[];
  onCancel: () => void;
  onSave: (ids: string[]) => void;
}) {
  const [ids, setIds] = useState(
    () => new Set(assigned.map((account) => account.id)),
  );
  return (
    <div className="modal-backdrop">
      <div className="modal form-modal">
        <div className="modal-header">
          <div>
            <h3>Assign accounts</h3>
            <p>{group.name}</p>
          </div>
          <button className="close-button" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="check-list">
          {accounts.map((account) => (
            <label className="check-row" key={account.id}>
              <input
                type="checkbox"
                checked={ids.has(account.id)}
                onChange={() =>
                  setIds((current) => {
                    const next = new Set(current);
                    if (next.has(account.id)) next.delete(account.id);
                    else next.add(account.id);
                    return next;
                  })
                }
              />
              {account.name}
              <small>{account.status}</small>
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave([...ids])}>
            Save assignments
          </button>
        </div>
      </div>
    </div>
  );
}
function OpenGroupModal({
  group,
  accounts,
  assigned,
  onCancel,
  onOpen,
  onProbe,
}: {
  group: FacebookGroup;
  accounts: FacebookAccount[];
  assigned: AssignmentAccount[];
  onCancel: () => void;
  onOpen: (id: string) => void;
  onProbe: (id: string) => void;
}) {
  const eligible = accounts.filter((account) =>
    assigned.some((item) => item.id === account.id),
  );
  return (
    <div className="modal-backdrop">
      <div className="modal form-modal">
        <div className="modal-header">
          <div>
            <h3>Open group manually</h3>
            <p>{group.name}</p>
          </div>
          <button className="close-button" onClick={onCancel}>
            ×
          </button>
        </div>
        {eligible.length ? (
          <div className="check-list">
            {eligible.map((account) => (
              <div className="picker-row" key={account.id}>
                <strong>{account.name}</strong>
                <small>
                  {account.status} · {account.lastHealthStatus ?? "not checked"}
                </small>
                <div className="actions">
                  <button
                    className="action-button"
                    onClick={() => onOpen(account.id)}
                  >
                    Open
                  </button>
                  <button
                    className="action-button"
                    onClick={() => onProbe(account.id)}
                  >
                    Validate Facebook UI
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted-block">
            Assign an account before opening this group.
          </div>
        )}
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
