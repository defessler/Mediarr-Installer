import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import confetti from 'canvas-confetti'
import {
  ExternalLink, RefreshCw, CheckCircle2, XCircle, Circle, RotateCcw,
  FileText, ChevronDown,
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

  const reduced = useReducedMotion()
  const installSucceeded = exit === 0 || (failCount === 0 && okCount > 0)

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
          {installSucceeded ? 'You did it!' : 'Setup complete'}
        </h1>
        <p className="text-slate-400 mt-3 text-base max-w-md mx-auto">
          {installSucceeded
            ? 'Your media stack is live. Click any service below to open it.'
            : 'Some services need a closer look — the grid below shows what\'s up.'}
        </p>
        <div className="mt-5 flex items-center justify-center gap-3">
          <BigButton
            size="md"
            variant="secondary"
            icon={<RefreshCw size={16} />}
            loading={running}
            onClick={runValidate}
          >
            {running ? 'Checking...' : 'Re-check health'}
          </BigButton>
        </div>
      </motion.header>

      {/* Service tile grid — each tile gets a staggered entrance + an
          icon (status circle) that animates between states. Clicking
          opens the service URL in the user's default browser. */}
      <div className="grid grid-cols-2 gap-3">
        {SERVICES.map((s, i) => {
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
                <ServiceIcon size={18} className={s.iconColor} strokeWidth={1.75} />
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
              <StatusIcon size={16} className={`shrink-0 ${statusColor}`} strokeWidth={2} aria-hidden="true" />
              <span className="sr-only">
                Status: {h === 'ok' ? 'healthy' : h === 'fail' ? 'not responding' : 'unknown'}
              </span>
              <ExternalLink size={14} className="text-slate-500 shrink-0" aria-hidden="true" />
            </motion.button>
          )
        })}
      </div>

      <details className="rounded-md border border-slate-800 group">
        <summary className="cursor-pointer p-3 text-sm font-medium flex items-center justify-between gap-2 [&::-webkit-details-marker]:hidden hover:bg-slate-800/40 transition-colors rounded-t-md">
          <span className="inline-flex items-center gap-2">
            <ChevronDown
              size={14}
              className="text-slate-500 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
            <FileText size={14} className="text-slate-400" strokeWidth={1.75} aria-hidden="true" />
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
        <div className="flex-1 text-sm text-center" role="status" aria-live="polite">
          {healthEntries.length === 0 ? (
            <span className="text-slate-500 inline-flex items-center gap-1.5">
              <Circle size={12} className="text-slate-600" aria-hidden="true" />
              Validation pending
            </span>
          ) : failCount === 0 ? (
            <span className="text-emerald-300 inline-flex items-center gap-1.5">
              <CheckCircle2 size={14} aria-hidden="true" />
              All {okCount} services reachable
            </span>
          ) : (
            <span className="text-amber-300 inline-flex items-center gap-1.5">
              <CheckCircle2 size={14} className="text-emerald-400" aria-hidden="true" />
              {okCount} reachable,
              <XCircle size={14} className="text-rose-400" aria-hidden="true" />
              {failCount} not — see grid above
            </span>
          )}
        </div>
        <BigButton
          size="md"
          variant="secondary"
          icon={<RotateCcw size={14} />}
          onClick={reset}
        >
          Start over
        </BigButton>
      </div>
    </div>
    </div>
  )
}
