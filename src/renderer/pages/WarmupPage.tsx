import { useEffect, useRef, useState, useCallback } from "react";
import type { WarmupConfig, WarmupExecutionLog, WarmupProgress } from "@shared/types";
import { DEFAULT_WARMUP_CONFIG } from "@shared/types";

declare global {
  interface Window {
    warmupApi: import("@shared/types").WarmupApi;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "RUNNING": return "text-blue-400";
    case "PAUSED": return "text-yellow-400";
    case "DONE": return "text-green-400";
    case "ERROR": return "text-red-400";
    default: return "text-slate-400";
  }
}

function formatSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export default function WarmupPage() {
  const [list, setList] = useState<WarmupProgress[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [logs, setLogs] = useState<WarmupExecutionLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState<WarmupConfig>(DEFAULT_WARMUP_CONFIG);
  const [showConfig, setShowConfig] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      const data = await window.warmupApi.listAll();
      setList(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const reloadLogs = useCallback(async (accountId: string) => {
    try {
      const data = await window.warmupApi.getLogs({ accountId, limit: 200 });
      setLogs(data);
      setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }), 50);
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => {
    void reload();
    const unsub = window.warmupApi.onChanged(() => {
      void reload();
      if (selected) void reloadLogs(selected);
    });
    return unsub;
  }, [reload, reloadLogs, selected]);

  useEffect(() => {
    if (selected) void reloadLogs(selected);
    else setLogs([]);
  }, [selected, reloadLogs]);

  async function handleStart(accountId: string) {
    setError(null);
    try {
      await window.warmupApi.start({ accountId });
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function handleStop(accountId: string) {
    setError(null);
    try {
      await window.warmupApi.stop(accountId);
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function handlePause(accountId: string) {
    setError(null);
    try {
      await window.warmupApi.pause(accountId);
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function handleResume(accountId: string) {
    setError(null);
    try {
      await window.warmupApi.resume(accountId);
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function handleSaveConfig(accountId: string) {
    setError(null);
    try {
      await window.warmupApi.updateConfig(accountId, configDraft);
      setShowConfig(false);
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const selectedProgress = list.find((p) => p.accountId === selected);

  return (
    <div className="flex h-full text-slate-100">
      {/* Sidebar */}
      <div className="w-72 border-r border-slate-700 flex flex-col">
        <div className="px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">Warmup Engine</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.length === 0 && (
            <p className="p-4 text-xs text-slate-500">Chưa có tài khoản nào đang được warm-up.<br />Bấm Start ở bất kỳ tài khoản nào để bắt đầu.</p>
          )}
          {list.map((p) => (
            <button
              key={p.accountId}
              onClick={() => setSelected(p.accountId === selected ? null : p.accountId)}
              className={`w-full text-left px-4 py-3 border-b border-slate-700/50 hover:bg-slate-800 transition-colors ${selected === p.accountId ? "bg-slate-800" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate">{p.accountId.slice(0, 8)}…</span>
                <span className={`text-xs font-semibold ${statusColor(p.status)}`}>{p.status}</span>
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Tổng: {formatSeconds(p.totalDurationSeconds)}
              </div>
              {/* Progress bar visual */}
              <div className="mt-1.5 h-1 rounded bg-slate-700 overflow-hidden">
                <div
                  className={`h-full rounded transition-all ${p.status === "RUNNING" ? "bg-blue-500" : p.status === "DONE" ? "bg-green-500" : "bg-slate-500"}`}
                  style={{ width: `${Math.min(100, (p.totalDurationSeconds / (p.config.durationMinutes * 60)) * 100)}%` }}
                />
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Main Panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedProgress ? (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700 bg-slate-900/50">
              <span className="text-sm font-medium text-slate-300">Account:</span>
              <code className="text-xs text-slate-400">{selectedProgress.accountId}</code>
              <span className={`ml-2 text-xs font-semibold ${statusColor(selectedProgress.status)}`}>{selectedProgress.status}</span>
              <div className="flex-1" />
              {selectedProgress.status === "IDLE" || selectedProgress.status === "DONE" || selectedProgress.status === "ERROR" ? (
                <button onClick={() => void handleStart(selectedProgress.accountId)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-medium transition-colors">▶ Start</button>
              ) : null}
              {selectedProgress.status === "RUNNING" ? (
                <>
                  <button onClick={() => void handlePause(selectedProgress.accountId)} className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 rounded text-xs font-medium transition-colors">⏸ Pause</button>
                  <button onClick={() => void handleStop(selectedProgress.accountId)} className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-xs font-medium transition-colors">■ Stop</button>
                </>
              ) : null}
              {selectedProgress.status === "PAUSED" ? (
                <button onClick={() => void handleResume(selectedProgress.accountId)} className="px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-xs font-medium transition-colors">▶ Resume</button>
              ) : null}
              <button onClick={() => { setConfigDraft({ ...selectedProgress.config }); setShowConfig(true); }} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs font-medium transition-colors">⚙ Config</button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-px border-b border-slate-700 bg-slate-700">
              {[
                ["Tổng thời gian", formatSeconds(selectedProgress.totalDurationSeconds)],
                ["Mục tiêu", `${selectedProgress.config.durationMinutes} phút`],
                ["Lỗi cuối", selectedProgress.lastError ?? "—"],
              ].map(([label, value]) => (
                <div key={label} className="bg-slate-900 px-4 py-3">
                  <div className="text-xs text-slate-500">{label}</div>
                  <div className="text-sm font-medium text-slate-200 truncate">{value}</div>
                </div>
              ))}
            </div>

            {/* Log viewer */}
            <div ref={logRef} className="flex-1 overflow-y-auto p-4 space-y-0.5 font-mono text-xs">
              {logs.length === 0 && <p className="text-slate-600">Chưa có log nào.</p>}
              {logs.map((log) => (
                <div key={log.id} className={`flex gap-3 ${log.ok ? "" : "text-red-400"}`}>
                  <span className="text-slate-600 shrink-0">{log.createdAt.slice(11, 19)}</span>
                  <span className={`shrink-0 w-24 ${log.ok ? "text-cyan-500" : "text-red-400"}`}>[{log.phase.slice(0, 9)}]</span>
                  <span className="text-slate-400 shrink-0 w-28">{log.action}</span>
                  <span className="text-slate-300">{log.detail ?? ""}</span>
                  {log.durationMs !== undefined && <span className="ml-auto text-slate-600 shrink-0">{log.durationMs}ms</span>}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-600 text-sm">
            Chọn một tài khoản để xem chi tiết và điều khiển warm-up
          </div>
        )}
      </div>

      {/* Config Modal */}
      {showConfig && selectedProgress && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-lg p-6 w-96 space-y-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-slate-200">Cấu hình Warm-up</h3>
            <label className="block">
              <span className="text-xs text-slate-400">Thời gian (phút)</span>
              <input type="number" min={5} max={120} value={configDraft.durationMinutes}
                onChange={(e) => setConfigDraft((c) => ({ ...c, durationMinutes: Number(e.target.value) }))}
                className="mt-1 w-full bg-slate-700 rounded px-3 py-2 text-sm text-slate-100 border border-slate-600 focus:outline-none focus:border-blue-500"
              />
            </label>
            {(["enableLikes", "enableComments", "enableReels", "headless"] as const).map((key) => (
              <label key={key} className="flex items-center justify-between">
                <span className="text-xs text-slate-400">{key}</span>
                <button
                  onClick={() => setConfigDraft((c) => ({ ...c, [key]: !c[key] }))}
                  className={`w-10 h-5 rounded-full transition-colors ${configDraft[key] ? "bg-blue-600" : "bg-slate-600"}`}
                >
                  <span className={`block w-4 h-4 bg-white rounded-full shadow transition-transform mx-0.5 ${configDraft[key] ? "translate-x-5" : ""}`} />
                </button>
              </label>
            ))}
            <div className="flex gap-2 pt-2">
              <button onClick={() => void handleSaveConfig(selectedProgress.accountId)}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 rounded text-xs font-medium transition-colors">
                Lưu
              </button>
              <button onClick={() => setShowConfig(false)}
                className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded text-xs font-medium transition-colors">
                Huỷ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-4 right-4 bg-red-900 border border-red-700 text-red-200 text-xs px-4 py-3 rounded shadow-lg max-w-sm z-50">
          <div className="flex items-start gap-2">
            <span>⚠</span>
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-auto shrink-0 hover:text-white">✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
