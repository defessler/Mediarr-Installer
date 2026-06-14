#!/bin/bash
# ── qbit-guardian.sh — periodic self-heal for VPN-wrapped qBittorrent ──
#
# Run every ~5 min by the cron/boot hook that install-boot-resilience.sh
# wires up. ONE detect → maybe-recover → exit cycle (no loop, no daemon —
# we deliberately avoid an always-on sidecar). It heals the two ways a
# gluetun-namespaced qBittorrent dies and can't come back on its own:
#
#   1. qBit container exited / created / restarting — the NAS-reboot
#      ordering race (qBit started before gluetun's namespace existed,
#      hit "must join at least one network", now stuck in Docker's
#      exponential restart backoff).
#   2. qBit container "running" but its network is DEAD — gluetun was
#      rm+recreated under it (update/crash), so the namespace qBit is
#      welded to no longer exists. A plain `docker restart` can NOT fix
#      this (HostConfig.NetworkMode pins gluetun's OLD container id and is
#      immutable); only a rm+recreate rebinds qBit to the live gluetun.
#
# Recovery delegates to the already-tested restart-qbit.sh (ordered
# gluetun→qBit recreate). Quiet when healthy — the log only ever shows
# real incidents. Gated on VPN_ENABLED=true AND ENABLE_QBITTORRENT: with
# VPN off, qBit is on the plain bridge (no gluetun namespace to go stale)
# and Docker's own restart policy already recovers it, so there's nothing
# to guard.

set -uo pipefail

# Cron runs with a stripped PATH that often lacks docker; prepend the
# usual locations (incl. DSM's /usr/local/bin) so binaries resolve.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

# ── Resolve layout (mirrors restart-qbit.sh / boot-orchestrator.sh) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if   [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/.env" ]; then
    COMPOSE_DIR="$SCRIPT_DIR"                                   # v0.3.23+
elif [ "$(basename "$SCRIPT_DIR")" = "scripts" ] && [ -f "$(dirname "$SCRIPT_DIR")/.env" ]; then
    COMPOSE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"                 # v0.3.22
else
    COMPOSE_DIR="$SCRIPT_DIR"                                   # legacy
fi
cd "$COMPOSE_DIR" || exit 0
[ -f .env ] || exit 0

LOG="$SCRIPT_DIR/qbit-guardian.log"
LOCK_FILE="$SCRIPT_DIR/.qbit-guardian.lock"
QBIT_PORT=49156
GRACE_SECONDS=180          # qBit must be up this long before a WebUI miss counts
MAXLOG=262144             # 256 KiB log cap

log()   { echo "[$(date -Is 2>/dev/null || date)] $*" >> "$LOG" 2>/dev/null; }
short() { printf '%.12s' "$1"; }
rotate_log() {
    [ -f "$LOG" ] || return 0
    local sz; sz=$(wc -c < "$LOG" 2>/dev/null || echo 0)
    case "$sz" in ''|*[!0-9]*) sz=0 ;; esac
    [ "$sz" -gt "$MAXLOG" ] && { tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null || true; }
}

# Read a single .env value (comment-stripped, \r-stripped, trimmed). Don't
# source .env — a value with shell metachars would execute.
env_val()    { grep -m1 "^$1=" .env 2>/dev/null | cut -d'=' -f2- | sed 's/#.*//' | tr -d '\r' | xargs; }
is_enabled() { local v; v="$(env_val "$1" | tr '[:upper:]' '[:lower:]')"; case "$v" in false|0|no|off) return 1 ;; *) return 0 ;; esac; }
is_true()    { case "$1" in true|1|yes|on) return 0 ;; *) return 1 ;; esac; }

# ── Gate: VPN on + (qBittorrent OR Soulseek) enabled. Both share gluetun's
#    namespace and the same wedge. qBit is default-on (is_enabled); Soulseek is
#    OPT-IN (is_true → explicit true/1/yes/on only — a missing key must NOT
#    arm the guardian for it). ──
is_true "$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]')" || exit 0
QBIT_ON=0; SOULSEEK_ON=0
is_enabled ENABLE_QBITTORRENT && QBIT_ON=1
is_true "$(env_val ENABLE_SOULSEEK | tr '[:upper:]' '[:lower:]')" && SOULSEEK_ON=1
[ "$QBIT_ON" -eq 1 ] || [ "$SOULSEEK_ON" -eq 1 ] || exit 0

