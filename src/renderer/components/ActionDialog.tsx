import { useState, type ReactNode } from "react";

export function ActionDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <div className="modal form-modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <div>
            <h3>{title}</h3>
            <p>{message}</p>
          </div>
          <button className="close-button" disabled={busy} onClick={onCancel}>
            ×
          </button>
        </div>
        {children}
        <div className="modal-actions">
          <button className="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className={danger ? "danger" : "primary"}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
