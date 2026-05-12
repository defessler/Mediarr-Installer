#!/bin/bash
# ── Post-Deploy Validation ──
#
# Run after docker compose up -d to verify the stack is working correctly.
# Checks containers, dashboard pages, VPN, and media visibility.
#
# Usage:
#   bash /volume1/docker/media/post-deploy-validate.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

PASS=0
FAIL=0
WARN=0

ok()   { echo "  ✔ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✘ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠ $1"; WARN=$((WARN + 1)); }

section() {
    echo ""
    echo "── $1 ──────────────────────────────────────────"
}

env_val() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r'; }

# Default-on opt-out semantics matching the rest of the toolchain
# (env-render.ts isEnabled / setup.sh is_enabled / setup-arr-config.py
# is_enabled). Missing or empty → enabled; only an explicit
# false/0/no/off (any case) counts as disabled.
is_enabled() {
    local val
    val="$(env_val "$1" | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$val" in
        false|0|no|off) return 1 ;;
        *)              return 0 ;;
    esac
}

# VPN flag — used to gate the gluetun checks.
vpn_on() {
    local val
    val="$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$val" in
        true|1|yes|on) return 0 ;;
        *)             return 1 ;;
    esac
}

LAN_IP=$(env_val "LAN_IP")

echo "============================================="
echo "  Post-Deploy Validation"
echo "============================================="

# ── Containers Running ────────────────────────────────────────────────────────

section "Containers"

# Build the list of containers we expect to see running based on the
# ENABLE_* flags. Prowlarr + Flaresolverr are always-on (not profile-
# gated in docker-compose.yml). Each user-toggled service maps to one
# or more container names — Plex stack groups three under ENABLE_PLEX,
# qBittorrent pulls in gluetun when VPN_ENABLED.
CONTAINERS=(prowlarr flaresolverr)
is_enabled ENABLE_PLEX        && CONTAINERS+=(plex tautulli seerr)
is_enabled ENABLE_SONARR      && CONTAINERS+=(sonarr)
is_enabled ENABLE_RADARR      && CONTAINERS+=(radarr)
is_enabled ENABLE_LIDARR      && CONTAINERS+=(lidarr)
is_enabled ENABLE_BAZARR      && CONTAINERS+=(bazarr)
is_enabled ENABLE_QBITTORRENT && CONTAINERS+=(qbittorrent)
is_enabled ENABLE_QBITTORRENT && vpn_on && CONTAINERS+=(gluetun)
is_enabled ENABLE_SABNZBD     && CONTAINERS+=(sabnzbd)
is_enabled ENABLE_HOMEPAGE    && CONTAINERS+=(homepage)
is_enabled ENABLE_RECYCLARR   && CONTAINERS+=(recyclarr)
is_enabled ENABLE_UNPACKERR   && CONTAINERS+=(unpackerr)

for container in "${CONTAINERS[@]}"; do
    STATUS=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null)
    if [ "$STATUS" = "running" ]; then
        ok "$container is running"
    elif [ -z "$STATUS" ]; then
        fail "$container does not exist"
    else
        fail "$container is not running (status: $STATUS)"
    fi
done

# ── Dashboard Pages ───────────────────────────────────────────────────────────

section "Dashboard Pages"

check_url() {
    local label="$1"
    local url="$2"
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url")
    if [[ "$http_code" =~ ^(200|301|302|303|307|308|401|403)$ ]]; then
        ok "$label ($url) — HTTP $http_code"
    else
        fail "$label ($url) — HTTP $http_code (not reachable)"
    fi
}

# Check URL only when the underlying service is enabled — checking a
# disabled service would return HTTP 000 (nothing listening) and false-
# fail the post-deploy.
is_enabled ENABLE_HOMEPAGE    && check_url "Homepage"     "http://$LAN_IP:3000"
is_enabled ENABLE_PLEX        && check_url "Plex"         "http://$LAN_IP:32400/web"
is_enabled ENABLE_SONARR      && check_url "Sonarr"       "http://$LAN_IP:49152"
is_enabled ENABLE_RADARR      && check_url "Radarr"       "http://$LAN_IP:49151"
is_enabled ENABLE_LIDARR      && check_url "Lidarr"       "http://$LAN_IP:49154"
check_url "Prowlarr"     "http://$LAN_IP:49150"
is_enabled ENABLE_BAZARR      && check_url "Bazarr"       "http://$LAN_IP:49153"
is_enabled ENABLE_SABNZBD     && check_url "SABnzbd"      "http://$LAN_IP:49155"
is_enabled ENABLE_QBITTORRENT && check_url "qBittorrent"  "http://$LAN_IP:49156"
is_enabled ENABLE_PLEX        && check_url "Seerr"        "http://$LAN_IP:5056"
is_enabled ENABLE_PLEX        && check_url "Tautulli"     "http://$LAN_IP:8181"
check_url "Flaresolverr" "http://$LAN_IP:8191"