# ── Honour a custom/Podman socket the same way setup.sh does, so the
#    recovery targets the right daemon (cron inherits a bare env) ──
DOCKER_SOCK="$(env_val DOCKER_SOCK)"
if [ -n "$DOCKER_SOCK" ] && [ -z "${DOCKER_HOST:-}" ]; then
    case "$DOCKER_SOCK" in
        unix://*|tcp://*|ssh://*) export DOCKER_HOST="$DOCKER_SOCK" ;;
        *)                        export DOCKER_HOST="unix://$DOCKER_SOCK" ;;
    esac
fi

# ── Mutex (non-blocking; degrade if no flock) so a slow recovery can't
#    stack when the next 5-min tick fires mid-heal ──
if command -v flock >/dev/null 2>&1; then
    exec 200>"$LOCK_FILE"
    flock -n 200 || exit 0
fi

# ── Pick the container runtime (Docker or Podman) so recovery targets the
#    right daemon on a Podman-only host ──
RT="docker"; COMPOSE="docker compose"
if command -v docker >/dev/null 2>&1; then
    docker compose version >/dev/null 2>&1 || { command -v docker-compose >/dev/null 2>&1 && COMPOSE="docker-compose"; }
elif command -v podman >/dev/null 2>&1; then
    RT="podman"
    if podman compose version >/dev/null 2>&1; then COMPOSE="podman compose"
    elif command -v podman-compose >/dev/null 2>&1; then COMPOSE="podman-compose"; fi
    if [ -z "${DOCKER_HOST:-}" ]; then
        if   [ -S "$HOME/.local/share/containers/podman/podman.sock" ]; then export DOCKER_HOST="unix://$HOME/.local/share/containers/podman/podman.sock"
        elif [ -S /run/podman/podman.sock ]; then export DOCKER_HOST="unix:///run/podman/podman.sock"; fi
    fi
fi

# ── Daemon must be up; a transient daemon-down is a non-event ──
command -v "$RT" >/dev/null 2>&1 || exit 0
$RT info >/dev/null 2>&1 || exit 0

cstate()  { $RT inspect -f '{{.State.Status}}'        "$1" 2>/dev/null || echo missing; }
chealth() { $RT inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo none; }
cid()     { $RT inspect -f '{{.Id}}'                  "$1" 2>/dev/null || echo ""; }
qbit_ns_id() {
    local nm; nm=$($RT inspect -f '{{.HostConfig.NetworkMode}}' qbittorrent 2>/dev/null || echo "")
    case "$nm" in container:*) echo "${nm#container:}" ;; *) echo "" ;; esac
}
slskd_ns_id() {
    local nm; nm=$($RT inspect -f '{{.HostConfig.NetworkMode}}' slskd 2>/dev/null || echo "")
    case "$nm" in container:*) echo "${nm#container:}" ;; *) echo "" ;; esac
}
qbit_uptime() {
    local s t now
    s=$($RT inspect -f '{{.State.StartedAt}}' qbittorrent 2>/dev/null) || { echo 0; return; }
    # Normalize Go's RFC3339Nano (2026-06-13T19:12:34.123456789Z) into a form
    # BOTH GNU and busybox `date -d` accept: drop the fractional seconds +
    # trailing Z and swap 'T' for a space (parsed as local time, which lines
    # up with `now` below). Use sed (universal) rather than bash-only
    # ${s/T/ } so this works under a busybox /bin/bash on QNAP etc.
    s=$(printf '%s' "$s" | sed 's/\..*//; s/Z$//; s/T/ /')
    # Fail CLOSED on any parse failure: echo 0 (treat as just-started) so the
    # uptime-gated WebUI backstop is SKIPPED rather than firing a needless
    # recreate on a box whose `date` can't read the timestamp.
    t=$(date -d "$s" +%s 2>/dev/null) || { echo 0; return; }
    now=$(date +%s 2>/dev/null) || { echo 0; return; }
    echo $(( now - t ))
}
webui_ok() {
    local LAN_IP code
    LAN_IP="$(env_val LAN_IP)"
    [ -n "$LAN_IP" ] || return 0                  # no LAN_IP → don't probe, assume ok
    command -v curl >/dev/null 2>&1 || return 0   # no curl  → skip probe
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$LAN_IP:$QBIT_PORT/" 2>/dev/null || echo 000)
    case "$code" in 200|401|403|301|302) return 0 ;; *) return 1 ;; esac
}

