import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import confetti from 'canvas-confetti'
import {
  ExternalLink, RefreshCw, CheckCircle2, XCircle, Circle, RotateCcw,
  FileText, ChevronDown, AlertTriangle,
  LayoutDashboard, PlaySquare, Tv, Film, Music, Radar, Captions,
  Newspaper, Download, MessageSquare, BarChart3, Shield,
  type LucideIcon,
} from 'lucide-react'
import { useWizard } from '../store/wizard.js'
import { LogPanel, stripAnsi } from '../components/LogPanel.js'
import { LogActions } from '../components/LogActions.js'
import { AnimatedCheck } from '../components/AnimatedCheck.js'
import { BigButton } from '../components/BigButton.js'
import { PATH_PREFIX } from '../../shared/synology-path.js'
import { reportError } from '../store/errors.js'
import { isEnabled } from '../../shared/env-render.js'

// Per-service glyph + accent. Same vocabulary the Configure screen uses
// for the Services checklist, so a user who learned "Sonarr is the sky-
// blue TV icon" on Configure recognises it again here. Two new entries
// for things that don't appear on Configure (Prowlarr always-on, Seerr
// derived from Plex stack, Tautulli derived, Flaresolverr always-on).
const SERVICES: {
  name: string
  port: string
  note?: string
  icon: LucideIcon
  iconColor: string
}[] = [
  { name: 'Homepage',     port: '3000',      note: 'Start here', icon: LayoutDashboard, iconColor: 'text-teal-400' },
  { name: 'Plex',         port: '32400/web',                     icon: PlaySquare,      iconColor: 'text-amber-400' },
  { name: 'Sonarr',       port: '49152',                         icon: Tv,              iconColor: 'text-sky-400' },
  { name: 'Radarr',       port: '49151',                         icon: Film,            iconColor: 'text-yellow-400' },
  { name: 'Lidarr',       port: '49154',                         icon: Music,           iconColor: 'text-fuchsia-400' },
  { name: 'Prowlarr',     port: '49150',                         icon: Radar,           iconColor: 'text-indigo-400' },
  { name: 'Bazarr',       port: '49153',                         icon: Captions,        iconColor: 'text-violet-400' },
  { name: 'SABnzbd',      port: '49155',                         icon: Newspaper,       iconColor: 'text-orange-400' },
  { name: 'qBittorrent',  port: '49156',                         icon: Download,        iconColor: 'text-blue-400' },
  { name: 'Seerr',        port: '5056',                          icon: MessageSquare,   iconColor: 'text-purple-400' },
  { name: 'Tautulli',     port: '8181',                          icon: BarChart3,       iconColor: 'text-cyan-400' },
  { name: 'Flaresolverr', port: '8191',                          icon: Shield,          iconColor: 'text-amber-300' },
]

type ServiceHealth = 'unknown' | 'ok' | 'fail'
const VALIDATE_CHANNEL = 'post-deploy-validate'

