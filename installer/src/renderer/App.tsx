import { useWizard, type WizardStep } from './store/wizard.js'
import { ConnectScreen } from './screens/ConnectScreen.js'
import { EnvDetectScreen } from './screens/EnvDetectScreen.js'
import { ConfigureScreen } from './screens/ConfigureScreen.js'
import { RunScreen } from './screens/RunScreen.js'
import { DoneScreen } from './screens/DoneScreen.js'

const STEPS: { id: WizardStep; label: string }[] = [
  { id: 'connect',   label: 'Connect' },
  { id: 'detect',    label: 'Detect' },
  { id: 'configure', label: 'Configure' },
  { id: 'run',       label: 'Install' },
  { id: 'done',      label: 'Done' },
]

export function App() {
  const step = useWizard((s) => s.step)

  return (
    <div className="h-full flex flex-col">
      {/* Top stepper rail */}
      <nav className="flex items-center justify-center gap-2 border-b border-slate-800 px-4 py-3 bg-slate-900/50">
        {STEPS.map((s, i) => {
          const idx = STEPS.findIndex((x) => x.id === step)
          const myIdx = i
          const state =
            myIdx < idx ? 'done' : myIdx === idx ? 'current' : 'pending'
          return (
            <div key={s.id} className="flex items-center gap-2">
              <div
                className={
                  state === 'current'
                    ? 'flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-600 text-white text-sm font-medium'
                    : state === 'done'
                    ? 'flex items-center gap-2 px-3 py-1 rounded-full bg-slate-700 text-emerald-300 text-sm'
                    : 'flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 text-slate-500 text-sm'
                }
              >
                <span className="font-mono text-xs">{i + 1}</span>
                <span>{s.label}</span>
              </div>
              {i < STEPS.length - 1 && <span className="text-slate-700">›</span>}
            </div>
          )
        })}
      </nav>

      <main className="flex-1 min-h-0 overflow-hidden">
        {step === 'connect'   && <ConnectScreen />}
        {step === 'detect'    && <EnvDetectScreen />}
        {step === 'configure' && <ConfigureScreen />}
        {step === 'run'       && <RunScreen />}
        {step === 'done'      && <DoneScreen />}
      </main>
    </div>
  )
}
