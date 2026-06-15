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
import { motion, useReducedMotion } from 'motion/react'
import { RefreshCw, ArrowLeft, ArrowRight, CheckCircle2, AlertCircle, Play } from 'lucide-react'
import { BigButton } from '../components/BigButton.js'
import { useWizard } from '../store/wizard.js'
import { LogPanel } from '../components/LogPanel.js'
import { LogActions } from '../components/LogActions.js'
import { PATH_PREFIX } from '../../shared/synology-path.js'
import { reportError } from '../store/errors.js'
import { SETUP_STEPS } from '../components/StepperRail.js'

const CHANNEL_ID = 'compose-update'

/** Helper sidecar containers that mount wizard-shipped scripts as
 *  single-file volumes (e.g. recyclarr-trigger reads recyclarr-trigger.py
 *  ONCE at startup). After every payload sync we restart any of these
 *  that's currently running so the new code takes effect — file mounts
 *  are visible to the container immediately, but the Python process
 *  keeps the old request-handler code loaded until it restarts.
 *
 *  Explicit list (no wildcard / no `docker compose restart`) so we never
 *  accidentally bounce a media container. The main arrs / Plex / qBit
 *  don't need this — their /config volumes hold runtime state, not
 *  wizard scripts. Add new entries here when a future helper sidecar
 *  is added with a similar single-file-mount pattern. */
const HELPER_CONTAINERS: readonly string[] = ['recyclarr-trigger']

type Phase = 'idle' | 'running' | 'done' | 'failed'
type Action = 'full' | 'pull' | 'sync' | 'homepage' | `step-${number}` | null

