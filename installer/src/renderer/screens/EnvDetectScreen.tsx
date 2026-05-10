import { useEffect, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import type { EnvDetectResult } from '../../shared/ipc.js'

type Status = 'detecting' | 'ok' | 'failed'

// Translate a detect result into a vertical checklist with red/green dots,
// then auto-fill what we can into the wizard's config so the user only
// edits things we couldn't infer.
// IPv4 in private RFC1918 / CGNAT ranges — the kind that should bind
// the stack's ports. 10/8, 172.16/12, 192.168/16, plus 100.64/10 (CGNAT,
// used by Tailscale; we deliberately rank it lower than RFC1918).
function isPrivateIPv4(ip: string): 'rfc1918' | 'cgnat' | 'no' {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return 'no'
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return 'rfc1918'
  if (a === 192 && b === 168) return 'rfc1918'
  if (a === 172 && b >= 16 && b <= 31) return 'rfc1918'
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
  return 'no'
}

/** Pick the most likely LAN IP for binding the stack's ports.
 *
 *  We trust the NAS's own view of its network over whatever the user
 *  typed in Connect. The user might have used a hostname (resolved by
 *  mDNS), a Tailscale IP, or any address that *happened* to route in —
 *  none of which are necessarily the LAN address services should bind.
 *
 *  Priority:
 *    1. The IP of the NAS's default-route interface — almost always
 *       its primary LAN address.
 *    2. The first detected RFC1918 IP from `ip addr show`.
 *    3. The first detected CGNAT IP (Tailscale-style).
 *    4. The exact IP the user typed in Connect (if it's an IPv4).
 *    5. The first detected IP, whatever it is.
 */
function pickLanIp(args: {
  defaultIp: string | null
  detected: string[]
  connectionHost?: string
}): string | null {
  if (args.defaultIp && /^\d+\.\d+\.\d+\.\d+$/.test(args.defaultIp)) {
    return args.defaultIp
  }
  const rfc = args.detected.find((ip) => isPrivateIPv4(ip) === 'rfc1918')
  if (rfc) return rfc
  const cg = args.detected.find((ip) => isPrivateIPv4(ip) === 'cgnat')
  if (cg) return cg
  if (args.connectionHost && /^\d+\.\d+\.\d+\.\d+$/.test(args.connectionHost)) {
    return args.connectionHost
  }
  return args.detected[0] ?? null
}

export function EnvDetectScreen() {
  const { sessionId, setStep, setConfig, setMode, config, connection, targetDir } = useWizard()
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
        // PUID/PGID intentionally NOT auto-filled from the SSH user —
        // that's the install/admin account, which is usually different
        // from the user that should own the media files. The Configure
        // screen has a "Container user" lookup for that.
        const patch: Record<string, string> = {}
        if (r.tz && !config.TZ) patch.TZ = r.tz
        const lanIp = pickLanIp({
          defaultIp: r.defaultIp,
          detected: r.lanIps,
          connectionHost: connection.host,
        })
        // Always overwrite — the user-typed IP from Connect may have
        // been good enough to reach the NAS but isn't necessarily what
        // services should bind. Trust the NAS's own self-report.
        if (lanIp) patch.LAN_IP = lanIp
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
            {(() => {
              // The host-level reachability checks (curl + getent) are
              // unreliable on Synology — stock curl has out-of-date CAs,
              // BusyBox often lacks getent, and outbound HTTPS from the
              // SSH shell is sometimes firewalled separately from the
              // Docker daemon. The daemon has its own network stack and
              // pulls images fine regardless. So: trust Docker's presence
              // check. We only flag a real problem if Docker isn't even
              // installed (which is already covered above).
              const dockerInstalled = r.docker !== 'missing'
              const curlWorks = r.internet.dockerHub
              return <>
                <Check
                  ok={dockerInstalled}
                  label="Image pulls"
                  value={
                    !dockerInstalled ? 'docker not installed' :
                    curlWorks ? 'verified reachable' :
                    'should work (Docker daemon does its own network)'
                  }
                />
                {dockerInstalled && !curlWorks && (
                  <p className="text-slate-500 text-xs ml-5 mt-1">
                    Note: a basic curl from the SSH shell couldn&apos;t reach
                    docker.io. Synology&apos;s stock curl is often out of
                    date, but the Docker daemon talks to the registry on
                    its own. If <code>docker pull hello-world</code> works
                    in your terminal you&apos;re fine.
                  </p>
                )}
              </>
            })()}
            {/* plex.tv reachability removed — it tested host curl, but
                Plex runs in a container with its own network stack. The
                check was a frequent false-negative (Synology curl trust
                store) and not actionable for the wizard. */}
          </section>

          <section className="rounded-md border border-slate-800 p-4 space-y-1">
            <h2 className="font-medium mb-1 text-sm uppercase text-slate-400 tracking-wide">
              SSH session info
            </h2>
            <Check
              ok={!!r.username}
              label="Logged in as"
              value={r.username ? `${r.username} (uid=${r.puid}, gid=${r.pgid})` : null}
            />
            <p className="text-slate-500 text-xs ml-5">
              This is the install user. The container user (PUID/PGID for
              media files) is set separately on the next screen — it should
              usually be a different, less-privileged account.
            </p>
          </section>

          <section className="rounded-md border border-slate-800 p-4 space-y-1">
            <h2 className="font-medium mb-1 text-sm uppercase text-slate-400 tracking-wide">
              Auto-filled
            </h2>
            <Check ok={!!r.tz} label="Timezone" value={r.tz} />
            <Check
              ok={r.lanIps.length > 0 || !!config.LAN_IP}
              label="LAN IP"
              value={config.LAN_IP || null}
            />
            {r.defaultIface && r.defaultIp && (
              <p className="ml-5 mt-0.5 text-xs text-slate-500">
                Default-route interface{' '}
                <span className="font-mono text-slate-300">{r.defaultIface}</span>{' '}
                ({r.defaultIp})
                {connection.host && r.defaultIp !== connection.host && (
                  <>
                    {' '}— differs from the address you connected via{' '}
                    <span className="font-mono text-amber-300">{connection.host}</span>;
                    we picked the NAS&apos;s real LAN IP for service binding.
                  </>
                )}
              </p>
            )}
            {r.lanIps.length > 0 && (
              <div className="ml-5 mt-1 text-xs">
                <div className="text-slate-500 mb-1">
                  Detected interfaces (click to use):
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {/* Connection host first if it's an IP and not already in the list */}
                  {connection.host && /^\d+\.\d+\.\d+\.\d+$/.test(connection.host)
                    && !r.lanIps.includes(connection.host) && (
                      <button
                        onClick={() => setConfig({ LAN_IP: connection.host })}
                        className={
                          'px-2 py-0.5 rounded font-mono ' +
                          (config.LAN_IP === connection.host
                            ? 'bg-emerald-700/50 text-emerald-200'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-300')
                        }
                      >
                        {connection.host} <span className="text-slate-500">(connected via)</span>
                      </button>
                  )}
                  {r.lanIps.map((ip) => {
                    const kind = isPrivateIPv4(ip)
                    const tag =
                      kind === 'rfc1918' ? '' :
                      kind === 'cgnat' ? ' (CGNAT/Tailscale)' :
                      ' (public?)'
                    return (
                      <button
                        key={ip}
                        onClick={() => setConfig({ LAN_IP: ip })}
                        className={
                          'px-2 py-0.5 rounded font-mono ' +
                          (config.LAN_IP === ip
                            ? 'bg-emerald-700/50 text-emerald-200'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-300')
                        }
                      >
                        {ip}{tag && <span className="text-slate-500">{tag}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
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
