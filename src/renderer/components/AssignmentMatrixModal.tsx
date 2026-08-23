import { useState } from "react";
import type { AssignmentMatrix } from "@shared/types";

export function AssignmentMatrixModal({
  value,
  onCancel,
  onToggle,
}: {
  value: AssignmentMatrix;
  onCancel: () => void;
  onToggle: (accountId: string, groupId: string) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const groups = value.groups.filter((group) =>
    group.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="modal-backdrop">
      <div className="modal form-modal wide-modal matrix-modal">
        <div className="modal-header">
          <div>
            <h3>Account assignment matrix</h3>
            <p>Changes are validated and saved per account.</p>
          </div>
          <button className="close-button" onClick={onCancel}>
            ×
          </button>
        </div>
        <label>
          Search groups
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                {groups.map((group) => (
                  <th key={group.id}>{group.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    <strong>{account.name}</strong>
                  </td>
                  {groups.map((group) => (
                    <td key={group.id}>
                      <input
                        type="checkbox"
                        aria-label={`${account.name} ${group.name}`}
                        checked={value.assignments.some(
                          (entry) =>
                            entry.accountId === account.id &&
                            entry.groupId === group.id,
                        )}
                        onChange={() => void onToggle(account.id, group.id)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
