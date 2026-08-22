import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { BridgeGate, RendererErrorBoundary } from './components/RendererGuards';

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode><RendererErrorBoundary><BridgeGate value={window}><App /></BridgeGate></RendererErrorBoundary></React.StrictMode>
  );
}
