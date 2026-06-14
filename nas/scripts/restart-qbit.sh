#!/bin/bash
# ── Restart qBittorrent (gluetun-aware) ──
#
# Why this script exists: when VPN_ENABLED=true, qBittorrent is configured
# with `network_mode: service:gluetun` so all torrent traffic exits through
# the VPN tunnel. Docker enforces this hard — if gluetun isn't running
# OR its network namespace has been recreated, `docker restart
# qbittorrent` (or Synology Container Manager's "Restart" button) fails
# with:
#
#   Error response from daemon: container <hash> hostconfig must be
#   updated, container must join at least one network
#
# That message is correct but unhelpful: the fix is "bring gluetun up
# first" (and wait for it to be healthy). This script does that.
#
# When VPN_ENABLED=false the no-vpn override applies and qBittorrent is
# on the regular bridge network — no gluetun dance needed, just a
# normal compose up.
#
# Usage:
#   sudo bash /volume1/docker/media/restart-qbit.sh
#
# Synology Container Manager users: bind a "Triggered task" in
# Control Panel → Task Scheduler to this script if you want a one-click
# button. Or just run it from SSH whenever qBit needs a kick.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Pick the dir docker compose runs from:
#   v0.3.23+   → .env + docker-compose.yml live next to this script.
#   v0.3.22    → they're at SCRIPT_DIR's parent (scripts/ subfolder).
#   pre-v0.3.22 → SCRIPT_DIR IS the install root (loose layout).
if [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/.env" ]; then
    COMPOSE_DIR="$SCRIPT_DIR"
elif [ "$(basename "$SCRIPT_DIR")" = "scripts" ] && [ -f "$(dirname "$SCRIPT_DIR")/.env" ]; then
    COMPOSE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    COMPOSE_DIR="$SCRIPT_DIR"
fi
cd "$COMPOSE_DIR"

if [ ! -f .env ]; then
    echo "✘ .env not found at $COMPOSE_DIR/.env"
    echo "  This script expects to find docker-compose.yml + .env in the install dir."
    exit 1
fi

# Pick the container runtime + compose front-end (docker, or podman on a
# podman-only host). Matches setup.sh / qbit-guardian.sh. Honour DOCKER_SOCK
# from .env so a standalone run targets the right daemon.
DOCKER_SOCK="$(grep -m1 '^DOCKER_SOCK=' .env 2>/dev/null | cut -d'=' -f2- | tr -d '\r' | xargs)"
if [ -n "$DOCKER_SOCK" ] && [ -z "${DOCKER_HOST:-}" ]; then
    case "$DOCKER_SOCK" in
        unix://*|tcp://*|ssh://*) export DOCKER_HOST="$DOCKER_SOCK" ;;
        *)                        export DOCKER_HOST="unix://$DOCKER_SOCK" ;;
    esac
fi
RT="docker"; COMPOSE=""
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
elif command -v podman >/dev/null 2>&1; then
    RT="podman"
    if podman compose version >/dev/null 2>&1; then COMPOSE="podman compose"
    elif command -v podman-compose >/dev/null 2>&1; then COMPOSE="podman-compose"; fi
    if [ -z "${DOCKER_HOST:-}" ]; then
        if   [ -S "$HOME/.local/share/containers/podman/podman.sock" ]; then export DOCKER_HOST="unix://$HOME/.local/share/containers/podman/podman.sock"
        elif [ -S /run/podman/podman.sock ]; then export DOCKER_HOST="unix:///run/podman/podman.sock"; fi
    fi
fi
if [ -z "$COMPOSE" ]; then
    echo "✘ No container compose tool found (docker compose / docker-compose / podman compose)."
    exit 1
fi

env_val() { grep -m1 "^$1=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '\r'; }

VPN_ENABLED="$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]' | xargs)"
QBIT_ENABLED="$(env_val ENABLE_QBITTORRENT | tr '[:upper:]' '[:lower:]' | xargs)"

# Same default-on semantics as setup.sh: missing/empty → enabled. Only
# an explicit false-ish value counts as disabled.
case "$QBIT_ENABLED" in
    false|0|no|off) echo "✘ ENABLE_QBITTORRENT=$QBIT_ENABLED in .env — nothing to restart."; exit 1 ;;
