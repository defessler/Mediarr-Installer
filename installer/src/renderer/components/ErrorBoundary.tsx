// Render-time crash safety net for the wizard. Without this, any screen
// component that throws during render (or in a sync lifecycle / event
// handler that re-throws) produces a blank window — React unmounts the
// entire tree on uncaught render errors and shows nothing.
//
// A blank window with no actionable message is the worst possible
// failure mode for a child user: no clue what happened, no obvious way
// to recover. This boundary catches the error, logs it through the same
// reportError() pipeline as everything else, and renders a friendly
// fallback with three things:
//   1. A plain-language explanation that something broke
//   2. The technical detail (collapsed by default, copyable)
//   3. A "Reload wizard" button + a "Back to Welcome" reset button
//
// Specifically NOT a route-level boundary — we want one at App root so
// it catches crashes from ANY screen, including ones whose persisted
// state is what's actually broken.

import { Component, type ReactNode } from 'react'
import { AlertOctagon, RotateCw, Home, FileText } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Surface to the main-process electron-log via the install-log
    // append IPC if one's open, plus console.error which the main
    // process mirrors to electron-log automatically. Both wrapped in
    // try/catch because if the IPC bridge itself is broken (the most
    // likely shape of "first render crashed"), we shouldn't double-
    // fault on the way to the fallback UI.
    try {
      // eslint-disable-next-line no-console
      console.error('ErrorBoundary caught:', error, info.componentStack)
    } catch { /* swallow */ }
    try {
      void window.installer?.installLog?.append(
        `[renderer error] ${error.name}: ${error.message}\n` +
        (error.stack ? error.stack + '\n' : '') +
        (info.componentStack ? `Component stack:${info.componentStack}\n` : ''),
      )?.catch(() => { /* no install-log open yet — fine */ })
    } catch { /* swallow */ }
  }

  reload = () => {
    // Hard reload — re-runs the renderer bundle. If the crash was a
    // transient state issue (corrupted zustand cache, race on hydrate)
    // this clears it. Doesn't clear localStorage so persisted profiles
    // stay.
    try { window.location.reload() } catch { /* SSR-safe noop */ }
  }

  resetToWelcome = () => {
    // Nuclear option: wipe the persisted wizard state so a corrupted
    // step / profile reference doesn't trip the same crash on reload.
    // Profiles themselves live in encrypted files on disk — those are
    // unaffected.
    try {
      window.localStorage.removeItem('nas-installer-wizard')
    } catch { /* swallow */ }
    this.reload()
  }

  openLog = () => {
    try { void window.installer?.app?.openLog?.() } catch { /* swallow */ }
  }

  render() {
    if (!this.state.error) return this.props.children
    const err = this.state.error
    return (
      <div className="h-full overflow-y-auto bg-slate-950 text-slate-100">
        <div className="max-w-xl mx-auto px-8 py-12 space-y-6">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-rose-500/15 border border-rose-500/30 mb-4">
              <AlertOctagon size={36} className="text-rose-300" strokeWidth={1.5} aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
            <p className="text-slate-400 mt-2 text-sm">
              The wizard hit an error while drawing a screen. Your profile
              data is safe — only the in-app state needs a reset.
            </p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-2">
            <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
              Error
            </div>
            <pre className="text-xs text-rose-200 whitespace-pre-wrap break-words font-mono">
              {err.name}: {err.message}
            </pre>
            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer hover:text-slate-200 select-none">
                Stack trace
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] max-h-48 overflow-auto">
                {err.stack ?? '(no stack)'}
              </pre>
            </details>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={this.reload}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
            >
              <RotateCw size={16} aria-hidden="true" />
              Reload wizard
            </button>
            <button
              type="button"
              onClick={this.resetToWelcome}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100 font-medium text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
            >
              <Home size={16} aria-hidden="true" />
              Reset to Welcome
            </button>
            <button
              type="button"
              onClick={this.openLog}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
            >
              <FileText size={16} aria-hidden="true" />
              Open log
            </button>
          </div>

          <div className="text-xs text-slate-500 leading-relaxed">
            <strong className="text-slate-400">What to try:</strong>{' '}
            Reload first — most render crashes are transient. If the same
            error fires after reload, click <em>Reset to Welcome</em>;
            that wipes the persisted in-app state (last step, last mode)
            but keeps your saved profiles. If it STILL crashes, open the
            log file and share the contents.
          </div>
        </div>
      </div>
    )
  }
}
