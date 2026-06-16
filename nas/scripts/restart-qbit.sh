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

# Read a single .env value the SAME way setup.sh / qbit-guardian.sh do:
# strip a trailing whitespace-anchored " #comment" (NOT a # embedded in a
# value), drop \r, trim. Without the comment-strip a line like
# `VPN_ENABLED=true   # on` would parse as "true   # on" and fall through
# the true|1|yes|on case to VPN_OFF — silently taking the wrong network path.
env_val() { grep -m1 "^$1=" .env 2>/dev/null | cut -d'=' -f2- | sed 's/[[:space:]]#.*//' | tr -d '\r' | xargs; }

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

# Unconditional-recreate request. The guardian (qbit-guardian.sh) detects a
# qBit that is running with a CURRENT gluetun namespace but whose WebUI is
# DEAD (its backstop signal: process up, port not serving). That is NOT the
# stale-namespace wedge the gates below catch (ids still match), so without a
# force path `up -d` would see a healthy-looking qBit and leave it untouched —
# the guardian would "recover" in a no-op loop. Two ways to ask for it: env
# FORCE=1, or a non-empty first arg (a human-readable reason, which the
# guardian passes). Either makes us rm+recreate qBit (and slskd, when Soulseek
# is on) regardless of state so the WebUI backstop actually heals.
FORCE_REASON="${1:-}"
case "$(printf '%s' "${FORCE:-}" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) FORCE=1 ;;
    *)             FORCE=0 ;;
esac
[ -n "$FORCE_REASON" ] && { FORCE=1; echo "  Force-recreate requested: $FORCE_REASON"; }

# ── No-VPN path ───────────────────────────────────────────────────────────────
# qBittorrent runs on the bridge network via docker-compose.no-vpn.yml.
# A regular restart is fine — gluetun isn't involved. With FORCE (e.g. a
# WebUI-dead-but-running qBit), a plain `restart` may not clear the fault, so
# recreate the container from scratch instead.
if [ $VPN_ON -eq 0 ]; then
    if [ "$FORCE" -eq 1 ]; then
        echo "  VPN is off — force-recreating qBittorrent on the bridge network."
        COMPOSE_PROFILES=torrenting $COMPOSE -f docker-compose.yml -f docker-compose.no-vpn.yml up -d --force-recreate qbittorrent
    else
        echo "  VPN is off — restarting qBittorrent on the bridge network."
        COMPOSE_PROFILES=torrenting $COMPOSE -f docker-compose.yml -f docker-compose.no-vpn.yml restart qbittorrent
    fi
    echo "  ✔ qBittorrent restarted."
    exit 0
fi

# ── VPN-on path ───────────────────────────────────────────────────────────────
# Must order this carefully:
#   1. Bring up (or keep up) gluetun.
#   2. Recreate qBittorrent against gluetun's live network namespace.
#
# NOTE on ordering: qBit uses `network_mode: container:gluetun`, which forces
# its compose dep to the SHORT-LIST form `depends_on: [gluetun]` (the long
# `condition: service_healthy` form is NOT allowed alongside container: — see
# docker-compose.yml). The short form only waits for gluetun to START, NOT to
# be HEALTHY. So `up -d gluetun qbittorrent` orders start, but does NOT
# guarantee the tunnel is up before qBit starts. qBit's `unless-stopped` +
# this guardian's recovery loop close that gap (a qBit that came up against a
# not-yet-healthy gluetun gets re-welded on the next pass). Don't add a healthy
# claim back here — the compose file deliberately drops that gate.

echo "  VPN is on — bringing up gluetun then qBittorrent."
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
# Playlist Sync's playlistsync shares gluetun's namespace exactly like slskd —
# the identical stale-namespace wedge. Opt-in (explicit-true only); heal it in
# the same passes so one restart re-welds every gluetun-namespaced service.
PLAYLIST_ON=0
case "$(env_val ENABLE_PLAYLIST_SYNC | tr '[:upper:]' '[:lower:]')" in true|1|yes|on) PLAYLIST_ON=1 ;; esac
playlistsync_wedged_running() {
    [ "$($RT inspect -f '{{.State.Status}}' playlistsync 2>/dev/null || echo missing)" = "running" ] || return 1
    local nm gid
    nm=$($RT inspect -f '{{.HostConfig.NetworkMode}}' playlistsync 2>/dev/null || echo "")
    case "$nm" in container:*) nm="${nm#container:}" ;; *) return 1 ;; esac
    gid=$($RT inspect -f '{{.Id}}' gluetun 2>/dev/null || echo "")
    [ "$nm" != "$gid" ]
}
UP_PROFILES="vpn,torrenting"; UP_SVCS="gluetun qbittorrent"
if [ "$SOULSEEK_ON" -eq 1 ]; then UP_PROFILES="$UP_PROFILES,soulseek"; UP_SVCS="$UP_SVCS slskd"; fi
if [ "$PLAYLIST_ON" -eq 1 ]; then UP_PROFILES="$UP_PROFILES,playlists"; UP_SVCS="$UP_SVCS playlistsync"; fi

