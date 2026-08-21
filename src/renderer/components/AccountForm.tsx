import { useState, type FormEvent } from 'react';
import type { CreateAccountInput, FacebookAccount, UpdateAccountInput } from '@shared/types';

type Props = { mode: 'create' | 'edit'; account?: FacebookAccount; onCancel: () => void; onCreate: (input: CreateAccountInput) => Promise<void>; onUpdate: (input: UpdateAccountInput) => Promise<void> };

export function AccountForm({ mode, account, onCancel, onCreate, onUpdate }: Props) {
  const [name, setName] = useState(account?.name ?? '');
  const [profileName, setProfileName] = useState(account?.profileName ?? '');
  const [proxyEnabled, setProxyEnabled] = useState(account?.proxyEnabled ?? false);
  const [host, setHost] = useState(account?.proxyHost ?? '');
  const [port, setPort] = useState(account?.proxyPort?.toString() ?? '');
  const [username, setUsername] = useState(account?.proxyUsername ?? '');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault(); setFormError('');
    if (!name.trim() || (mode === 'create' && !profileName.trim())) { setFormError('Account name and profile name are required.'); return; }
    if (proxyEnabled && (!host.trim() || !port || Number(port) < 1 || Number(port) > 65535)) { setFormError('Enter a valid proxy host and port.'); return; }
    if (proxyEnabled && Boolean(username) !== Boolean(password) && !(mode === 'edit' && username && account?.proxyUsername && !password && !clearPassword)) { setFormError('Proxy username and password must be supplied together.'); return; }
    setSaving(true);
    try {
      if (mode === 'create') await onCreate({ name: name.trim(), profileName: profileName.trim(), proxyEnabled, proxyHost: host.trim() || undefined, proxyPort: port ? Number(port) : undefined, proxyUsername: username.trim() || undefined, proxyPassword: password || undefined });
      else await onUpdate({ accountId: account!.id, name: name.trim(), proxyEnabled, proxyHost: host.trim() || undefined, proxyPort: port ? Number(port) : undefined, proxyUsername: username.trim() || undefined, proxyPassword: password || undefined, clearProxyPassword: clearPassword });
    } finally { setSaving(false); }
  }

  return <div className="modal-backdrop"><form className="modal form-modal" onSubmit={submit}><div className="modal-header"><div><div className="eyebrow">ACCOUNT PROFILE</div><h2>{mode === 'create' ? 'Add account' : 'Edit account'}</h2></div><button type="button" className="close-button" onClick={onCancel}>×</button></div>
    {formError && <div className="inline-error">{formError}</div>}
    <label>Account name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="FB Shop 01" autoFocus /></label>
    <label>Profile name<input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="fb-shop-01" disabled={mode === 'edit'} /><small>{mode === 'edit' ? 'Profile directory is immutable after creation.' : 'Filesystem-safe name; each account gets its own directory.'}</small></label>
    <fieldset><legend>Network</legend><div className="radio-row"><label className="radio"><input type="radio" checked={!proxyEnabled} onChange={() => setProxyEnabled(false)} /> Direct</label><label className="radio"><input type="radio" checked={proxyEnabled} onChange={() => setProxyEnabled(true)} /> Fixed proxy</label></div></fieldset>
    {proxyEnabled && <div className="proxy-grid"><label>Host<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="proxy.example.com" /></label><label>Port<input type="number" min="1" max="65535" value={port} onChange={(e) => setPort(e.target.value)} placeholder="12345" /></label><label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Optional" /></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'edit' && account?.proxyUsername ? 'Leave blank to keep' : 'Required with username'} autoComplete="new-password" /></label>{mode === 'edit' && account?.proxyUsername && <label className="check-row"><input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} /> Clear saved proxy credentials</label>}</div>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : mode === 'create' ? 'Create account' : 'Save changes'}</button></div>
  </form></div>;
}
