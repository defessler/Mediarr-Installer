// Vertical stepper for the install run. Reflects the 10 numbered steps
// emitted by nas/setup.sh. Status is driven by parsing the live log
// stream — see updateStepsFromLog in RunScreen.

export type StepStatus = 'pending' | 'running' | 'ok' | 'fail'

export interface SetupStep {
  number: number
  label: string
  status: StepStatus
}

// Mirrors the 10 steps in nas/setup.sh in order. Labels copied verbatim
// from the script so a future renumbering breaks loudly here.
export const SETUP_STEPS: SetupStep[] = [
  { number: 1,  label: 'Set file permissions',                    status: 'pending' },
  { number: 2,  label: 'Create data and config directories',      status: 'pending' },
  { number: 3,  label: 'Apply firewall rules',                    status: 'pending' },
  { number: 4,  label: 'Fetch NordVPN WireGuard key',             status: 'pending' },
  { number: 5,  label: 'Validate configuration',                  status: 'pending' },
  { number: 6,  label: 'Start the stack',                         status: 'pending' },
  { number: 7,  label: 'Configure all services',                  status: 'pending' },
  { number: 8,  label: 'Add Prowlarr indexers',                   status: 'pending' },
  { number: 9,  label: 'Enable Bazarr subtitle providers',        status: 'pending' },
  { number: 10, label: 'Verify stack health',                     status: 'pending' },
]

export function StepperRail({ steps }: { steps: SetupStep[] }) {
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
        return (
          <li key={s.number} className={`flex items-center gap-3 text-sm ${text}`}>
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${dot}`}
              aria-hidden
            />
            <span className="font-mono text-xs w-5 text-right text-slate-500 shrink-0">
              {s.number}
            </span>
            <span className="truncate">{s.label}</span>
          </li>
        )
      })}
    </ol>
  )
}
