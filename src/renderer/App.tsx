import { useEffect, useState } from 'react';
import type { CreateAccountInput, FacebookAccount, HealthCheckResult, UpdateAccountInput } from '@shared/types';
import { AccountForm } from './components/AccountForm';
import { AccountTable } from './components/AccountTable';
import { ConfirmDialog } from './components/ConfirmDialog';
import { LogsPage } from './pages/LogsPage';

type Tab = 'accounts' | 'logs';
type UiError = { message: string; code?: string };

export default function App() {
  const [tab, setTab] = useState<Tab>('accounts');
  const [accounts, setAccounts] = useState<FacebookAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; account?: FacebookAccount } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FacebookAccount | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [error, setError] = useState<UiError | null>(null);
  const [health, setHealth] = useState<HealthCheckResult | null>(null);

  const refresh = async () => {
    try { setAccounts(await window.accountApi.list()); }
    catch (e) { setError(asUiError(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); return window.accountApi.onChanged(setAccounts); }, []);

  async function run(id: string, action: string, fn: () => Promise<unknown>) {
    setBusy((current) => ({ ...current, [id]: action })); setError(null);
    try { await fn(); await refresh(); }
    catch (e) { setError(asUiError(e)); }
    finally { setBusy((current) => { const next = { ...current }; delete next[id]; return next; }); }
  }

  async function submitCreate(input: CreateAccountInput) { setError(null); try { await window.accountApi.create(input); setForm(null); await refresh(); } catch (e) { setError(asUiError(e)); } }
  async function submitUpdate(input: UpdateAccountInput) { setError(null); try { await window.accountApi.update(input); setForm(null); await refresh(); } catch (e) { setError(asUiError(e)); } }

  async function confirmDelete(deleteProfile: boolean) {
    if (!deleteTarget) return;
    await run(deleteTarget.id, 'Deleting…', async () => { await window.accountApi.delete({ accountId: deleteTarget.id, deleteProfile }); });
    setDeleteTarget(null);
  }

  return <div className="app-shell">
    <header className="topbar">
      <div><div className="eyebrow">LOCAL ADMIN TOOL</div><h1>Facebook Account Manager</h1></div>
      <nav className="tabs" aria-label="Primary navigation">
        <button className={tab === 'accounts' ? 'tab active' : 'tab'} onClick={() => setTab('accounts')}>Accounts <span>{accounts.length}</span></button>
        <button className={tab === 'logs' ? 'tab active' : 'tab'} onClick={() => setTab('logs')}>Audit logs</button>
      </nav>
    </header>
    {error && <div className="notice error"><strong>{error.code ?? 'ERROR'}</strong><span>{error.message}</span><button onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}
    {health && <div className={`notice ${health.status === 'ERROR' || health.status === 'CHECKPOINT' ? 'error' : 'success'}`}><strong>Health check: {health.status}</strong><span>{health.reason ?? 'Session state classified successfully.'}</span><button onClick={() => setHealth(null)} aria-label="Dismiss">×</button></div>}
    {tab === 'accounts' ? <main className="content">
      <div className="page-heading"><div><h2>Accounts</h2><p>One Facebook account per isolated persistent browser profile.</p></div><button className="primary" onClick={() => setForm({ mode: 'create' })}>＋ Add account</button></div>
      <AccountTable accounts={accounts} loading={loading} busy={busy} onOpen={(id) => run(id, 'Opening…', async () => { await window.accountApi.open(id); })} onClose={(id) => run(id, 'Closing…', async () => { await window.accountApi.close(id); })} onHealth={(id) => run(id, 'Checking…', async () => { setHealth(await window.accountApi.healthCheck(id)); })} onEdit={(account) => setForm({ mode: 'edit', account })} onDelete={setDeleteTarget} onOpenFolder={(id) => run(id, 'Opening folder…', async () => { await window.accountApi.openProfileFolder(id); })} />
      <div className="safety-card"><div className="safety-icon">✓</div><div><strong>Safety boundary</strong><p>Facebook login happens manually in the browser. This application never stores Facebook passwords, cookies, access tokens, or bypasses checkpoints.</p></div></div>
    </main> : <LogsPage accounts={accounts} />}
    {form && <AccountForm mode={form.mode} account={form.account} onCancel={() => setForm(null)} onCreate={submitCreate} onUpdate={submitUpdate} />}
    {deleteTarget && <ConfirmDialog account={deleteTarget} busy={Boolean(busy[deleteTarget.id])} onCancel={() => setDeleteTarget(null)} onDeleteRecord={() => void confirmDelete(false)} onDeleteProfile={() => void confirmDelete(true)} />}
  </div>;
}

function asUiError(error: unknown): UiError { const value = error as { message?: string; code?: string }; return { message: value?.message ?? 'An unexpected error occurred.', code: value?.code }; }
