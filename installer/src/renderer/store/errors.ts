// App-wide error/toast store. Any screen, hook, or service worker that
// catches a recoverable error can push it here and a toast surfaces at
// the bottom-right of the window. Designed to be the catch-all so a
// single misbehaving IPC call can't silently disappear into a console
// log no one reads.

import { create } from 'zustand'

export type ToastSeverity = 'error' | 'warn' | 'info'

export interface Toast {
  id: string
  severity: ToastSeverity
  title: string
  detail?: string
  /** Auto-dismiss after this many ms; 0 = sticky until user closes. */
  ttlMs: number
  createdAt: number
}

interface ErrorsState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id' | 'createdAt' | 'ttlMs'> & { ttlMs?: number }) => void
  pushError: (title: string, detail?: string) => void
  pushWarn:  (title: string, detail?: string) => void
  pushInfo:  (title: string, detail?: string) => void
  dismiss: (id: string) => void
  clear: () => void
}

// randomUUID isn't available in older Chromium renderers via crypto.randomUUID
// reliably, but it IS on window.crypto. Use that to keep this stay-renderer-safe.
function uid(): string {
  try {
    if (globalThis.crypto && 'randomUUID' in globalThis.crypto) {
      return (globalThis.crypto as Crypto).randomUUID()
    }
  } catch { /* fall through */ }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export const useErrors = create<ErrorsState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const ttl = t.ttlMs ?? (t.severity === 'error' ? 0 : 6_000)
    const toast: Toast = {
      id: uid(),
      createdAt: Date.now(),
      severity: t.severity,
      title: t.title,
      detail: t.detail,
      ttlMs: ttl,
    }
    set((s) => ({ toasts: [...s.toasts, toast] }))
    if (ttl > 0) {
      setTimeout(() => get().dismiss(toast.id), ttl)
    }
  },
  pushError: (title, detail) => get().push({ severity: 'error', title, detail }),
  pushWarn:  (title, detail) => get().push({ severity: 'warn',  title, detail }),
  pushInfo:  (title, detail) => get().push({ severity: 'info',  title, detail }),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}))

/** Convenience for try/catch sites — coerces any thrown value into a
 *  reasonable title + detail and pushes to the toast store. */
export function reportError(scope: string, err: unknown): void {
  const e = err as { message?: string; stack?: string } | string | undefined
  const message = typeof e === 'string'
    ? e
    : e?.message ?? 'Unknown error'
  const stack = typeof e === 'object' && e?.stack ? e.stack : undefined
  useErrors.getState().pushError(`${scope}: ${message}`, stack)
}