esac

case "$VPN_ENABLED" in
    true|1|yes|on) VPN_ON=1 ;;
    *)             VPN_ON=0 ;;
esac

# ── No-VPN path ───────────────────────────────────────────────────────────────
# qBittorrent runs on the bridge network via docker-compose.no-vpn.yml.
# A regular restart is fine — gluetun isn't involved.
if [ $VPN_ON -eq 0 ]; then
    echo "  VPN is off — restarting qBittorrent on the bridge network."
    COMPOSE_PROFILES=torrenting $COMPOSE -f docker-compose.yml -f docker-compose.no-vpn.yml restart qbittorrent
    echo "  ✔ qBittorrent restarted."
    exit 0
fi

# ── VPN-on path ───────────────────────────────────────────────────────────────
# Must order this carefully:
#   1. Bring up (or keep up) gluetun. depends_on inside compose handles
#      the wait-for-healthy IF we use `up -d` (not `restart`).
#   2. Once gluetun is healthy, recreate qBittorrent against gluetun's
#      live network namespace.
#
# `up -d gluetun qbittorrent` with both profiles in COMPOSE_PROFILES
# does both steps in one shot — compose respects the depends_on chain
# and waits for gluetun's healthcheck to pass before starting qbit.

echo "  VPN is on — bringing up gluetun then qBittorrent (gluetun must be healthy first)."
echo ""

# Detect a qBit that is state=running but welded to a STALE gluetun
# namespace (gluetun was rm+recreated under it). Docker resolves
# network_mode: container:gluetun to gluetun's container ID at qBit-create
# time and freezes it in HostConfig.NetworkMode as 'container:<id>'. If
# that id no longer matches the LIVE gluetun id, qBit's tunnel is dead even
# though the process runs — a plain restart can't fix it (HostConfig is
# immutable); only rm+recreate rebinds it to the new namespace.
qbit_wedged_running() {
    [ "$($RT inspect -f '{{.State.Status}}' qbittorrent 2>/dev/null || echo missing)" = "running" ] || return 1
    local nm gid
    nm=$($RT inspect -f '{{.HostConfig.NetworkMode}}' qbittorrent 2>/dev/null || echo "")
    case "$nm" in container:*) nm="${nm#container:}" ;; *) return 1 ;; esac
    gid=$($RT inspect -f '{{.Id}}' gluetun 2>/dev/null || echo "")
    # Wedged if qBit's frozen namespace id differs from the LIVE gluetun id —
    # including when gluetun is GONE (gid empty). nm is always non-empty here
    # (the container:* case guard above), so a missing gluetun reads as a
    # mismatch, which is correct: qBit's tunnel is dead either way.
    [ "$nm" != "$gid" ]
}

# Soulseek's slskd shares gluetun's namespace exactly like qBittorrent, so it
# has the identical stale-namespace wedge. When ENABLE_SOULSEEK is on (opt-in,
# explicit-true only), heal it in the same passes. The compose up below then
# brings up + re-welds both behind one gluetun.
SOULSEEK_ON=0
case "$(env_val ENABLE_SOULSEEK | tr '[:upper:]' '[:lower:]')" in true|1|yes|on) SOULSEEK_ON=1 ;; esac
slskd_wedged_running() {
    [ "$($RT inspect -f '{{.State.Status}}' slskd 2>/dev/null || echo missing)" = "running" ] || return 1
    local nm gid
    nm=$($RT inspect -f '{{.HostConfig.NetworkMode}}' slskd 2>/dev/null || echo "")
    case "$nm" in container:*) nm="${nm#container:}" ;; *) return 1 ;; esac
    gid=$($RT inspect -f '{{.Id}}' gluetun 2>/dev/null || echo "")
    [ "$nm" != "$gid" ]
}
UP_PROFILES="vpn,torrenting"; UP_SVCS="gluetun qbittorrent"
if [ "$SOULSEEK_ON" -eq 1 ]; then UP_PROFILES="$UP_PROFILES,soulseek"; UP_SVCS="$UP_SVCS slskd"; fi

