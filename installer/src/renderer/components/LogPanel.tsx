import { useEffect, useRef } from 'react'
import { parseAnsi, COLOR_CLASS } from './ansi.js'

interface Props {
  /** Raw log lines (may contain ANSI escape sequences) */
  lines: string[]
  /** Auto-scroll to bottom on new lines (default true) */
  follow?: boolean
}

// Strip ANSI CSI sequences entirely. Used by callers that want to inspect
// log content (e.g. matching service names) without color noise.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g
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
        <span className="text-slate-500 italic">Waiting for output...</span>
      ) : (
        lines.map((l, i) => {
          const segs = parseAnsi(l)
          return (
            <div key={i}>
              {segs.length === 0 ? ' ' : segs.map((s, j) => {
                const cls = [
                  s.fg ? COLOR_CLASS[s.fg] : '',
                  s.bold ? 'font-semibold' : '',
                ].filter(Boolean).join(' ')
                return cls ? <span key={j} className={cls}>{s.text}</span> : <span key={j}>{s.text}</span>
              })}
            </div>
          )
        })
      )}
    </div>
  )
}
