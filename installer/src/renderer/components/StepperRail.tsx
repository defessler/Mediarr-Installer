// Vertical stepper for the install run. Reflects the 10 numbered steps
// emitted by nas/setup.sh. Status is driven by parsing the live log
// stream — see applyStepMarkers in RunScreen.
//
// Visual design notes:
// - Status icons replace coloured dots. A check / spinner / X glyph
//   carries more information at smaller sizes than a plain dot, and
//   children read meaning into shapes much faster than colour cues
//   (also helps colour-blind users).
// - Running step gets a subtle background highlight to anchor the eye
//   without making the surrounding pending steps feel "wrong" by
//   contrast (which a brighter pulse would).
// - Status changes animate via Motion's layout animation: when a
//   pending step becomes running, the highlight expands into place
//   rather than appearing instantly — small motion that matches the
//   user's progress feeling.

import { motion, useReducedMotion } from 'motion/react'
import { Check, X, Loader2, Circle, RotateCw } from 'lucide-react'

export type StepStatus = 'pending' | 'running' | 'ok' | 'fail'

export interface SetupStep {
  number: number
  label: string
  status: StepStatus
  /** Re-runnable command relative to targetDir. Empty means the step
   *  isn't independently re-runnable and the rerun button is hidden. */
  rerun: string
}

// Mirrors the 10 steps in nas/setup.sh in order. Labels copied verbatim
// from the script so a future renumbering breaks loudly here. The rerun
// commands map each step back to the script setup.sh would have run.
export const SETUP_STEPS: SetupStep[] = [
  { number: 1,  label: 'Set file permissions',                    status: 'pending', rerun: 'bash setup-chmod.sh' },
  { number: 2,  label: 'Create data and config directories',      status: 'pending', rerun: 'bash setup-folders.sh' },
  { number: 3,  label: 'Apply firewall rules',                    status: 'pending', rerun: 'bash setup-firewall.sh' },
  { number: 4,  label: 'Fetch NordVPN WireGuard key',             status: 'pending', rerun: 'bash setup-nordvpn.sh' },
  { number: 5,  label: 'Validate configuration',                  status: 'pending', rerun: 'bash setup-validate.sh' },
  { number: 6,  label: 'Start the stack',                         status: 'pending', rerun: 'docker compose up -d' },
  { number: 7,  label: 'Configure all services',                  status: 'pending', rerun: 'python3 setup-arr-config.py' },
  { number: 8,  label: 'Add Prowlarr indexers',                   status: 'pending', rerun: 'python3 indexers/setup-indexers.py' },
  { number: 9,  label: 'Enable Bazarr subtitle providers',        status: 'pending', rerun: 'python3 indexers/setup-bazarr-providers.py' },
  { number: 10, label: 'Verify stack health',                     status: 'pending', rerun: 'bash post-deploy-validate.sh' },
]

interface Props {
  steps: SetupStep[]
  /** When provided, each row that's `ok` or `fail` shows a small re-run
   *  button. Disable while a re-run is already in flight. */
  onRerun?: (stepNumber: number) => void
  rerunningStep?: number | null
}

interface StatusIconProps {
  status: StepStatus
  size?: number
}

function StatusIcon({ status, size = 16 }: StatusIconProps) {
  if (status === 'ok') {
    return <Check size={size} className="text-emerald-400" strokeWidth={3} />
  }
  if (status === 'fail') {
    return <X size={size} className="text-rose-400" strokeWidth={3} />
  }
  if (status === 'running') {
    return <Loader2 size={size} className="text-amber-300 animate-spin" strokeWidth={2.5} />
  }
  return <Circle size={size} className="text-slate-700" strokeWidth={2} fill="currentColor" />
}

export function StepperRail({ steps, onRerun, rerunningStep }: Props) {
  const reduced = useReducedMotion()
  return (
    <ol className="space-y-1" aria-label="Install steps">
      {steps.map((s) => {
        const text =
          s.status === 'ok' ? 'text-slate-300'
          : s.status === 'fail' ? 'text-rose-300'
          : s.status === 'running' ? 'text-slate-50 font-semibold'
          : 'text-slate-500'
        const showRerun = onRerun && (s.status === 'ok' || s.status === 'fail') && s.rerun
        const isRerunning = rerunningStep === s.number
        // aria-current marks the active step for screen readers — same
        // semantic as visual "this is happening right now."
        const ariaCurrent: 'step' | undefined = s.status === 'running' ? 'step' : undefined
        const ariaLabel = `Step ${s.number} of ${steps.length}: ${s.label} — ${
          s.status === 'ok' ? 'complete'
          : s.status === 'fail' ? 'failed'
          : s.status === 'running' ? 'in progress'
          : 'pending'
        }`
        return (
          <li
            key={s.number}
            className={`relative group ${text}`}
            aria-current={ariaCurrent}
            aria-label={ariaLabel}
          >
            {/* Running-step background highlight. layoutId tells Motion
                to share a single highlight DOM element across rows so
                it slides between steps as they progress — a cheap but
                very satisfying touch that gives the impression of
                "progress moving through the list." */}
            {s.status === 'running' && (
              <motion.div
                layoutId={reduced ? undefined : 'stepper-highlight'}
                className="absolute inset-0 rounded-md bg-amber-500/10 border border-amber-500/30"
                transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              />
            )}
            <div className="relative flex items-center gap-3 px-2 py-2 text-sm">
              <div className="w-5 h-5 flex items-center justify-center shrink-0">
                <StatusIcon status={s.status} />
              </div>
              <span className="font-mono text-xs w-5 text-right text-slate-500 shrink-0 tabular-nums">
                {s.number}
              </span>
              <span className="truncate flex-1">{s.label}</span>
              {showRerun && (
                <button
                  type="button"
                  onClick={() => onRerun!(s.number)}
                  disabled={!!rerunningStep}
                  title={`Re-run step ${s.number}: ${s.rerun}`}
                  className={
                    // Always-visible at low opacity (was opacity-0 + hover-only,
                    // which hid it from touch users and didn't communicate
                    // discoverability to anyone who didn't already know the
                    // feature existed). Full opacity on hover / focus / running.
                    'shrink-0 inline-flex items-center justify-center h-6 w-6 rounded transition-all ' +
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 ' +
                    (isRerunning
                      ? 'bg-amber-700/50 text-amber-200 opacity-100'
                      : 'bg-slate-700/70 hover:bg-slate-600 focus-visible:bg-slate-600 text-slate-300 ' +
                        'opacity-50 group-hover:opacity-100 focus-visible:opacity-100 ' +
                        'disabled:opacity-25 disabled:hover:bg-slate-700/70')
                  }
                >
                  <RotateCw
                    size={12}
                    className={isRerunning ? 'animate-spin' : ''}
                    strokeWidth={2.5}
                  />
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