# If qBittorrent's container exists but is dead, OR is running but pinned to
# a destroyed gluetun namespace, remove it so compose recreates it cleanly
# against the (possibly new) gluetun network namespace. Without this, `up
# -d` may reuse the stale container and re-trigger "must join at least one
# network" (or silently leave qBit's tunnel dead).
# FORCE also removes it even when state=running and the namespace id still
# matches: that is exactly the WebUI-dead-but-running case (the guardian's
# backstop) which neither the state nor the wedge test catches, so without the
# FORCE arm `up -d` would spare the broken container and the recreate would be
# a no-op.
if $RT ps -a --format '{{.Names}}' | grep -qx qbittorrent; then
    state=$($RT inspect --format='{{.State.Status}}' qbittorrent 2>/dev/null || echo missing)
    if [ "$FORCE" -eq 1 ] || [ "$state" != "running" ] || qbit_wedged_running; then
        echo "  Removing stale/wedged/forced qbittorrent container (state=$state) so compose recreates it cleanly..."
        $RT rm -f qbittorrent >/dev/null 2>&1 || true
    fi
fi

# Same for slskd (Soulseek), which is in gluetun's namespace too. (slskd has no
# WebUI backstop in the guardian, but honour FORCE here too for consistency so
# a forced heal recreates the whole gluetun-namespaced set in one pass.)
if [ "$SOULSEEK_ON" -eq 1 ] && $RT ps -a --format '{{.Names}}' | grep -qx slskd; then
    state=$($RT inspect --format='{{.State.Status}}' slskd 2>/dev/null || echo missing)
    if [ "$FORCE" -eq 1 ] || [ "$state" != "running" ] || slskd_wedged_running; then
        echo "  Removing stale/wedged/forced slskd container (state=$state) so compose recreates it cleanly..."
        $RT rm -f slskd >/dev/null 2>&1 || true
    fi
fi

# Same for playlistsync (Playlist Sync), in gluetun's namespace too.
if [ "$PLAYLIST_ON" -eq 1 ] && $RT ps -a --format '{{.Names}}' | grep -qx playlistsync; then
    state=$($RT inspect --format='{{.State.Status}}' playlistsync 2>/dev/null || echo missing)
    if [ "$FORCE" -eq 1 ] || [ "$state" != "running" ] || playlistsync_wedged_running; then
        echo "  Removing stale/wedged/forced playlistsync container (state=$state) so compose recreates it cleanly..."
        $RT rm -f playlistsync >/dev/null 2>&1 || true
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
if qbit_wedged_running || { [ "$SOULSEEK_ON" -eq 1 ] && slskd_wedged_running; } || { [ "$PLAYLIST_ON" -eq 1 ] && playlistsync_wedged_running; }; then
    echo "  A gluetun-namespaced container is still on a stale namespace — recreating once more..."
    if qbit_wedged_running; then $RT rm -f qbittorrent >/dev/null 2>&1 || true; fi
    if [ "$SOULSEEK_ON" -eq 1 ] && slskd_wedged_running; then $RT rm -f slskd >/dev/null 2>&1 || true; fi
    if [ "$PLAYLIST_ON" -eq 1 ] && playlistsync_wedged_running; then $RT rm -f playlistsync >/dev/null 2>&1 || true; fi
    COMPOSE_PROFILES=$UP_PROFILES $COMPOSE -f docker-compose.yml up -d $UP_SVCS
fi

# Quick post-up sanity. qBit's `container:` dep means compose does NOT gate
# its start on gluetun being HEALTHY (only on gluetun having started — see the
# VPN-on note above), and the tunnel can drop moments later regardless. Surface
# gluetun's health state and qBit's running state so the user sees green/red
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
