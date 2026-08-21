import type { AccountStatus, HealthStatus } from '@shared/types';

export function AccountStatusBadge({ status, health }: { status: AccountStatus; health?: HealthStatus }) {
  const label = status === 'RUNNING' && health ? `RUNNING · ${health}` : status.replaceAll('_', ' ');
  return <span className={`status-badge status-${status.toLowerCase()}`}>{label}</span>;
}
