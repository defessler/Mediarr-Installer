import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Terminal, ChevronDown } from 'lucide-react'
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
  const reduced = useReducedMotion()
  /** True when the user has scrolled up to read history. While stuck,
   *  we stop auto-scrolling so we don't yank them away from what
   *  they're reading. The moment they scroll back to the bottom (or
   *  click "Jump to bottom") we resume following. Stored in a ref so
   *  fast log-stream updates don't trigger a re-render every chunk. */
  const stuckRef = useRef(false)
  /** Mirror of stuckRef as state — purely so the JumpToBottom button
   *  knows when to appear. Polled every 250ms from stuckRef rather
   *  than tied to log updates so the button doesn't flicker. */
  const [stuck, setStuck] = useState(false)

  // Scroll on every render. linesRef in RunScreen is mutated in place
  // for efficiency, so React's `lines` reference rarely changes and a
  // dep array of [lines] silently misses updates. Setting scrollTop is
  // one DOM property write — cheap.
  //
  // Use direct scrollTop= (not scrollTo with behavior:'smooth') —
  // smooth scrolling lags dangerously during high-frequency renders
  // (100+ lines/sec from docker compose pull) and never catches up to
  // the growing scrollHeight. Instant scroll always lands at the bottom.
  useEffect(() => {
    if (!follow || !ref.current) return
    if (stuckRef.current) return
    ref.current.scrollTop = ref.current.scrollHeight
  })

  // User-intent detection: only mark "stuck" on user-initiated scroll
  // (wheel, touch, keyboard). Pure scroll events also fire when WE
  // programmatically scrollTop=scrollHeight, and during fast content
  // appends the layout shifts can momentarily measure as "not at
  // bottom" — which previously kicked us into stuck mode incorrectly.
  // Listening to wheel/touch directly bypasses that race entirely.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const markStuck = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      stuckRef.current = !atBottom
    }
    const checkUnstuck = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      // Only un-stick from scroll events — never auto-stick. The user
      // has to wheel/touch/keyboard to enter stuck mode.
      if (atBottom) stuckRef.current = false
    }
    el.addEventListener('wheel', markStuck, { passive: true })
    el.addEventListener('touchmove', markStuck, { passive: true })
    el.addEventListener('keydown', markStuck)
    el.addEventListener('scroll', checkUnstuck, { passive: true })
    return () => {
      el.removeEventListener('wheel', markStuck)
      el.removeEventListener('touchmove', markStuck)
      el.removeEventListener('keydown', markStuck)
      el.removeEventListener('scroll', checkUnstuck)
    }
  }, [])

  // Mirror stuckRef → stuck state every 250ms. Decoupled from log
  // updates so the button doesn't flicker on every chunk; coupled
  // tightly enough to feel responsive when the user wheels up/down.
  useEffect(() => {
    const i = setInterval(() => {
      if (stuckRef.current !== stuck) setStuck(stuckRef.current)
    }, 250)
    return () => clearInterval(i)
  }, [stuck])

  function jumpToBottom() {
    const el = ref.current
    if (!el) return
    stuckRef.current = false
    el.scrollTop = el.scrollHeight
    setStuck(false)
  }

  return (
    <div className="relative h-full">
      <div
        ref={ref}
        tabIndex={0}
        className="log-panel h-full overflow-y-auto bg-black/60 border border-slate-800 rounded-md p-3 text-slate-300 focus:outline-none"
      >
        {lines.length === 0 ? (
          <div className="flex items-center gap-2 text-slate-500">
            <Terminal size={14} className="text-slate-600" />
            <span className="italic">Waiting for output</span>
            {/* Three dots that pulse one-by-one — gives a clear
                "I'm alive, just waiting on the shell" signal without
                being noisy. Suppressed under reduced-motion. */}
            <span aria-hidden className="inline-flex gap-0.5 ml-0.5">
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="inline-block w-1 h-1 rounded-full bg-slate-500"
                  animate={reduced ? {} : { opacity: [0.2, 1, 0.2] }}
                  transition={{
                    duration: 1.2,
                    repeat: Infinity,
                    delay: i * 0.18,
                    ease: 'easeInOut',
                  }}
                />
              ))}
            </span>
          </div>
        ) : (
          lines.map((l, i) => {
            const segs = parseAnsi(l)
            return (
              <div key={i}>
                {segs.length === 0 ? ' ' : segs.map((s, j) => {
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
      <AnimatePresence>
        {stuck && (
          <motion.button
            type="button"
            onClick={jumpToBottom}
            initial={reduced ? { opacity: 1 } : { opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            whileHover={reduced ? {} : { y: -1 }}
            whileTap={reduced ? {} : { scale: 0.97 }}
            className="absolute bottom-3 right-3 px-3 py-1.5 text-xs rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/50 border border-emerald-500/40 flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
            title="Resume following the log (Esc / End also works)"
          >
            Jump to bottom
            <ChevronDown size={14} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
