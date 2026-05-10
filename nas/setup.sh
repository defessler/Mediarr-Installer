#!/bin/bash
# ── Media Stack Setup ──
#
# Complete first-time setup in one command.
# Safe to re-run — all steps are idempotent.
#
# Usage:
#   sudo bash /volume1/docker/media/setup.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Force docker compose to emit plain progress output. Default ("auto")
# detects a TTY and emits an animated multi-line spinner that's
# unreadable when streamed to a non-terminal log panel (every frame
# becomes its own line). Plain mode emits one event per phase change.
# Set this BEFORE any docker compose invocation in this script.
#
# Note: older docker compose versions (v2.x pre-2.20) ignore
# COMPOSE_PROGRESS in tty mode but DO honor the --progress flag, so
# we pass that explicitly on every compose call below. Belt-and-
# suspenders so the installer log stays readable across DSM versions.
export COMPOSE_PROGRESS=plain
export COMPOSE_ANSI=never
export DOCKER_CLI_HINTS=false
COMPOSE_QUIET_FLAGS="--progress plain --ansi never"

PASS=0
FAIL=0

# ── Detect docker compose command ────────────────────────────────────────────

COMPOSE=""
if docker compose version &>/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
    COMPOSE="docker-compose"
else
    echo "Error: neither 'docker compose' nor 'docker-compose' found."
    echo "Install Docker Desktop or the Docker Compose plugin first."
    exit 1
fi

# ── Choose compose files based on VPN_ENABLED in .env ────────────────────────
# VPN is OFF by default. When VPN_ENABLED is anything other than 'true' / '1'
# / 'yes', the no-vpn override is applied — gluetun is excluded and
# qBittorrent runs on the regular bridge network, ports bound to LAN_IP.
# Set VPN_ENABLED=true and fill in NORDVPN_PRIVATE_KEY to opt into gluetun.

VPN_ENABLED="$(grep -m1 '^VPN_ENABLED=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
COMPOSE_FILES="-f docker-compose.yml"
if [ "$VPN_ENABLED" = "true" ] || [ "$VPN_ENABLED" = "1" ] || [ "$VPN_ENABLED" = "yes" ]; then
    echo "  Note: VPN_ENABLED=true — routing qBittorrent through gluetun (NordVPN)."
else
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.no-vpn.yml"
    echo "  Note: VPN off (default). qBittorrent traffic will use your real public IP."
    echo "  Set VPN_ENABLED=true in .env and re-run to enable gluetun routing."
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

run_step() {
    local step="$1" description="$2"
    shift 2

    echo ""
    echo "┌─────────────────────────────────────────────"
    echo "│ Step $step: $description"
    echo "└─────────────────────────────────────────────"

    if "$@"; then
        echo ""
        echo "  ✔ Step $step complete."
        PASS=$((PASS + 1))
    else
        echo ""
        echo "  ✘ Step $step failed — fix the errors above and re-run."
        FAIL=$((FAIL + 1))
    fi
}

abort_if_failed() {
    if [ $FAIL -gt 0 ]; then
        echo ""
        echo "============================================="
        echo "  Setup halted — fix the errors above."
        echo "  All steps are safe to re-run."
        echo "  sudo bash $SCRIPT_DIR/setup.sh"
        echo "============================================="
        exit 1
    fi
}

wait_for_services() {
    local max_wait=600
    local interval=10
    local elapsed=0
    local services="sonarr radarr lidarr prowlarr sabnzbd bazarr flaresolverr"

    echo ""
    echo "  Waiting for containers to become healthy..."
    echo "  (First run pulls images — this may take 5-15 minutes)"
    echo ""

    while [ $elapsed -lt $max_wait ]; do
        local all_up=true
        local status_line="  ${elapsed}s  "

        for svc in $services; do
            local state
            state=$(docker inspect --format='{{.State.Status}}' "$svc" 2>/dev/null || echo "missing")
            if [ "$state" = "running" ]; then
                status_line+="$svc ✔  "
            else
                status_line+="$svc … "
                all_up=false
            fi
        done

        echo "$status_line"

        if $all_up; then
            echo ""
            echo "  ✔ All containers running — waiting 20s for services to initialise..."
            sleep 20
            return 0
        fi

        sleep $interval
        elapsed=$((elapsed + interval))
    done

    echo ""
    echo "  ✘ Containers did not start within ${max_wait}s"
    echo "  Check logs:  $COMPOSE logs"
    return 1
}

# ── Pre-flight ────────────────────────────────────────────────────────────────

echo ""
echo "============================================="
echo "  Media Stack Setup"
echo "============================================="
echo "  Using: $COMPOSE"
echo "  This script runs the full first-time install."
echo "  Safe to re-run — all steps skip what's already done."

