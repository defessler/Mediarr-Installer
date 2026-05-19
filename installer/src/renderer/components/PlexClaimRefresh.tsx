import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Clock, ExternalLink, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { useWizard } from '../store/wizard.js'

interface Props {
  value: string | undefined
  onChange: (claim: string | undefined) => void
}

// Plex claim tokens expire 4 minutes after generation. The wizard
// collects one on the Configure screen, but if the user spends more
// than ~3 minutes on later screens before clicking Start, it's dead
// and setup.sh step 6 (docker compose up) will fail to register Plex.
//
// This component shows a freshness countdown that starts ticking when
// the user pastes a claim, plus a one-click "Get fresh token" link to
// plex.tv/claim. Lives on the Run screen.
//
// CRITICAL: the "when was this pasted?" timestamp lives in the wizard
// store, not in a component-local useRef. The component is mounted and
// unmounted as the user navigates idle → uploading → failed; a
// component-local ref re-initializes to `Date.now()` on each mount and
// the countdown would falsely show "4:00 fresh" on the failed view even
// when the token is actually 5+ minutes old.

const FRESH_FOR_MS = 4 * 60 * 1000      // Plex's documented expiry
const STALE_AT_MS  = 3.5 * 60 * 1000    // start warning before it actually expires

export function PlexClaimRefresh({ value, onChange }: Props) {
  const setAt = useWizard((s) => s.plexClaimSetAt)
  const [, setTick] = useState(0)

  // Repaint every second so the countdown ticks visibly.
  useEffect(() => {
    if (!value) return
    const i = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(i)
  }, [value])

  // If we have a value but no timestamp (rare — older state, or claim
  // hand-set into config without going through setConfig), assume it
  // was pasted just now. Don't pretend it's stale, but don't pretend
  // it's brand-new either.
  const effectiveSetAt = value && setAt ? setAt : value ? Date.now() : 0
  const ageMs = effectiveSetAt ? Date.now() - effectiveSetAt : 0
  const remaining = Math.max(0, FRESH_FOR_MS - ageMs)
  const stale = !!value && ageMs > STALE_AT_MS
  const expired = !!value && remaining === 0

  const mm = Math.floor(remaining / 60_000)
  const ss = Math.floor((remaining % 60_000) / 1000).toString().padStart(2, '0')

  const reduced = useReducedMotion()
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-4 space-y-3">
      <label className="flex items-center gap-2 text-sm" htmlFor="plex-claim-input">
        <Clock size={16} className="text-emerald-400 shrink-0" />
        <span className="font-semibold">Plex claim token</span>
        <span className="text-slate-500 text-xs">
          · expires 4 minutes after you generate it
        </span>
        <a
          href="https://plex.tv/claim"
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-emerald-400 hover:text-emerald-300 hover:underline transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded"
        >
          Get fresh token <ExternalLink size={11} />
        </a>
      </label>
      <input
        id="plex-claim-input"
        type="text"
        placeholder="claim-xxxxxxxxxxxxxxxxxxxx"
        aria-invalid={expired ? true : undefined}
        aria-describedby="plex-claim-status"
        className={
          'w-full px-3 py-2 text-sm bg-slate-800 border rounded-md font-mono transition-colors focus:outline-none focus:ring-1 ' +
          (expired
            ? 'border-rose-600 text-rose-200 focus:ring-rose-400'
            : stale
              ? 'border-amber-600 text-amber-200 focus:ring-amber-400'
              : value
                ? 'border-emerald-700 text-emerald-100 focus:ring-emerald-400 focus:border-emerald-500'
                : 'border-slate-700 focus:ring-emerald-400 focus:border-emerald-500')
        }
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
      {value && (
        <motion.div
          key={expired ? 'exp' : stale ? 'stale' : 'fresh'}
          initial={reduced ? { opacity: 1, x: 0 } : { opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.15 }}
          id="plex-claim-status"
          role="status"
          aria-live="polite"
          className="text-xs flex items-center gap-1.5"
        >
          {expired ? (
            <>
              <XCircle size={14} className="text-rose-400 shrink-0" aria-hidden="true" />
              <span className="text-rose-300">
                Expired — open plex.tv/claim and paste a fresh token.
              </span>
            </>
          ) : stale ? (
            <>
              <AlertTriangle size={14} className="text-amber-400 shrink-0" aria-hidden="true" />
              <span className="text-amber-300">
                Expires in <span className="font-mono tabular-nums">{mm}:{ss}</span> —
                refresh if you'll wait before clicking install.
              </span>
            </>
          ) : (
            <>
              <CheckCircle2 size={14} className="text-emerald-400 shrink-0" aria-hidden="true" />
              <span className="text-emerald-300">
                Fresh · <span className="font-mono tabular-nums">{mm}:{ss}</span> remaining
              </span>
            </>
          )}
        </motion.div>
      )}
      {!value && (
        <div className="text-xs text-slate-500">
          Optional. Plex still works without a claim — you'll just need to sign
          in once at <span className="font-mono">http://&lt;NAS&gt;:32400/web</span>.
        </div>
      )}
    </div>
  )
}
