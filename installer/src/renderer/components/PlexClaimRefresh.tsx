import { useEffect, useState } from 'react'
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

  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Plex claim token</span>
        <span className="text-slate-500 text-xs">
          (4-minute expiry; refresh just before clicking Start)
        </span>
        <a
          href="https://plex.tv/claim"
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-xs text-emerald-400 hover:underline"
        >
          Get fresh token →
        </a>
      </div>
      <input
        type="text"
        placeholder="claim-xxxxxxxxxxxxxxxxxxxx"
        className={
          'w-full px-3 py-1.5 text-sm bg-slate-800 border rounded-md font-mono ' +
          (expired ? 'border-rose-600 text-rose-200'
            : stale ? 'border-amber-600 text-amber-200'
            : 'border-slate-700')
        }
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
      {value && (
        <div className="text-xs">
          {expired ? (
            <span className="text-rose-300">
              Expired — open plex.tv/claim and paste a fresh token.
            </span>
          ) : stale ? (
            <span className="text-amber-300">
              Will expire in {mm}:{ss} — paste a fresh token if you'll wait
              before starting.
            </span>
          ) : (
            <span className="text-emerald-400">
              Fresh ({mm}:{ss} remaining)
            </span>
          )}
        </div>
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