run_step 1 "Set file permissions" \
    bash "$SCRIPT_DIR/setup-chmod.sh"

run_step 2 "Create data and config directories" \
    bash "$SCRIPT_DIR/setup-folders.sh"

run_step 3 "Apply firewall rules" \
    bash "$SCRIPT_DIR/setup-firewall.sh"

echo "  Note: fetches your WireGuard private key from the NordVPN API"
run_step 4 "Fetch NordVPN WireGuard key" \
    bash "$SCRIPT_DIR/setup-nordvpn.sh"

run_step 5 "Validate configuration" \
    bash "$SCRIPT_DIR/setup-validate.sh"

abort_if_failed

# ── Stack ─────────────────────────────────────────────────────────────────────

echo ""
echo "  Note: first run will pull all Docker images — this can take 5-15 minutes"
run_step 6 "Start the stack" \
    bash -c "cd '$SCRIPT_DIR' && $COMPOSE $COMPOSE_QUIET_FLAGS $COMPOSE_FILES up -d"

abort_if_failed

wait_for_services || { FAIL=$((FAIL + 1)); abort_if_failed; }

# ── API Configuration ─────────────────────────────────────────────────────────

echo ""
echo "  Note: configuring Sonarr, Radarr, Lidarr, Prowlarr, SABnzbd, Bazarr, Seerr,"
echo "        Flaresolverr proxy, qBittorrent watch folder, and more via API."
echo "        Skips anything already configured."
run_step 7 "Configure all services" \
    python3 "$SCRIPT_DIR/setup-arr-config.py"

echo ""
echo "  Note: adding public torrent indexers (1337x, YTS, Nyaa, TPB...) and any"
echo "        usenet/private indexers whose credentials are set in .env"
run_step 8 "Add Prowlarr indexers" \
    python3 "$SCRIPT_DIR/indexers/setup-indexers.py"

echo ""
echo "  Note: enabling free subtitle providers and any account-based providers"
echo "        (OpenSubtitles, Addic7ed) configured in .env"
run_step 9 "Enable Bazarr subtitle providers" \
    python3 "$SCRIPT_DIR/indexers/setup-bazarr-providers.py"

# ── Post-deploy validation ────────────────────────────────────────────────────

echo ""
echo "  Note: running post-deploy health checks on all services"
run_step 10 "Verify stack health" \
    bash "$SCRIPT_DIR/post-deploy-validate.sh"

# ── Summary ───────────────────────────────────────────────────────────────────

LAN_IP=$(grep -m1 '^LAN_IP=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '\r')
IP="${LAN_IP:-<NAS-IP>}"

echo ""
echo "============================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "============================================="

if [ $FAIL -gt 0 ]; then
    echo ""
    echo "  One or more steps failed — review the output above."
    echo "  Fix the issue and re-run:  sudo bash $SCRIPT_DIR/setup.sh"
    exit 1
fi

echo ""
echo "  ✔ Setup complete!"
echo ""
echo "  ── Dashboard ──────────────────────────────────"
echo "  Homepage     http://${IP}:3000           ← start here"
echo ""
echo "  ── Services ───────────────────────────────────"
echo "  Plex         http://${IP}:32400/web"
echo "  Sonarr       http://${IP}:49152"
echo "  Radarr       http://${IP}:49151"
echo "  Lidarr       http://${IP}:49154"
echo "  Prowlarr     http://${IP}:49150"
echo "  SABnzbd      http://${IP}:49155"
echo "  qBittorrent  http://${IP}:49156"
echo "  Bazarr       http://${IP}:49153"
echo "  Seerr        http://${IP}:5056"
echo "  Tautulli     http://${IP}:8181"
echo ""
echo "  ── Remaining manual steps ─────────────────────"
echo "  1. Seerr wizard: http://${IP}:5056"
echo "     Connect Plex with: http://plex:32400"
echo "     Then re-run: python3 $SCRIPT_DIR/setup-arr-config.py"
echo ""
echo "  2. Tautulli: http://${IP}:8181"
echo "     Connect Plex with token from:"
echo "     Plex → Settings → Troubleshooting → Get X-Plex-Token"
echo ""
echo "  3. SABnzbd usenet server: http://${IP}:49155"
echo "     Add your usenet provider under Config → Servers"
echo ""
echo "  4. Recyclarr quality profiles:"
echo "     docker exec recyclarr recyclarr sync"
echo "     (customise /volume1/docker/media/recyclarr/config/recyclarr.yml first)"
echo ""
echo "  ── Updates ────────────────────────────────────"
echo "  cd $SCRIPT_DIR"
echo "  $COMPOSE $COMPOSE_FILES pull && $COMPOSE $COMPOSE_FILES up -d"
