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
      // The remote command does the same .env-aware compose-files +
      // COMPOSE_PROFILES dance that setup.sh does, inlined as bash so
      // we don't have to source the wizard's script. Without this:
      //   - profile-gated services (everything but prowlarr + flare-
      //     solverr after the flexibility-pass change) wouldn't be in
      //     the start set, so `up -d` would no-op on them and they'd
      //     stay running on stale images even after the `pull`;
      //   - users with VPN_ENABLED=false would see qBittorrent get
      //     reconfigured to use service:gluetun (the base file's
      //     network_mode) because the no-vpn override wasn't applied,
      //     and qBittorrent would die trying to share the namespace of
      //     a gluetun container that isn't profile-active.
      //
      // The is_enabled() bash helper matches env-render's isEnabled()
      // and setup.sh's identically-named helper: default-on, only
      // explicit false/0/no/off opts out.
      //
      // --progress plain + --ansi never keep docker compose's output
      // line-per-event instead of the fancy spinner display, which
      // floods the log panel with 16-line redraw frames every 100ms.
      // COMPOSE_PROGRESS / COMPOSE_ANSI are belt-and-suspenders for
      // older compose versions that ignore the CLI flags.
      const composeUpdate = `\
env_val() { grep -m1 "^$1=" .env 2>/dev/null | cut -d'=' -f2- | sed 's/#.*//' | tr -d '\\r' | xargs; }
is_enabled() {
  local v="$(env_val "$1" | tr '[:upper:]' '[:lower:]')"
  case "$v" in false|0|no|off) return 1 ;; *) return 0 ;; esac
}

# Compose file list: base + no-vpn override when VPN is off (default).
VPN="$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]')"
FILES="-f docker-compose.yml"
case "$VPN" in true|1|yes|on) ;; *) FILES="$FILES -f docker-compose.no-vpn.yml" ;; esac

# COMPOSE_PROFILES from the same ENABLE_* flags setup.sh uses.
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

      {/* All three buttons always rendered, disabled with a tooltip
          explaining the gate when they're not applicable to the
          current phase. */}
      <div className="flex justify-between items-center gap-3">
        <button
          onClick={() => setStep('welcome')}
          disabled={phase === 'running'}
          title={
            phase === 'running'
              ? 'Wait for the update to finish before going back'
              : 'Return to the welcome screen'
          }
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40 text-sm"
        >
          Back to start
        </button>
        <div className="flex-1 text-sm text-center text-slate-400">
          {phase === 'idle' && 'Ready to pull newer images'}
          {phase === 'running' && 'Pulling images and recreating containers...'}
          {phase === 'done' && '✓ Update complete — click Continue'}
          {phase === 'failed' && '✘ Update failed — see log, then Retry'}
        </div>
        <button
          onClick={go}
          disabled={phase === 'running' || phase === 'done'}
          title={
            phase === 'running'
              ? 'Already pulling images — wait for it to finish'
              : phase === 'done'
                ? 'Update succeeded — nothing to re-run'
                : phase === 'failed'
                  ? 'Try the pull and recreate again'
                  : 'Pull newer images and recreate the containers'
          }
          className="px-4 py-2 bg-sky-600 hover:bg-sky-500 rounded-md disabled:opacity-40 text-sm"
        >
          {phase === 'failed' ? 'Retry' : 'Pull and recreate'}
        </button>
        <button
          onClick={() => setStep('done')}
          disabled={phase !== 'done'}
          title={
            phase === 'done'
              ? 'Continue to the post-update dashboard'
              : phase === 'failed'
                ? 'Update failed — Retry first'
                : 'Available once the update completes'
          }
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-40 text-sm"
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
