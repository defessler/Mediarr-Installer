import { useEffect, useRef, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import { LogPanel, stripAnsi } from '../components/LogPanel.js'
import { LogActions } from '../components/LogActions.js'
import { PATH_PREFIX } from '../../shared/synology-path.js'
import { reportError } from '../store/errors.js'

const SERVICES: { name: string; port: string; note?: string }[] = [
  { name: 'Homepage',    port: '3000',  note: 'Start here' },
  { name: 'Plex',        port: '32400/web' },
  { name: 'Sonarr',      port: '49152' },
  { name: 'Radarr',      port: '49151' },
  { name: 'Lidarr',      port: '49154' },
  { name: 'Prowlarr',    port: '49150' },
  { name: 'Bazarr',      port: '49153' },
  { name: 'SABnzbd',     port: '49155' },
  { name: 'qBittorrent', port: '49156' },
  { name: 'Seerr',       port: '5056' },
  { name: 'Tautulli',    port: '8181' },
  { name: 'Flaresolverr', port: '8191' },
]

type ServiceHealth = 'unknown' | 'ok' | 'fail'
const VALIDATE_CHANNEL = 'post-deploy-validate'

export function DoneScreen() {
  const { config, sessionId, targetDir, reset } = useWizard()
  const ip = config.LAN_IP ?? '<NAS-IP>'

  const [running, setRunning] = useState(false)
  const [exit, setExit] = useState<number | null>(null)
  const linesRef = useRef<string[]>([])
  const [, setTick] = useState(0)
  const [health, setHealth] = useState<Record<string, ServiceHealth>>({})

  function appendChunk(text: string) {
    // pty:true → ONLCR converts '\n' to '\r\n' on the wire. Normalize
    // before splitting so a trailing '\r' isn't mistaken for a docker
    // progress redraw.
    text = text.replace(/\r\n/g, '\n')
    const parts = text.split('\n')
    if (linesRef.current.length === 0) {
      linesRef.current.push(...parts)
    } else {
      linesRef.current[linesRef.current.length - 1] += parts[0]
      for (let i = 1; i < parts.length; i++) linesRef.current.push(parts[i])
    }

    // Update per-service health by scanning each new complete line for the
    // patterns post-deploy-validate.sh emits:
    //   "  ✔ Homepage (http://...) — HTTP 200"
    //   "  ✘ Sonarr (http://...) — HTTP 000 (not reachable)"
    setHealth((cur) => {
      const next = { ...cur }
      for (const line of parts) {
        const clean = stripAnsi(line)
        for (const svc of SERVICES) {
          // Anchored on the URL check lines only — ignore "container running" lines
          // so a healthy container with an unreachable WebUI doesn't register as ok.
          if (clean.includes(`${svc.name} (http`)) {
            if (clean.includes('✔')) next[svc.name] = 'ok'
            else if (clean.includes('✘')) next[svc.name] = 'fail'
          }
        }
      }
      return next
    })

    if (linesRef.current.length > 5_000) {
      linesRef.current.splice(0, linesRef.current.length - 5_000)
    }
    setTick((t) => t + 1)
  }

  useEffect(() => {
    if (!sessionId) return
    const offData = window.installer.ssh.onStreamData((d) => {
      if (d.channelId !== VALIDATE_CHANNEL) return
      appendChunk(d.chunk)
    })
    const offClose = window.installer.ssh.onStreamClose((d) => {
      if (d.channelId !== VALIDATE_CHANNEL) return
      setExit(d.exitCode)
      setRunning(false)
    })
    return () => { offData(); offClose() }
  }, [sessionId])

  async function runValidate() {
    if (!sessionId || running) return
    linesRef.current = []
    setHealth({})
    setExit(null)
    setRunning(true)
    setTick((t) => t + 1)
    try {
      await window.installer.ssh.execStream({
        sessionId,
        cmd: PATH_PREFIX + `bash '${targetDir}/post-deploy-validate.sh'`,
        sudo: true,
        channelId: VALIDATE_CHANNEL,
      })
    } catch (e) {
      linesRef.current.push(`Error: ${(e as Error).message}`)
      setRunning(false)
      reportError('Post-deploy validate', e)
    }
  }

  // Auto-run validation once on entry.
  useEffect(() => {
    runValidate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function open(url: string) {
    window.open(url, '_blank')
  }

  // Aggregate health for the footer status line.
  const healthEntries = Object.entries(health)
  const okCount = healthEntries.filter(([, h]) => h === 'ok').length
  const failCount = healthEntries.filter(([, h]) => h === 'fail').length

  return (
    <div className="h-full flex flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto">
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Setup complete</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Click any service to open it. Health checks run automatically;
            green = reachable, red = not reachable, grey = unknown.
          </p>
        </div>
        <button
          onClick={runValidate}
          disabled={running}
          className="px-3 py-2 text-sm bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
        >
          {running ? 'Checking...' : 'Re-check'}
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3">
        {SERVICES.map((s) => {
          const url = `http://${ip}:${s.port}`
          const h = health[s.name] ?? 'unknown'
          const dot =
            h === 'ok' ? 'bg-emerald-400'
            : h === 'fail' ? 'bg-rose-400'
            : 'bg-slate-600'
          return (
            <button
              key={s.name}
              onClick={() => open(url)}
              className="text-left p-3 bg-slate-800 hover:bg-slate-700 rounded-md border border-slate-700 flex items-center gap-3"
            >
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot}`} />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {s.name}{' '}
                  {s.note && <span className="text-emerald-400 text-xs ml-1">{s.note}</span>}
                </div>
                <div className="text-xs text-slate-400 font-mono truncate">{url}</div>
              </div>
            </button>
          )
        })}
      </div>

      <details className="rounded-md border border-slate-800">
        <summary className="cursor-pointer p-3 text-sm font-medium flex items-center justify-between">
          <span>
            Validation log {exit !== null && (
              <span className={`ml-2 text-xs ${exit === 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                (exit {exit})
              </span>
            )}
          </span>
          {linesRef.current.length > 0 && (
            <span onClick={(e) => e.stopPropagation()}>
              <LogActions
                lines={linesRef.current}
                defaultName="mediarr-validate.log"
                header={`exit=${exit ?? 'pending'}`}
              />
            </span>
          )}
        </summary>
        <div className="p-3 pt-0">
          <div style={{ height: 240 }}>
            <LogPanel lines={linesRef.current} />
          </div>
        </div>
      </details>

      <section className="space-y-2 border-t border-slate-800 pt-6">
        <h2 className="text-lg font-medium">Manual steps still needed</h2>
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-300">
          <li>
            Open <span className="font-mono text-emerald-400">http://{ip}:5056</span> and run
            the Seerr wizard. Connect Plex with the URL{' '}
            <span className="font-mono">http://plex:32400</span>.
          </li>
          {!config.USENET_HOST && (
            <li>
              Open SABnzbd at <span className="font-mono text-emerald-400">http://{ip}:49155</span>{' '}
              and add your usenet provider under Config &rarr; Servers.
              {' '}
              <span className="text-slate-500 italic">
                (skip this if you don&apos;t use usenet, or fill in USENET_HOST/USER/PASS in
                the wizard next time and we&apos;ll add it for you.)
              </span>
            </li>
          )}
        </ol>
      </section>

      <section className="space-y-2 border-t border-slate-800 pt-6">
        <h2 className="text-lg font-medium text-emerald-400">Configured automatically</h2>
        <ul className="list-disc list-inside space-y-1 text-sm text-slate-300">
          <li>
            Tautulli is wired to <span className="font-mono">plex:32400</span> using the
            token Plex got from your claim. Visit{' '}
            <span className="font-mono text-emerald-400">http://{ip}:8181</span> to verify.
            {' '}
            <span className="text-slate-500 italic">
              (Note: if you ran the wizard before Plex finished its first-claim
              handshake, re-run setup-arr-config.py once Plex is up.)
            </span>
          </li>
          {config.USENET_HOST && (
            <li>
              SABnzbd usenet provider <span className="font-mono">{config.USENET_HOST}</span>
              {' '}was added. Verify connections at
              {' '}<span className="font-mono text-emerald-400">http://{ip}:49155 → Status</span>.
            </li>
          )}
        </ul>
      </section>

    </div>
    </div>

    {/* Sticky footer: health summary + Start over. Pinned so the user
        always knows how many services responded and can reset the
        wizard from anywhere on the page. */}
    <div className="border-t border-slate-800 bg-slate-950 px-8 py-3 shrink-0">
      <div className="max-w-3xl mx-auto flex items-center gap-3">
        <div className="text-sm text-slate-400">
          {running ? 'Running validation...' : `exit ${exit ?? '?'}`}
        </div>
        <div className="flex-1 text-sm text-center">
          {healthEntries.length === 0 ? (
            <span className="text-slate-500">Validation pending</span>
          ) : failCount === 0 ? (
            <span className="text-emerald-300">
              ✓ All {okCount} services reachable
            </span>
          ) : (
            <span className="text-amber-300">
              ✓ {okCount} reachable, ✘ {failCount} not — see grid above
            </span>
          )}
        </div>
        <button
          onClick={reset}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md text-sm"
        >
          Start over
        </button>
      </div>
    </div>
    </div>
  )
}
