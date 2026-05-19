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
# Compose root = scripts/ parent in the new layout, or SCRIPT_DIR itself
# in legacy loose-scripts installs. `docker compose` needs the compose
# root as cwd to find docker-compose.yml + .env.
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    INSTALL_DIR="$SCRIPT_DIR"
fi
cd "$INSTALL_DIR"

if [ ! -f .env ]; then
    echo "✘ .env not found at $INSTALL_DIR/.env"
    echo "  This script expects to find docker-compose.yml + .env in the install dir."
    exit 1
fi

# Pick the right compose binary — v2 plugin preferred, legacy v1
# script as fallback. Matches setup.sh's detection.
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
else
    echo "✘ Neither 'docker compose' nor 'docker-compose' is available."
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

# If qBittorrent's container exists but is dead, remove it so compose
# recreates it cleanly against the (possibly new) gluetun network
# namespace. Without this, `up -d` may try to reuse the stale container
# and re-trigger the "must join at least one network" error.
if docker ps -a --format '{{.Names}}' | grep -qx qbittorrent; then
    state=$(docker inspect --format='{{.State.Status}}' qbittorrent 2>/dev/null || echo missing)
    if [ "$state" != "running" ]; then
        echo "  Removing stale qbittorrent container (state=$state) so compose recreates it cleanly..."
        docker rm -f qbittorrent >/dev/null 2>&1 || true
    fi
fi

# Same for gluetun if it's in a broken state. unless-stopped should
# auto-restart but a wedged container (e.g. mid-pull, bad config
# refresh) sometimes sticks at created/exited.
if docker ps -a --format '{{.Names}}' | grep -qx gluetun; then
    state=$(docker inspect --format='{{.State.Status}}' gluetun 2>/dev/null || echo missing)
    if [ "$state" != "running" ]; then
        echo "  Removing stale gluetun container (state=$state) so compose recreates it cleanly..."
        docker rm -f gluetun >/dev/null 2>&1 || true
    fi
fi

COMPOSE_PROFILES=vpn,torrenting $COMPOSE -f docker-compose.yml up -d gluetun qbittorrent

# Quick post-up sanity. The depends_on:service_healthy gate inside
# compose ensures gluetun was healthy when qbit started, but it's
# possible the VPN tunnel drops moments after. Surface gluetun's
# health state and qBit's running state so the user sees green/red
# without having to docker-inspect manually.
echo ""
echo "  Status:"
for svc in gluetun qbittorrent; do
    state=$(docker inspect --format='{{.State.Status}}' "$svc" 2>/dev/null || echo missing)
    health=$(docker inspect --format='{{.State.Health.Status}}' "$svc" 2>/dev/null || true)
    [ -n "$health" ] && [ "$health" != "<no value>" ] && state="$state ($health)"
    echo "    $svc: $state"
done

echo ""
echo "  ✔ Done. If gluetun shows 'unhealthy' or qBittorrent isn't running,"
echo "    check the gluetun logs for VPN-connection errors:"
echo "      docker compose logs gluetun --tail 50"
