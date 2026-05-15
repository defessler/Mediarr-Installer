// Update Stack flow — three distinct actions over an existing install,
// for the cases where the user doesn't want a full Configure-then-Run
// re-install but does want to update SOMETHING:
//
//   1. Pull + recreate containers — refresh docker images, recreate
//      anything whose image hash changed. Doesn't touch the wizard's
//      payload files on the NAS.
//
//   2. Sync wizard scripts — re-upload the bundled nas/ payload
//      (setup.sh, setup-arr-config.py, setup-indexers.py, etc.) to
//      the NAS. Used when the WIZARD itself shipped an update and
//      the on-NAS scripts are stale, but the user doesn't want to
//      re-run anything yet.
//
//   3. Re-run a step — pick one of setup.sh's 10 steps. Auto-syncs
//      scripts first so the step runs against the latest version,
//      then exec's the matching command. Used for "the wizard added
//      a forceSave fix to setup-indexers.py and I want to re-add the
//      indexers without redoing everything else".
//
// State: a single Phase + a `lastAction` label that tells the user
// which action they just kicked off. All three buttons are exclusive
// — only one action can run at a time, the others get disabled while
// one's in flight.

import { useEffect, useRef, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import { LogPanel } from '../components/LogPanel.js'
import { LogActions } from '../components/LogActions.js'
import { PATH_PREFIX } from '../../shared/synology-path.js'
import { reportError } from '../store/errors.js'
import { SETUP_STEPS } from '../components/StepperRail.js'

const CHANNEL_ID = 'compose-update'

type Phase = 'idle' | 'running' | 'done' | 'failed'
type Action = 'pull' | 'sync' | `step-${number}` | null

export function UpdateRunScreen() {
  const { sessionId, targetDir, setStep } = useWizard()
  const [phase, setPhase] = useState<Phase>('idle')
  const [lastAction, setLastAction] = useState<Action>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  /** Selected step in the dropdown — defaults to step 8 (the most common
   *  re-run reason now: pick up a new indexer-script fix). */
  const [stepToRerun, setStepToRerun] = useState<number>(8)
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

  /** Wizard-internal log line — distinguish from remote output by
   *  prefixing with [wizard]. Same convention as RunScreen. */
  function wlog(msg: string) {
    appendChunk(`\n[wizard] ${msg}\n`)
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

  // Reset on each action start so a previous run's output doesn't
  // confuse the user. We DON'T clear lastAction — the label "last
  // action: Pull + recreate" only flips when the new action starts
  // running, so the user sees what's about to happen.
  function reset() {
    setErrorMsg(null)
    linesRef.current = []
    setTick((t) => t + 1)
    setExitCode(null)
  }

  /** SFTP-only upload of the bundled nas/ payload to targetDir.
   *  No remote exec — just refreshes the scripts on disk. Returns
   *  true on success, false if upload failed (and sets phase=failed). */
  async function syncPayload(): Promise<boolean> {
    if (!sessionId) {
      setErrorMsg('No SSH session. Go back and reconnect.')
      setPhase('failed')
      return false
    }
    wlog('Uploading nas/ payload via SFTP...')
    const SFTP_TIMEOUT_MS = 5 * 60 * 1000
    try {
      const r = await Promise.race([
        window.installer.sftp.uploadDir({
          sessionId,
          localDir: '@payload',
          remoteDir: targetDir,
        }),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error(
              `SFTP upload didn't complete within ${SFTP_TIMEOUT_MS / 60_000} min.`,
            )),
            SFTP_TIMEOUT_MS,
          ),
        ),
      ])
      wlog(`Uploaded ${r.uploaded} files (${(r.bytesTotal / 1024).toFixed(1)} KiB)`)
      return true
    } catch (e) {
      const msg = (e as Error).message
      setErrorMsg(msg)
      setPhase('failed')
      reportError('SFTP upload', e)
      return false
    }
  }

  /** Pull newer images and recreate containers. Same .env-aware
   *  compose-files + COMPOSE_PROFILES dance setup.sh does, inlined
   *  as bash. Doesn't sync scripts first — this is purely about
   *  image freshness, not script freshness. */
  async function pullAndRecreate() {
    if (!sessionId || phase === 'running') return
    reset()
    setLastAction('pull')
    setPhase('running')

    // Inline bash — picks COMPOSE_PROFILES + compose-files from .env
    // so the right services start. See setup.sh for the canonical
    // version; this duplicates the logic minus the per-step run_step
    // wrapping. The is_enabled() helper matches env-render's
    // isEnabled() and setup.sh's identically-named helper.
    const composeUpdate = `\
env_val() { grep -m1 "^$1=" .env 2>/dev/null | cut -d'=' -f2- | sed 's/#.*//' | tr -d '\\r' | xargs; }
is_enabled() {
  local v="$(env_val "$1" | tr '[:upper:]' '[:lower:]')"
  case "$v" in false|0|no|off) return 1 ;; *) return 0 ;; esac
}

VPN="$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]')"
FILES="-f docker-compose.yml"
case "$VPN" in true|1|yes|on) ;; *) FILES="$FILES -f docker-compose.no-vpn.yml" ;; esac

P=()
is_enabled ENABLE_PLEX        && P+=("plex")
is_enabled ENABLE_SONARR      && P+=("sonarr")
is_enabled ENABLE_RADARR      && P+=("radarr")
is_enabled ENABLE_LIDARR      && P+=("lidarr")
is_enabled ENABLE_BAZARR      && P+=("bazarr")
is_enabled ENABLE_SABNZBD     && P+=("usenet")
is_enabled ENABLE_HOMEPAGE    && P+=("homepage")
is_enabled ENABLE_RECYCLARR   && P+=("recyclarr")
is_enabled ENABLE_UNPACKERR   && P+=("unpackerr")
if is_enabled ENABLE_QBITTORRENT; then
  P+=("torrenting")
  case "$VPN" in true|1|yes|on) P+=("vpn") ;; esac
fi
[ "\${#P[@]}" -gt 0 ] && export COMPOSE_PROFILES="$(IFS=,; echo "\${P[*]}")"

echo "[wizard-update] compose files: $FILES"
echo "[wizard-update] profiles: \${COMPOSE_PROFILES:-(none — only Prowlarr + Flaresolverr)}"

export COMPOSE_PROGRESS=plain COMPOSE_ANSI=never DOCKER_CLI_HINTS=false
docker compose $FILES --progress plain --ansi never pull && \\
docker compose $FILES --progress plain --ansi never up -d`

    try {
      await window.installer.ssh.execStream({
        sessionId,
        cmd:
          PATH_PREFIX +
          `cd ${shellQuote(targetDir)} && ` +
          `bash -c ${shellQuote(composeUpdate)}`,
        sudo: true,
        channelId: CHANNEL_ID,
      })
    } catch (e) {
      setErrorMsg((e as Error).message)
      setPhase('failed')
      reportError('Pull and recreate', e)
    }
  }

  /** SFTP-only payload sync, no remote exec. The user just wants
   *  fresh scripts on the NAS without running anything. Phase
   *  transitions are handled inline (no SSH stream-close event for
   *  a pure SFTP path) so the UI looks the same as the exec actions. */
  async function syncOnly() {
    if (!sessionId || phase === 'running') return
    reset()
    setLastAction('sync')
    setPhase('running')
    const ok = await syncPayload()
    // syncPayload already set phase=failed on error; only flip to done
    // on success since the SFTP path doesn't go through the SSH stream-
    // close handler that handles the exec actions.
    if (ok) {
      setExitCode(0)
      setPhase('done')
    }
  }

  /** Sync payload + run one of setup.sh's 10 step-rerun commands.
   *  Auto-syncs first so the step exec'd is always the latest version
   *  from the bundled payload — important when the user is updating
   *  TO get a wizard-side fix (e.g., the forceSave indexer change). */
  async function rerunStep(n: number) {
    if (!sessionId || phase === 'running') return
    const step = SETUP_STEPS.find((s) => s.number === n)
    if (!step?.rerun) return

    reset()
    setLastAction(`step-${n}` as Action)
    setPhase('running')

    // Step 1: sync scripts so the exec runs the latest code.
    const synced = await syncPayload()
    if (!synced) return    // syncPayload already set phase=failed

    wlog(`Running step ${n}: ${step.label}`)

    // Step 6 is "Start the stack" — `docker compose up -d` in the
    // SETUP_STEPS table. But that bare command doesn't include the
    // -f / COMPOSE_PROFILES flags our profile-gated services need.
    // For step 6 specifically, fall through to pullAndRecreate's
    // logic without the pull half. Other steps just exec their
    // rerun command directly.
    let cmd: string
    if (n === 6) {
      const composeUp = `\
env_val() { grep -m1 "^$1=" .env 2>/dev/null | cut -d'=' -f2- | sed 's/#.*//' | tr -d '\\r' | xargs; }
is_enabled() {
  local v="$(env_val "$1" | tr '[:upper:]' '[:lower:]')"
  case "$v" in false|0|no|off) return 1 ;; *) return 0 ;; esac
}
VPN="$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]')"
FILES="-f docker-compose.yml"
case "$VPN" in true|1|yes|on) ;; *) FILES="$FILES -f docker-compose.no-vpn.yml" ;; esac
P=()
is_enabled ENABLE_PLEX        && P+=("plex")
is_enabled ENABLE_SONARR      && P+=("sonarr")
is_enabled ENABLE_RADARR      && P+=("radarr")
is_enabled ENABLE_LIDARR      && P+=("lidarr")
is_enabled ENABLE_BAZARR      && P+=("bazarr")
is_enabled ENABLE_SABNZBD     && P+=("usenet")
is_enabled ENABLE_HOMEPAGE    && P+=("homepage")
is_enabled ENABLE_RECYCLARR   && P+=("recyclarr")
is_enabled ENABLE_UNPACKERR   && P+=("unpackerr")
if is_enabled ENABLE_QBITTORRENT; then
  P+=("torrenting")
  case "$VPN" in true|1|yes|on) P+=("vpn") ;; esac
fi
[ "\${#P[@]}" -gt 0 ] && export COMPOSE_PROFILES="$(IFS=,; echo "\${P[*]}")"
export COMPOSE_PROGRESS=plain COMPOSE_ANSI=never DOCKER_CLI_HINTS=false
docker compose $FILES --progress plain --ansi never up -d`
      cmd = PATH_PREFIX + `cd ${shellQuote(targetDir)} && bash -c ${shellQuote(composeUp)}`
    } else {
      cmd = PATH_PREFIX + `cd ${shellQuote(targetDir)} && ${step.rerun}`
    }

    try {
      await window.installer.ssh.execStream({
        sessionId, cmd, sudo: true, channelId: CHANNEL_ID,
      })
    } catch (e) {
      setErrorMsg((e as Error).message)
      setPhase('failed')
      reportError(`Re-run step ${n}`, e)
    }
  }

  const running = phase === 'running'
  const lastActionLabel =
    lastAction === 'pull' ? 'Pull + recreate containers'
    : lastAction === 'sync' ? 'Sync wizard scripts'
    : lastAction && lastAction.startsWith('step-')
      ? `Re-run step ${lastAction.slice(5)}`
      : null

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Update existing stack</h1>
          <p className="text-sm text-slate-400 mt-1">
            Three flavours of update against
            <code className="font-mono bg-slate-800 px-1 rounded mx-1">{targetDir}</code>.
            Your <code className="font-mono bg-slate-800 px-1 rounded">.env</code> and
            container config volumes are untouched throughout.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {linesRef.current.length > 0 && (
            <LogActions
              lines={linesRef.current}
              defaultName="mediarr-update.log"
              header={`exit=${exitCode ?? 'pending'} phase=${phase} lastAction=${lastAction ?? 'none'}`}
            />
          )}
          <div className="text-sm text-slate-400">
            {phase === 'idle' && 'Ready'}
            {phase === 'running' && `Running: ${lastActionLabel ?? '…'}`}
            {phase === 'done' && `${lastActionLabel} — complete`}
            {phase === 'failed' && (errorMsg ? `Failed: ${errorMsg.slice(0, 80)}` : `${lastActionLabel} exited ${exitCode}`)}
          </div>
        </div>
      </header>

      {/* Action picker — three cards laid out horizontally. Disabled
          while one is running so the user can't kick off a second
          action mid-flight (they'd race against the same stream
          channel). */}
      <section className="grid grid-cols-3 gap-3 shrink-0">
        <ActionCard
          title="Pull + recreate containers"
          subtitle="Fetch newer images and recreate any container whose image changed."
          when="When you want the latest Sonarr/Radarr/Plex/etc. binaries."
          buttonLabel={running && lastAction === 'pull' ? 'Pulling…' : 'Pull + recreate'}
          onClick={pullAndRecreate}
          disabled={running}
          accent="sky"
        />
        <ActionCard
          title="Sync wizard scripts"
          subtitle="Re-upload setup.sh / setup-arr-config.py / setup-indexers.py from this wizard's bundled payload."
          when="When the wizard itself was updated and the on-NAS scripts are stale, but you don't want to re-run anything yet."
          buttonLabel={running && lastAction === 'sync' ? 'Uploading…' : 'Sync scripts'}
          onClick={syncOnly}
          disabled={running}
          accent="slate"
        />
        <div className="rounded-md border border-slate-700 bg-slate-900/40 p-3 space-y-2 flex flex-col">
          <h3 className="font-medium text-sm">Re-run a step</h3>
          <p className="text-xs text-slate-400">
            Sync scripts then run one of setup.sh&apos;s 10 steps. Use when
            a wizard fix lives in a specific script and you want only
            that step to re-apply.
          </p>
          <p className="text-xs text-slate-500 italic mt-auto">
            E.g.: indexer-script update → step 8.
          </p>
          <div className="flex gap-2">
            <select
              value={stepToRerun}
              onChange={(e) => setStepToRerun(Number(e.target.value))}
              disabled={running}
              className="flex-1 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs disabled:opacity-50"
            >
              {SETUP_STEPS.map((s) => (
                <option key={s.number} value={s.number}>
                  {s.number}. {s.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => rerunStep(stepToRerun)}
              disabled={running}
              className="px-3 py-1.5 bg-amber-700/70 hover:bg-amber-600 disabled:opacity-40 rounded-md text-xs font-medium"
            >
              {running && lastAction === `step-${stepToRerun}` ? 'Running…' : 'Run step'}
            </button>
          </div>
        </div>
      </section>

      <div className="flex-1 min-h-0">
        <LogPanel lines={linesRef.current} />
      </div>

      {/* Footer: Back / Continue. Each action sets phase=done on
          success — Continue stays gated on done so user only advances
          once SOMETHING completed cleanly. */}
      <div className="flex justify-between items-center gap-3">
        <button
          onClick={() => setStep('welcome')}
          disabled={running}
          title={
            running
              ? 'Wait for the in-flight action to finish before going back'
              : 'Return to the welcome screen'
          }
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40 text-sm"
        >
          Back to start
        </button>
        <div className="flex-1 text-sm text-center text-slate-400">
          {phase === 'idle' && 'Pick an action above'}
          {phase === 'running' && `${lastActionLabel} in progress…`}
          {phase === 'done' && `✓ ${lastActionLabel} complete`}
          {phase === 'failed' && `✘ ${lastActionLabel} failed — see log`}
        </div>
        <button
          onClick={() => setStep('done')}
          disabled={phase !== 'done'}
          title={
            phase === 'done'
              ? 'Continue to the post-update dashboard'
              : phase === 'failed'
                ? 'Action failed — retry first'
                : 'Available once an action completes'
          }
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-40 text-sm"
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function ActionCard({
  title, subtitle, when, buttonLabel, onClick, disabled, accent,
}: {
  title: string
  subtitle: string
  when: string
  buttonLabel: string
  onClick: () => void
  disabled: boolean
  accent: 'sky' | 'slate'
}) {
  // Class strings hardcoded so Tailwind's purge keeps them; dynamic
  // `bg-${accent}-...` would get stripped at build.
  const btnCls = accent === 'sky'
    ? 'bg-sky-700/80 hover:bg-sky-600'
    : 'bg-slate-700 hover:bg-slate-600'
  return (
    <div className="rounded-md border border-slate-700 bg-slate-900/40 p-3 space-y-2 flex flex-col">
      <h3 className="font-medium text-sm">{title}</h3>
      <p className="text-xs text-slate-400">{subtitle}</p>
      <p className="text-xs text-slate-500 italic mt-auto">{when}</p>
      <button
        onClick={onClick}
        disabled={disabled}
        className={`${btnCls} disabled:opacity-40 rounded-md text-xs font-medium px-3 py-1.5`}
      >
        {buttonLabel}
      </button>
    </div>
  )
}

// Shell-quote a string for safe inline insertion into a bash command.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
