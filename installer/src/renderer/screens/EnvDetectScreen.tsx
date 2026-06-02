import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import {
  Radar, AlertCircle, ArrowLeft, ArrowRight,
  CheckCircle2, XCircle, AlertTriangle, Info, RefreshCw,
} from 'lucide-react'
import { BigButton } from '../components/BigButton.js'
import { useWizard } from '../store/wizard.js'
import type { EnvDetectResult } from '../../shared/ipc.js'
import { type EnvFormValues, isEnabled } from '../../shared/env-render.js'
import { reportError } from '../store/errors.js'

/** Map a stack-container name to the ENABLE_* form key that toggles
 *  it on/off. Used by the "Bring your own" panel to translate "I see
 *  Plex already running" into "set ENABLE_PLEX=false" with one click.
 *  Containers without a corresponding flag (prowlarr, flaresolverr —
 *  always-on, not profile-gated) return null so the UI just shows
 *  them as "managed in place; we'll keep yours" without a Skip option. */
function containerToEnableKey(c: string): keyof EnvFormValues | null {
  switch (c) {
    case 'plex':
    case 'tautulli':
    case 'seerr':         return 'ENABLE_PLEX'
    case 'sonarr':        return 'ENABLE_SONARR'
    case 'radarr':        return 'ENABLE_RADARR'
    case 'lidarr':        return 'ENABLE_LIDARR'
    case 'bazarr':        return 'ENABLE_BAZARR'
    case 'qbittorrent':
    case 'gluetun':       return 'ENABLE_QBITTORRENT'
    case 'sabnzbd':       return 'ENABLE_SABNZBD'
    case 'homepage':      return 'ENABLE_HOMEPAGE'
    case 'recyclarr':     return 'ENABLE_RECYCLARR'
    case 'unpackerr':     return 'ENABLE_UNPACKERR'
    default:              return null
  }
}

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
  const { sessionId, setStep, setConfig, setMode, setNasFamily, config, connection, targetDir } = useWizard()
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
        // Publish the detected family to the store so family-gated UI
        // outside this screen (the Help modal) can tailor its platform-
        // specific instructions.
        setNasFamily(r.nasFamily)

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
        // NAS-family-aware path defaults. The wizard's defaultConfig
        // seeds these with Synology values, so a fresh Unraid / QNAP /
        // Linux profile would otherwise carry phantom /volume1/* paths
        // until the user edits them. We override when EITHER the field
        // is empty OR it still holds a Synology default AND the box
        // isn't actually Synology — that way an explicit user edit on
        // a previous run survives, but the seeded default gets fixed
        // up for non-Synology hosts before they reach Configure.
        const SYNOLOGY_DEFAULT_INSTALL = '/volume1/docker/media'
        const SYNOLOGY_DEFAULT_DATA    = '/volume1/Data'
        const wrongFamilyDefault = r.nasFamily !== 'synology'
        if (r.suggestedInstallDir && (
            !config.INSTALL_DIR ||
            (wrongFamilyDefault && config.INSTALL_DIR === SYNOLOGY_DEFAULT_INSTALL)
          )) {
          patch.INSTALL_DIR = r.suggestedInstallDir
        }
        if (r.suggestedDataRoot && (
            !config.DATA_ROOT ||
            (wrongFamilyDefault && config.DATA_ROOT === SYNOLOGY_DEFAULT_DATA)
          )) {
          patch.DATA_ROOT = r.suggestedDataRoot
        }
        // Family-aware PUID/PGID fallback. Same logic: if the form still
        // holds the Synology-historical "1026"/"100" defaults but we're
        // on a different family, swap in that family's convention so the
        // Configure screen doesn't seed the form with values the user
        // would have to manually fix (and the linuxserver/* containers
        // would chown-spam over on every boot). User-explicit edits +
        // /etc/passwd-driven dropdown selections still take precedence —
        // they don't match the historical defaults so this branch skips.
        const SYNOLOGY_DEFAULT_PUID = '1026'
        const SYNOLOGY_DEFAULT_PGID = '100'
        if (r.suggestedPuid && wrongFamilyDefault && config.PUID === SYNOLOGY_DEFAULT_PUID) {
          patch.PUID = r.suggestedPuid
        }
        if (r.suggestedPgid && wrongFamilyDefault && config.PGID === SYNOLOGY_DEFAULT_PGID) {
          patch.PGID = r.suggestedPgid
        }
        // INSTALL_DIR also drives the wizard's targetDir (where the
        // payload + setup.sh land on the NAS). Keep them in sync so
        // RunScreen doesn't try to SFTP to /volume1/docker/media on an
        // Unraid host where that path doesn't exist.
        if (patch.INSTALL_DIR && targetDir !== patch.INSTALL_DIR) {
          useWizard.getState().setTargetDir(patch.INSTALL_DIR)
        }
        if (Object.keys(patch).length > 0) setConfig(patch)

        setStatus('ok')
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message)
        setStatus('failed')
        reportError('Environment detect', e)
      }
    })()
    return () => { cancelled = true }
  }, [sessionId, targetDir])

  // `tone` overrides the icon when a row is neither a clean pass nor a
  // real failure — e.g. a data dir that's "missing" but will be created
  // by the installer. Defaults to ok/fail for every existing caller.
  const Check = ({ ok, label, value, tone }: {
    ok: boolean; label: string; value?: string | null
    tone?: 'ok' | 'fail' | 'info'
  }) => {
    const t = tone ?? (ok ? 'ok' : 'fail')
    return (
    <div className="flex items-center gap-3 py-1.5">
      {/* aria-hidden on the icon — surrounding label already carries
          the pass/fail meaning. We surface the actual status via the
          parent role/aria-label structure on the section. */}
      {t === 'ok' ? (
        <CheckCircle2 size={18} className="text-emerald-400 shrink-0" strokeWidth={2} aria-hidden="true" />
      ) : t === 'info' ? (
        <Info size={18} className="text-sky-400 shrink-0" strokeWidth={2} aria-hidden="true" />
      ) : (
        <XCircle size={18} className="text-rose-400 shrink-0" strokeWidth={2} aria-hidden="true" />
      )}
      <span className="text-sm">
        <span className="sr-only">{t === 'ok' ? 'OK: ' : t === 'info' ? 'Info: ' : 'Failed: '}</span>
        {label}
      </span>
      {value !== undefined && (
        <span className="ml-auto text-sm font-mono text-slate-400">{value ?? '-'}</span>
      )}
    </div>
    )
  }

  const r = result
  const MIN_FREE_GIB = 20
  const lowDisk = !!r?.disk && r.disk.freeGiB < MIN_FREE_GIB
  // SQLite corrupts on NETWORK filesystems (NFS/CIFS/SMB/fuse). Flag only
  // those — an 'unknown' fstype (e.g. the install dir doesn't exist yet)
  // or any local fs (ext4/btrfs/xfs/zfs/…) is fine and must NOT trip the
  // "will corrupt" warning. Previously the check was an allow-list that
  // treated 'unknown' as unsafe, which false-alarmed on healthy UGREEN
  // boxes where /volume1/docker/media isn't created until install.
  const installFsRisky = !!r?.installDirFs && /^(nfs|cifs|smb|fuse)/i.test(r.installDirFs)
  // The "iptables kernel modules unloaded" probe (lsmod | grep ^ip_tables)
  // is a Synology-DSM-specific failure mode — DSM point releases wipe the
  // legacy ip_tables module. On nftables-based distros (UGOS/Debian) that
  // module is legitimately absent (Docker uses the nft backend), so the
  // warning is a false alarm everywhere except Synology.
  const iptablesModulesWarn = r?.iptablesLoaded === false && r.nasFamily === 'synology'
  const allBlocking =
    !!r &&
    r.docker !== 'missing' &&
    r.volume1 &&
    !!r.python3 &&
    !!r.iptables

  const reduced = useReducedMotion()
  return (
    <div className="h-full flex flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto">
    <div className="max-w-2xl mx-auto px-8 py-10 space-y-7">
      <motion.header
        initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="text-center"
      >
        {/* Radar icon doubles as a "scanning" indicator while detection
            is in flight (spinning slowly), and a static "we scanned"
            icon once results land. */}
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-500/20 to-sky-700/30 border border-sky-500/30 mb-4">
          {/* Slow continuous rotation while scanning — Motion's animate
              prop with infinite repeat handles the 4s loop without
              needing a custom Tailwind keyframe. Stops to a static
              radar icon once results land. */}
          <motion.div
            animate={status === 'detecting' && !reduced ? { rotate: 360 } : { rotate: 0 }}
            transition={
              status === 'detecting' && !reduced
                ? { duration: 4, repeat: Infinity, ease: 'linear' }
                : { duration: 0.3 }
            }
          >
            <Radar size={36} className="text-sky-300" strokeWidth={1.5} aria-hidden="true" />
          </motion.div>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">
          {status === 'detecting' ? 'Scanning your NAS…' : status === 'failed' ? 'Scan trouble' : 'Scan complete'}
        </h1>
        <p className="text-slate-400 mt-2 text-base max-w-lg mx-auto">
          {status === 'detecting'
            ? "We're looking up Docker, your user IDs, timezone, and network — to pre-fill the next screen."
            : status === 'failed'
              ? "Couldn't reach the NAS to scan it. The details below tell you what's missing."
              : 'Everything we found is below — review it, then continue.'}
        </p>
      </motion.header>

      {status === 'failed' && error && (
        <motion.div
          initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          className="bg-rose-950/40 border border-rose-700/50 text-rose-100 rounded-lg px-4 py-3 text-sm flex items-start gap-3"
        >
          <AlertCircle size={22} className="text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1">
            <div className="font-semibold">Detection failed</div>
            <div className="text-rose-200/80 text-xs mt-0.5 font-mono whitespace-pre-wrap">{error}</div>
          </div>
        </motion.div>
      )}

      {r && (
        <>
          {/* NAS family banner. Surfaces what the wizard auto-detected
              + the paths it picked — gives the user a sanity check
              before they commit to those paths on Configure. */}
          <section className="rounded-md border border-slate-800 p-4 space-y-2">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-slate-400 uppercase tracking-wide text-xs">
                Detected NAS
              </span>
              <span className="font-medium">
                {{
                  synology: 'Synology DSM',
                  ugreen:   'UGREEN UGOS',
                  qnap:     'QNAP QTS / QuTS',
                  unraid:   'Unraid',
                  truenas:  'TrueNAS',
                  omv:      'OpenMediaVault',
                  linux:    'Generic Linux',
                }[r.nasFamily]}
              </span>
              {r.osVersion && (
                <span className="font-mono text-xs text-slate-500">{r.osVersion}</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-slate-500">Install dir:</span>{' '}
                <span className="font-mono text-slate-300">{r.suggestedInstallDir}</span>
              </div>
              <div>
                <span className="text-slate-500">Data root:</span>{' '}
                <span className="font-mono text-slate-300">{r.suggestedDataRoot}</span>
              </div>
            </div>
            {r.nasFamily !== 'synology' && (
              <p className="text-xs text-emerald-300/80">
                Non-Synology host detected. The wizard auto-fills these paths
                on the Configure screen; you can override them there.
              </p>
            )}
            {r.dataCandidates.length > 0 && (
              <div className="text-xs text-slate-500">
                Other share roots present:{' '}
                <span className="font-mono text-slate-400">
                  {r.dataCandidates.filter((d) => d !== r.suggestedDataRoot).join(', ') || '—'}
                </span>
              </div>
            )}
          </section>

          <section className="rounded-md border border-slate-800 p-4 space-y-1">
            <h2 className="font-medium mb-1 text-sm uppercase text-slate-400 tracking-wide">
              Required
            </h2>
            <Check
              ok={r.docker !== 'missing'}
              label="Docker"
              value={r.docker === 'v2' ? 'v2' : r.docker === 'v1-legacy' ? 'v1 (legacy)' : 'missing'}
            />
            <Check
              ok={r.volume1 || r.nasFamily !== 'synology'}
              label={r.nasFamily === 'synology' ? '/volume1 exists' : 'Storage root present'}
              value={r.volume1 ? '/volume1'
                : r.dataCandidates[0] ? r.dataCandidates[0]
                : 'no candidate found'}
            />
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
                      <motion.button
                        onClick={() => setConfig({ LAN_IP: connection.host })}
                        whileHover={reduced ? {} : { y: -1 }}
                        whileTap={reduced ? {} : { scale: 0.96 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        className={
                          'px-2 py-0.5 rounded font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 transition-colors ' +
                          (config.LAN_IP === connection.host
                            ? 'bg-emerald-700/50 text-emerald-200 border border-emerald-600/40'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-transparent')
                        }
                      >
                        {connection.host} <span className="text-slate-500">(connected via)</span>
                      </motion.button>
                  )}
                  {r.lanIps.map((ip) => {
                    const kind = isPrivateIPv4(ip)
                    const tag =
                      kind === 'rfc1918' ? '' :
                      kind === 'cgnat' ? ' (CGNAT/Tailscale)' :
                      ' (public?)'
                    return (
                      <motion.button
                        key={ip}
                        onClick={() => setConfig({ LAN_IP: ip })}
                        whileHover={reduced ? {} : { y: -1 }}
                        whileTap={reduced ? {} : { scale: 0.96 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        className={
                          'px-2 py-0.5 rounded font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 transition-colors ' +
                          (config.LAN_IP === ip
                            ? 'bg-emerald-700/50 text-emerald-200 border border-emerald-600/40'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-transparent')
                        }
                      >
                        {ip}{tag && <span className="text-slate-500">{tag}</span>}
                      </motion.button>
                    )
                  })}
                </div>
              </div>
            )}
          </section>

          {/* Data-directory check — historically the "Sonarr says root
              folder doesn't exist" trap on Synology (shared-folder ACL
              denying write under PUID), but the same probe is useful on
              every NAS family as an early warning that the data tree
              doesn't exist yet, or POSIX perms deny the SSH user.
              Section title + fix instructions adapt to the detected
              family — DSM Control Panel on Synology, mkdir+chown on
              everything else. The install-time [acl] step in RunScreen
              still auto-applies when synoacltool is available; this
              section is the early warning. */}
          <section className="rounded-md border border-slate-800 p-4 space-y-2">
            <h2 className="font-medium mb-1 text-sm uppercase text-slate-400 tracking-wide">
              {r.nasFamily === 'synology' ? 'Shared folder ACL' : 'Data directory'}
            </h2>
            {/* A missing data dir is only a hard failure on Synology, where
                the canonical move is creating a *shared folder* in DSM (a
                bare mkdir bypasses the ACL/share layer the install relies
                on). On every other family there's no shared-folder concept
                and setup-folders.sh just `mkdir -p`s the whole tree during
                install — so "missing" there is informational, not a red ✗. */}
            {(() => {
              const willCreate = !r.dataShareExists && r.nasFamily !== 'synology' && !!r.dataSharePath
              return (
                <Check
                  ok={r.dataShareExists}
                  tone={r.dataShareExists ? 'ok' : willCreate ? 'info' : 'fail'}
                  label={
                    willCreate
                      ? `${r.dataSharePath} (created during install)`
                      : `${r.dataSharePath ?? 'Data directory'} exists`
                  }
                  value={r.dataShareExists ? 'yes' : willCreate ? 'will be created' : 'missing'}
                />
              )
            })()}
            {!r.dataShareExists && r.nasFamily === 'synology' && (
              <p className="text-amber-300 text-xs ml-5 mt-1">
                Create it in DSM → Control Panel → Shared Folder → Create.
                The wizard's data tree (Media + Downloads) lives there.
              </p>
            )}
            {!r.dataShareExists && r.nasFamily !== 'synology' && r.dataSharePath && (
              <div className="ml-5 mt-1 text-xs text-slate-400 space-y-1">
                <p>
                  No action needed — the install creates this and the full
                  Media + Downloads tree, owned by{' '}
                  <span className="font-mono">{r.username ?? 'your user'}:{r.groupname ?? 'group'}</span>.
                  To create it yourself first (e.g. to reuse an existing media
                  share), run:
                </p>
                <p className="font-mono text-slate-300">
                  sudo mkdir -p {r.dataSharePath} && sudo chown {r.username ?? '<user>'}:{r.groupname ?? '<group>'} {r.dataSharePath}
                </p>
              </div>
            )}
            {!r.dataShareExists && !r.dataSharePath && (
              <p className="text-amber-300 text-xs ml-5 mt-1">
                Couldn't pick a default data directory for this host's NAS family.
                Set DATA_ROOT on the next screen and the wizard will create the tree
                under it during install.
              </p>
            )}
            {r.dataShareExists && (
              <Check
                ok={r.dataShareWritable === true}
                label={`Writable as ${r.username ?? 'SSH user'}`}
                value={
                  r.dataShareWritable === true ? 'yes'
                  : r.dataShareWritable === false
                    ? (r.nasFamily === 'synology' ? 'denied by ACL' : 'denied by POSIX')
                    : 'unknown'
                }
              />
            )}
            {r.dataShareExists && r.dataShareWritable === false && r.nasFamily === 'synology' && (
              <div className="ml-5 mt-2 text-xs text-amber-200/90 space-y-1">
                <p>
                  Synology's shared-folder ACL is denying write access. The
                  arrs will fail to register their root folders at step 7
                  unless this is fixed (the wizard tries to grant it
                  automatically via <code className="font-mono">synoacltool</code>
                  during install, but DSM Control Panel is the source of
                  truth).
                </p>
                <p>
                  <span className="text-amber-300 font-medium">Fix in DSM:</span>{' '}
                  Control Panel → Shared Folder → click <span className="font-mono">Data</span> → Edit → Permissions →
                  find <span className="font-mono">{r.username ?? 'your user'}</span> → check Read/Write → Save. Then
                  click Re-detect on this screen.
                </p>
              </div>
            )}
            {r.dataShareExists && r.dataShareWritable === false && r.nasFamily !== 'synology' && (
              <div className="ml-5 mt-2 text-xs text-amber-200/90 space-y-1">
                <p>
                  POSIX permissions deny the SSH user write access to{' '}
                  <span className="font-mono">{r.dataSharePath}</span>. The arrs
                  will fail to register their root folders at step 7 unless this
                  is fixed (the wizard's <code className="font-mono">prep</code>
                  step tries to chown + chmod during install, but if the dir is
                  owned by root with no write bit, even that fails).
                </p>
                <p className="font-mono">
                  sudo chown -R {r.username ?? '<user>'}:{r.groupname ?? '<group>'} {r.dataSharePath} && sudo chmod -R 775 {r.dataSharePath}
                </p>
              </div>
            )}
            {r.dataShareExists && r.dataShareAcl.length > 0 && (
              <details className="ml-5 mt-1">
                <summary className="cursor-pointer text-xs text-slate-500 select-none">
                  Current ACL ({r.dataShareAcl.length} entries) — click to expand
                </summary>
                <ul className="mt-2 space-y-0.5 text-xs font-mono text-slate-400">
                  {r.dataShareAcl.map((ace, i) => (
                    <li key={i}>
                      <span className="text-slate-500">[{i}]</span>{' '}
                      <span className="text-slate-300">{ace.kind}:{ace.name}</span>{' '}
                      <span className={ace.allow ? 'text-emerald-400' : 'text-rose-400'}>
                        {ace.allow ? 'allow' : 'deny'}
                      </span>{' '}
                      <span className="text-slate-500">{ace.perms}</span>{' '}
                      <span className="text-slate-600">inherit={ace.inherit}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="rounded-md border border-slate-800 p-4 text-sm">
            <div className="flex items-center gap-3">
              {r.sudoMode === 'root' || r.sudoMode === 'nopasswd' ? (
                <CheckCircle2 size={18} className="text-emerald-400 shrink-0" strokeWidth={2} aria-hidden="true" />
              ) : (
                <AlertTriangle size={18} className="text-amber-400 shrink-0" strokeWidth={2} aria-hidden="true" />
              )}
              <span>
                Sudo strategy: <span className="font-mono">{r.sudoMode}</span>
              </span>
            </div>
            {r.sudoMode === 'password' && (
              <p className="text-amber-200/80 mt-2">
                You logged in as a non-root user, so the privileged install
                steps run under <span className="font-mono mx-1">sudo</span>.
                Make sure you filled in the{' '}
                <span className="font-mono mx-1">Sudo password</span> field on
                the Connect screen — the wizard pipes it to{' '}
                <span className="font-mono">sudo -S</span> for each step.
                {r.nasFamily === 'synology' && (
                  <> Alternatively, log in as{' '}
                  <span className="font-mono mx-1">root</span> — DSM 7 disables
                  root SSH by default, but you can re-enable it via Control
                  Panel → User &amp; Group → root → Edit → set a password.</>
                )}
                {r.nasFamily === 'ugreen' && (
                  <> On UGOS this is expected — the admin user uses password
                  sudo and root SSH is off by default, so just keep the Sudo
                  password field filled.</>
                )}
              </p>
            )}
          </section>

          {/* Platform readiness — three Synology-DSM7-specific conditions
              that don't surface during install but silently break the
              stack afterwards. None block Continue: tun module is only
              needed for VPN; iptables modules are normally loaded;
              non-local filesystem is rare. Warn-not-block so users can
              proceed with their eyes open. */}
          {(r.tunDevice === false || iptablesModulesWarn || installFsRisky) && (
            <section className="rounded-md border border-amber-900/50 bg-amber-950/30 p-4 text-sm">
              <h2 className="font-medium text-amber-200 mb-2 inline-flex items-center gap-2">
                <AlertTriangle size={16} className="text-amber-400" strokeWidth={2} aria-hidden="true" />
                Platform readiness
              </h2>
              {r.tunDevice === false && (
                <div className="mb-2">
                  <div className="text-amber-200 inline-flex items-center gap-2">
                    <AlertTriangle size={16} className="text-amber-400 shrink-0" strokeWidth={2} aria-hidden="true" />
                    <span className="font-mono">/dev/net/tun</span> not present
                  </div>
                  <p className="text-amber-200/80 mt-1 ml-5">
                    Gluetun&apos;s WireGuard tunnel needs this device. If the tun
                    module isn&apos;t loaded, Gluetun starts but the tunnel silently
                    never connects, cascading into qBittorrent never starting.
                    Only matters if you enable the VPN. Fix once:
                  </p>
                  {r.nasFamily === 'synology' ? (
                    <pre className="ml-5 mt-1 text-xs bg-black/40 rounded p-2 font-mono">
sudo insmod /lib/modules/tun.ko
{'\n'}# then in DSM: Control Panel → Task Scheduler → Create
# Triggered Task → "Boot-up" → User-defined script:
{'\n'}#   insmod /lib/modules/tun.ko</pre>
                  ) : (
                    <pre className="ml-5 mt-1 text-xs bg-black/40 rounded p-2 font-mono">
sudo modprobe tun
{'\n'}# make it load on every boot:
{'\n'}echo tun | sudo tee /etc/modules-load.d/tun.conf</pre>
                  )}
                </div>
              )}
              {iptablesModulesWarn && (
                <div className="mb-2">
                  <div className="text-amber-200 inline-flex items-center gap-2">
                    <AlertTriangle size={16} className="text-amber-400 shrink-0" strokeWidth={2} aria-hidden="true" />
                    iptables kernel modules not loaded
                  </div>
                  <p className="text-amber-200/80 mt-1 ml-5">
                    DSM minor updates routinely wipe these out, after which Docker
                    can&apos;t program NAT and every <code className="font-mono">docker compose up</code> fails
                    with &quot;Operation not permitted.&quot; Recovery script:
                  </p>
                  <pre className="ml-5 mt-1 text-xs bg-black/40 rounded p-2 font-mono">
git clone https://github.com/telnetdoogie/synology-docker.git
{'\n'}sudo bash synology-docker/install_iptables_modules.sh
{'\n'}# then reboot the NAS</pre>
                </div>
              )}
              {installFsRisky && (
                <div className="mb-2">
                  <div className="text-rose-200 inline-flex items-center gap-2">
                    <XCircle size={16} className="text-rose-400 shrink-0" strokeWidth={2} aria-hidden="true" />
                    Install dir is on <span className="font-mono">{r.installDirFs}</span> — SQLite will corrupt
                  </div>
                  <p className="text-rose-200/80 mt-1 ml-5">
                    The arrs (Sonarr/Radarr/etc) use SQLite for their config DBs.
                    SQLite corrupts catastrophically on network filesystems (NFS, CIFS, fuse mounts).
                    Move <code className="font-mono">INSTALL_DIR</code> to local storage like
                    <code className="font-mono"> {r.suggestedInstallDir}</code>.
                  </p>
                </div>
              )}
            </section>
          )}

          {/* Bring-your-own panel — when the NAS already has stack-known
              container names running, let the user opt those services
              out of THIS install with one click each. Use case:
                - User has an existing Plex installed manually + curated;
                  they want the wizard to install Sonarr/Radarr/qBit but
                  leave Plex alone.
                - User has a remote Plex on a separate box; tautulli +
                  seerr should follow Plex's lead and stay off here.
              The Skip button toggles the corresponding ENABLE_*=false
              flag in the wizard config. The user can confirm or reverse
              on the next Configure screen. We DON'T currently read API
              keys out of the external service's config (that's a fuller
              "Adopt" mode for a follow-up) — Skip is the safe MVP. */}
          {r.existingInstall.runningContainers.length > 0 && (() => {
            // Distinct enable-keys for the detected containers, so e.g.
            // plex+tautulli+seerr collapse into a single "Skip Plex stack"
            // option (they share ENABLE_PLEX). null-mapped containers
            // (prowlarr, flaresolverr) don't get a skip option here.
            const detectedKeys = Array.from(new Set(
              r.existingInstall.runningContainers
                .map(containerToEnableKey)
                .filter((k): k is keyof EnvFormValues => k !== null),
            ))
            if (detectedKeys.length === 0) return null
            const isOn = (k: keyof EnvFormValues) => isEnabled(config[k] as string | undefined)
            const skipAll = () => {
              const patch: Partial<EnvFormValues> = {}
              for (const k of detectedKeys) patch[k] = 'false' as never
              setConfig(patch)
            }
            const allSkipped = detectedKeys.every((k) => !isOn(k))
            return (
              <section className="rounded-md border border-amber-700/50 bg-amber-900/10 p-4 space-y-3 text-sm">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={18} className="text-amber-400 shrink-0" strokeWidth={2} aria-hidden="true" />
                  <span className="font-medium">Services already running — keep them?</span>
                </div>
                <p className="text-slate-300 text-xs">
                  We see container(s) with the stack&apos;s standard names already
                  running. The default install will rebuild them from this wizard&apos;s
                  compose file (preserving config dirs / .env). If you&apos;d rather
                  the wizard leave them alone — e.g. you maintain Plex yourself
                  with a custom config — Skip the matching service(s) below and
                  this install won&apos;t touch them.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {detectedKeys.map((k) => {
                    const skipped = !isOn(k)
                    // Label = "Plex" not "ENABLE_PLEX". Strip the prefix
                    // and title-case the rest so the UI reads naturally.
                    const label = k
                      .replace(/^ENABLE_/, '')
                      .toLowerCase()
                      .replace(/^\w/, (c) => c.toUpperCase())
                    // Pretty-print which containers from the detected
                    // set match this key — gives the user a sanity check
                    // that "Plex stack" really means "plex + tautulli + seerr".
                    const matched = r.existingInstall.runningContainers
                      .filter((c) => containerToEnableKey(c) === k)
                    return (
                      <label
                        key={k}
                        className={
                          'flex items-start gap-2 rounded-md border p-2 cursor-pointer text-xs ' +
                          (skipped
                            ? 'border-slate-700 bg-slate-900/40 opacity-80'
                            : 'border-amber-700/40 bg-amber-900/10')
                        }
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 shrink-0"
                          checked={skipped}
                          onChange={(e) => {
                            setConfig({ [k]: e.target.checked ? 'false' : 'true' } as Partial<EnvFormValues>)
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">
                            Skip {label}
                          </div>
                          <div className="text-xs text-slate-400 font-mono truncate">
                            {matched.join(', ')}
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>
                {!allSkipped && (
                  <div className="flex gap-2 items-center">
                    <BigButton
                      size="sm"
                      variant="secondary"
                      onClick={skipAll}
                      className="bg-amber-700/60 hover:bg-amber-600 border-amber-600/30"
                    >
                      Skip all detected ({detectedKeys.length})
                    </BigButton>
                    <span className="text-xs text-slate-500">
                      Equivalent to ticking every Skip box above
                    </span>
                  </div>
                )}
              </section>
            )
          })()}

          {/* Existing install banner — switch to Update mode when found */}
          {(r.existingInstall.hasCompose || r.existingInstall.runningContainers.length > 0) && (
            <section className="rounded-md border border-sky-700/50 bg-sky-900/20 p-4 space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Info size={18} className="text-sky-400 shrink-0" strokeWidth={2} aria-hidden="true" />
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
              <div className="flex gap-2 items-center">
                <BigButton
                  size="sm"
                  variant="primary"
                  icon={<RefreshCw size={14} />}
                  className="bg-gradient-to-b from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 shadow-lg shadow-sky-900/40 border-sky-400/30"
                  onClick={() => { setMode('update'); setStep('run-update') }}
                >
                  Switch to Update mode
                </BigButton>
                <span className="text-xs text-slate-400">
                  or continue and overwrite the install (.env preserved)
                </span>
              </div>
            </section>
          )}

          {/* Port conflict callout — these would fail `docker compose up` */}
          {r.portConflicts.length > 0 && (
            <section className="rounded-md border border-rose-700/50 bg-rose-900/20 p-4 space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <XCircle size={18} className="text-rose-400 shrink-0" strokeWidth={2} aria-hidden="true" />
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
                    {/* Synology-specific: port 49152 = Media Server (DLNA)
                        almost without exception. Surface the precise fix
                        path inline so the user doesn't have to dig. The
                        stack's port range (49150-49156) overlaps with the
                        IANA dynamic-port range that DLNA / UPnP commonly
                        squat on; only DSM ships a package that does
                        this by default. */}
                    {c.port === 49152 && r.nasFamily === 'synology' && (
                      <div className="ml-5 mt-1 text-amber-200/80">
                        Likely cause: Synology Media Server (DLNA).
                        Fix: DSM → Package Center → Media Server → Stop
                        (or uninstall if you don&apos;t use DLNA).
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

    </div>
    </div>

    {/* Sticky footer: Back / status / Continue. Pinned so the user can
        always advance regardless of how far they've scrolled. */}
    <div className="border-t border-slate-800 bg-slate-950 px-8 py-3 shrink-0">
      <div className="max-w-2xl mx-auto flex items-center gap-3">
        <BigButton
          size="md"
          variant="secondary"
          icon={<ArrowLeft size={18} />}
          onClick={() => setStep('connect')}
        >
          Back
        </BigButton>
        <div className="flex-1 text-sm text-center">
          {status === 'detecting' && (
            <span className="text-slate-400 inline-flex items-center gap-1.5">
              <Radar size={16} className="text-sky-400" aria-hidden="true" />
              Running checks over SSH…
            </span>
          )}
          {status === 'failed' && (
            <span className="text-rose-300 inline-flex items-center gap-1.5" role="status" aria-live="polite">
              <XCircle size={16} aria-hidden="true" />
              Detection failed — see details above
            </span>
          )}
          {status === 'ok' && allBlocking && (
            <span className="text-emerald-300 inline-flex items-center gap-1.5" role="status" aria-live="polite">
              <CheckCircle2 size={16} aria-hidden="true" />
              All required checks passed
            </span>
          )}
          {status === 'ok' && !allBlocking && (
            <span className="text-amber-300 inline-flex items-center gap-1.5" role="status" aria-live="polite">
              <AlertTriangle size={16} aria-hidden="true" />
              Fix the red items above to continue
            </span>
          )}
        </div>
        <BigButton
          size="md"
          variant="primary"
          trailingIcon={<ArrowRight size={18} />}
          disabled={!allBlocking}
          onClick={() => setStep('configure')}
          title={
            status === 'detecting'
              ? 'Wait for environment checks to finish'
              : status === 'failed'
                ? 'Detection failed — see the error above and go back to retry'
                : !allBlocking
                  ? 'One or more required checks failed — install would not succeed'
                  : 'Advance to the configure screen'
          }
        >
          Continue
        </BigButton>
      </div>
    </div>
    </div>
  )
}