export function UpdateRunScreen() {
  const { sessionId, targetDir, setStep, setBusy } = useWizard()
  const [phase, setPhase] = useState<Phase>('idle')
  const [lastAction, setLastAction] = useState<Action>(null)
  /** Whether the action controls (primary card + targeted-action grid) are
   *  shown. Collapsing them hands the full height to the log — which is what
   *  the user wants while a run streams. Auto-collapses when a run starts. */
  const [showActions, setShowActions] = useState(true)
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

  // Auto-collapse the action controls when a run starts so the log gets the
  // full height — that's when the user wants to watch output, not pick actions.
  // They can reopen them from the header toggle.
  useEffect(() => { if (phase === 'running') setShowActions(false) }, [phase])

  // Publish the global "busy" flag while a stack action streams, so the
  // in-place app-updater trigger in App.tsx is disabled — self-updating
  // quits the app, which would sever the live SSH action. Cleared on
  // done/failed and on unmount.
  useEffect(() => { setBusy(phase === 'running') }, [phase, setBusy])
  useEffect(() => () => setBusy(false), [setBusy])

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
      // v0.3.22 moved every script under scripts/ — clean up the old
      // loose copies at INSTALL_DIR root so the compose root stays
      // tidy. We delete a known whitelist of filenames, not a wildcard,
      // so a user's hand-placed file with an unrelated name survives.
      // Non-fatal: failures here just leave the orphan present.
      await cleanupLegacyLooseScripts()
      // Bounce any helper sidecar containers (recyclarr-trigger today)
      // so single-file mounts like recyclarr-trigger.py take effect
      // without a manual `docker restart`. Non-fatal: a failure here
      // doesn't fail the upload — the new file is already on disk and
      // the user can restart manually if needed.
      await restartHelperContainers()
      return true
    } catch (e) {
      const msg = (e as Error).message
      setErrorMsg(msg)
      setPhase('failed')
      reportError('SFTP upload', e)
      return false
    }
  }

  /** Delete the v0.3.21-and-earlier loose scripts at INSTALL_DIR root.
   *  The v0.3.22 payload puts them under scripts/, but Sync just adds
   *  new files — it doesn't remove anything. Without this step, an
   *  upgraded install ends up with both layouts present, which is
   *  ugly and risks the user accidentally running the stale loose
   *  copy. Whitelist of filenames so a hand-placed unrelated file is
   *  never touched. Non-fatal: failures (permission denied, etc.) log
   *  a warning but don't fail the Sync action. */
  async function cleanupLegacyLooseScripts(): Promise<void> {
    if (!sessionId) return
    // Closed set of historical loose-script filenames. New scripts must
    // not be added here — they ship under scripts/ from day one.
    const LEGACY_LOOSE = [
      'setup.sh',
      'setup-arr-config.py',
      'setup-chmod.sh',
      'setup-firewall.sh',
      'setup-folders.sh',
      'setup-nordvpn.sh',
      'setup-validate.sh',
      'post-deploy-validate.sh',
      'recyclarr-sync.sh',
      'recyclarr-trigger.py',
      'tune-arrs.sh',
      'fix-imports.sh',
      'boot-orchestrator.sh',
      'boot-orchestrator.log',
      'restart-qbit.sh',
      'stop-all.sh',
      '.setup.lock',
      '.boot-orchestrator.lock',
      // v0.3.23 moved the compose files + docs + .env.example into
      // scripts/. Add those to the cleanup so an upgrade from v0.3.22
      // doesn't leave them orphaned at the root. Note .env itself is
      // handled separately below — we MIGRATE it (preserve user's
      // secrets) instead of deleting.
      'docker-compose.yml',
      'docker-compose.no-vpn.yml',
      'docker-compose.test-override.yml',
      'INDEXERS.md',
      '.env.example',
      '.payload-sha',
    ]
    // Only run if scripts/ exists (i.e., the new layout actually
    // landed). Otherwise we'd nuke the live setup.sh and leave the
    // user with no scripts at all.
    try {
      const probe = await window.installer.ssh.exec({
        sessionId,
        sudo: true,
        cmd:
          PATH_PREFIX +
          `cd ${shellQuote(targetDir)} && ` +
          `if [ -d scripts ] && [ -f scripts/setup.sh ]; then echo ready; else echo skip; fi`,
      })
      if (probe.stdout.trim() !== 'ready') {
        wlog('Skipped cleanup of legacy loose scripts (scripts/ not present).')
        return
      }
    } catch (e) {
      wlog(`[warn] Could not probe scripts/ presence: ${(e as Error).message}`)
      return
    }
    // Two more entries: the indexers/ subfolder (legacy) and migration/
    // stays put — only delete indexers/ since it moved under scripts/.
    //
    // .env handling is special: it holds the user's secrets, so we
    // MIGRATE rather than nuke. If a root .env exists and scripts/.env
    // doesn't (Sync wrote it AFTER cleanup, or .env wasn't part of
    // the payload), move the file across so docker compose still has
    // its substitutions. If both exist, the canonical copy is
    // scripts/.env (Sync just landed it) — delete the stale root copy.
    const rmList = LEGACY_LOOSE.map((f) => shellQuote(f)).join(' ')
    try {
      const r = await window.installer.ssh.exec({
        sessionId,
        sudo: true,
        cmd:
          PATH_PREFIX +
          `cd ${shellQuote(targetDir)} && ` +
          `removed=0; ` +
          // .env migration (preserve user's secrets):
          `if [ -f .env ]; then ` +
          `  if [ -f scripts/.env ]; then ` +
          `    rm -f .env && removed=$((removed+1)); ` +
          `  else ` +
          `    mv .env scripts/.env && removed=$((removed+1)); ` +
          `  fi; ` +
          `fi; ` +
          // Loose .sh / .py files: delete by exact name when present.
          // No fallback — we just bulk-removed them all from the source
          // so anything left at root is stale.
          `for f in ${rmList}; do ` +
          `  if [ -f "$f" ]; then rm -f "$f" && removed=$((removed+1)); fi; ` +
          `done; ` +
          // Old indexers/ at root moved under scripts/indexers/.
          `if [ -d indexers ]; then rm -rf indexers && removed=$((removed+1)); fi; ` +
          `echo "[cleanup] migrated/removed $removed legacy loose entries"`,
      })
      const out = r.stdout.trim()
      if (out) wlog(out)
    } catch (e) {
      wlog(`[warn] Legacy-cleanup step failed: ${(e as Error).message}`)
    }
  }

  /** Re-up every container in HELPER_CONTAINERS that's currently
   *  running. We use `docker compose up -d --no-deps <name>` (NOT
   *  `docker restart`) for an important reason: restart preserves the
   *  EXISTING container's volume mounts, network config, and env. If
   *  the wizard ships a docker-compose.yml change that adds a new
   *  mount (e.g. ${INSTALL_DIR}:/install-dir:rw for recyclarr-trigger),
   *  a plain restart leaves the container running without the new
   *  mount and the freshly-uploaded Python code fails at runtime ("Could
   *  not save profile picks: .env not found at /install-dir/.env"). The
   *  compose-up path is smart enough to detect the spec changed and
   *  recreate just the changed container; if nothing changed, it's a
   *  cheap no-op restart instead.
   *
   *  --no-deps so recyclarr-trigger's recyclarr dependency doesn't get
   *  re-pulled / restarted along with it; we want surgical changes.
   *  We still probe with `docker ps --filter` first so a stopped helper
   *  isn't spuriously started — if the user disabled it intentionally
   *  we leave it alone. */
  async function restartHelperContainers(): Promise<void> {
    if (!sessionId) return
    for (const name of HELPER_CONTAINERS) {
      try {
        const r = await window.installer.ssh.exec({
          sessionId,
          // sudo: docker compose + docker ps both need root on most NAS
          // setups (Synology DSM in particular gates /var/run/docker.sock
          // behind the docker group, and the SSH user often isn't in it).
          // Mirrors the sudo:true used by execStream below.
          sudo: true,
          cmd:
            PATH_PREFIX +
            // v0.3.23+: docker-compose.yml + .env live in scripts/.
            // Fall back to targetDir root for pre-v0.3.23 layouts.
            `cd ${shellQuote(targetDir)} && ` +
            `if [ -f scripts/docker-compose.yml ]; then cd scripts; fi && ` +
            `if docker ps --filter name=^${name}$ --format '{{.Names}}' ` +
            `  | grep -qx ${shellQuote(name)}; then ` +
            // Detect VPN to pick the right override-file. Mirrors the
            // FILES logic in pullAndRecreate's composeUpdate script.
            `  VPN=$(grep -m1 '^VPN_ENABLED=' .env 2>/dev/null | cut -d= -f2- | tr -d '\\r' | tr '[:upper:]' '[:lower:]' | xargs); ` +
            `  FILES='-f docker-compose.yml'; ` +
            `  case "$VPN" in true|1|yes|on) ;; *) FILES="$FILES -f docker-compose.no-vpn.yml" ;; esac; ` +
            `  docker compose $FILES up -d --no-deps ${shellQuote(name)} 2>&1 && echo recreated; ` +
            `else ` +
            `  echo not-running; ` +
            `fi`,
        })
        const out = r.stdout.trim()
        // `docker compose up -d` emits its own status lines (e.g.
        // "Container recyclarr-trigger  Recreated" or "  Running"); we
        // append the final "recreated" sentinel to confirm success.
        if (out.endsWith('recreated')) {
          wlog(`Re-upped ${name} so any new compose mounts / env take effect.`)
        } else if (out === 'not-running') {
          wlog(`Skipped ${name} re-up — container is not running.`)
        } else if (r.exitCode !== 0) {
          wlog(`[warn] Re-up of ${name} returned exit ${r.exitCode}: ${(r.stderr || '').trim()}`)
        }
      } catch (e) {
        // Non-fatal — the upload already succeeded. Log a warning so the
        // user knows they may need to `docker compose up -d` manually.
        wlog(`[warn] Could not re-up ${name}: ${(e as Error).message}`)
      }
    }
  }

  /** The "just make my NAS current" action — the canonical way to deliver
   *  wizard fixes to an existing install. Syncs the bundled payload, then
   *  runs setup.sh END-TO-END against the .env ALREADY on the NAS. We do
   *  NOT re-render/overwrite .env here: that keeps every on-NAS value
   *  intact (notably the API keys the configurator discovered and wrote
   *  back, which the wizard form blanks). setup.sh is idempotent +
   *  REINSTALL_PRESERVE-aware, so this preserves data, configs and secrets
   *  while applying every script fix — and it's what installs the boot
   *  hook + qBittorrent self-heal for users who only ever click Update. */
  async function updateStack() {
    if (!sessionId || phase === 'running') return
    reset()
    setLastAction('full')
    setPhase('running')

    const synced = await syncPayload()
    if (!synced) return    // syncPayload already set phase=failed

    wlog('Re-running setup.sh against your existing .env (idempotent — your data, configs and secrets are preserved)...')
    try {
      await window.installer.ssh.execStream({
        sessionId,
        cmd:
          PATH_PREFIX +
          // v0.3.23+ keeps setup.sh under scripts/; fall back to the
          // install root for pre-v0.3.23 layouts that haven't migrated.
          `cd ${shellQuote(targetDir)} && ` +
          `if [ -f scripts/setup.sh ]; then cd scripts; fi && ` +
          `bash setup.sh`,
        sudo: true,
        channelId: CHANNEL_ID,
      })
    } catch (e) {
      setErrorMsg((e as Error).message)
      setPhase('failed')
      reportError('Update stack to latest', e)
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

MEDIA_SERVER="$(env_val MEDIA_SERVER | tr '[:upper:]' '[:lower:]')"
[ "$MEDIA_SERVER" = "jellyfin" ] || MEDIA_SERVER="plex"
P=()
is_enabled ENABLE_PLEX        && P+=("$MEDIA_SERVER")
is_enabled ENABLE_SONARR      && P+=("sonarr")
is_enabled ENABLE_RADARR      && P+=("radarr")
is_enabled ENABLE_LIDARR      && P+=("lidarr")
is_enabled ENABLE_BAZARR      && P+=("bazarr")
is_enabled ENABLE_SABNZBD     && P+=("usenet")
is_enabled ENABLE_HOMEPAGE    && P+=("homepage")
is_enabled ENABLE_RECYCLARR   && P+=("recyclarr")
is_enabled ENABLE_UNPACKERR   && P+=("unpackerr")
is_enabled ENABLE_FLARESOLVERR && P+=("flaresolverr")
if is_enabled ENABLE_QBITTORRENT; then
  P+=("torrenting")
  case "$VPN" in true|1|yes|on) P+=("vpn") ;; esac
fi
[ "\${#P[@]}" -gt 0 ] && export COMPOSE_PROFILES="$(IFS=,; echo "\${P[*]}")"

echo "[wizard-update] compose files: $FILES"
echo "[wizard-update] profiles: \${COMPOSE_PROFILES:-(none — only Prowlarr + Flaresolverr)}"

# Reinstall-conflict guards (mirror setup.sh's reconcile). qBittorrent's
# network mode is IMMUTABLE on a live container, so a VPN toggle leaves the
# running qBit in the wrong mode → "container name /qbittorrent already in
# use" / "port is already allocated"; and a now-orphan gluetun (VPN off)
# still holds qBit's published port. Reap both so the up -d below is clean.
case "$VPN" in true|1|yes|on) VPN_ON=1 ;; *) VPN_ON=0 ;; esac
if [ "$VPN_ON" = 0 ] && docker ps -a --format '{{.Names}}' | grep -qx gluetun; then
  docker stop gluetun >/dev/null 2>&1 || true; docker rm gluetun >/dev/null 2>&1 || true
  echo "[wizard-update] removed stale gluetun (VPN off — it held qBittorrent's port)"