# If qBittorrent's container exists but is dead, OR is running but pinned to
# a destroyed gluetun namespace, remove it so compose recreates it cleanly
# against the (possibly new) gluetun network namespace. Without this, `up
# -d` may reuse the stale container and re-trigger "must join at least one
# network" (or silently leave qBit's tunnel dead).
if $RT ps -a --format '{{.Names}}' | grep -qx qbittorrent; then
    state=$($RT inspect --format='{{.State.Status}}' qbittorrent 2>/dev/null || echo missing)
    if [ "$state" != "running" ] || qbit_wedged_running; then
        echo "  Removing stale/wedged qbittorrent container (state=$state) so compose recreates it cleanly..."
        $RT rm -f qbittorrent >/dev/null 2>&1 || true
    fi
fi

# Same for slskd (Soulseek), which is in gluetun's namespace too.
if [ "$SOULSEEK_ON" -eq 1 ] && $RT ps -a --format '{{.Names}}' | grep -qx slskd; then
    state=$($RT inspect --format='{{.State.Status}}' slskd 2>/dev/null || echo missing)
    if [ "$state" != "running" ] || slskd_wedged_running; then
        echo "  Removing stale/wedged slskd container (state=$state) so compose recreates it cleanly..."
        $RT rm -f slskd >/dev/null 2>&1 || true
    fi
fi

# Same for gluetun if it's in a broken state. unless-stopped should
# auto-restart but a wedged container (e.g. mid-pull, bad config
# refresh) sometimes sticks at created/exited.
if $RT ps -a --format '{{.Names}}' | grep -qx gluetun; then
    state=$($RT inspect --format='{{.State.Status}}' gluetun 2>/dev/null || echo missing)
    if [ "$state" != "running" ]; then
        echo "  Removing stale gluetun container (state=$state) so compose recreates it cleanly..."
        $RT rm -f gluetun >/dev/null 2>&1 || true
    fi
fi

COMPOSE_PROFILES=$UP_PROFILES $COMPOSE -f docker-compose.yml up -d $UP_SVCS

# Post-up reconcile. Compose recreates a service whose own spec changed, but
# it will NOT recreate an ALREADY-RUNNING qBittorrent just because gluetun
# was recreated under it with a new id (there's no --always-recreate-deps by
# default). That can leave qBit welded to the old, now-dead namespace — e.g.
# when gluetun was merely exited (so the qBit-removal gate above saw matching
# ids and spared it), then got recreated here. If qBit is running but its
# frozen namespace id no longer matches the LIVE gluetun, rm it and bring it
# up once more so a single run fully heals the wedge (matters most for the
# documented standalone `sudo bash restart-qbit.sh` use).
if qbit_wedged_running || { [ "$SOULSEEK_ON" -eq 1 ] && slskd_wedged_running; }; then
    echo "  A gluetun-namespaced container is still on a stale namespace — recreating once more..."
    if qbit_wedged_running; then $RT rm -f qbittorrent >/dev/null 2>&1 || true; fi
    if [ "$SOULSEEK_ON" -eq 1 ] && slskd_wedged_running; then $RT rm -f slskd >/dev/null 2>&1 || true; fi
    COMPOSE_PROFILES=$UP_PROFILES $COMPOSE -f docker-compose.yml up -d $UP_SVCS
fi

# Quick post-up sanity. The depends_on:service_healthy gate inside
# compose ensures gluetun was healthy when qbit started, but it's
# possible the VPN tunnel drops moments after. Surface gluetun's
# health state and qBit's running state so the user sees green/red
# without having to docker-inspect manually.
echo ""
echo "  Status:"
for svc in gluetun qbittorrent; do
    state=$($RT inspect --format='{{.State.Status}}' "$svc" 2>/dev/null || echo missing)
    health=$($RT inspect --format='{{.State.Health.Status}}' "$svc" 2>/dev/null || true)
    [ -n "$health" ] && [ "$health" != "<no value>" ] && state="$state ($health)"
    echo "    $svc: $state"
done

echo ""
echo "  ✔ Done. If gluetun shows 'unhealthy' or qBittorrent isn't running,"
echo "    check the gluetun logs for VPN-connection errors:"
echo "      docker compose logs gluetun --tail 50"
