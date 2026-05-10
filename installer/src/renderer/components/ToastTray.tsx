import { useState } from 'react'
import { useErrors, type Toast } from '../store/errors.js'

const SEVERITY_STYLE: Record<Toast['severity'], string> = {
  error: 'border-rose-700/60 bg-rose-950/80 text-rose-100',
  warn:  'border-amber-700/60 bg-amber-950/80 text-amber-100',
  info:  'border-sky-700/60 bg-sky-950/80 text-sky-100',
}

const SEVERITY_LABEL: Record<Toast['severity'], string> = {
  error: 'Error',
  warn:  'Warning',
  info:  'Note',
}

export function ToastTray() {
  const toasts = useErrors((s) => s.toasts)
  const dismiss = useErrors((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  )
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [showDetail, setShowDetail] = useState(false)
  return (
    <div
      className={
        'rounded-md border shadow-2xl p-3 text-sm animate-in slide-in-from-right ' +
        SEVERITY_STYLE[toast.severity]
      }
    >
      <div className="flex items-start gap-2">
        <span className="text-[11px] uppercase tracking-wide opacity-75 shrink-0 mt-0.5">
          {SEVERITY_LABEL[toast.severity]}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-medium break-words">{toast.title}</div>
          {toast.detail && (
            <button
              type="button"
              onClick={() => setShowDetail((s) => !s)}
              className="mt-1 text-xs opacity-75 hover:opacity-100 underline"
            >
              {showDetail ? 'Hide details' : 'Show details'}
            </button>
          )}
          {showDetail && toast.detail && (
            <pre className="mt-2 text-[11px] whitespace-pre-wrap font-mono opacity-90 max-h-48 overflow-auto">
              {toast.detail}
            </pre>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 opacity-60 hover:opacity-100"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  )
}
