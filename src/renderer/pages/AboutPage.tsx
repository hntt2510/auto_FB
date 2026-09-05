import { useEffect, useState } from "react";
import type { AboutInfo, DatabaseIntegrityReport } from "@shared/types";

export function AboutPage({ onError }: { onError: (error: unknown) => void }) {
  const [info, setInfo] = useState<AboutInfo>();
  const [integrity, setIntegrity] = useState<DatabaseIntegrityReport>();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void window.operationsApi.about().then(setInfo).catch(onError);
  }, [onError]);

  async function runIntegrityCheck() {
    setChecking(true);
    try {
      const result = await window.operationsApi.integrityCheck();
      setIntegrity(result);
    } catch (error) {
      onError(error);
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <h2>About</h2>
          <p>Release and runtime component versions.</p>
        </div>
      </div>
      {!info ? (
        <div className="empty-state">Loading release information…</div>
      ) : (
        <>
          <section className="panel about-panel">
            <h3>{info.appName}</h3>
            <dl>
              <dt>App version</dt>
              <dd>{info.appVersion}</dd>
              <dt>Database schema</dt>
              <dd>{info.databaseSchema}</dd>
              <dt>Selector version</dt>
              <dd>{info.selectorVersion}</dd>
              <dt>Electron</dt>
              <dd>{info.electronVersion}</dd>
              <dt>Playwright</dt>
              <dd>{info.playwrightVersion}</dd>
            </dl>
            <p className="muted-block">
              Visible-browser operation only. Security challenges require manual
              action.
            </p>
          </section>

          <section className="panel about-panel" style={{ marginTop: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Database Release Integrity</h3>
              <button
                type="button"
                className="secondary"
                disabled={checking}
                onClick={() => void runIntegrityCheck()}
              >
                {checking ? "Checking…" : "Run integrity check"}
              </button>
            </div>
            {integrity && (
              <dl style={{ marginTop: "0.75rem" }}>
                <dt>Integrity Status</dt>
                <dd>
                  <span className={`status-badge status-${integrity.integrityOk ? "succeeded" : "failed"}`}>
                    {integrity.integrityOk ? "PASSED" : "FAILED"}
                  </span>
                </dd>
                <dt>SQLite Integrity Check</dt>
                <dd>{integrity.integrityDetail}</dd>
                <dt>Foreign Key Violations</dt>
                <dd>{integrity.foreignKeyViolations}</dd>
                <dt>Schema Version</dt>
                <dd>{integrity.schemaVersion} (expected: {integrity.expectedSchemaVersion})</dd>
                <dt>Missing Tables</dt>
                <dd>{integrity.missingTables.length ? integrity.missingTables.join(", ") : "None"}</dd>
                <dt>Checked At</dt>
                <dd>{new Date(integrity.checkedAt).toLocaleString()}</dd>
              </dl>
            )}
          </section>
        </>
      )}
    </main>
  );
}
