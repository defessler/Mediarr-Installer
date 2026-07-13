#!/bin/bash
# ── boot-orchestrator.sh — bring the stack up cleanly on NAS reboot ──
#
# Why this exists:
#
# qBittorrent uses `network_mode: container:gluetun` so all torrent
# traffic exits through the VPN. Docker enforces this hard at container-
# create time: if gluetun's network namespace doesn't exist yet, qBit's
# create errors with:
#
#   container must join at least one network
#
# On NAS reboot the docker daemon restarts every `unless-stopped`
# container in arbitrary order — qBittorrent often tries to start
# BEFORE gluetun's namespace is ready, hits the error, then enters
# Docker's exponential restart backoff (100ms → 200ms → 400ms → ...
# → several MINUTES between retries). Even after gluetun is healthy,
# qBit can stay stuck for 10+ minutes before its backoff timer elapses
# and the next restart attempt actually fires.
#
# `depends_on` in docker-compose.yml DOESN'T help at NAS boot because
# Docker's daemon doesn't honor compose semantics on its restart-policy
# path — only `docker compose up` does. So we need a script that runs
# at boot, waits for Docker to be ready, then invokes compose with the
# user's profile set. Compose then brings everything up respecting
# depends_on ordering.
#
# Wire it as a Synology Task Scheduler triggered task:
#
#   Control Panel → Task Scheduler → Create → Triggered Task →
#     User-defined script (run as root)
#     Event: Boot-up
#     Run command:
#       bash /volume1/docker/media/boot-orchestrator.sh
#
# After that, NAS reboots bring up the whole stack cleanly with no
# manual restart-qbit.sh required.
#
# Safe to re-run any time; idempotent because `compose up -d` only
# restarts containers whose config changed.

set -uo pipefail

# PATH for boot context. The DSM rc.d hook (and cron on every platform) runs
# with a stripped PATH that omits the container-runtime bin dirs, so a bare
# `command -v docker` returns false at boot — RT stays "docker", `docker info`
# fails the whole 5-min wait, and this orchestrator silently no-ops, letting
# qBittorrent hit the gluetun "must join at least one network" + restart-backoff
# wedge this script exists to prevent. Export the FULL set the codebase
# standardizes on (synology-path.ts / env-detector.ts): on modern DSM 7 docker
# lives under /var/packages/ContainerManager/target/usr/bin, older DSM under
# /var/packages/Docker/target/usr/bin, QNAP under container-station/bin.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/var/packages/ContainerManager/target/usr/bin:/var/packages/Docker/target/usr/bin:/share/CACHEDEV1_DATA/.qpkg/container-station/bin:/share/.qpkg/container-station/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Compose root depends on layout:
#   v0.3.23+ → .env + compose live next to this script in scripts/
#   v0.3.22  → at parent (scripts/ subfolder, compose at root)
#   legacy   → SCRIPT_DIR IS the install root (no scripts/)
# Lock + log files stay alongside the script itself so they're
# discoverable in either layout.
if [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/.env" ]; then
    COMPOSE_DIR="$SCRIPT_DIR"            # v0.3.23+
elif [ "$(basename "$SCRIPT_DIR")" = "scripts" ] && [ -f "$(dirname "$SCRIPT_DIR")/.env" ]; then
    COMPOSE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # v0.3.22
else
    COMPOSE_DIR="$SCRIPT_DIR"            # legacy
fi
cd "$COMPOSE_DIR" || { echo "boot-orchestrator: cannot cd to $COMPOSE_DIR — aborting." >&2; exit 1; }

LOG="$SCRIPT_DIR/boot-orchestrator.log"
log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

# Mutex — Task Scheduler can occasionally fire the boot-up trigger
# twice on DSM, and a user might manually re-run while the original
# is still in flight. Two parallel `compose up -d` aren't strictly
# unsafe but race on the same docker-cli locks and produce confusing
# interleaved logs. Non-blocking lock: second invocation exits clean.
LOCK_FILE="$SCRIPT_DIR/.boot-orchestrator.lock"
if command -v flock >/dev/null 2>&1; then
    exec 200>"$LOCK_FILE"
    if ! flock -n 200; then
        log "boot-orchestrator already running (lock $LOCK_FILE held) — exiting"
        exit 0
    fi
fi

log "════ boot-orchestrator starting ════"

if [ ! -f .env ]; then
    log "✘ .env not found at $COMPOSE_DIR/.env — aborting"
    exit 1
fi

# Wait for Docker daemon. On a Synology cold-boot, Synology's own
# services start before Docker's; if we run too early, `docker info`
# errors with "Cannot connect to the Docker daemon" and our compose
# up errors with the same.
#
# Poll up to 5 minutes — typical Synology boot to Docker-ready is
# 60-120 seconds; allow generous headroom for spinning rust + lots of
# DSM packages restoring state.
# Pick the runtime up front (docker, or podman on a podman-only host) so the
# daemon-ready wait + the gluetun reap below target it.
RT="docker"; command -v docker >/dev/null 2>&1 || { command -v podman >/dev/null 2>&1 && RT="podman"; }

log "Waiting for the $RT daemon..."
deadline=$(($(date +%s) + 300))
until $RT info >/dev/null 2>&1; do
    if [ "$(date +%s)" -gt "$deadline" ]; then
        log "✘ $RT daemon didn't become ready within 5min — aborting"
        log "  Check:  systemctl status pkgctl-Docker  (or DSM Package Center)"
        exit 1
    fi
    sleep 5
done
log "✔ Docker daemon ready"

# Pull values from .env the same way setup.sh does. Don't `source`
# the file — values containing spaces / special chars would execute
# as bash expressions and either break or pose a security risk.
env_val() {
    grep -m1 "^$1=" .env 2>/dev/null | cut -d'=' -f2- | sed 's/[[:space:]]#.*//' | tr -d '\r' | xargs
}
is_enabled() {
    local v="$(env_val "$1" | tr '[:upper:]' '[:lower:]')"
    case "$v" in false|0|no|off) return 1 ;; *) return 0 ;; esac
}

