import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import {
  HelpCircle, FileText, FolderOpen, Wrench, ArrowUpCircle, ChevronRight,
} from 'lucide-react'
import { useWizard, type WizardStep, STEPS_NEEDING_SESSION } from './store/wizard.js'
import { useErrors, reportError } from './store/errors.js'
import { ToastTray } from './components/ToastTray.js'
import { TroubleshootingModal } from './components/TroubleshootingModal.js'
import { ScreenTransition } from './components/ScreenTransition.js'
import { useProfileAutosave } from './hooks/useProfileAutosave.js'
import { WelcomeScreen } from './screens/WelcomeScreen.js'
import { ConnectScreen } from './screens/ConnectScreen.js'
import { EnvDetectScreen } from './screens/EnvDetectScreen.js'
import { ConfigureScreen } from './screens/ConfigureScreen.js'
import { RunScreen } from './screens/RunScreen.js'
import { UpdateRunScreen } from './screens/UpdateRunScreen.js'
import { MigrateScreen } from './screens/MigrateScreen.js'
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

const MIGRATE_STEPS: { id: WizardStep; label: string }[] = [
  { id: 'welcome', label: 'Start' },
  { id: 'connect', label: 'Connect' },
  { id: 'migrate', label: 'Migrate' },
  { id: 'done',    label: 'Done' },
]

