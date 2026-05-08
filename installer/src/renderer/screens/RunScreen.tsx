import { useEffect, useRef, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import { LogPanel, stripAnsi } from '../components/LogPanel.js'
import { LogActions } from '../components/LogActions.js'
import { renderEnv, type EnvFormValues } from '../../shared/env-render.js'
import { SETUP_STEPS, StepperRail, type SetupStep } from '../components/StepperRail.js'

type Phase =
  | 'idle'
  | 'uploading'
  | 'writing-env'
  | 'running-setup'
  | 'done'
  | 'failed'

const CHANNEL_ID = 'setup-sh-main'
const RERUN_CHANNEL_PREFIX = 'setup-sh-rerun-'

// setup.sh emits these markers in its run_step helper. We parse them
// from the streaming log to drive the StepperRail.
//
// Header (start of step):       │ Step 3: Apply firewall rules
// Footer (success):              ✔ Step 3 complete.
// Footer (failure):              ✘ Step 3 failed
const STEP_START_RE = /Step\s+(\d+):/
const STEP_OK_RE    = /✔\s*Step\s+(\d+)\s+complete/
const STEP_FAIL_RE  = /✘\s*Step\s+(\d+)\s+failed/

export function RunScreen() {
  const { sessionId, targetDir, config, setStep } = useWizard()
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<{ pct: number; file: string } | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const linesRef = useRef<string[]>([])
  const [steps, setSteps] = useState<SetupStep[]>(() =>
    SETUP_STEPS.map((s) => ({ ...s })),
  )
  const [rerunningStep, setRerunningStep] = useState<number | null>(null)
  const [, setTick] = useState(0) // force re-render on log append

  function resetSteps() {
    setSteps(SETUP_STEPS.map((s) => ({ ...s })))
  }

  function applyStepMarkers(newLines: string[]) {
    // Walk the new lines once and collect any state transitions we
    // observe, then commit a single setSteps update.
    const transitions: { idx: number; status: SetupStep['status'] }[] = []
    for (const raw of newLines) {
      const line = stripAnsi(raw)
      // Header lines look like:  "│ Step N: <description>"
      // The footer "✔ Step N complete." pattern is very similar — match
      // success/fail first so a "Step N complete" line isn't claimed by the
      // generic start matcher.
      const ok = line.match(STEP_OK_RE)
      if (ok) {
        transitions.push({ idx: Number(ok[1]) - 1, status: 'ok' })
        continue
      }
      const bad = line.match(STEP_FAIL_RE)
      if (bad) {
        transitions.push({ idx: Number(bad[1]) - 1, status: 'fail' })
        continue
      }
      const start = line.match(STEP_START_RE)
      if (start && line.includes('│')) {
        transitions.push({ idx: Number(start[1]) - 1, status: 'running' })
        continue
      }
    }
    if (transitions.length === 0) return
    setSteps((prev) => {
      const next = prev.map((s) => ({ ...s }))
      for (const t of transitions) {
        if (t.idx >= 0 && t.idx < next.length) next[t.idx].status = t.status
      }
      return next
    })
  }

  function appendChunk(text: string) {
    // PTY chunks may straddle line boundaries. Concatenate the leading
    // piece onto the previous line, then push any complete new lines.
    const parts = text.split(/\r?\n/)
    const newlyCompleted: string[] = []

    if (linesRef.current.length === 0) {
      // First chunk: every part except the trailing partial is "complete".
      linesRef.current.push(...parts)
      for (let i = 0; i < parts.length - 1; i++) newlyCompleted.push(parts[i])
    } else {
      // The first part extends the prior trailing line.
      linesRef.current[linesRef.current.length - 1] += parts[0]
      // Any additional parts are new lines; the prior trailing line
      // is now finalised and the new lines after it are complete except
      // for the very last (which may itself be a trailing partial).
      if (parts.length > 1) {
        // The previously-trailing line just got terminated.
        newlyCompleted.push(linesRef.current[linesRef.current.length - 1])
        for (let i = 1; i < parts.length - 1; i++) {
          linesRef.current.push(parts[i])
          newlyCompleted.push(parts[i])
        }
        linesRef.current.push(parts[parts.length - 1])
      }
    }

    // Cap memory.
    if (linesRef.current.length > 20_000) {
      linesRef.current.splice(0, linesRef.current.length - 20_000)
    }

    if (newlyCompleted.length > 0) applyStepMarkers(newlyCompleted)
    setTick((t) => t + 1)
  }

  useEffect(() => {
    if (!sessionId) return
    const offData = window.installer.ssh.onStreamData((d) => {
      // Forward both the main install stream and any per-step re-runs
      // into the same log buffer.
      if (d.channelId !== CHANNEL_ID && !d.channelId.startsWith(RERUN_CHANNEL_PREFIX)) return
      appendChunk(d.chunk)
    })
    const offClose = window.installer.ssh.onStreamClose((d) => {
      if (d.channelId === CHANNEL_ID) {
        setExitCode(d.exitCode)
        setPhase(d.exitCode === 0 ? 'done' : 'failed')
        // Any remaining "running" steps after a clean exit are implicitly ok.
        // After a failed exit, the failed step already got marked fail by
        // the marker parser; leave others alone.
        if (d.exitCode === 0) {
          setSteps((prev) =>
            prev.map((s) => (s.status === 'running' ? { ...s, status: 'ok' } : s)),
          )
        }
        return
      }
      if (d.channelId.startsWith(RERUN_CHANNEL_PREFIX)) {
        const stepNumber = Number(d.channelId.slice(RERUN_CHANNEL_PREFIX.length))
        setRerunningStep(null)
        // The transcript lines themselves carry "✔ Step N complete." or
        // "✘ Step N failed" which the marker parser already handled. As
        // a safety net, force the step to ok/fail based on exit code.
        setSteps((prev) => prev.map((s) =>
          s.number === stepNumber
            ? { ...s, status: d.exitCode === 0 ? 'ok' : 'fail' }
            : s,
        ))
      }
    })
    const offProg = window.installer.sftp.onProgress((p) => {
      setProgress({ pct: p.pctOverall, file: p.file })
    })
    return () => {
      offData()
      offClose()
      offProg()
    }
  }, [sessionId])

  async function rerunStep(stepNumber: number) {
    if (!sessionId || rerunningStep !== null) return
    const step = steps.find((s) => s.number === stepNumber)
    if (!step?.rerun) return

    setRerunningStep(stepNumber)
    setSteps((prev) =>
      prev.map((s) => (s.number === stepNumber ? { ...s, status: 'running' } : s)),
    )

    // Echo a small banner into the log so the user can find this re-run later.
    const banner = `\n--- Re-running step ${stepNumber}: ${step.label} ---\n`
    appendChunk(banner)

    try {
      await window.installer.ssh.execStream({
        sessionId,
        cmd: `cd ${shellQuote(targetDir)} && ${step.rerun}`,
        sudo: true,
        channelId: `${RERUN_CHANNEL_PREFIX}${stepNumber}`,
      })
    } catch (e) {
      appendChunk(`\nRe-run error: ${(e as Error).message}\n`)
      setRerunningStep(null)
      setSteps((prev) =>
        prev.map((s) => (s.number === stepNumber ? { ...s, status: 'fail' } : s)),
      )
    }
  }

  async function go() {
    if (!sessionId) {
      setErrorMsg('No SSH session. Go back and reconnect.')
      setPhase('failed')
      return
    }
    setErrorMsg(null)
    linesRef.current = []
    resetSteps()
    setTick((t) => t + 1)

    try {
      // 1. Make sure the target dir exists, then upload the payload.
      setPhase('uploading')
      await window.installer.ssh.exec({
        sessionId,
        cmd: `mkdir -p ${shellQuote(targetDir)}`,
        sudo: true,
      })

      // The renderer can't read disk. We pass the sentinel "@payload" and
      // the main process's sftp-service resolves it via payload-resolver.
      // Renderer never learns absolute filesystem paths.
      await window.installer.sftp.uploadDir({
        sessionId,
        localDir: '@payload',
        remoteDir: targetDir,
      })

      // 2. Write the .env file with secrets.
      setPhase('writing-env')
      const envText = renderEnv(config as EnvFormValues)
      await window.installer.sftp.writeFile({
        sessionId,
        remotePath: `${targetDir}/.env`,
        content: envText,
        mode: 0o600,
      })

      // 3. Stream-run setup.sh. The exit code arrives via the stream-close
      // event handled in useEffect, which advances the phase.
      setPhase('running-setup')
      await window.installer.ssh.execStream({
        sessionId,
        cmd: `bash ${shellQuote(`${targetDir}/setup.sh`)}`,
        sudo: true,
        channelId: CHANNEL_ID,
      })
    } catch (e) {
      setErrorMsg((e as Error).message)
      setPhase('failed')
    }
  }

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Installing the stack</h1>
        <div className="flex items-center gap-3">
          {linesRef.current.length > 0 && (
            <LogActions
              lines={linesRef.current}
              defaultName="nas-arr-install.log"
              header={`exit=${exitCode ?? 'pending'} phase=${phase}`}
            />
          )}
          <div className="text-sm text-slate-400">
            {phase === 'idle' && 'Ready'}
            {phase === 'uploading' && `Uploading files... ${progress?.pct ?? 0}%`}
            {phase === 'writing-env' && 'Writing .env'}
            {phase === 'running-setup' && 'Running setup.sh'}
            {phase === 'done' && 'Setup complete'}
            {phase === 'failed' && (errorMsg ? `Failed: ${errorMsg}` : `Setup exited ${exitCode}`)}
          </div>
        </div>
      </header>

      {phase === 'uploading' && progress && (
        <div className="w-full bg-slate-800 rounded h-2 overflow-hidden">
          <div className="h-2 bg-emerald-500 transition-all" style={{ width: `${progress.pct}%` }} />
        </div>
      )}

      {/* Two-pane: stepper rail on the left, streaming log on the right */}
      <div className="flex-1 min-h-0 grid grid-cols-[260px_1fr] gap-4">
        <aside className="overflow-y-auto rounded-md border border-slate-800 bg-slate-900/40 p-4">
          <h2 className="text-xs uppercase tracking-wide text-slate-400 mb-3">
            setup.sh steps
          </h2>
          <StepperRail
            steps={steps}
            onRerun={phase === 'done' || phase === 'failed' ? rerunStep : undefined}
            rerunningStep={rerunningStep}
          />
          {(phase === 'done' || phase === 'failed') && (
            <p className="mt-3 text-xs text-slate-500">
              Hover a finished step to re-run it. Each script is idempotent.
            </p>
          )}
        </aside>
        <div className="min-h-0">
          <LogPanel lines={linesRef.current} />
        </div>
      </div>

      <div className="flex justify-between">
        <button
          onClick={() => setStep('configure')}
          disabled={phase === 'uploading' || phase === 'running-setup'}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
        >
          Back
        </button>
        {phase === 'idle' || phase === 'failed' ? (
          <button
            onClick={go}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md"
          >
            {phase === 'failed' ? 'Retry' : 'Start'}
          </button>
        ) : phase === 'done' ? (
          <button
            onClick={() => setStep('done')}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md"
          >
            Continue
          </button>
        ) : null}
      </div>
    </div>
  )
}

// Shell-quote for embedding into a remote bash command.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