fi
if is_enabled ENABLE_QBITTORRENT && docker ps -a --format '{{.Names}}' | grep -qx qbittorrent; then
  QBM="$(docker inspect -f '{{.HostConfig.NetworkMode}}' qbittorrent 2>/dev/null || echo '')"
  MM=0
  if [ "$VPN_ON" = 1 ]; then case "$QBM" in container:*) ;; *) MM=1 ;; esac
  else case "$QBM" in container:*) MM=1 ;; esac; fi
  if [ "$MM" = 1 ]; then
    docker stop qbittorrent >/dev/null 2>&1 || true; docker rm qbittorrent >/dev/null 2>&1 || true
    echo "[wizard-update] removed qBittorrent to recreate in the correct network mode (VPN toggled)"
  fi
fi

export COMPOSE_PROGRESS=plain COMPOSE_ANSI=never DOCKER_CLI_HINTS=false
docker compose $FILES --progress plain --ansi never pull && \\
docker compose $FILES --progress plain --ansi never up -d
UP_RC=$?

# Post-up: the pull may have recreated gluetun with a new id; a still-running
# qBittorrent welded to the OLD id is now on a dead namespace. Recreate it
# once so it rejoins the live gluetun (same fix restart-qbit.sh applies).
if [ "$VPN_ON" = 1 ] && is_enabled ENABLE_QBITTORRENT; then
  NM="$(docker inspect -f '{{.HostConfig.NetworkMode}}' qbittorrent 2>/dev/null || echo '')"
  GID="$(docker inspect -f '{{.Id}}' gluetun 2>/dev/null || echo '')"
  case "$NM" in container:*) NM="$(printf '%s' "$NM" | cut -d: -f2-)" ;; *) NM="" ;; esac
  if [ -n "$NM" ] && [ -n "$GID" ] && [ "$NM" != "$GID" ]; then
    echo "[wizard-update] qBittorrent on a stale gluetun namespace — recreating it"
    docker rm -f qbittorrent >/dev/null 2>&1 || true
    docker compose $FILES --progress plain --ansi never up -d gluetun qbittorrent
    UP_RC=$?
  fi
