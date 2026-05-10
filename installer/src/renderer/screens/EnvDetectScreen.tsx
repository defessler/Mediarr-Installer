import { useEffect, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import type { EnvDetectResult } from '../../shared/ipc.js'

type Status = 'detecting' | 'ok' | 'failed'

// Translate a detect result into a vertical checklist with red/green dots,
// then auto-fill what we can into the wizard's config so the user only
// edits things we couldn't infer.
export function EnvDetectScreen() {
  const { sessionId, setStep, setConfig, setMode, config, targetDir } = useWizard()
  const [status, setStatus] = useState<Status>('detecting')
  const [result, setResult] = useState<EnvDetectResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setError('No SSH session — go back and reconnect.')
      setStatus('failed')
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const r = await window.installer.env.detect(sessionId, targetDir)
        if (cancelled) return
        setResult(r)

        // Auto-fill anything we detected that the user hasn't already typed.
        const patch: Record<string, string> = {}
        if (r.puid !== null && !config.PUID) patch.PUID = String(r.puid)
        if (r.pgid !== null && !config.PGID) patch.PGID = String(r.pgid)
        if (r.tz && !config.TZ) patch.TZ = r.tz
        if (r.lanIps[0] && !config.LAN_IP) patch.LAN_IP = r.lanIps[0]
        if (Object.keys(patch).length > 0) setConfig(patch)

        setStatus('ok')
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message)
        setStatus('failed')
      }
    })()
    return () => { cancelled = true }
  }, [sessionId, targetDir])

  const Check = ({ ok, label, value }: { ok: boolean; label: string; value?: string | null }) => (
    <div className="flex items-center gap-3 py-1.5">
      <span
        className={
          'inline-block w-2.5 h-2.5 rounded-full ' +
          (ok ? 'bg-emerald-400' : 'bg-rose-400')
        }
      />
      <span className="text-sm">{label}</span>
      {value !== undefined && (
        <span className="ml-auto text-sm font-mono text-slate-400">{value ?? '-'}</span>
      )}
    </div>
  )

  const r = result
  const MIN_FREE_GIB = 20
  const lowDisk = !!r?.disk && r.disk.freeGiB < MIN_FREE_GIB
  const allBlocking =
    !!r &&
    r.docker !== 'missing' &&
    r.volume1 &&
    !!r.python3 &&
    !!r.iptables

  return (
    <div className="h-full overflow-y-auto">
    <div className="max-w-2xl mx-auto p-8 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Probing your NAS</h1>
        <p className="text-slate-400 mt-1 text-sm">
          Auto-detecting Docker, Python, your user IDs, timezone, and LAN
          interfaces so we can pre-fill the next screen.
        </p>
      </header>

      {status === 'detecting' && (
        <div className="text-slate-400 text-sm">Running checks over SSH...</div>
      )}

      {status === 'failed' && (
        <div className="bg-rose-900/40 text-rose-200 rounded-md p-3 text-sm">
          Detection failed: {error}
        </div>
      )}

      {r && (
        <>
          <section className="rounded-md border border-slate-800 p-4 space-y-1">
            <h2 className="font-medium mb-1 text-sm uppercase text-slate-400 tracking-wide">
              Required
            </h2>
            <Check
              ok={r.docker !== 'missing'}
              label="Docker"
              value={r.docker === 'v2' ? 'v2' : r.docker === 'v1-legacy' ? 'v1 (legacy)' : 'missing'}
            />
            <Check ok={r.volume1} label="/volume1 exists" value={r.volume1 ? 'yes' : 'no'} />
            <Check ok={!!r.python3} label="python3" value={r.python3 ?? 'missing'} />
            <Check ok={!!r.iptables} label="iptables" value={r.iptables ?? 'missing'} />
          </section>

          <section className="rounded-md border border-slate-800 p-4 space-y-1">
            <h2 className="font-medium mb-1 text-sm uppercase text-slate-400 tracking-wide">
              Capacity & connectivity
            </h2>
            <Check
              ok={!!r.disk && !lowDisk}
              label="Disk space on /volume1"
              value={r.disk
                ? `${r.disk.freeGiB} GiB free of ${Math.round(r.disk.totalBytes / 1024 ** 3)} GiB`
                : 'unknown'}
            />
            {lowDisk && r.disk && (
              <p className="text-amber-300 text-xs ml-5 mt-1">
                Stack images are ~10 GiB on first pull. We recommend at least
                {' '}{MIN_FREE_GIB} GiB free.
              </p>
            )}
            <Check ok={r.internet.dockerHub} label="Docker Hub reachable" value={r.internet.dockerHub ? 'yes' : 'no'} />
            {!r.internet.dockerHub && (
              <p className="text-rose-300 text-xs ml-5 mt-1">
                Image pulls will fail. Check the NAS's DNS and outbound firewall.
              </p>
            )}
            <Check ok={r.internet.plexTv} label="plex.tv reachable" value={r.internet.plexTv ? 'yes' : 'no'} />
            {!r.internet.plexTv && (
              <p className="text-amber-300 text-xs ml-5 mt-1">
                Plex won't be able to validate your claim token. Other services unaffected.
              </p>
            )}
          </section>

          <section className="rounded-md border border-slate-800 p-4 space-y-1">
            <h2 className="font-medium mb-1 text-sm uppercase text-slate-400 tracking-wide">
              Auto-filled
            </h2>
            <Check ok={r.puid !== null} label="PUID" value={r.puid !== null ? String(r.puid) : null} />
            <Check ok={r.pgid !== null} label="PGID" value={r.pgid !== null ? String(r.pgid) : null} />
            <Check ok={!!r.tz} label="Timezone" value={r.tz} />
            <Check
              ok={r.lanIps.length > 0}
              label={`LAN IP (${r.lanIps.length} found)`}
              value={r.lanIps[0] ?? null}
            />
          </section>

          <section className="rounded-md border border-slate-800 p-4 text-sm">
            <div className="flex items-center gap-3">
              <span
                className={
                  'inline-block w-2.5 h-2.5 rounded-full ' +
                  (r.sudoMode === 'root' || r.sudoMode === 'nopasswd' ? 'bg-emerald-400' : 'bg-amber-400')
                }
              />
              <span>
                Sudo strategy: <span className="font-mono">{r.sudoMode}</span>
              </span>
            </div>
            {r.sudoMode === 'password' && (
              <p className="text-amber-200/80 mt-2">
                You logged in as a non-root user. Phase 2 prompts for a sudo
                password; in Phase 1 the cleanest path is to log in as
                <span className="font-mono mx-1">root</span> instead.
              </p>
            )}
          </section>

          {/* Existing install banner — switch to Update mode when found */}
          {(r.existingInstall.hasCompose || r.existingInstall.runningContainers.length > 0) && (
            <section className="rounded-md border border-sky-700/50 bg-sky-900/20 p-4 space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-sky-400" />
                <span className="font-medium">An install already exists at this path</span>
              </div>
              <ul className="text-slate-300 space-y-0.5 ml-5 list-disc list-inside text-xs">
                {r.existingInstall.hasCompose && (
                  <li><span className="font-mono">{targetDir}/docker-compose.yml</span> exists</li>
                )}
                {r.existingInstall.hasEnv && (
                  <li><span className="font-mono">{targetDir}/.env</span> exists (we will not overwrite secrets)</li>
                )}
                {r.existingInstall.runningContainers.length > 0 && (
                  <li>
                    {r.existingInstall.runningContainers.length} stack container(s) running:{' '}
                    <span className="font-mono">
                      {r.existingInstall.runningContainers.slice(0, 5).join(', ')}
                      {r.existingInstall.runningContainers.length > 5 && '...'}
                    </span>
                  </li>
                )}
              </ul>
              <div className="flex gap-2">
                <button
                  onClick={() => { setMode('update'); setStep('run-update') }}
                  className="px-3 py-1.5 text-xs bg-sky-600 hover:bg-sky-500 rounded-md"
                >
                  Switch to Update mode
                </button>
                <span className="text-xs text-slate-400 self-center">
                  or continue and overwrite the install (.env preserved)
                </span>
              </div>
            </section>
          )}

          {/* Port conflict callout — these would fail `docker compose up` */}
          {r.portConflicts.length > 0 && (
            <section className="rounded-md border border-rose-700/50 bg-rose-900/20 p-4 space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-rose-400" />
                <span className="font-medium">Port conflicts detected</span>
              </div>
              <p className="text-slate-300 text-xs">
                These ports are already bound by another process and will block
                <code className="bg-slate-800 px-1 rounded mx-1">docker compose up</code>.
                Stop the offending process or change the conflicting service&apos;s port
                in <span className="font-mono">docker-compose.yml</span>.
              </p>
              <ul className="space-y-0.5 ml-5 list-disc list-inside text-xs text-slate-300">
                {r.portConflicts.map((c) => (
                  <li key={c.port}>
                    Port <span className="font-mono">{c.port}</span> ({c.service})
                    {c.process && (
                      <span className="text-slate-500"> — held by {c.process}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <div className="flex justify-between pt-4 border-t border-slate-800">
        <button
          onClick={() => setStep('connect')}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md"
        >
          Back
        </button>
        <button
          onClick={() => setStep('configure')}
          disabled={!allBlocking}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </div>
    </div>
  )
}
