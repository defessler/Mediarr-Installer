import { motion } from 'motion/react'
import {
  Download, Loader2, CheckCircle2, RefreshCw, AlertTriangle, X,
} from 'lucide-react'
import type { UpdaterState } from '../../shared/ipc.js'

interface Props {
  /** Live updater state. The caller only mounts this overlay for the
   *  "committed to an update" kinds (downloading / extracting /
   *  downloaded / installing) plus a mid-update error, but we re-narrow
   *  here so every branch is type-safe. */
  state: UpdaterState
  /** Abort the in-flight download (download phase only). */
  onCancel: () => void
  /** Restart now and apply the staged update (downloaded phase). */
  onInstall: () => void
  /** Dismiss the overlay and apply on next launch (downloaded phase). */
  onDefer: () => void
  /** Acknowledge a mid-update error and return to the app. */
  onDismissError: () => void
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

/**
 * Full-screen blocking overlay shown while an in-place app update is
 * actively running. It sits above the entire wizard (stepper, screen,
 * footer) so the user can't navigate or kick off a second remote
 * operation while the app is busy swapping its own binary — the update
 * is an all-or-nothing event and a half-applied swap is the worst
 * outcome.
 *
 * Phases:
 *   downloading → progress bar + Cancel (the one interruptible phase)
 *   extracting  → indeterminate spinner, no escape (can't safely abort)
 *   downloaded  → "Restart now" primary + "Install on next launch" out
 *   installing  → terminal "Restarting…" spinner (app quits in ~500 ms)
 *   error       → message + Close (returns to the app to retry)
 */
export function UpdateOverlay({
  state, onCancel, onInstall, onDefer, onDismissError,
}: Props) {
  const version =
    state.kind === 'extracting'
      || state.kind === 'downloaded'
      || state.kind === 'installing'
      ? state.version
      : ''

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      role="dialog"
      aria-modal="true"
      aria-label="Updating Mediarr Installer"
    >
      <motion.div
        className="w-full max-w-md mx-4 rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50 p-8 text-center"
        initial={{ scale: 0.94, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 26 }}
      >
        {/* ── Downloading ─────────────────────────────────────────── */}
        {state.kind === 'downloading' && (
          <>
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 mb-5">
              <Download size={32} className="text-emerald-300" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <h2 className="text-xl font-bold text-slate-100">Downloading update</h2>
            <p className="text-sm text-slate-400 mt-1.5">
              The app is locked while it updates. This only takes a moment.
            </p>
            <div className="mt-6 space-y-2" aria-live="polite">
              <div className="h-2.5 w-full bg-slate-800 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 rounded-full"
                  animate={{ width: `${state.percent}%` }}
                  transition={{ type: 'spring', stiffness: 80, damping: 20 }}
                />
              </div>
              <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                <span>
                  {state.percent}% · {mb(state.transferred)}/{mb(state.total)} MB
                </span>
                <span>{(state.bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="mt-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            >
              <X size={15} aria-hidden="true" />
              Cancel update
            </button>
          </>
        )}

        {/* ── Extracting ──────────────────────────────────────────── */}
        {state.kind === 'extracting' && (
          <>
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 mb-5">
              <Loader2 size={32} className="text-emerald-300 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <h2 className="text-xl font-bold text-slate-100">Unpacking update</h2>
            <p className="text-sm text-slate-400 mt-1.5">
              Extracting v{version}… please don't close the app.
            </p>
          </>
        )}

        {/* ── Downloaded — ready to restart ───────────────────────── */}
        {state.kind === 'downloaded' && (
          <>
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 mb-5">
              <CheckCircle2 size={32} className="text-emerald-300" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <h2 className="text-xl font-bold text-slate-100">Update ready</h2>
            <p className="text-sm text-slate-400 mt-1.5">
              v{version} is downloaded. Restart now to finish — the app will
              reopen automatically.
            </p>
            <div className="mt-6 flex flex-col gap-2">
              <button
                type="button"
                onClick={onInstall}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
              >
                <RefreshCw size={17} aria-hidden="true" />
                Restart now to finish
              </button>
              <button
                type="button"
                onClick={onDefer}
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
              >
                Install on next launch
              </button>
            </div>
          </>
        )}

        {/* ── Installing — about to quit ──────────────────────────── */}
        {state.kind === 'installing' && (
          <>
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 mb-5">
              <Loader2 size={32} className="text-emerald-300 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <h2 className="text-xl font-bold text-slate-100">Restarting…</h2>
            <p className="text-sm text-slate-400 mt-1.5">
              Applying v{version} and reopening. This window will close on its own.
            </p>
          </>
        )}

        {/* ── Error — mid-update failure ──────────────────────────── */}
        {state.kind === 'error' && (
          <>
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-rose-500/15 border border-rose-500/30 mb-5">
              <AlertTriangle size={32} className="text-rose-300" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <h2 className="text-xl font-bold text-slate-100">Update failed</h2>
            <p className="text-sm text-rose-200/90 mt-1.5 break-words">
              {state.message}
            </p>
            <p className="text-xs text-slate-500 mt-2">
              Your current version is untouched. You can try again from the
              footer.
            </p>
            <button
              type="button"
              onClick={onDismissError}
              className="mt-6 inline-flex items-center justify-center px-4 py-2 rounded-lg bg-slate-800 text-slate-100 font-medium hover:bg-slate-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            >
              Close
            </button>
          </>
        )}
      </motion.div>
    </motion.div>
  )
}
