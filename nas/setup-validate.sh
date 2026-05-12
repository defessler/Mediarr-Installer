#!/bin/bash
# ── Stack Validation ──
#
# Checks that everything is correctly configured before running docker compose.
#
# Usage:
#   bash /volume1/docker/media/setup-validate.sh

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

# Helper: read a value from .env (strips \r for Windows-edited files)
env_val() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r'; }

echo "============================================="
echo "  Stack Validation"
echo "============================================="

# ── Files ─────────────────────────────────────────────────────────────────────

section "Files"

[ -f "$SCRIPT_DIR/docker-compose.yml" ] && ok "docker-compose.yml exists" || fail "docker-compose.yml not found"
[ -r "$SCRIPT_DIR/docker-compose.yml" ] && ok "docker-compose.yml is readable" || fail "docker-compose.yml is not readable — run setup-chmod.sh"

[ -f "$ENV_FILE" ]  && ok ".env exists"       || fail ".env not found — copy .env.example to .env and fill in your values"
[ -r "$ENV_FILE" ]  && ok ".env is readable"  || fail ".env is not readable — run setup-chmod.sh"

for script in setup.sh setup-chmod.sh setup-folders.sh setup-firewall.sh setup-nordvpn.sh setup-validate.sh post-deploy-validate.sh; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        [ -x "$SCRIPT_DIR/$script" ] && ok "$script is executable" || fail "$script is not executable — run setup-chmod.sh"
    else
        warn "$script not found"
    fi
done

# ── .env Variables ────────────────────────────────────────────────────────────

section ".env Variables"

check_var() {
    local key="$1"
    local val
    val=$(env_val "$key")
    if [ -z "$val" ]; then
        fail "$key is not set"
    else
        ok "$key is set"
    fi
}

check_var "PUID"
check_var "PGID"
check_var "TZ"
check_var "LAN_IP"

# VPN env vars only required when VPN_ENABLED=true. With VPN off,
# setup.sh applies docker-compose.no-vpn.yml and gluetun never starts.
VPN_ENABLED_LC=$(env_val "VPN_ENABLED" | tr '[:upper:]' '[:lower:]')
case "$VPN_ENABLED_LC" in
    true|1|yes|on)
        check_var "VPN_PROVIDER"
        check_var "VPN_TYPE"
        check_var "VPN_COUNTRIES"
        check_var "NORDVPN_PRIVATE_KEY"
        ;;
    *)
        ok "VPN disabled (VPN_ENABLED=$VPN_ENABLED_LC) — skipping VPN var checks"
        ;;
esac

check_var "QBITTORRENT_USER"
check_var "QBITTORRENT_PASS"

# API keys are auto-discovered from config.xml after first boot — warn only
check_var_warn() {
    local key="$1"
    local val
    val=$(env_val "$key")
    if [ -z "$val" ]; then
        warn "$key not set — auto-discovered from config.xml by setup-arr-config.py"
    else
        ok "$key is set"
    fi
}
check_var_warn "SONARR_API_KEY"
check_var_warn "RADARR_API_KEY"

