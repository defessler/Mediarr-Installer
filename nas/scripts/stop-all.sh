#!/bin/bash
# ── Stop the entire media stack ──
#
# Why this script exists: every user-facing service in
# docker-compose.yml has a `profiles:` key (so setup.sh can opt out
# individual services). `docker compose down` without COMPOSE_PROFILES
# set ONLY stops services in the default profile — i.e. just Prowlarr
# and Flaresolverr in this stack. Plex, the arrs, qBittorrent, gluetun,
# Homepage, recyclarr, unpackerr all stay running because compose
# considers them "out of scope" for the down command.
#
# That's a long-standing docker-compose UX wart, but the workaround
# is straightforward: tell compose about every profile in .env, then
# `down` works as you'd expect.
#
# Usage:
#   sudo bash /volume1/docker/media/stop-all.sh
#
# This script's safe to re-run. It will:
#   - Detect VPN + per-service ENABLE_* flags in .env
#   - Build the COMPOSE_PROFILES list
#   - Run `docker compose down --remove-orphans` against the right files
#   - Catch profile-gated services that the .env doesn't currently flag
#     (e.g. you opted OUT of Lidarr but the lidarr container is still
#     running from a previous install) via `--remove-orphans`

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Compose root depends on layout. See restart-qbit.sh's comment block.
if [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/.env" ]; then
    COMPOSE_DIR="$SCRIPT_DIR"            # v0.3.23+
elif [ "$(basename "$SCRIPT_DIR")" = "scripts" ] && [ -f "$(dirname "$SCRIPT_DIR")/.env" ]; then
    COMPOSE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # v0.3.22
else
    COMPOSE_DIR="$SCRIPT_DIR"            # legacy
fi
cd "$COMPOSE_DIR"

if [ ! -f .env ]; then
    echo "✘ .env not found at $COMPOSE_DIR/.env"
    echo "  This script expects to find docker-compose.yml + .env in the install dir."
    exit 1
fi

# Pick the container runtime + compose front-end (docker, or podman on a
# podman-only host). Matches restart-qbit.sh. Honour DOCKER_SOCK from .env
# so a standalone run targets the right daemon.
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

# Default-on opt-out semantics: missing/empty/anything-but-false → enabled.
is_enabled() {
    local val
    val="$(env_val "$1" | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$val" in
        false|0|no|off) return 1 ;;
        *)              return 0 ;;
    esac
}

VPN_ENABLED="$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]' | xargs)"
case "$VPN_ENABLED" in
    true|1|yes|on) VPN_ON=1 ;;
    *)             VPN_ON=0 ;;
esac

# Build the FULL profile set — even profiles the user is currently
# opted-out of. The point is to stop ANY container that ever was
# part of the stack, including ones whose ENABLE_* got flipped to
# false since last install. `--remove-orphans` is the belt-and-
# braces on top of that.
# "soulseek" is opt-in (slskd + soularr, default OFF) but MUST be listed
# here for the same reason as every other profile: if it was ever enabled,
# its containers are up, and omitting the profile leaves slskd/soularr
# orphaned after `down` (compose only stops profiles it's told about).
# "playlists" (Playlist Sync) and "livetv" (Dispatcharr) are opt-in for the
# same reason — heavyweight LAN services that otherwise keep running (holding
# RAM + bound ports) after a "stop all". Profile names match setup.sh's
# COMPOSE_PROFILES builder.
PROFILES=(plex jellyfin sonarr radarr lidarr bazarr usenet torrenting vpn soulseek playlists livetv homepage recyclarr unpackerr flaresolverr)

# Pick the right compose files. When VPN was off at install time, the
# no-vpn override is part of the active config; loading it on down
# keeps compose's project state in sync with what was up.
FILES="-f docker-compose.yml"
if [ $VPN_ON -eq 0 ]; then
    FILES="$FILES -f docker-compose.no-vpn.yml"
fi

echo "  Stopping the entire media stack..."
echo "  Profiles: ${PROFILES[*]}"
echo "  Compose files: $FILES"
echo ""

COMPOSE_PROFILES="$(IFS=,; echo "${PROFILES[*]}")" \
    $COMPOSE $FILES down --remove-orphans

echo ""
echo "  ✔ All stack containers stopped + removed."
echo ""

# Optional networks cleanup. compose down removes the project network
# when no container references it, but external networks or stranded
# networks from old installs sometimes survive. Surface them but
# don't auto-delete — could clobber unrelated stacks.
STRAY=$($RT network ls --format '{{.Name}}' | grep -E '^(media|mediarr|nas)_' || true)
if [ -n "$STRAY" ]; then
    echo "  Note: these docker networks are still defined (delete manually if unused):"
    echo "$STRAY" | sed 's/^/    /'
fi

# Quick sanity: anything left running with one of our container names?
LEFTOVERS=""
# slskd + soularr included so the soulseek profile's containers are part
# of the leftover safety-check too (they're the ones the omitted profile
# above used to strand silently). playlistsync + dispatcharr are here for the
# same reason — the playlists/livetv profiles' containers.
for c in prowlarr flaresolverr plex jellyfin tautulli seerr sonarr radarr lidarr \
         bazarr qbittorrent gluetun sabnzbd slskd soularr playlistsync dispatcharr \
         homepage recyclarr unpackerr; do
    if $RT ps --format '{{.Names}}' | grep -qx "$c"; then
        LEFTOVERS="$LEFTOVERS $c"
    fi
done
if [ -n "$LEFTOVERS" ]; then
    echo ""
    echo "  ⚠ Still running:$LEFTOVERS"
    echo "    Force-stop them with:  $RT stop$LEFTOVERS"
fi
