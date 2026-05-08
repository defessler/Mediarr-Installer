// Vertical stepper for the install run. Reflects the 10 numbered steps
// emitted by nas/setup.sh. Status is driven by parsing the live log
// stream — see applyStepMarkers in RunScreen.

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

export function StepperRail({ steps, onRerun, rerunningStep }: Props) {
  return (
    <ol className="space-y-1.5">
      {steps.map((s) => {
        const dot =
          s.status === 'ok' ? 'bg-emerald-400'
          : s.status === 'fail' ? 'bg-rose-400'
          : s.status === 'running' ? 'bg-amber-400 animate-pulse'
          : 'bg-slate-700'
        const text =
          s.status === 'ok' ? 'text-slate-300'
          : s.status === 'fail' ? 'text-rose-300'
          : s.status === 'running' ? 'text-slate-100 font-medium'
          : 'text-slate-500'
        const showRerun = onRerun && (s.status === 'ok' || s.status === 'fail') && s.rerun
        const isRerunning = rerunningStep === s.number
        return (
          <li key={s.number} className={`flex items-center gap-2 text-sm group ${text}`}>
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${dot}`}
              aria-hidden
            />
            <span className="font-mono text-xs w-5 text-right text-slate-500 shrink-0">
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
                  'shrink-0 text-xs px-1.5 py-0.5 rounded transition-opacity ' +
                  (isRerunning
                    ? 'bg-amber-700/50 text-amber-200 opacity-100'
                    : 'bg-slate-700 hover:bg-slate-600 text-slate-300 opacity-0 group-hover:opacity-100 disabled:opacity-30')
                }
              >
                {isRerunning ? '...' : '↻'}
              </button>
            )}
          </li>
        )
      })}
    </ol>
  )
}
