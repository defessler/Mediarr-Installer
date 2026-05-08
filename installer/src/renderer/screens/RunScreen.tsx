import { useEffect, useRef, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import { LogPanel, stripAnsi } from '../components/LogPanel.js'
import { renderEnv, type EnvFormValues } from '../../shared/env-render.js'

type Phase =
  | 'idle'
  | 'uploading'
  | 'writing-env'
  | 'running-setup'
  | 'done'
  | 'failed'

const CHANNEL_ID = 'setup-sh-main'

export function RunScreen() {
  const { sessionId, targetDir, config, setStep } = useWizard()
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<{ pct: number; file: string } | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const linesRef = useRef<string[]>([])
  const [, setTick] = useState(0) // force re-render on log append

  function appendChunk(text: string) {
    // PTY chunks may straddle line boundaries. Concatenate the leading
    // piece onto the previous line, then push any complete new lines.
    const parts = text.split(/\r?\n/)
    if (linesRef.current.length === 0) {
      linesRef.current.push(...parts)
    } else {
      linesRef.current[linesRef.current.length - 1] += parts[0]
      for (let i = 1; i < parts.length; i++) {
        linesRef.current.push(parts[i])
      }
    }
    // Cap memory. Setup output is usually a few thousand lines, but
    // pathological cases (an image pull stuck retrying) could spam.
    if (linesRef.current.length > 20_000) {
      linesRef.current.splice(0, linesRef.current.length - 20_000)
    }
    setTick((t) => t + 1)
  }

  useEffect(() => {
    if (!sessionId) return
    const offData = window.installer.ssh.onStreamData((d) => {
      if (d.channelId !== CHANNEL_ID) return
      appendChunk(d.chunk)
    })
    const offClose = window.installer.ssh.onStreamClose((d) => {
      if (d.channelId !== CHANNEL_ID) return
      setExitCode(d.exitCode)
      setPhase(d.exitCode === 0 ? 'done' : 'failed')
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

  async function go() {
    if (!sessionId) {
      setErrorMsg('No SSH session. Go back and reconnect.')
      setPhase('failed')
      return
    }
    setErrorMsg(null)
    linesRef.current = []
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
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Installing the stack</h1>
        <div className="text-sm text-slate-400">
          {phase === 'idle' && 'Ready'}
          {phase === 'uploading' && `Uploading files... ${progress?.pct ?? 0}%`}
          {phase === 'writing-env' && 'Writing .env'}
          {phase === 'running-setup' && 'Running setup.sh'}
          {phase === 'done' && 'Setup complete'}
          {phase === 'failed' && (errorMsg ? `Failed: ${errorMsg}` : `Setup exited ${exitCode}`)}
        </div>
      </header>

      {phase === 'uploading' && progress && (
        <div className="w-full bg-slate-800 rounded h-2 overflow-hidden">
          <div className="h-2 bg-emerald-500 transition-all" style={{ width: `${progress.pct}%` }} />
        </div>
      )}

      <div className="flex-1 min-h-0">
        <LogPanel lines={linesRef.current.map(stripAnsi)} />
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
