// Toast tray — bottom-right transient notifications.
//
// Each toast slides in from the right + scales up subtly, slides out
// when dismissed. Lucide icon + severity-colored panel makes the
// nature of the message readable at a glance, no need to parse a
// "Error" label prefix.

import { useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { AlertCircle, AlertTriangle, Info, X, FileText } from 'lucide-react'
import { useErrors, reportError, type Toast } from '../store/errors.js'

const SEVERITY_STYLE: Record<Toast['severity'], string> = {
  error: 'border-rose-700/60 bg-rose-950/85 text-rose-100',
  warn:  'border-amber-700/60 bg-amber-950/85 text-amber-100',
  info:  'border-sky-700/60 bg-sky-950/85 text-sky-100',
}

const SEVERITY_ICON: Record<Toast['severity'], typeof AlertCircle> = {
  error: AlertCircle,
  warn:  AlertTriangle,
  info:  Info,
}

const SEVERITY_ICON_COLOR: Record<Toast['severity'], string> = {
  error: 'text-rose-400',
  warn:  'text-amber-300',
  info:  'text-sky-300',
}

export function ToastTray() {
  const toasts = useErrors((s) => s.toasts)
  const dismiss = useErrors((s) => s.dismiss)

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md pointer-events-none"
      role="region"
      aria-label="Notifications"
    >
      {/* pointer-events-none on the tray + auto on individual cards
          so a misbehaving toast can't block clicks elsewhere on the
          screen while still being interactive. */}
      <AnimatePresence>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [showDetail, setShowDetail] = useState(false)
  const reduced = useReducedMotion()
  const Icon = SEVERITY_ICON[toast.severity]
  return (
    <motion.div
      initial={reduced ? { opacity: 1, x: 0 } : { opacity: 0, x: 40, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      layout
      role={toast.severity === 'error' ? 'alert' : 'status'}
      aria-live={toast.severity === 'error' ? 'assertive' : 'polite'}
      className={
        'pointer-events-auto rounded-lg border shadow-2xl p-3 text-sm backdrop-blur-sm ' +
        SEVERITY_STYLE[toast.severity]
      }
    >
      <div className="flex items-start gap-3">
        <Icon size={20} className={`shrink-0 mt-0.5 ${SEVERITY_ICON_COLOR[toast.severity]}`} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold break-words">{toast.title}</div>
          <div className="mt-1 flex items-center gap-3 text-xs opacity-80">
            {toast.detail && (
              <button
                type="button"
                onClick={() => setShowDetail((s) => !s)}
                className="hover:opacity-100 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 rounded"
              >
                {showDetail ? 'Hide details' : 'Show details'}
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                window.installer.app.openLog().catch((e) =>
                  reportError('Open log', e),
                )
              }
              className="inline-flex items-center gap-1 hover:opacity-100 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 rounded"
            >
              <FileText size={12} />
              Open log
            </button>
          </div>
          <AnimatePresence>
            {showDetail && toast.detail && (
              <motion.pre
                initial={reduced ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="mt-2 text-[11px] whitespace-pre-wrap font-mono opacity-90 max-h-48 overflow-auto"
              >
                {toast.detail}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:opacity-100"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </motion.div>
  )
}
