import { useEffect, useRef } from 'react'

interface Props {
  lines: string[]
  /** Auto-scroll to bottom on new lines (default true) */
  follow?: boolean
}

// Strip a small subset of ANSI escapes — full ANSI rendering is Phase 2.
const ANSI_RE = /\[[0-9;]*[a-zA-Z]/g
export const stripAnsi = (s: string) => s.replace(ANSI_RE, '')

export function LogPanel({ lines, follow = true }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!follow || !ref.current) return
    ref.current.scrollTop = ref.current.scrollHeight
  }, [lines, follow])

  return (
    <div
      ref={ref}
      className="log-panel h-full overflow-y-auto bg-black/60 border border-slate-800 rounded-md p-3 text-slate-300"
    >
      {lines.length === 0 ? (
        <span className="text-slate-500 italic">Waiting for output…</span>
      ) : (
        lines.map((l, i) => <div key={i}>{stripAnsi(l)}</div>)
      )}
    </div>
  )
}
