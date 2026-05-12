#!/bin/bash
# ── Media Stack Setup ──
#
# Complete first-time setup in one command.
# Safe to re-run — all steps are idempotent.
#
# Usage:
#   sudo bash /volume1/docker/media/setup.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Required .env vars ───────────────────────────────────────────────────────
# Belt-and-suspenders: docker compose substitutes empty for any unset
# variable in docker-compose.yml. With ${INSTALL_DIR}/plex/config and
# INSTALL_DIR missing, the bind mount becomes "/plex/config:/config",
# which compose then happily tries to bind from the host's root — usually
# failing or, worse, creating a stray directory. Catch that here.
#
# The Mediarr Installer wizard always writes these vars. They'd only be
# missing if someone hand-edited .env or copied an older one over the
# top. Back-compat: if INSTALL_DIR is missing but a .env exists, we
# auto-fill it with SCRIPT_DIR (which IS the install dir by definition,
# since setup.sh lives there). DATA_ROOT has no portable default — bail
# with a clear message rather than guess.
ENV_FILE="$SCRIPT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    if ! grep -q '^INSTALL_DIR=' "$ENV_FILE"; then
        echo "INSTALL_DIR was missing from .env — auto-filling with $SCRIPT_DIR (setup.sh's directory)."
        echo "INSTALL_DIR=$SCRIPT_DIR" >> "$ENV_FILE"
    fi
    if ! grep -q '^DATA_ROOT=' "$ENV_FILE"; then
        echo "Error: DATA_ROOT is missing from $ENV_FILE"
        echo ""
        echo "  DATA_ROOT names the directory where your media + downloads tree lives;"
        echo "  it's bind-mounted into every arr / qBittorrent / sabnzbd container as"
        echo "  /data. Without it, docker compose would silently substitute empty"
        echo "  and create stray bind mounts at the host's root."
        echo ""
        echo "  If you're on Synology DSM, the historical default is /volume1/Data."
        echo "  On Unraid: /mnt/user/data.  On QNAP: /share/Data.  Add a line like:"
        echo "    DATA_ROOT=/volume1/Data"
        echo "  to $ENV_FILE and re-run setup.sh — or re-run the Mediarr Installer"
        echo "  wizard to regenerate .env from scratch."
        exit 1
    fi
fi

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
            # 45s post-up settle: containers may report "running" before
            # their bind-mounted volumes are visible from inside, before
            # the arr web servers bind their ports, and before DSM's
            # shared-folder ACL layer is reachable through the mount.
            # The Python config script also retries each API call so a
            # tight wait here isn't catastrophic, but a longer wait
            # avoids most of the spurious "Path does not exist" errors.
            echo "  ✔ All containers running — waiting 45s for services to initialise..."
            sleep 45
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

# Synology-specific firewall integration uses iptables rules that get
# installed in /usr/local/etc/rc.d/ to survive reboots. That layout is
# DSM-specific — on Unraid/QNAP/TrueNAS/generic Linux the user manages
# firewall via their own UI (Unraid's UI, QTS's UI, ufw/firewalld, …)
# so we skip the step cleanly instead of dumping rules into rc.d/ that
# never run.
#
# Going through run_step in BOTH branches so the wizard's stepper rail
# parses a matching "Step 3 complete" marker and advances the progress
# bar regardless of which path was taken. The non-Synology skip body
# emits the same final "✔ Step 3 complete" line, just after a "what
# you need to do" hint for the user.
if [ -f /etc/synoinfo.conf ]; then
    run_step 3 "Apply firewall rules" \
        bash "$SCRIPT_DIR/setup-firewall.sh"
else
    # Use a here-doc instead of inline echo args so the message can
    # contain any character (apostrophes, parens, em dashes) without
    # tripping the surrounding shell quoting — an earlier version had
    # echo "The wizard's firewall step" which terminated the single-
    # quoted bash -c body early and made bash -n fail.
    run_step 3 "Apply firewall rules" bash -c 'cat <<MSG
  ⏭ Synology-specific firewall integration skipped — not DSM.
    The wizard step installs DSM-style rc.d rules that no other NAS
    family uses. On this host, open the stack ports in your NAS firewall
    UI (Unraid Settings → Network, QTS Control Panel → Security, ufw /
    firewalld / OPNsense — whatever applies). Required ports:
      32400 (Plex), 3000 (Homepage), 5056 (Seerr),
      8181 (Tautulli), 8191 (Flaresolverr),
      49150–49156 (arrs + qBittorrent + SAB).
MSG
exit 0'
fi

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
echo "     (customise $SCRIPT_DIR/recyclarr/config/recyclarr.yml first)"
echo ""
echo "  ── Updates ────────────────────────────────────"
echo "  cd $SCRIPT_DIR"
echo "  $COMPOSE $COMPOSE_FILES pull && $COMPOSE $COMPOSE_FILES up -d"