fi
exit $UP_RC`

    try {
      await window.installer.ssh.execStream({
        sessionId,
        cmd:
          PATH_PREFIX +
          // v0.3.23+: compose lives in scripts/. Fall back to root for
          // pre-v0.3.23 installs that haven't migrated yet.
          `cd ${shellQuote(targetDir)} && ` +
          `if [ -f scripts/docker-compose.yml ]; then cd scripts; fi && ` +
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

  /** Sync payload + regenerate Homepage's services.yaml + settings.yaml
   *  from the user's current .env. Targeted fix for "I enabled a
   *  service but its tile isn't on the dashboard" and "I re-ran the
   *  wizard but the dashboard layout didn't change" — both of which
   *  trace back to a stale services.yaml left behind by older builds
   *  whose generator was skip-if-exists.
   *
   *  Uses setup-arr-config.py's --homepage-only CLI flag which:
   *    1. Force-deletes services.yaml + settings.yaml
   *    2. Re-renders both from .env (with the current ENABLE_* + TRASH_*
   *       picks reflected in the new section / tile content)
   *    3. Skips every per-service API call main() makes — fast (<1s)
   *       and can't accidentally cycle a running arr.
   *
   *  Homepage watches its config dir for changes, so the user just
   *  refreshes their browser to see the new tiles — no container
   *  restart needed. */
  async function refreshDashboard() {
    if (!sessionId || phase === 'running') return
    reset()
    setLastAction('homepage')
    setPhase('running')

    // Sync first so the --homepage-only flag (added in a later
    // wizard version) is present on the NAS. Users on a pre-flag
    // payload would otherwise get "unrecognised argument" and the
    // run would fail. syncPayload sets phase=failed + reports on
    // its own; bail without further work if it returns false.
    const synced = await syncPayload()
    if (!synced) return

    wlog('Regenerating Homepage services.yaml + settings.yaml from .env...')
    try {
      await window.installer.ssh.execStream({
        sessionId,
        cmd:
          PATH_PREFIX +
          `cd ${shellQuote(targetDir)} && ` +
          // v0.3.22 layout puts setup-arr-config.py under scripts/.
          // Legacy installs (loose at INSTALL_DIR) get the fallback.
          `if [ -f scripts/setup-arr-config.py ]; then ` +
          `  python3 scripts/setup-arr-config.py --homepage-only; ` +
          `else ` +
          `  python3 setup-arr-config.py --homepage-only; ` +
          `fi`,
        sudo: true,
        channelId: CHANNEL_ID,
      })
    } catch (e) {
      setErrorMsg((e as Error).message)
      setPhase('failed')
      reportError('Refresh dashboard', e)
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
MEDIA_SERVER="$(env_val MEDIA_SERVER | tr '[:upper:]' '[:lower:]')"
[ "$MEDIA_SERVER" = "jellyfin" ] || MEDIA_SERVER="plex"
P=()
is_enabled ENABLE_PLEX        && P+=("$MEDIA_SERVER")
is_enabled ENABLE_SONARR      && P+=("sonarr")
is_enabled ENABLE_RADARR      && P+=("radarr")
is_enabled ENABLE_LIDARR      && P+=("lidarr")
is_enabled ENABLE_BAZARR      && P+=("bazarr")
is_enabled ENABLE_SABNZBD     && P+=("usenet")
is_enabled ENABLE_HOMEPAGE    && P+=("homepage")
is_enabled ENABLE_RECYCLARR   && P+=("recyclarr")
is_enabled ENABLE_UNPACKERR   && P+=("unpackerr")
is_enabled ENABLE_FLARESOLVERR && P+=("flaresolverr")
if is_enabled ENABLE_QBITTORRENT; then
  P+=("torrenting")
  case "$VPN" in true|1|yes|on) P+=("vpn") ;; esac
fi
[ "\${#P[@]}" -gt 0 ] && export COMPOSE_PROFILES="$(IFS=,; echo "\${P[*]}")"
export COMPOSE_PROGRESS=plain COMPOSE_ANSI=never DOCKER_CLI_HINTS=false
docker compose $FILES --progress plain --ansi never up -d`
      // v0.3.23+: compose lives in scripts/; cd there for the
      // docker-compose.yml / docker-compose.no-vpn.yml + .env to be
      // picked up correctly. Fall back to targetDir root for older
      // layouts.
      cmd =
        PATH_PREFIX +
        `cd ${shellQuote(targetDir)} && ` +
        `if [ -f scripts/docker-compose.yml ]; then cd scripts; fi && ` +
        `bash -c ${shellQuote(composeUp)}`
    } else {
      // step.rerun uses scripts/... paths (v0.3.22+ layout). Wrap in
      // a layout-aware guard so the same command works against
      // pre-v0.3.22 (loose scripts at root) AND v0.3.23+ where the
      // SCRIPT cwd matters less because step.rerun has the path
      // baked in.
      const legacyRerun = step.rerun
        .replace(/^bash scripts\//, 'bash ')
        .replace(/^python3 scripts\//, 'python3 ')
      const guard =
        `if [ -d scripts ]; then ${step.rerun}; ` +
        `else ${legacyRerun}; fi`
      cmd = PATH_PREFIX + `cd ${shellQuote(targetDir)} && bash -c ${shellQuote(guard)}`
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
    lastAction === 'full' ? 'Update stack to latest'
    : lastAction === 'pull' ? 'Pull + recreate containers'
    : lastAction === 'sync' ? 'Sync wizard scripts'
    : lastAction === 'homepage' ? 'Refresh dashboard'
    : lastAction && lastAction.startsWith('step-')
      ? `Re-run step ${lastAction.slice(5)}`
      : null

  const reduced = useReducedMotion()
  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <motion.header
        initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="flex items-center justify-between gap-4"
      >
        <div className="flex items-center gap-3">
          <div className="shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-sky-500/20 to-sky-700/30 border border-sky-500/30 flex items-center justify-center">
            <RefreshCw
              size={24}
              className={`text-sky-300 ${phase === 'running' && !reduced ? 'animate-spin' : ''}`}
              strokeWidth={2}
              aria-hidden="true"
            />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Update your stack</h1>
            <p className="text-sm text-slate-400 mt-0.5">
              Pick what to refresh — your <code className="font-mono bg-slate-800 px-1 rounded">.env</code>
              {' '}and container data are untouched.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowActions((v) => !v)}
            className="text-xs px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors shrink-0"
            title={showActions ? 'Hide the update controls to see more of the log' : 'Show the update actions'}
          >
            {showActions ? 'Hide actions ▴' : 'Show actions ▾'}
          </button>
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
      </motion.header>

      {showActions && (<>
      {/* Primary update path — what most users want: bring the NAS fully
          current (latest scripts + a full idempotent setup.sh re-run)
          without re-walking the whole Configure wizard. This is the only
          action that runs setup.sh end-to-end, so it's how script fixes
          (incl. the qBittorrent boot hook + self-heal) reach an existing
          install. Sits above the targeted actions. */}
      <section className="shrink-0">
        <div className="rounded-lg border border-emerald-600/40 bg-emerald-950/20 p-4 flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-base text-emerald-200">Update stack to latest</h3>
            <p className="text-sm text-slate-300 mt-1">
              Syncs the newest wizard scripts and re-runs{' '}
              <code className="font-mono bg-slate-800 px-1 rounded">setup.sh</code> against your existing{' '}
              <code className="font-mono bg-slate-800 px-1 rounded">.env</code> — applies every fix (including the
              qBittorrent boot &amp; self-heal hooks) while preserving your data, configs and secrets.
            </p>
            <p className="text-xs text-slate-400 mt-1 italic">
              The recommended way to pick up a new wizard release. Idempotent — safe to run anytime.
            </p>
          </div>
          <BigButton
            size="md"
            variant="primary"
            onClick={updateStack}
            disabled={running}
            loading={running && lastAction === 'full'}
            icon={!(running && lastAction === 'full') ? <Play size={15} fill="currentColor" /> : undefined}
          >
            {running && lastAction === 'full' ? 'Updating…' : 'Update to latest'}
          </BigButton>
        </div>
      </section>

      <p className="text-xs text-slate-500 shrink-0 -mb-1">Or run a targeted action:</p>

      {/* Action picker — four cards in a 2x2 grid. Disabled while one
          is running so the user can't kick off a second action mid-
          flight (they'd race against the same stream channel). 2x2
          gives each card enough width for descriptive text without
          truncation; 1280px window splits cleanly into ~600px columns. */}
      <section className="grid grid-cols-2 gap-3 shrink-0">
        <ActionCard
          title="Pull + recreate containers"
          subtitle="Fetch newer images and recreate any container whose image changed."
          when="When you want the latest Sonarr/Radarr/Plex/etc. binaries."
          buttonLabel={running && lastAction === 'pull' ? 'Pulling…' : 'Pull + recreate'}
          onClick={pullAndRecreate}
          disabled={running}
          accent="sky"
          running={running && lastAction === 'pull'}
        />
        <ActionCard
          title="Sync wizard scripts"
          subtitle="Re-upload setup.sh / setup-arr-config.py / setup-indexers.py / recyclarr-trigger.py from this wizard's bundled payload, then restart helper sidecars (recyclarr-trigger) so file-mount changes take effect."
          when="When the wizard itself was updated and the on-NAS scripts (or the Recyclarr 'Sync Now' page) are stale, but you don't want to re-run anything yet."
          buttonLabel={running && lastAction === 'sync' ? 'Uploading…' : 'Sync scripts'}
          onClick={syncOnly}
          disabled={running}
          accent="slate"
          running={running && lastAction === 'sync'}
        />
        <ActionCard
          title="Refresh dashboard"
          subtitle="Regenerate Homepage's services.yaml + settings.yaml from your current .env (.env's ENABLE_* / TRASH_* picks)."
          when="When you enabled a service after the first install and its tile isn't on the Homepage dashboard. Fast (<1s) and won't restart any container."
          buttonLabel={running && lastAction === 'homepage' ? 'Refreshing…' : 'Refresh dashboard'}
          onClick={refreshDashboard}
          disabled={running}
          accent="emerald"
          running={running && lastAction === 'homepage'}
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
              aria-label="Pick a setup.sh step to re-run"
              value={stepToRerun}
              onChange={(e) => setStepToRerun(Number(e.target.value))}
              disabled={running}
              className="flex-1 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs disabled:opacity-50 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 transition-colors"
            >
              {SETUP_STEPS.map((s) => (
                <option key={s.number} value={s.number}>
                  {s.number}. {s.label}
                </option>
              ))}
            </select>
            <BigButton
              size="sm"
              variant="danger"
              icon={!(running && lastAction === `step-${stepToRerun}`) ? <Play size={13} fill="currentColor" /> : undefined}
              onClick={() => rerunStep(stepToRerun)}
              disabled={running}
              loading={running && lastAction === `step-${stepToRerun}`}
            >
              Run step
            </BigButton>
          </div>
        </div>
      </section>
      </>)}

      <div className="flex-1 min-h-0">
        <LogPanel lines={linesRef.current} />
      </div>

      {/* Footer: Back / Continue. Each action sets phase=done on
          success — Continue stays gated on done so user only advances
          once SOMETHING completed cleanly. */}
      <div className="flex justify-between items-center gap-3">
        <BigButton
          size="md"
          variant="secondary"
          icon={<ArrowLeft size={18} />}
          onClick={() => setStep('welcome')}
          disabled={running}
          title={
            running
              ? 'Wait for the in-flight action to finish before going back'
              : 'Return to the welcome screen'
          }
        >
          Back to start
        </BigButton>
        <div className="flex-1 text-sm text-center text-slate-400" role="status" aria-live="polite">
          {phase === 'idle' && 'Pick an action above'}
          {phase === 'running' && `${lastActionLabel} in progress…`}
          {phase === 'done' && (
            <span className="inline-flex items-center gap-1.5 text-emerald-300">
              <CheckCircle2 size={16} aria-hidden="true" /> {lastActionLabel} complete
            </span>
          )}
          {phase === 'failed' && (
            <span className="inline-flex items-center gap-1.5 text-amber-200/90">
              <AlertCircle size={16} aria-hidden="true" /> {lastActionLabel} paused — see log
            </span>
          )}
        </div>
        <BigButton
          size="md"
          variant={phase === 'done' ? 'primary' : 'secondary'}
          trailingIcon={<ArrowRight size={18} />}
          onClick={() => setStep('done')}
          disabled={phase !== 'done'}
          title={
            phase === 'done'
              ? 'Continue to the post-update dashboard'
              : phase === 'failed'
                ? 'Action paused — try again first'
                : 'Available once an action completes'
          }
        >
          Continue
        </BigButton>
      </div>
    </div>
  )
}

