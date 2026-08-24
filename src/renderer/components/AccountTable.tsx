import type { FacebookAccount } from '@shared/types';
import { AccountStatusBadge } from './AccountStatusBadge';

type Props = {
  accounts: FacebookAccount[]; loading: boolean; busy: Record<string, string>;
  onOpen: (id: string) => void; onClose: (id: string) => void; onHealth: (id: string) => void;
  onEdit: (account: FacebookAccount) => void; onDelete: (account: FacebookAccount) => void; onOpenFolder: (id: string) => void;
};

export function AccountTable({ accounts, loading, busy, onOpen, onClose, onHealth, onEdit, onDelete, onOpenFolder }: Props) {
  if (loading) return <div className="empty-state">Loading accounts…</div>;
  if (!accounts.length) return <div className="empty-state"><div className="empty-icon">◎</div><strong>No accounts yet</strong><p>Add an account to create its isolated persistent profile.</p></div>;
  return <div className="table-card"><div className="table-wrap"><table><thead><tr><th>Account</th><th>Profile</th><th>Network</th><th>Proxy health</th><th>Status</th><th>Last opened</th><th>Last health check</th><th>Actions</th></tr></thead><tbody>
    {accounts.map((account) => { const action = busy[account.id]; const running = account.status === 'RUNNING' || account.status === 'STARTING'; return <tr key={account.id}>
      <td><div className="account-name"><span className="avatar">{account.name.slice(0, 1).toUpperCase()}</span><div><strong>{account.name}</strong><small>{account.id.slice(0, 8)}</small></div></div></td>
      <td><div className="profile-cell"><code>{account.profileName}</code><small title={account.profileDirectory}>{account.profileDirectory}</small></div></td>
      <td><div className="network-cell"><span className={`network-dot ${account.proxyEnabled ? 'proxy' : ''}`}></span><span>{account.proxyEnabled ? `Proxy · ${account.proxyProtocol}` : 'Direct'}</span>{account.proxyEnabled && <small>{maskProxy(account.proxyHost, account.proxyPort)}</small>}</div></td>
      <td>{account.proxyEnabled ? <div className="proxy-health-cell"><span className={`status-badge status-${account.proxyStatus.toLowerCase()}`}>{account.proxyStatus}</span><small>{account.lastProxyTestIp ? `IP ${account.lastProxyTestIp}` : 'No outbound IP yet'}</small>{account.lastProxyLatencyMs !== undefined && <small>{account.lastProxyLatencyMs} ms</small>}{account.lastProxyError && <small className="error-text" title={account.lastProxyError}>{account.lastProxyError}</small>}</div> : <span className="status-badge">DIRECT</span>}</td>
      <td><AccountStatusBadge status={account.status} health={account.lastHealthStatus} />{account.lastError && <small className="error-text" title={account.lastError}>{account.lastError}</small>}</td>
      <td>{formatDate(account.lastOpenedAt)}</td><td>{formatDate(account.lastHealthCheckAt)}{account.lastHealthStatus && <small className="health-label">{account.lastHealthStatus.replaceAll('_', ' ')}</small>}</td>
      <td><div className="actions"><button className="action-button" disabled={Boolean(action)} onClick={() => running ? onClose(account.id) : onOpen(account.id)}>{action && action.includes('…') ? action : running ? 'Close' : 'Open'}</button><button className="action-button" disabled={Boolean(action)} onClick={() => onHealth(account.id)}>Health check</button><button className="icon-button" disabled={Boolean(action)} onClick={() => onEdit(account)} title="Edit">Edit</button><button className="icon-button danger-text" disabled={Boolean(action)} onClick={() => onDelete(account)} title="Delete">Delete</button><button className="icon-button" disabled={Boolean(action)} onClick={() => onOpenFolder(account.id)} title="Open profile folder">Folder</button></div></td>
    </tr>; })}
  </tbody></table></div></div>;
}

function formatDate(value?: string): string { return value ? new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—'; }
function maskProxy(host?: string, port?: number): string { if (!host || !port) return 'Configured'; const parts = host.split('.'); const masked = parts.length === 4 ? `•••.•••.${parts[2]}.${parts[3]}` : `${host.slice(0, 3)}•••`; return `${masked}:${port}`; }