# ── Plex External Access ──────────────────────────────────────────────────────

# Fetch public IP up-front — both Plex external check and VPN check need
# it, and they're each independently gated below.
PUBLIC_IP=""
if is_enabled ENABLE_PLEX || { is_enabled ENABLE_QBITTORRENT && vpn_on; }; then
    echo "  Fetching public IP..."
    PUBLIC_IP=$(curl -sf --max-time 5 https://api.ipify.org)
fi

if is_enabled ENABLE_PLEX; then
    section "Plex External Access"
    if [ -z "$PUBLIC_IP" ]; then
        fail "Could not determine public IP — check internet connectivity"
    else
        ok "Public IP: $PUBLIC_IP"
        echo "  Testing Plex on $PUBLIC_IP:32400 from outside..."
        PLEX_EXTERNAL=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://$PUBLIC_IP:32400/identity")
        if [[ "$PLEX_EXTERNAL" =~ ^(200|301)$ ]]; then
            ok "Plex is reachable externally on port 32400"
        else
            warn "Plex is not reachable externally (HTTP $PLEX_EXTERNAL)"
            warn "Port 32400 may not be forwarded on your router — remote access via relay will still work"
        fi
    fi
fi

# ── Gluetun VPN ───────────────────────────────────────────────────────────────

# Only meaningful when the user actually opted into VPN-wrapped torrenting
# (VPN_ENABLED=true AND ENABLE_QBITTORRENT=true). Otherwise gluetun isn't
# running and `docker exec gluetun` would fail; skip with a clear note.
if is_enabled ENABLE_QBITTORRENT && vpn_on; then
    section "Gluetun VPN"
    echo "  Checking VPN IP..."
    VPN_IP=$(docker exec gluetun wget -qO- --timeout=10 https://api.ipify.org 2>/dev/null)
    if [ -z "$VPN_IP" ]; then
        fail "Could not get IP through Gluetun — VPN may not be connected"
    else
        if [ "$VPN_IP" = "$PUBLIC_IP" ]; then
            fail "VPN IP matches your public IP — traffic is NOT going through the VPN"
        else
            ok "VPN is active — qBittorrent traffic exits via $VPN_IP"
        fi
    fi
fi

# ── Media Visibility ──────────────────────────────────────────────────────────

# docker exec'ing into disabled arrs fails ("no such container") and
# false-fails the post-deploy. Each media check needs its container to
# exist — gate them on the matching ENABLE_*.

if is_enabled ENABLE_SONARR || is_enabled ENABLE_RADARR || is_enabled ENABLE_LIDARR; then
    section "Media Visibility"
fi

check_media() {
    local container="$1"
    local path="$2"
    local label="$3"
    local count
    count=$(docker exec "$container" find "$path" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l)
    if [ "$count" -gt 0 ]; then
        ok "$label — $count items found ($container:$path)"
    else
        warn "$label — folder is empty ($container:$path)"
    fi
}

if is_enabled ENABLE_SONARR; then
    check_media "sonarr" "/data/Media/TV Shows"       "TV Shows"
    check_media "sonarr" "/data/Media/Anime/TV Shows" "Anime TV"
    check_media "sonarr" "/data/Downloads"            "Downloads folder"
fi
if is_enabled ENABLE_RADARR; then
    check_media "radarr" "/data/Media/Movies"         "Movies"
    check_media "radarr" "/data/Media/Anime/Movies"   "Anime Movies"
fi
if is_enabled ENABLE_LIDARR; then
    check_media "lidarr" "/data/Media/Music"          "Music"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "============================================="
echo "  Results: $PASS passed, $WARN warnings, $FAIL failed"
echo "============================================="

if [ $FAIL -gt 0 ]; then
    echo "  Some checks failed — review the output above."
    exit 1
elif [ $WARN -gt 0 ]; then
    echo "  All checks passed with warnings — review above."
    exit 0
else
    echo "  Everything looks good!"
    exit 0
fi
