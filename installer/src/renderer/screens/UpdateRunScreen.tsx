// Update Stack flow: skip detect+configure entirely. Just connect, run
// `docker compose pull && docker compose up -d` in the target dir, show
// the streaming output, mark done.

import { useEffect, useRef, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import { LogPanel } from '../components/LogPanel.js'
import { LogActions } from '../components/LogActions.js'
import { PATH_PREFIX } from '../../shared/synology-path.js'
import { reportError } from '../store/errors.js'

const CHANNEL_ID = 'compose-update'

type Phase = 'idle' | 'running' | 'done' | 'failed'

export function UpdateRunScreen() {
  const { sessionId, targetDir, setStep } = useWizard()
  const [phase, setPhase] = useState<Phase>('idle')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const linesRef = useRef<string[]>([])
  const [, setTick] = useState(0)

  function appendChunk(text: string) {
    // pty:true gives us "\r\n" line endings (ONLCR mode); normalize so
    // we don't accidentally treat the '\r' as a docker-style redraw.
    text = text.replace(/\r\n/g, '\n')
    const parts = text.split('\n')
    if (linesRef.current.length === 0) {
      linesRef.current.push(...parts)
    } else {
      linesRef.current[linesRef.current.length - 1] += parts[0]
      for (let i = 1; i < parts.length; i++) linesRef.current.push(parts[i])
    }
    if (linesRef.current.length > 10_000) {
      linesRef.current.splice(0, linesRef.current.length - 10_000)
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
    return () => { offData(); offClose() }
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
    setPhase('running')
    try {
      await window.installer.ssh.execStream({
        sessionId,
        cmd: PATH_PREFIX + `cd ${shellQuote(targetDir)} && docker compose pull && docker compose up -d`,
        sudo: true,
        channelId: CHANNEL_ID,
      })
    } catch (e) {
      setErrorMsg((e as Error).message)
      setPhase('failed')
      reportError('Update', e)
    }
  }

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Update existing stack</h1>
          <p className="text-sm text-slate-400 mt-1">
            Pulls newer images and recreates containers in
            <code className="font-mono bg-slate-800 px-1 rounded mx-1">{targetDir}</code>.
            Your <code className="font-mono bg-slate-800 px-1 rounded">.env</code> and config
            volumes are untouched.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {linesRef.current.length > 0 && (
            <LogActions
              lines={linesRef.current}
              defaultName="mediarr-update.log"
              header={`exit=${exitCode ?? 'pending'} phase=${phase}`}
            />
          )}
          <div className="text-sm text-slate-400">
            {phase === 'idle' && 'Ready'}
            {phase === 'running' && 'Pulling images...'}
            {phase === 'done' && 'Update complete'}
            {phase === 'failed' && (errorMsg ? `Failed: ${errorMsg}` : `Exited ${exitCode}`)}
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0">
        <LogPanel lines={linesRef.current} />
      </div>

      <div className="flex justify-between">
        <button
          onClick={() => setStep('welcome')}
          disabled={phase === 'running'}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
        >
          Back to start
        </button>
        {phase === 'idle' || phase === 'failed' ? (
          <button
            onClick={go}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 rounded-md"
          >
            {phase === 'failed' ? 'Retry' : 'Pull and recreate'}
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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