# Validate LAN_IP looks like an IP address
LAN_IP=$(env_val "LAN_IP")
if [[ "$LAN_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    ok "LAN_IP looks valid ($LAN_IP)"
else
    fail "LAN_IP does not look like a valid IP address: '$LAN_IP'"
fi

# Validate WireGuard key length (should be 44 chars)
# NordVPN's API sometimes returns 43 chars — auto-fix by padding.
WG_KEY=$(env_val "NORDVPN_PRIVATE_KEY")
if [ -n "$WG_KEY" ]; then
    KEY_LEN=${#WG_KEY}
    if [ "$KEY_LEN" -eq 44 ]; then
        ok "NORDVPN_PRIVATE_KEY length looks correct (44 chars)"
    elif [ "$KEY_LEN" -eq 43 ]; then
        PADDED_KEY="${WG_KEY}="
        sed -i "s|NORDVPN_PRIVATE_KEY=.*|NORDVPN_PRIVATE_KEY=$PADDED_KEY|" "$ENV_FILE"
        ok "NORDVPN_PRIVATE_KEY was 43 chars — padded to 44 automatically (added trailing =)"
    else
        fail "NORDVPN_PRIVATE_KEY length is $KEY_LEN — expected 44. Run setup-nordvpn.sh"
    fi
fi

# Warn if PLEX_CLAIM is empty (only needed on first run)
PLEX_CLAIM=$(env_val "PLEX_CLAIM")
if [ -z "$PLEX_CLAIM" ]; then
    warn "PLEX_CLAIM is empty — only needed on first run. Get one from https://plex.tv/claim"
else
    ok "PLEX_CLAIM is set"
fi

# ── Folders ───────────────────────────────────────────────────────────────────

section "Directories"

# NAS-family-portable: read INSTALL_DIR / DATA_ROOT from .env and
# fall back to the Synology-historical defaults for older .envs.
INSTALL_DIR=$(env_val "INSTALL_DIR")
DATA_ROOT=$(env_val "DATA_ROOT")
: "${INSTALL_DIR:=$SCRIPT_DIR}"
: "${DATA_ROOT:=/volume1/Data}"

REQUIRED_DIRS=(
    "$INSTALL_DIR/plex/config"
    "$INSTALL_DIR/tautulli/config"
    "$INSTALL_DIR/seerr/config"
    "$INSTALL_DIR/prowlarr/config"
    "$INSTALL_DIR/sonarr/config"
    "$INSTALL_DIR/radarr/config"
    "$INSTALL_DIR/bazarr/config"
    "$INSTALL_DIR/lidarr/config"
    "$INSTALL_DIR/qbittorrent/config"
    "$INSTALL_DIR/sabnzbd/config"
    "$INSTALL_DIR/recyclarr/config"
    "$INSTALL_DIR/unpackerr/config"
    "$INSTALL_DIR/homepage/config"
    "$DATA_ROOT/Media/Movies"
    "$DATA_ROOT/Media/TV Shows"
    "$DATA_ROOT/Media/Anime/Movies"
    "$DATA_ROOT/Media/Anime/TV Shows"
    "$DATA_ROOT/Media/Music"
    "$DATA_ROOT/Downloads/Torrents/ToFetch"
    "$DATA_ROOT/Downloads/Torrents/InProgress"
    "$DATA_ROOT/Downloads/Torrents/Completed/tv-sonarr"
    "$DATA_ROOT/Downloads/Torrents/Completed/radarr"
    "$DATA_ROOT/Downloads/Usenet/incomplete"
    "$DATA_ROOT/Downloads/Usenet/complete"
    "$DATA_ROOT/Downloads/Usenet/complete/tv"
    "$DATA_ROOT/Downloads/Usenet/complete/movies"
    "$DATA_ROOT/Downloads/Usenet/complete/music"
)

for dir in "${REQUIRED_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        ok "$dir"
    else
        fail "$dir missing — run setup-folders.sh"
    fi
done

# ── Firewall ──────────────────────────────────────────────────────────────────

section "Firewall"

check_port() {
    local port="$1"
    local label="$2"
    if iptables -L INPUT -n 2>/dev/null | grep -q "dpt:$port"; then
        ok "Port $port open ($label)"
    else
        fail "Port $port not in iptables ($label) — run setup-firewall.sh"
    fi
}

check_port 32400 "Plex"
check_port 49150 "Prowlarr"
check_port 49151 "Radarr"
check_port 49152 "Sonarr"
check_port 49153 "Bazarr"
check_port 49154 "Lidarr"
check_port 49155 "SABnzbd"
check_port 49156 "qBittorrent"
check_port 5056  "Seerr"
check_port 8181  "Tautulli"
check_port 3000  "Homepage"

if [ -f /usr/local/etc/rc.d/media-firewall.sh ]; then
    ok "Firewall script installed in rc.d (survives reboots)"
else
    warn "Firewall script not installed in rc.d — rules won't survive a reboot"
    warn "Run: sudo cp $SCRIPT_DIR/setup-firewall.sh /usr/local/etc/rc.d/media-firewall.sh && sudo chmod 755 /usr/local/etc/rc.d/media-firewall.sh"
fi

# ── Docker ────────────────────────────────────────────────────────────────────

section "Docker"

if command -v docker &>/dev/null; then
    ok "Docker is installed"
    if docker info &>/dev/null; then
        ok "Docker daemon is running"
    else
        fail "Docker daemon is not running"
    fi
else
    fail "Docker is not installed"
fi

if docker compose version &>/dev/null 2>&1; then
    ok "docker compose (v2) is available"
elif command -v docker-compose &>/dev/null; then
    ok "docker-compose (v1) is available — consider upgrading to Docker Compose v2"
else
    fail "Neither 'docker compose' nor 'docker-compose' is installed"
fi

# ── Network ───────────────────────────────────────────────────────────────────

section "Network"

if curl -sf --max-time 5 https://api.nordvpn.com/v1/servers/countries &>/dev/null; then
    ok "NordVPN API is reachable"
else
    fail "NordVPN API is not reachable — check internet connectivity"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "============================================="
echo "  Results: $PASS passed, $WARN warnings, $FAIL failed"
echo "============================================="

if [ $FAIL -gt 0 ]; then
    echo "  Fix the failing checks above before running docker compose."
    exit 1
elif [ $WARN -gt 0 ]; then
    echo "  All checks passed with warnings. Review above before proceeding."
    exit 0
else
    echo "  All checks passed. Ready to run docker compose up -d"
    exit 0
fi
