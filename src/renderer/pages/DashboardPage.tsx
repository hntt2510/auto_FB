import { useEffect, useState } from 'react';
import type { DashboardSummary } from '@shared/types';

export function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary>();
  const [error, setError] = useState('');
  useEffect(() => { void window.dashboardApi.summary().then(setSummary).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Unable to load dashboard.')); }, []);
  if (error) return <main className="content"><div className="page-heading"><div><h2>Dashboard</h2><p>Workspace overview.</p></div></div><div className="notice error">{error}</div></main>;
  if (!summary) return <main className="content"><div className="empty-state">Loading dashboard…</div></main>;
  const cards = [
    ['Accounts', `${summary.accounts.total}`, `${summary.accounts.ready} ready · ${summary.accounts.loginRequired} need login`],
    ['Active groups', `${summary.groups.active}`, `${summary.groups.total} total`],
    ['Ready drafts', `${summary.drafts.ready}`, `${summary.drafts.total} total`],
    ['Queue', `${summary.queue.active}`, `${summary.queue.due} due · ${summary.queue.cancelled} cancelled`]
  ];
  return <main className="content"><div className="page-heading"><div><h2>Dashboard</h2><p>Health, content readiness, and queue activity at a glance.</p></div><button className="secondary" onClick={() => window.location.reload()}>Refresh</button></div>
    <div className="stat-grid">{cards.map(([label, value, detail]) => <div className="stat-card" key={label}><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>)}</div>
    <div className="dashboard-grid"><section className="panel"><div className="panel-heading"><h3>Recent queue items</h3><span>{summary.recentQueue.length}</span></div>{summary.recentQueue.length ? <div className="stack-list">{summary.recentQueue.map((item) => <div className="stack-row" key={item.id}><div><strong>{item.draftTitle}</strong><small>{item.accountName} → {item.groupName}</small></div><span className={`status-badge status-${item.status.toLowerCase()}`}>{item.status}</span></div>)}</div> : <div className="muted-block">No queue activity yet.</div>}</section>
      <section className="panel"><div className="panel-heading"><h3>Recent audit events</h3><span>{summary.recentLogs.length}</span></div>{summary.recentLogs.length ? <div className="stack-list">{summary.recentLogs.map((log) => <div className="stack-row" key={log.id}><div><strong>{log.eventType}</strong><small>{log.message}</small></div><time>{new Date(log.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time></div>)}</div> : <div className="muted-block">No audit events yet.</div>}</section></div>
  </main>;
}
