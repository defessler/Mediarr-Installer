// IssuesModal — shows the set of install-time issues the parser caught
// out of the streaming log, tabbed by severity. Replaces the previous
// inline <details> Issues panel that lived above the stepper rail.
//
// Rationale for going button → modal vs inline expand:
//   - The inline panel was always taking vertical real-estate (even
//     when collapsed: the summary row plus border). Modal opens on
//     demand and frees the layout for the more-frequently-useful log.
//   - Inline-collapsed lists encourage "is something wrong?" anxiety
//     even when everything's fine. Buttons that only RENDER when there
//     are real issues (fail/action counts > 0) make the absence of
//     buttons itself a positive signal — "no buttons = no issues."
//   - Modals fit larger lists comfortably; the previous max-h-48
//     inline panel hid most of the content behind a scrollbar anyway.
//
// Two visible tiers (matches the post-research recommendation of three
// total buckets — OK isn't a separate tier, just "no buttons rendered"):
//   - Failed: hard errors the user needs to investigate
//   - Needs Action: manual steps + non-blocking flakes the user might
//     want to know about

import { useEffect, useState } from 'react'

export type Issue = {
  severity: 'fail' | 'warn' | 'note'
  text: string
}

interface Props {
  /** Which tab opened the modal — also the default-selected one. */
  initialTab: 'fail' | 'action'
  issues: Issue[]
  onClose: () => void
}

export function IssuesModal({ initialTab, issues, onClose }: Props) {
  // Tab state lives here so the user can switch between Failed and
  // Needs Action without re-opening from the button row.
  const fails  = issues.filter((i) => i.severity === 'fail')
  // 'Needs Action' = the user-actionable bucket. We FOLD 'warn' into
  // here (from setup-validate.sh's ⚠ lines, which are usually self-
  // healing "API key auto-discovered" hints) AND 'note' (from
  // setup-arr-config.py's ! lines, the actual manual-UI prompts).
  // The post-research three-bucket model didn't have a separate
  // "warn" tier because in practice warn always degrades into noise.
  const actions = issues.filter((i) => i.severity !== 'fail')

  // ESC closes the dialog — standard modal hygiene.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Default to whatever tab opened the modal, unless that tab is empty
  // (e.g. user clicked "Failed: 0" — shouldn't happen because the
  // button wouldn't render, but be defensive).
  const startTab = initialTab === 'fail' && fails.length > 0 ? 'fail'
                : actions.length > 0 ? 'action'
                : fails.length > 0 ? 'fail'
                : 'action'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="issues-modal-title"
      onClick={(e) => {
        // Click outside the dialog (i.e. on the backdrop) closes —
        // standard modal interaction. Don't close when click lands on
        // the inner card (stopped by the inner div's onClick handler).
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 pt-4 pb-3 border-b border-slate-800">
          <div className="flex items-center justify-between">
            <h2 id="issues-modal-title" className="text-lg font-semibold">
              Install issues
            </h2>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 text-xl leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Parsed from the install log. Self-healing transient conditions
            (Flaresolverr-resolvable CloudFlare blocks, etc.) show as info
            lines in the log itself, not in this list.
          </p>
        </header>

        <TabbedBody fails={fails} actions={actions} startTab={startTab} />

        <footer className="px-5 py-3 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md text-sm"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}

function TabbedBody({
  fails, actions, startTab,
}: { fails: Issue[]; actions: Issue[]; startTab: 'fail' | 'action' }) {
  // Tab state is component-local — switching tabs doesn't need to be
  // persisted or coordinate with the parent.
  const [tab, setTab] = useTabState(startTab)
  const visible = tab === 'fail' ? fails : actions
  const emptyMsg = tab === 'fail'
    ? "No failures recorded for this run."
    : "Nothing needs your attention right now."

  return (
    <>
      <div className="flex gap-1 px-5 pt-3">
        <TabButton
          active={tab === 'fail'}
          onClick={() => setTab('fail')}
          disabled={fails.length === 0}
          label={`Failed${fails.length > 0 ? ` · ${fails.length}` : ''}`}
          accent="rose"
        />
        <TabButton
          active={tab === 'action'}
          onClick={() => setTab('action')}
          disabled={actions.length === 0}
          label={`Needs action${actions.length > 0 ? ` · ${actions.length}` : ''}`}
          accent="amber"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {visible.length === 0 ? (
          <p className="text-sm text-slate-500 italic">{emptyMsg}</p>
        ) : (
          <ul className="space-y-2 text-sm font-mono">
            {visible.map((it, i) => {
              const cls =
                it.severity === 'fail' ? 'text-rose-300'
                : it.severity === 'warn' ? 'text-amber-300'
                : 'text-sky-300'
              const glyph =
                it.severity === 'fail' ? '✘'
                : it.severity === 'warn' ? '⚠'
                : '!'
              return (
                <li key={i} className={`flex gap-2 ${cls}`}>
                  <span className="shrink-0 select-none">{glyph}</span>
                  <span className="break-words">{it.text}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </>
  )
}

function TabButton({
  active, onClick, disabled, label, accent,
}: {
  active: boolean
  onClick: () => void
  disabled: boolean
  label: string
  accent: 'rose' | 'amber'
}) {
  // Compose class strings explicitly so Tailwind's purge picks them up
  // — dynamic class names like `bg-${accent}-900/30` get stripped at
  // build time and silently break the styling. Verbose but reliable.
  let cls = 'px-3 py-1.5 text-sm rounded-t-md border-b-2 transition-colors '
  if (disabled) {
    cls += 'border-transparent text-slate-600 cursor-not-allowed'
  } else if (active) {
    cls += accent === 'rose'
      ? 'border-rose-500 text-rose-200'
      : 'border-amber-500 text-amber-200'
  } else {
    cls += 'border-transparent text-slate-400 hover:text-slate-200'
  }
  return (
    <button onClick={onClick} disabled={disabled} className={cls}>
      {label}
    </button>
  )
}

// Tab state stored once at modal mount. The parent unmounts+remounts
// the modal on each button-click (open → close → re-open), so the
// `initial` value picked up here always reflects the latest button
// click — no useEffect needed to sync.
function useTabState(initial: 'fail' | 'action') {
  return useState<'fail' | 'action'>(initial)
}
