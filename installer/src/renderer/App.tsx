import { useEffect, useState } from 'react'
import { useWizard, type WizardStep } from './store/wizard.js'
import { useErrors, reportError } from './store/errors.js'
import { ToastTray } from './components/ToastTray.js'
import { WelcomeScreen } from './screens/WelcomeScreen.js'
import { ConnectScreen } from './screens/ConnectScreen.js'
import { EnvDetectScreen } from './screens/EnvDetectScreen.js'
import { ConfigureScreen } from './screens/ConfigureScreen.js'
import { RunScreen } from './screens/RunScreen.js'
import { UpdateRunScreen } from './screens/UpdateRunScreen.js'
import { DoneScreen } from './screens/DoneScreen.js'
import type { AppInfo } from '../shared/ipc.js'

// Stepper labels for the install flow. The update flow uses a 3-step
// reduced rail (Welcome -> Connect -> Update -> Done).
const INSTALL_STEPS: { id: WizardStep; label: string }[] = [
  { id: 'welcome',   label: 'Start' },
  { id: 'connect',   label: 'Connect' },
  { id: 'detect',    label: 'Detect' },
  { id: 'configure', label: 'Configure' },
  { id: 'run',       label: 'Install' },
  { id: 'done',      label: 'Done' },
]

const UPDATE_STEPS: { id: WizardStep; label: string }[] = [
  { id: 'welcome',    label: 'Start' },
  { id: 'connect',    label: 'Connect' },
  { id: 'run-update', label: 'Update' },
  { id: 'done',       label: 'Done' },
]

export function App() {
  const step = useWizard((s) => s.step)
  const mode = useWizard((s) => s.mode)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    window.installer.app.getInfo().then(setInfo).catch((e) =>
      reportError('App info', e),
    )
  }, [])

  // Catch-all surface for anything that escapes a try/catch in any
  // renderer code path. Without these, a bad async chain just disappears
  // into devtools and the user sees a frozen UI with no explanation.
  useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      reportError('Unhandled error', e.error ?? e.message)
    }
    const onRej = (e: PromiseRejectionEvent) => {
      reportError('Unhandled promise rejection', e.reason)
    }
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)
    return () => {
      window.removeEventListener('error', onErr)
      window.removeEventListener('unhandledrejection', onRej)
    }
  }, [])

  // Watch every SSH stream close — if a remote command exits non-zero
  // and the screen that owns the stream doesn't surface the error, the
  // toast guarantees the user still sees it.
  useEffect(() => {
    const off = window.installer.ssh.onStreamClose((d) => {
      if (d.exitCode != null && d.exitCode !== 0) {
        useErrors.getState().pushWarn(
          `Remote command exited with code ${d.exitCode}`,
          `channel: ${d.channelId}${d.signal ? `\nsignal: ${d.signal}` : ''}`,
        )
      }
    })
    return () => { off() }
  }, [])

  const stepList = mode === 'update' ? UPDATE_STEPS : INSTALL_STEPS

  return (
    <div className="h-full flex flex-col">
      {info?.mock && (
        <div className="bg-amber-500/15 text-amber-200 border-b border-amber-500/30 text-xs px-4 py-1.5 text-center font-medium">
          MOCK MODE — SSH, SFTP, env detection, and NordVPN API are stubbed.
          No real NAS is contacted.
        </div>
      )}

      {/* Top stepper rail */}
      <nav className="flex items-center justify-center gap-2 border-b border-slate-800 px-4 py-3 bg-slate-900/50">
        {stepList.map((s, i) => {
          const idx = stepList.findIndex((x) => x.id === step)
          const myIdx = i
          const state =
            myIdx < idx ? 'done' : myIdx === idx ? 'current' : 'pending'
          return (
            <div key={s.id} className="flex items-center gap-2">
              <div
                className={
                  state === 'current'
                    ? `flex items-center gap-2 px-3 py-1 rounded-full text-white text-sm font-medium ${mode === 'update' ? 'bg-sky-600' : 'bg-emerald-600'}`
                    : state === 'done'
                    ? `flex items-center gap-2 px-3 py-1 rounded-full bg-slate-700 text-sm ${mode === 'update' ? 'text-sky-300' : 'text-emerald-300'}`
                    : 'flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 text-slate-500 text-sm'
                }
              >
                <span className="font-mono text-xs">{i + 1}</span>
                <span>{s.label}</span>
              </div>
              {i < stepList.length - 1 && <span className="text-slate-700">›</span>}
            </div>
          )
        })}
      </nav>

      <main className="flex-1 min-h-0 overflow-hidden">
        {step === 'welcome'    && <WelcomeScreen />}
        {step === 'connect'    && <ConnectScreen />}
        {step === 'detect'     && <EnvDetectScreen />}
        {step === 'configure'  && <ConfigureScreen />}
        {step === 'run'        && <RunScreen />}
        {step === 'run-update' && <UpdateRunScreen />}
        {step === 'done'       && <DoneScreen />}
      </main>

      {/* Footer with build info — handy for support */}
      {info && (
        <footer className="text-xs text-slate-600 px-4 py-1.5 border-t border-slate-900 flex justify-between">
          <span>v{info.version}</span>
          <span className="font-mono">
            payload: {info.payloadSha?.slice(0, 8) ?? 'dev'}
          </span>
        </footer>
      )}

      {/* Global toast tray — anything that calls reportError() or pushes
          to useErrors() shows up here, on every screen. */}
      <ToastTray />
    </div>
  )
}
