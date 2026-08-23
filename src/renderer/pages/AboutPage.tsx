import { useEffect, useState } from "react";
import type { AboutInfo } from "@shared/types";

export function AboutPage({ onError }: { onError: (error: unknown) => void }) {
  const [info, setInfo] = useState<AboutInfo>();
  useEffect(() => {
    void window.operationsApi.about().then(setInfo).catch(onError);
  }, [onError]);
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
      )}
    </main>
  );
}