# Compose binary detection — match setup.sh's preference (v2 plugin
# first, legacy v1 script second). Synology DSM 7 ships the plugin
# but some older installs still have the legacy `docker-compose`.
COMPOSE=""
if [ "$RT" = docker ] && docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
elif [ "$RT" = podman ]; then
    if podman compose version >/dev/null 2>&1; then COMPOSE="podman compose"
    elif command -v podman-compose >/dev/null 2>&1; then COMPOSE="podman-compose"; fi
fi
if [ -z "$COMPOSE" ]; then
    log "✘ No container compose tool found (docker compose / docker-compose / podman compose)"
    exit 1
fi

# Compose file selection: when VPN is disabled, the no-vpn override
# replaces qBit's gluetun network_mode with the standard bridge.
# Same logic as setup.sh + the installer's UpdateRunScreen.
FILES="-f docker-compose.yml"
VPN="$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]')"
if [ "$VPN" != "true" ] && [ "$VPN" != "1" ] && [ "$VPN" != "yes" ] && [ "$VPN" != "on" ]; then
    FILES="$FILES -f docker-compose.no-vpn.yml"
fi

# Build COMPOSE_PROFILES from the user's ENABLE_* picks. Without this,
# `compose up -d` only starts the no-profile services (Prowlarr +
# Flaresolverr); profile-gated services like Plex / qBittorrent /
# gluetun never come back up after a NAS boot.
# Media server (plex|jellyfin) — the profile name IS the value. seerr
# is in both profiles so it comes up under either. Mirrors setup.sh.
MEDIA_SERVER="$(env_val MEDIA_SERVER | tr '[:upper:]' '[:lower:]')"
[ "$MEDIA_SERVER" = "jellyfin" ] || MEDIA_SERVER="plex"
PROFILES=()
is_enabled ENABLE_PLEX        && PROFILES+=("$MEDIA_SERVER")
is_enabled ENABLE_SONARR      && PROFILES+=("sonarr")
is_enabled ENABLE_RADARR      && PROFILES+=("radarr")
is_enabled ENABLE_LIDARR      && PROFILES+=("lidarr")
is_enabled ENABLE_BAZARR      && PROFILES+=("bazarr")
is_enabled ENABLE_SABNZBD     && PROFILES+=("usenet")
is_enabled ENABLE_HOMEPAGE    && PROFILES+=("homepage")
is_enabled ENABLE_RECYCLARR   && PROFILES+=("recyclarr")
is_enabled ENABLE_UNPACKERR   && PROFILES+=("unpackerr")
is_enabled ENABLE_FLARESOLVERR && PROFILES+=("flaresolverr")
if is_enabled ENABLE_QBITTORRENT; then
    PROFILES+=("torrenting")
    case "$VPN" in true|1|yes|on) PROFILES+=("vpn") ;; esac
