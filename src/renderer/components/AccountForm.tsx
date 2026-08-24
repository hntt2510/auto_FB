import { useState, type FormEvent } from 'react';
import type { CreateAccountInput, FacebookAccount, ProxyProtocol, ProxyTestResult, UpdateAccountInput } from '@shared/types';
import { parseProxyInput } from '@shared/proxy';

type Props = { mode: 'create' | 'edit'; account?: FacebookAccount; onCancel: () => void; onCreate: (input: CreateAccountInput) => Promise<void>; onUpdate: (input: UpdateAccountInput) => Promise<void> };

export function AccountForm({ mode, account, onCancel, onCreate, onUpdate }: Props) {
  const [name, setName] = useState(account?.name ?? '');
  const [profileName, setProfileName] = useState(account?.profileName ?? '');
  const [proxyEnabled, setProxyEnabled] = useState(account?.proxyEnabled ?? false);
  const [protocol, setProtocol] = useState<ProxyProtocol>(account?.proxyProtocol ?? 'HTTP');
  const [host, setHost] = useState(account?.proxyHost ?? '');
  const [port, setPort] = useState(account?.proxyPort?.toString() ?? '');
  const [username, setUsername] = useState(account?.proxyUsername ?? '');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [testResult, setTestResult] = useState<ProxyTestResult>();
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const running = account?.status === 'RUNNING' || account?.status === 'STARTING';

  function validateProxy(): string | undefined {
    if (!proxyEnabled) return undefined;
    if (!host.trim() || !port || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return 'Enter a valid proxy host and port.';
    const savedPasswordAvailable = mode === 'edit' && Boolean(account?.proxyPasswordSaved) && username.trim() === account?.proxyUsername && !clearPassword;
    if (Boolean(username.trim()) !== Boolean(password || savedPasswordAvailable)) return 'Proxy username and password must be supplied together.';
    return undefined;
  }

  function applyPastedProxy() {
    setFormError(''); setTestResult(undefined);
    try {
      const parsed = parseProxyInput(pasteValue);
      setProxyEnabled(true); setProtocol(parsed.proxyProtocol); setHost(parsed.proxyHost); setPort(String(parsed.proxyPort)); setUsername(parsed.proxyUsername ?? ''); setPassword(parsed.proxyPassword ?? ''); setClearPassword(false); setPasteValue('');
    } catch (error) { setFormError(error instanceof Error ? error.message : 'Proxy input is invalid.'); }
  }

  async function testProxy() {
    setFormError(''); setTestResult(undefined);
    const validation = validateProxy(); if (validation) { setFormError(validation); return; }
    setTesting(true);
    try {
      const result = await window.accountApi.testProxy({ ...(mode === 'edit' ? { accountId: account!.id } : {}), proxyProtocol: protocol, proxyHost: host.trim(), proxyPort: Number(port), proxyUsername: username.trim() || undefined, proxyPassword: password || undefined });
      setTestResult(result);
    } catch (error) { setFormError(error instanceof Error ? error.message : 'Proxy test failed.'); }
    finally { setTesting(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setFormError('');
    if (running) { setFormError('Close this account browser before changing proxy settings.'); return; }
    if (!name.trim() || (mode === 'create' && !profileName.trim())) { setFormError('Account name and profile name are required.'); return; }
    const validation = validateProxy(); if (validation) { setFormError(validation); return; }
    setSaving(true);
    try {
      const proxy = proxyEnabled ? { proxyProtocol: protocol, proxyHost: host.trim(), proxyPort: Number(port), proxyUsername: username.trim() || undefined, proxyPassword: password || undefined } : {};
      if (mode === 'create') await onCreate({ name: name.trim(), profileName: profileName.trim(), proxyEnabled, ...proxy });
      else await onUpdate({ accountId: account!.id, name: name.trim(), proxyEnabled, ...proxy, clearProxyPassword: proxyEnabled ? clearPassword : undefined });
    } finally { setSaving(false); }
  }

  return <div className="modal-backdrop"><form className="modal form-modal wide-modal" onSubmit={submit}><div className="modal-header"><div><div className="eyebrow">ACCOUNT PROFILE</div><h2>{mode === 'create' ? 'Add account' : 'Edit account'}</h2></div><button type="button" className="close-button" onClick={onCancel}>×</button></div>
    {formError && <div className="inline-error">{formError}</div>}
    {running && <div className="inline-warning">Close this account browser before changing proxy settings.</div>}
    <label>Account name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="FB Shop 01" autoFocus /></label>
    <label>Profile name<input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="fb-shop-01" disabled={mode === 'edit'} /><small>{mode === 'edit' ? 'Profile directory is immutable after creation.' : 'Filesystem-safe name; each account gets its own directory.'}</small></label>
    <fieldset><legend>Network</legend><div className="radio-row"><label className="radio"><input type="radio" checked={!proxyEnabled} onChange={() => { setProxyEnabled(false); setTestResult(undefined); }} disabled={running} /> Direct</label><label className="radio"><input type="radio" checked={proxyEnabled} onChange={() => setProxyEnabled(true)} disabled={running} /> Fixed proxy</label></div></fieldset>
    {proxyEnabled && <>
      <div className="proxy-paste-row"><input aria-label="Paste proxy" value={pasteValue} onChange={(event) => setPasteValue(event.target.value)} placeholder="host:port or protocol://username:password@host:port" disabled={running} /><button type="button" className="secondary" onClick={applyPastedProxy} disabled={running || !pasteValue.trim()}>Paste proxy</button></div>
      <div className="proxy-grid"><label>Protocol<select value={protocol} onChange={(event) => { setProtocol(event.target.value as ProxyProtocol); setTestResult(undefined); }} disabled={running}><option>HTTP</option><option>HTTPS</option><option>SOCKS5</option></select></label><label>Host<input value={host} onChange={(event) => { setHost(event.target.value); setTestResult(undefined); }} placeholder="proxy.example.com" disabled={running} /></label><label>Port<input type="number" min="1" max="65535" value={port} onChange={(event) => { setPort(event.target.value); setTestResult(undefined); }} placeholder="12345" disabled={running} /></label><label>Username<input value={username} onChange={(event) => { setUsername(event.target.value); setClearPassword(false); setTestResult(undefined); }} placeholder="Optional; treated as opaque" disabled={running} /></label><label>Password<input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setClearPassword(false); setTestResult(undefined); }} placeholder={account?.proxyPasswordSaved ? 'Leave blank to keep saved password' : 'Required with username'} autoComplete="new-password" disabled={running} /></label>
      {mode === 'edit' && <div className="proxy-saved-state"><strong>Password: {account?.proxyPasswordSaved ? 'Saved' : 'Not saved'}</strong>{account?.lastProxyTestAt && <small>Last test: {new Date(account.lastProxyTestAt).toLocaleString()}</small>}{account?.lastProxyTestIp && <small>Outbound IP: {account.lastProxyTestIp}</small>}{account?.lastProxyLatencyMs !== undefined && <small>Latency: {account.lastProxyLatencyMs} ms</small>}</div>}
      {mode === 'edit' && account?.proxyPasswordSaved && <label className="check-row"><input type="checkbox" checked={clearPassword} onChange={(event) => { const checked = event.target.checked; setClearPassword(checked); setPassword(''); setUsername(checked ? '' : account.proxyUsername ?? ''); setTestResult(undefined); }} disabled={running} /> Clear saved proxy credentials</label>}</div>
      <div className="proxy-warning">Changing network location may cause the website to request login or security verification. The existing browser profile will be preserved.</div>
      <div className="proxy-test-row"><button type="button" className="secondary" onClick={() => void testProxy()} disabled={running || testing}>{testing ? 'Testing…' : !account || account.proxyStatus === 'UNTESTED' ? 'Test proxy' : 'Retest proxy'}</button>{testResult && <div className={testResult.success ? 'proxy-test-result success' : 'proxy-test-result failed'}><strong>{testResult.success ? 'Proxy connected' : testResult.message ?? 'Proxy test failed'}</strong>{testResult.ip && <span>IP: {testResult.ip}</span>}{testResult.latencyMs !== undefined && <span>Latency: {testResult.latencyMs} ms</span>}{testResult.errorCode && <span>{testResult.errorCode}</span>}</div>}</div>
    </>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={saving || running}>{saving ? 'Saving…' : mode === 'create' ? 'Create account' : 'Save changes'}</button></div>
  </form></div>;
}
