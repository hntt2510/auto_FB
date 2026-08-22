import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isOperationalBridge, sanitizeRendererError, type RendererBridge } from '../bridge';

export function BridgeGate({ value, children }: { value: RendererBridge | undefined; children: ReactNode }) {
  if (isOperationalBridge(value)) return <>{children}</>;
  const available = value?.appBridge?.available === true;
  const location = typeof window === 'undefined' ? 'unknown' : window.location.href;
  return <main className="bridge-fallback"><div className="bridge-fallback-card"><div className="brand-mark">f</div><h1>Facebook Account Manager</h1><h2>Electron bridge unavailable.</h2><p>This interface must be opened through the desktop application, not directly in a normal web browser.</p><dl><dt>Renderer URL</dt><dd>{location}</dd><dt>App bridge available</dt><dd>{available ? 'YES' : 'NO'}</dd></dl></div></main>;
}

type BoundaryState = { error?: string };

export class RendererErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = {};

  static getDerivedStateFromError(error: unknown): BoundaryState { return { error: sanitizeRendererError(error) }; }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') console.error('Renderer UI error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <main className="bridge-fallback"><div className="bridge-fallback-card"><div className="brand-mark">f</div><h1>Application UI Error</h1><p>{this.state.error}</p><button className="primary" onClick={() => window.location.reload()}>Reload UI</button></div></main>;
  }
}