function ActionCard({
  title, subtitle, when, buttonLabel, onClick, disabled, accent, running,
}: {
  title: string
  subtitle: string
  when: string
  buttonLabel: string
  onClick: () => void
  disabled: boolean
  accent: 'sky' | 'slate' | 'emerald'
  running?: boolean
}) {
  // Accent maps to the BigButton variant family. Hard-coded so Tailwind
  // purge keeps the right classes — dynamic `bg-${accent}-…` would be
  // stripped at build time.
  const variant: 'primary' | 'secondary' =
    accent === 'emerald' || accent === 'sky' ? 'primary' : 'secondary'
  const borderCls =
    accent === 'sky'     ? 'border-sky-700/40 hover:border-sky-600/50'
    : accent === 'emerald' ? 'border-emerald-700/40 hover:border-emerald-600/50'
    : 'border-slate-700 hover:border-slate-600'
  return (
    <div className={`rounded-lg border ${borderCls} bg-slate-900/40 p-3 space-y-2 flex flex-col transition-colors`}>
      <h3 className="font-medium text-sm">{title}</h3>
      <p className="text-xs text-slate-400">{subtitle}</p>
      <p className="text-xs text-slate-500 italic mt-auto">{when}</p>
      <BigButton
        size="sm"
        variant={variant}
        onClick={onClick}
        disabled={disabled}
        loading={running}
        icon={!running ? <Play size={13} fill="currentColor" /> : undefined}
      >
        {buttonLabel}
      </BigButton>
    </div>
  )
}

// Shell-quote a string for safe inline insertion into a bash command.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
