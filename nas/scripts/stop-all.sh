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
# Compose root = scripts/ parent in the new layout, or SCRIPT_DIR itself
# in legacy loose-scripts installs.
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
PROFILES=(plex sonarr radarr lidarr bazarr usenet torrenting vpn homepage recyclarr unpackerr)

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
STRAY=$(docker network ls --format '{{.Name}}' | grep -E '^(media|mediarr|nas)_' || true)
if [ -n "$STRAY" ]; then
    echo "  Note: these docker networks are still defined (delete manually if unused):"
    echo "$STRAY" | sed 's/^/    /'
fi

# Quick sanity: anything left running with one of our container names?
LEFTOVERS=""
for c in prowlarr flaresolverr plex tautulli seerr sonarr radarr lidarr \
         bazarr qbittorrent gluetun sabnzbd homepage recyclarr unpackerr; do
    if docker ps --format '{{.Names}}' | grep -qx "$c"; then
        LEFTOVERS="$LEFTOVERS $c"
    fi
done
if [ -n "$LEFTOVERS" ]; then
    echo ""
    echo "  ⚠ Still running:$LEFTOVERS"
    echo "    Force-stop them with:  docker stop$LEFTOVERS"
fi