export function App() {
  const step = useWizard((s) => s.step)
  const mode = useWizard((s) => s.mode)
  const sessionId = useWizard((s) => s.sessionId)
  const activeProfileId = useWizard((s) => s.activeProfileId)
  const activeProfileLabel = useWizard((s) => s.activeProfileLabel)
  const setStep = useWizard((s) => s.setStep)
  const loadFromProfile = useWizard((s) => s.loadFromProfile)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [profileHydrated, setProfileHydrated] = useState(false)
  // Help modal — opens from the footer button. Opens to the full list
  // of troubleshooting entries, searchable + copy-to-clipboard. Useful
  // from any screen, hence wired here at App level rather than inside
  // a specific screen.
  const [helpOpen, setHelpOpen] = useState(false)
  const targetDir = useWizard((s) => s.targetDir)

  // On launch, the persist middleware restores {step, mode,
  // activeProfileId, activeProfileLabel}, but the connection / config /
  // targetDir come from the (encrypted) profile on disk. Hydrate them
  // now so the user lands on the right step with everything filled in,
  // rather than having to bounce back to Welcome and re-select.
  useEffect(() => {
    if (!activeProfileId || profileHydrated) return
    let cancelled = false
    ;(async () => {
      try {
        const p = await window.installer.profiles.load(activeProfileId)
        if (cancelled) return
        if (p) {
          loadFromProfile({
            id: p.id,
            label: p.label,
            connection: p.connection,
            config: p.config as Record<string, string>,
            targetDir: p.targetDir,
            migrate: p.migrate,
          })
        } else {
          // Profile referenced in persisted state was deleted on disk.
          // Bounce to Welcome so the user can pick a real one.
          useWizard.setState({
            activeProfileId: null,
            activeProfileLabel: null,
            step: 'welcome',
          })
        }
      } catch (e) {
        if (!cancelled) reportError('Hydrate profile', e)
      } finally {
        if (!cancelled) setProfileHydrated(true)
      }
    })()
    return () => { cancelled = true }
  }, [activeProfileId, profileHydrated, loadFromProfile])

  // Autosave per-profile changes whenever connection/config/targetDir
  // mutate. (No-op when activeProfileId is null.)
  useProfileAutosave()

  // Bounce back to a safe step when state is missing. Two cases:
  //   - any step past welcome but no profile selected → welcome
  //   - any step needing an SSH session but sessionId is null → connect
  // Without these, a persisted "step: 'run'" + cold start would leave
  // the user staring at "No SSH session" with no obvious recovery.
  //
  // Toast policy: don't blast a "Reconnect required" notice on every
  // cold-start bounce — the app was just launched, of course there's
  // no live SSH session yet, and the user is already being moved to
  // the Connect screen which makes that perfectly obvious. The toast
  // only adds value when the user was actively working in a session-
  // dependent step and the session DROPPED (e.g. SSH timeout mid-
  // install). We approximate that with a ref that flips true after
  // the first render — subsequent missing-session bounces are
  // "something changed under the user's feet," worth surfacing.
  const firstBounceRef = useRef(true)
  useEffect(() => {
    if (step !== 'welcome' && !activeProfileId) {
      setStep('welcome')
      return
    }
    if (STEPS_NEEDING_SESSION.includes(step) && !sessionId) {
      // Silent on the initial bounce (cold start / app reload).
      // Subsequent bounces mean a session expired mid-flight — toast.
      if (!firstBounceRef.current) {
        useErrors.getState().pushInfo(
          'Reconnect required',
          'Your SSH session expired. Bouncing back to Connect so you can reopen it.',
        )
      }
      setStep('connect')
    }
    firstBounceRef.current = false
  }, [step, activeProfileId, sessionId, setStep])

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

  // Watch every SSH stream close — fall-through safety net for any
  // channel that DOESN'T have a screen showing its exit status. The
  // streaming channels we run today are all owned by a screen:
  //   - setup-sh-main / setup-sh-rerun-*  → RunScreen (stepper + log)
  //   - compose-update                    → UpdateRunScreen (status bar)
  //   - post-deploy-validate              → DoneScreen (re-check button)
  // Those screens already render the exit code, the stepper colour,
  // and the streamed log — a toast on top is duplicate noise. Skip
  // toasts for those known IDs but keep the catch-all behaviour for
  // anything new added without UI, so a future regression doesn't
  // disappear silently.
  useEffect(() => {
    const off = window.installer.ssh.onStreamClose((d) => {
      if (d.exitCode == null || d.exitCode === 0) return
      const owned =
        d.channelId === 'setup-sh-main' ||
        d.channelId === 'compose-update' ||
        d.channelId === 'post-deploy-validate' ||
        d.channelId.startsWith('setup-sh-rerun-')
      if (owned) return  // The owning screen surfaces it; don't double up.
      useErrors.getState().pushWarn(
        `Remote command exited with code ${d.exitCode}`,
        `channel: ${d.channelId}${d.signal ? `\nsignal: ${d.signal}` : ''}`,
      )
    })
    return () => { off() }
  }, [])

  const stepList =
    mode === 'update'  ? UPDATE_STEPS
    : mode === 'migrate' ? MIGRATE_STEPS
    : INSTALL_STEPS

  return (
    <div className="h-full flex flex-col">
      {/* Drag region for the frameless title bar. The native window
          controls (minimize/maximize/close on Windows, traffic lights
          on macOS) are painted by the OS on top of this strip via
          titleBarOverlay / hiddenInset; everything below this bar is
          regular renderer content. On Linux we keep the native frame
          and this bar still works as a thin top accent. */}
      <div
        className="flex items-center select-none text-xs text-slate-400"
        style={{
          // @ts-expect-error — non-standard CSS property exposed by Electron
          WebkitAppRegion: 'drag',
          height: 36,
          background: '#020617',
          // macOS positions traffic lights at the top-left; reserve ~78px
          // so our app name doesn't disappear under them. Harmless extra
          // space on Windows/Linux.
          paddingLeft: /Mac/i.test(navigator.userAgent) ? 78 : 14,
          // Windows controls sit on the top-right (~138px wide on
          // standard DPI). Don't put anything clickable inside that band.
          paddingRight: 150,
        }}
      >
        <span className="font-medium tracking-wide text-slate-300">Mediarr Installer</span>
      </div>

      {info?.mock && (
        <div className="bg-amber-500/15 text-amber-200 border-b border-amber-500/30 text-xs px-4 py-1.5 text-center font-medium">
          MOCK MODE — SSH, SFTP, env detection, and NordVPN API are stubbed.
          No real NAS is contacted.
        </div>
      )}

      {/* Active profile pill — visible from every screen so the user
          always knows which NAS they're configuring. Click the
          "switch" link to bounce back to Welcome. Subtle gradient
          + monogram avatar make it feel like an identity, not a
          forgettable text strip. */}
      {activeProfileLabel && step !== 'welcome' && (
        <div className="flex items-center justify-center gap-2 border-b border-slate-900 px-4 py-1.5 bg-slate-950 text-xs">
          <div className="inline-flex items-center justify-center w-5 h-5 rounded bg-emerald-600/20 border border-emerald-600/30 text-emerald-200 text-[10px] font-bold uppercase">
            {activeProfileLabel.slice(0, 2)}
          </div>
          <span className="text-slate-500">Profile:</span>
          <span className="font-semibold text-slate-200">{activeProfileLabel}</span>
          <button
            type="button"
            onClick={() => setStep('welcome')}
            className="ml-2 text-emerald-400 hover:text-emerald-300 hover:underline transition-colors"
          >
            switch
          </button>
        </div>
      )}

      {/* Top stepper rail — every step is clickable for free-form
          navigation. Clicking a step that requires a session without
          one redirects to Connect via the App-level effect above. */}
      <nav className="flex items-center justify-center gap-2 border-b border-slate-800 px-4 py-3 bg-slate-900/50">
        {stepList.map((s, i) => {
          const idx = stepList.findIndex((x) => x.id === step)
          const state =
            i < idx ? 'done' : i === idx ? 'current' : 'pending'
          // Disable steps that aren't reachable yet:
          //  - any step past welcome needs a profile
          //  - session-required steps need an active SSH session
          const disabled =
            (s.id !== 'welcome' && !activeProfileId) ||
            (STEPS_NEEDING_SESSION.includes(s.id) && !sessionId)
          // Tailwind can't generate class names from interpolated
          // strings, so the two accent palettes are hand-spelled.
          const cls =
            state === 'current'
              ? (mode === 'update'
                  ? 'bg-sky-600 text-white font-medium'
                  : 'bg-emerald-600 text-white font-medium')
              : state === 'done'
              ? (mode === 'update'
                  ? 'bg-slate-700 text-sky-300 hover:bg-slate-600'
                  : 'bg-slate-700 text-emerald-300 hover:bg-slate-600')
              : disabled
              ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
              : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
          const isCurrent = state === 'current'
          return (
            <div key={s.id} className="flex items-center gap-2">
              <button
                type="button"
                disabled={disabled}
                onClick={() => setStep(s.id)}
                className={
                  // Bumped to py-2 + px-4 so the touch target is ≥40px tall
                  // (was 28px). Children + reduced-motor-precision users
                  // tap accurately ~75% more often above the 44px WCAG AAA
                  // target threshold; this is close enough without ruining
                  // the horizontal compactness of the rail on smaller
                  // window widths.
                  `flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-all ` +
                  `duration-200 ${cls} ` +
                  // The current step gets a subtle pulse-ring so the
                  // eye instantly finds it without having to compare
                  // text colors. Pulse pauses for reduced-motion users
                  // (Tailwind's animate-pulse uses opacity which the OS
                  // reduced-motion setting doesn't actually disable on
                  // its own, but a brief 1s pulse stop at scale-1.03 is
                  // mild enough that we leave it on as a focus aid).
                  (isCurrent ? 'ring-2 ring-offset-2 ring-offset-slate-950 ' +
                    (mode === 'update' ? 'ring-sky-400/60' : 'ring-emerald-400/60') : '')
                }
                title={disabled
                  ? (s.id !== 'welcome' && !activeProfileId
                    ? 'Select a profile first'
                    : 'Connect to your NAS first')
                  : `Go to ${s.label}`}
              >
                <span className="font-mono text-xs">{i + 1}</span>
                <span>{s.label}</span>
              </button>
              {/* Connector chevron transitions to green/blue as steps
                  complete behind it — gives a clear "we got past here"
                  cue without an explicit progress bar. Lucide
                  ChevronRight (vs the raw "›" glyph) renders at exact
                  same metrics across platforms, which matters because
                  the previous char was a tofu-prone single guillemet. */}
              {i < stepList.length - 1 && (
                <ChevronRight
                  size={14}
                  strokeWidth={2.5}
                  className={
                    'transition-colors duration-300 shrink-0 ' +
                    (state === 'done'
                      ? (mode === 'update' ? 'text-sky-400' : 'text-emerald-400')
                      : 'text-slate-700')
                  }
                />
              )}
            </div>
          )
        })}
      </nav>

      <main className="flex-1 min-h-0 overflow-hidden">
        {/* AnimatePresence + ScreenTransition give every step change a
            consistent fade-up entrance. mode="wait" means the leaving
            screen finishes its exit before the new one starts — keeps
            the layout stable and avoids two screens overlapping during
            the transition. */}
        <AnimatePresence mode="wait">
          <ScreenTransition screenKey={step}>
            {step === 'welcome'    && <WelcomeScreen />}
            {step === 'connect'    && <ConnectScreen />}
            {step === 'detect'     && <EnvDetectScreen />}
            {step === 'configure'  && <ConfigureScreen />}
            {step === 'run'        && <RunScreen />}
            {step === 'run-update' && <UpdateRunScreen />}
            {step === 'migrate'    && <MigrateScreen />}
            {step === 'done'       && <DoneScreen />}
          </ScreenTransition>
        </AnimatePresence>
      </main>

      {/* Footer with build info — handy for support */}
      {info && (
        <footer className="text-xs text-slate-500 px-4 py-1.5 border-t border-slate-900 flex justify-between items-center gap-3">
          <div className="flex items-center gap-2">
            <span>v{info.version}</span>
            {info.updateAvailable && (
              <a
                href={info.updateAvailable.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-700/50 text-emerald-100 hover:bg-emerald-600/60 font-medium transition-colors"
                title={`Click to open the v${info.updateAvailable.latest} release page on GitHub`}
              >
                <ArrowUpCircle size={11} />
                v{info.updateAvailable.latest} available
              </a>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-700/50 hover:bg-emerald-600/60 text-emerald-100 font-medium transition-colors"
              title="Common issues + the exact fix for each — searchable, copy-to-clipboard"
            >
              <HelpCircle size={12} />
              Help
            </button>
            <button
              type="button"
              onClick={() =>
                window.installer.app.openLog().then((r) => {
                  if (r.error) {
                    useErrors.getState().pushError(
                      'Could not open log file',
                      `${r.error}\n\nPath: ${r.path}`,
                    )
                  } else {
                    useErrors.getState().pushInfo('Log opened', r.path)
                  }
                }).catch((e) => reportError('Open log', e))
              }
              className="inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-800 hover:text-slate-200 transition-colors"
              title={info.logPath}
            >
              <FileText size={12} />
              Open log
            </button>
            <button
              type="button"
              onClick={() =>
                window.installer.app.showLogInFolder()
                  .catch((e) => reportError('Reveal log', e))
              }
              className="inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-800 hover:text-slate-200 transition-colors"
              title="Show the log file in your file manager"
            >
              <FolderOpen size={12} />
              Reveal
            </button>
            <button
              type="button"
              onClick={() =>
                window.installer.app.openDevTools()
                  .catch((e) => reportError('Open DevTools', e))
              }
              className="inline-flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-800 hover:text-slate-200 transition-colors"
              title="Toggle Chromium DevTools — only needed for debugging"
            >
              <Wrench size={12} />
              DevTools
            </button>
            <span className="font-mono opacity-60">
              payload: {info.payloadSha?.slice(0, 8) ?? 'dev'}
            </span>
          </div>
        </footer>
      )}

      {/* Global toast tray — anything that calls reportError() or pushes
          to useErrors() shows up here, on every screen. */}
      <ToastTray />

      {/* Troubleshooting / help modal — opens from the footer Help
          button. Renders nothing when closed; no perf cost. The
          AnimatePresence wrap lets the modal play its exit animation
          when the user closes it (backdrop fade + dialog scale-down). */}
      <AnimatePresence>
        {helpOpen && (
          <TroubleshootingModal
            installDir={targetDir}
            onClose={() => setHelpOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