export function DoneScreen() {
  const { config, sessionId, targetDir, reset } = useWizard()
  const ip = config.LAN_IP ?? '<NAS-IP>'

  // Starts true: the screen auto-runs post-deploy validation on mount (effect
  // below), so initializing true avoids a one-frame "Setup finished — with
  // issues" flash before the effect sets it.
  const [running, setRunning] = useState(true)
  // Re-entrancy guard for runValidate(). This MUST be separate from the
  // `running` state: `running` starts true (for the no-flash reason above),
  // so if runValidate() gated on it, the auto-run would no-op forever and the
  // Done screen would hang on "Checking…" for every install. The ref tracks
  // an actually-in-flight validation (cleared only when the stream closes or
  // setup fails), so a real double-click on "Re-check" is still prevented
  // without blocking the initial run.
  const runningRef = useRef(false)
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
        // post-deploy-validate.sh names the media-server line after whichever
        // server is live, so map the 'Plex' entry to 'Jellyfin' when deployed
        // — otherwise the Jellyfin tile never registers and stays grey.
        const mediaName = (config.MEDIA_SERVER || 'plex') === 'jellyfin' ? 'Jellyfin' : 'Plex'
        for (const svc of SERVICES) {
          const name = svc.name === 'Plex' ? mediaName : svc.name
          // Anchored on the URL check lines only — ignore "container running" lines
          // so a healthy container with an unreachable WebUI doesn't register as ok.
          if (clean.includes(`${name} (http`)) {
            if (clean.includes('✔')) next[name] = 'ok'
            else if (clean.includes('✘')) next[name] = 'fail'
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
      runningRef.current = false
      setRunning(false)
    })
    return () => { offData(); offClose() }
  }, [sessionId])

  async function runValidate() {
    if (!sessionId || runningRef.current) return
    runningRef.current = true
    linesRef.current = []
    setHealth({})
    setExit(null)
    setRunning(true)
    setTick((t) => t + 1)
    try {
      await window.installer.ssh.execStream({
        sessionId,
        // v0.3.22+ moved post-deploy-validate.sh under scripts/. Try
        // the new path; fall back to the legacy root location so this
        // still works on installs that haven't run Sync yet.
        cmd:
          PATH_PREFIX +
          `if [ -f '${targetDir}/scripts/post-deploy-validate.sh' ]; then ` +
          `  bash '${targetDir}/scripts/post-deploy-validate.sh'; ` +
          `else ` +
          `  bash '${targetDir}/post-deploy-validate.sh'; ` +
          `fi`,
        sudo: true,
        channelId: VALIDATE_CHANNEL,
      })
    } catch (e) {
      linesRef.current.push(`Error: ${(e as Error).message}`)
      runningRef.current = false
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

  const reduced = useReducedMotion()
  // Honest success signal: ONLY a clean validator exit. The old fallback
  // (failCount===0 && okCount>0) painted "success" even on a non-zero exit,
  // so a VPN IP-leak / hardlink-EXDEV / missing-key failure was hidden behind
  // confetti while the reachable-service tiles were all green.
  const installSucceeded = exit === 0
  // Media-server-aware tile NAMES. post-deploy-validate.sh names its
  // reachability line after whichever server is live (Plex or Jellyfin), so
  // both the tile grid AND the criticalIssues exclusion below must use these.
  const mediaServer = config.MEDIA_SERVER || 'plex'
  const tileNames = SERVICES.map((s) =>
    s.name === 'Plex' && mediaServer === 'jellyfin' ? 'Jellyfin' : s.name)
  // Validator failures that AREN'T service-reachability tiles — VPN IP-leak,
  // hardlink copy-fallback, missing API keys, daemon issues. These were
  // previously invisible (only "(http" tile lines fed the footer). Surface
  // them as first-class problems. Derived from the log so no extra state.
  // Exclude tile lines via the media-server-aware names so a Jellyfin
  // WebUI-unreachable line isn't mis-flagged as a critical (VPN-class) issue.
  const criticalIssues = Array.from(new Set(
    linesRef.current
      .map(stripAnsi)
      .filter((l) => l.includes('✘') && !tileNames.some((n) => l.includes(`${n} (http`)))
      .map((l) => l.replace(/.*✘\s*/, '').trim())
      .filter(Boolean),
  ))

  // Media-server-aware tile list — swap the Plex tile for Jellyfin (port
  // 8096) and drop Plex-only Tautulli when the user deployed Jellyfin, so
  // the grid matches what actually got installed.
  const displayedServices = SERVICES.flatMap((s) => {
    if (s.name === 'Plex') {
      return mediaServer === 'jellyfin' ? [{ ...s, name: 'Jellyfin', port: '8096' }] : [s]
    }
    if (s.name === 'Tautulli' && mediaServer === 'jellyfin') return []
    return [s]
  })

  // Single confetti burst when the user lands here with the install
  // succeeded. Reward moment — emotionally distinct from "yep, looks
  // ok" toast. Suppressed in reduced-motion (vestibular sensitivity).
  // Tracked in a ref so re-renders / re-runs of validate don't fire
  // it again — once per Done screen mount, max.
  const firedConfettiRef = useRef(false)
  useEffect(() => {
    if (firedConfettiRef.current) return
    if (!installSucceeded) return
    if (reduced) return
    firedConfettiRef.current = true
    // Small delay so the hero animation can lead before confetti.
    const t = setTimeout(() => {
      // Two cones aimed up + slightly outward from the page center.
      // 80 particles total, gravity-pulled, fall in ~3s. Tuned to feel
      // celebratory without being annoying on re-mount.
      const opts = {
        particleCount: 40,
        spread: 60,
        startVelocity: 35,
        scalar: 0.9,
        gravity: 0.9,
        ticks: 200,
        colors: ['#34d399', '#10b981', '#6ee7b7', '#fbbf24', '#a7f3d0'],
      }
      confetti({ ...opts, origin: { x: 0.3, y: 0.6 }, angle: 70 })
      confetti({ ...opts, origin: { x: 0.7, y: 0.6 }, angle: 110 })
    }, 350)
    return () => clearTimeout(t)
  }, [installSucceeded, reduced])

  return (
    <div className="h-full flex flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto">
    <div className="max-w-3xl mx-auto px-8 py-10 space-y-8">
      {/* Big celebratory hero with animated checkmark draws in over ~1s.
          Single payoff moment — keeps the install feeling like an
          accomplishment, not a chore. */}
      <motion.header
        initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="text-center"
      >
        <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-emerald-500/15 border border-emerald-500/30 mb-5" aria-hidden="true">
          <AnimatedCheck size={64} className="text-emerald-400" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight">
          {installSucceeded
            ? 'You did it!'
            : running
              ? 'Checking your stack…'
              : 'Setup finished — with issues to review'}
        </h1>
        <p className="text-slate-400 mt-3 text-base max-w-md mx-auto">
          {installSucceeded
            ? 'Your media stack is live. Click any service below to open it.'
            : running
              ? 'Running post-deploy validation…'
              : 'Validation flagged problems — review them below before relying on the stack.'}
        </p>
        <div className="mt-5 flex items-center justify-center gap-3">
          <BigButton
            size="md"
            variant="secondary"
            icon={<RefreshCw size={18} />}
            loading={running}
            onClick={runValidate}
          >
            {running ? 'Checking...' : 'Re-check health'}
          </BigButton>
        </div>
      </motion.header>

      {criticalIssues.length > 0 && (
        <div className="rounded-lg border border-rose-600/40 bg-rose-950/20 p-4">
          <h2 className="text-sm font-semibold text-rose-200 flex items-center gap-2">
            <AlertTriangle size={16} aria-hidden="true" />
            Validation flagged {criticalIssues.length} problem{criticalIssues.length > 1 ? 's' : ''}
          </h2>
          <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-rose-100/90">
            {criticalIssues.slice(0, 8).map((m, i) => <li key={i}>{m}</li>)}
          </ul>
          <p className="mt-2 text-xs text-rose-200/70">
            If one of these is a VPN IP-leak, your torrent traffic is NOT going through the tunnel — fix it before downloading.
          </p>
        </div>
      )}

      {/* Service tile grid — each tile gets a staggered entrance + an
          icon (status circle) that animates between states. Clicking
          opens the service URL in the user's default browser. */}
      <div className="grid grid-cols-2 gap-3">
        {displayedServices.map((s, i) => {
          const url = `http://${ip}:${s.port}`
          const h = health[s.name] ?? 'unknown'
          const StatusIcon = h === 'ok' ? CheckCircle2 : h === 'fail' ? XCircle : Circle
          const statusColor =
            h === 'ok' ? 'text-emerald-400'
            : h === 'fail' ? 'text-rose-400'
            : 'text-slate-600'
          const ringColor =
            h === 'ok' ? 'hover:border-emerald-600/40 hover:bg-emerald-950/20'
            : h === 'fail' ? 'hover:border-rose-600/40 hover:bg-rose-950/20'
            : 'hover:border-slate-600 hover:bg-slate-800/70'
          const ServiceIcon = s.icon
          return (
            <motion.button
              key={s.name}
              type="button"
              onClick={() => open(url)}
              initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 + 0.025 * i, duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              whileHover={reduced ? {} : { y: -1 }}
              whileTap={reduced ? {} : { scale: 0.985 }}
              className={
                `text-left p-3 bg-slate-800/40 rounded-lg border border-slate-700 ` +
                `flex items-center gap-3 transition-colors focus:outline-none ` +
                `focus-visible:ring-2 focus-visible:ring-emerald-400/50 ${ringColor}`
              }
            >
              {/* Service-specific icon tile — same vocabulary as the
                  Configure screen so users carry the mental model
                  across screens. */}
              <div className="shrink-0 w-9 h-9 rounded-md bg-slate-900/70 border border-slate-700/60 flex items-center justify-center" aria-hidden="true">
                <ServiceIcon size={20} className={s.iconColor} strokeWidth={1.75} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate text-base flex items-center gap-2">
                  {s.name}
                  {s.note && (
                    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      {s.note}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-400 font-mono truncate">{url}</div>
              </div>
              {/* StatusIcon stays VISIBLE (the dot is the at-a-glance
                  health signal) but it's aria-hidden because we expose
                  the same info textually in a sr-only span below — keeps
                  screen readers from voicing both "checkmark" + "ok". */}
              <StatusIcon size={18} className={`shrink-0 ${statusColor}`} strokeWidth={2} aria-hidden="true" />
              <span className="sr-only">
                Status: {h === 'ok' ? 'healthy' : h === 'fail' ? 'not responding' : 'unknown'}
              </span>
              <ExternalLink size={16} className="text-slate-500 shrink-0" aria-hidden="true" />
            </motion.button>
          )
        })}
      </div>

      <details className="rounded-md border border-slate-800 group">
        <summary className="cursor-pointer p-3 text-sm font-medium flex items-center justify-between gap-2 [&::-webkit-details-marker]:hidden hover:bg-slate-800/40 transition-colors rounded-t-md">
          <span className="inline-flex items-center gap-2">
            <ChevronDown
              size={16}
              className="text-slate-500 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
            <FileText size={16} className="text-slate-400" strokeWidth={1.75} aria-hidden="true" />
            Validation log
            {exit !== null && (
              <span className={`ml-1 text-xs ${exit === 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
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
            the {mediaServer === 'jellyfin' ? 'Jellyseerr' : 'Seerr'} wizard. Connect{' '}
            {mediaServer === 'jellyfin' ? (
              <>Jellyfin with the URL <span className="font-mono">http://jellyfin:8096</span></>
            ) : (
              <>Plex with the URL <span className="font-mono">http://plex:32400</span></>
            )}.
          </li>
          {mediaServer === 'jellyfin' && (
            <li>
              Finish Jellyfin&apos;s first-run setup at{' '}
              <span className="font-mono text-emerald-400">http://{ip}:8096</span> (admin
              user + libraries pointing at <span className="font-mono">/media</span>). For
              auto library-refresh on import, generate an API key (Dashboard → API Keys),
              add it as <span className="font-mono">JELLYFIN_API_KEY</span> in .env, and
              re-run <span className="font-mono">setup-arr-config.py</span>.
            </li>
          )}
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
          {mediaServer === 'jellyfin' ? (
            <li>
              Sonarr/Radarr/Lidarr → Jellyfin library refresh is wired (once
              <span className="font-mono"> JELLYFIN_API_KEY</span> is set), so Jellyfin
              rescans the moment a download is imported.
            </li>
          ) : (
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
          )}
          {config.USENET_HOST && (
            <li>
              SABnzbd usenet provider <span className="font-mono">{config.USENET_HOST}</span>
              {' '}was added. Verify connections at
              {' '}<span className="font-mono text-emerald-400">http://{ip}:49155 → Status</span>.
            </li>
          )}
          <li>
            Boot resilience was set up where your platform supports it — the
            stack auto-starts in dependency order on reboot, so qBittorrent
            doesn&rsquo;t get stranded on &ldquo;must join at least one
            network.&rdquo; If the install log showed a{' '}
            <span className="font-mono">⚠</span> or{' '}
            <span className="font-mono">ℹ</span> for this step (e.g. QNAP, or a
            non-root run), wire the boot task manually using the steps it printed.
            {(config.VPN_ENABLED ?? 'false').toLowerCase() === 'true' &&
              isEnabled(config.ENABLE_QBITTORRENT as string | undefined) && (
              <>{' '}A self-heal task also recovers qBittorrent automatically if
              gluetun is ever recreated under it (after a VPN update or crash).</>
            )}
          </li>
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
        <div className="flex-1 text-sm text-center" role="status" aria-live="polite">
          {healthEntries.length === 0 ? (
            <span className="text-slate-500 inline-flex items-center gap-1.5">
              <Circle size={14} className="text-slate-600" aria-hidden="true" />
              Validation pending
            </span>
          ) : failCount === 0 ? (
            <span className="text-emerald-300 inline-flex items-center gap-1.5">
              <CheckCircle2 size={16} aria-hidden="true" />
              All {okCount} services reachable
            </span>
          ) : (
            <span className="text-amber-300 inline-flex items-center gap-1.5">
              <CheckCircle2 size={16} className="text-emerald-400" aria-hidden="true" />
              {okCount} reachable,
              <XCircle size={16} className="text-rose-400" aria-hidden="true" />
              {failCount} not — see grid above
            </span>
          )}
        </div>
        <BigButton
          size="md"
          variant="secondary"
          icon={<RotateCcw size={16} />}
          onClick={reset}
          title="Clear this session and start completely fresh (forgets the loaded profile selection)"
        >
          Start over
        </BigButton>
        <BigButton
          size="md"
          variant="primary"
          icon={<CheckCircle2 size={16} />}
          onClick={() => useWizard.getState().setStep('welcome')}
          title="Back to the home screen — your saved profile is kept, so you can run an update or open another NAS next"
        >
          Done
        </BigButton>
      </div>
    </div>
    </div>
  )
}