fi
# Soulseek is OPT-IN (explicit true only — a missing key must NOT enable it,
# unlike the default-on services above). slskd shares gluetun's namespace, so
# Soulseek also pulls in the vpn sidecar when VPN is on (same as qBittorrent).
case "$(env_val ENABLE_SOULSEEK | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on)
        PROFILES+=("soulseek")
        case "$VPN" in
            true|1|yes|on) case " ${PROFILES[*]} " in *" vpn "*) : ;; *) PROFILES+=("vpn") ;; esac ;;
        esac
        ;;
esac
# Playlist Sync is OPT-IN (explicit true only — a missing key must NOT enable
# it). playlistsync shares gluetun's namespace like slskd, so it also pulls in
# the vpn sidecar when VPN is on (the dup-guard avoids a second "vpn" entry).
# Without this the boot hook would not restart an opted-in playlistsync after a
# reboot, in gluetun-dependency order — the exact thing this orchestrator exists
# to do. Mirrors setup.sh's PROFILES block.
case "$(env_val ENABLE_PLAYLIST_SYNC | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on)
        PROFILES+=("playlists")
        case "$VPN" in
            true|1|yes|on) case " ${PROFILES[*]} " in *" vpn "*) : ;; *) PROFILES+=("vpn") ;; esac ;;
        esac
        ;;
esac
# Live TV (Dispatcharr) is OPT-IN (explicit true only — a missing key must NOT
# enable it, so use the case-guard, NOT is_enabled). Without the "livetv"
# profile here, a reboot where the dispatcharr container no longer exists
# (removed by a prior failed update/recreate or docker rm) would leave live TV
# down despite ENABLE_DISPATCHARR=true — the boot orchestrator exists to
# compose up the user's opted-in services. NOT VPN-coupled (it must stay
# LAN-reachable as a tuner), so no vpn-sidecar dup-guard is needed. Mirrors
# setup.sh's PROFILES block.
case "$(env_val ENABLE_DISPATCHARR | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) PROFILES+=("livetv") ;;
esac
if [ "${#PROFILES[@]}" -gt 0 ]; then
    export COMPOSE_PROFILES="$(IFS=,; echo "${PROFILES[*]}")"
    log "COMPOSE_PROFILES=$COMPOSE_PROFILES"
fi

# VPN off, but a gluetun container is still around — Docker's restart policy
# brought it back after the reboot. It is an orphan relative to the no-vpn
# project and still holds qBittorrent's published ${LAN_IP}:49156, so the
# bridge-mode qBit would fail to bind ("port is already allocated"). Reap it
# so the stack comes up clean.
case "$VPN" in
    true|1|yes|on) ;;
    *) if $RT ps -a --format '{{.Names}}' 2>/dev/null | grep -qx gluetun; then
           log "Removing leftover gluetun (VPN is off — it would hold qBittorrent's port)"
           $RT stop gluetun >/dev/null 2>&1 || true
           $RT rm gluetun >/dev/null 2>&1 || true
       fi ;;
esac

log "Running: $COMPOSE $FILES up -d"

# `up -d` respects depends_on ordering inside the project — gluetun
# starts BEFORE qbittorrent because of qBit's depends_on entry. That's
# the whole reason this script exists vs. relying on Docker's restart-
# policy: docker daemon doesn't read depends_on, but `compose up` does.
#
# Plain ANSI/progress output goes to the log; the redirect captures
# both stdout + stderr so failure modes (e.g. malformed compose YAML
# after an unattended pkg update) show up here for debugging.
export COMPOSE_PROGRESS=plain COMPOSE_ANSI=never DOCKER_CLI_HINTS=false
if $COMPOSE $FILES up -d 2>&1 | tee -a "$LOG"; then
    log "✔ Stack brought up cleanly"
    exit 0
else
    rc=${PIPESTATUS[0]}
    log "✘ compose up -d exited rc=$rc — see log above"
    exit "$rc"
fi