GS=$(cstate gluetun); GH=$(chealth gluetun); GID=$(cid gluetun)
WEDGED=0; REASON=""

if   [ "$GS" != "running" ]; then
    WEDGED=1; REASON="gluetun is $GS"
elif [ "$GH" = "starting" ]; then
    exit 0                                          # VPN warmup window — abstain, quiet
else
    # qBittorrent (if enabled): not-running / stale-namespace / WebUI backstop.
    if [ "$QBIT_ON" -eq 1 ]; then
        QS=$(cstate qbittorrent)
        if [ "$QS" != "running" ]; then
            WEDGED=1; REASON="qbittorrent is $QS"
        else
            NSID=$(qbit_ns_id)
            if [ -n "$NSID" ] && [ -n "$GID" ] && [ "$NSID" != "$GID" ]; then
                WEDGED=1; REASON="qbit namespace stale (welded to $(short "$NSID")…, gluetun now $(short "$GID")…)"
            elif [ "$GH" = "healthy" ] || [ "$GH" = "none" ]; then
                AGE=$(qbit_uptime)
                if [ "$AGE" -ge "$GRACE_SECONDS" ] && ! webui_ok; then
                    WEDGED=1; REASON="qbit WebUI unreachable on LAN:$QBIT_PORT (up ${AGE}s, gluetun healthy)"
                fi
            fi
        fi
    fi
    # slskd (if Soulseek enabled): same not-running / stale-namespace wedge.
    # No WebUI backstop — slskd has no cheap unauthenticated liveness probe.
    if [ "$WEDGED" -eq 0 ] && [ "$SOULSEEK_ON" -eq 1 ]; then
        SS=$(cstate slskd)
        if [ "$SS" != "running" ]; then
            WEDGED=1; REASON="slskd is $SS"
        else
            SNSID=$(slskd_ns_id)
            if [ -n "$SNSID" ] && [ -n "$GID" ] && [ "$SNSID" != "$GID" ]; then
                WEDGED=1; REASON="slskd namespace stale (welded to $(short "$SNSID")…, gluetun now $(short "$GID")…)"
            fi
        fi
    fi
fi

[ "$WEDGED" -eq 0 ] && exit 0                       # healthy: write nothing, quiet exit

rotate_log
log "WEDGED: $REASON — recovering"
if [ "$QBIT_ON" -eq 1 ] && [ -x "$SCRIPT_DIR/restart-qbit.sh" ]; then
    # restart-qbit.sh does the ordered gluetun→qBit recreate AND heals slskd in
    # the same pass when Soulseek is on (SOULSEEK_ON detected there too).
    bash "$SCRIPT_DIR/restart-qbit.sh" >> "$LOG" 2>&1; rc=$?
else
    # qBit off (Soulseek-only) or no restart-qbit.sh — inline recreate whatever
    # is enabled, ordered behind gluetun (same approach restart-qbit.sh uses).
    _rm="gluetun"; _up="gluetun"; _pr="vpn"
    [ "$QBIT_ON" -eq 1 ]     && { _rm="$_rm qbittorrent"; _up="$_up qbittorrent"; _pr="$_pr,torrenting"; }
    [ "$SOULSEEK_ON" -eq 1 ] && { _rm="$_rm slskd";       _up="$_up slskd";       _pr="$_pr,soulseek"; }
    $RT rm -f $_rm >/dev/null 2>&1 || true
    COMPOSE_PROFILES=$_pr $COMPOSE -f docker-compose.yml up -d $_up >> "$LOG" 2>&1; rc=$?
fi
log "recovery finished rc=$rc"
exit "$rc"
