#!/bin/bash
# ── Media Stack Setup ──
#
# Complete first-time setup in one command.
# Safe to re-run — all steps are idempotent.
#
# Usage:
#   sudo bash /volume1/docker/media/scripts/setup.sh

# As of v0.3.23 the wizard drops EVERYTHING (scripts, .env, .env.example,
# docker-compose.yml + overrides, INDEXERS.md) into a `scripts/`
# subfolder under INSTALL_DIR — leaving INSTALL_DIR root with only the
# service config dirs (sonarr/, radarr/, plex/, etc.) and migration/.
#
# Therefore:
#   SCRIPT_DIR  = where this script + .env + docker-compose.yml live.
#                 The "compose root" — we cd here for `docker compose`.
#   INSTALL_DIR = parent of SCRIPT_DIR, where the service config dirs
#                 live. Used for ${INSTALL_DIR}/<svc>/config compose-
#                 file mount substitutions.
#
# Legacy: pre-v0.3.22 had everything loose at INSTALL_DIR root; v0.3.22
# had scripts/ as a subfolder but compose + .env at the root. Both
# layouts still work — the basename check distinguishes the new one.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    INSTALL_DIR="$SCRIPT_DIR"
fi

# Mutex against concurrent runs (installer wizard + manual SSH session,
# or two SSH sessions racing). Lock lives alongside setup.sh in the
# scripts dir; if flock isn't available (busybox-only systems) we fall
# back to PID-file detection. Best-effort: a stale PID after a crashed
# setup.sh is detected via `kill -0` and reaped.
LOCK_FILE="$SCRIPT_DIR/.setup.lock"
if command -v flock >/dev/null 2>&1; then
    # Open FD 200 onto the lock file and try a non-blocking exclusive
    # lock. The lock auto-releases when this shell exits, no trap
    # needed.
    exec 200>"$LOCK_FILE"
    if ! flock -n 200; then
        echo "✘ Another setup.sh is already running (lock held on $LOCK_FILE)."
        echo "  Wait for the other run to finish, or check if a previous run is wedged:"
        echo "    cat $LOCK_FILE"
        exit 1
    fi
    echo $$ >&200
else
    if [ -f "$LOCK_FILE" ]; then
        OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
        if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
            echo "✘ Another setup.sh is already running (PID $OLD_PID, lock at $LOCK_FILE)."
            exit 1
        fi
        # Stale lock from a crashed run — overwrite and continue.
    fi
    echo "$$" > "$LOCK_FILE"
    # Single-quote the trap body so $LOCK_FILE expands when the trap
    # fires, not when it's registered — defensive against later code
    # paths reassigning LOCK_FILE. Functionally identical in this script
    # (LOCK_FILE is set above and never reassigned) but the single-quoted
    # form is what shellcheck recommends (SC2064).
    trap 'rm -f "$LOCK_FILE"' EXIT
fi

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
# auto-fill it with the computed install dir (parent of scripts/ in
# the v0.3.23+ layout). DATA_ROOT has no portable default — bail with
# a clear message rather than guess.
#
# v0.3.23+ layout: .env lives in scripts/ alongside docker-compose.yml.
# Legacy: .env was at INSTALL_DIR root — fall back to that path if the
# scripts/.env doesn't exist (handles the in-place upgrade window).
ENV_FILE="$SCRIPT_DIR/.env"
if [ ! -f "$ENV_FILE" ] && [ -f "$INSTALL_DIR/.env" ]; then
    ENV_FILE="$INSTALL_DIR/.env"
fi
if [ -f "$ENV_FILE" ]; then
    if ! grep -q '^INSTALL_DIR=' "$ENV_FILE"; then
        echo "INSTALL_DIR was missing from .env — auto-filling with $INSTALL_DIR."
        echo "INSTALL_DIR=$INSTALL_DIR" >> "$ENV_FILE"
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

    # Auto-discover Synology /volume[0-9]+ disks so the Homepage resources
    # widget shows real disk-usage stats. Each detected volume gets
    # MONITORED_DISK_N=/volumeN appended to .env (idempotent — re-runs
    # skip slots already set). docker-compose.yml's homepage service has
    # 4 conditional /diskN bind mounts that pick these up via
    # ${MONITORED_DISK_N:-/tmp} substitution; setup-arr-config.py's
    # render_homepage_widgets() emits a disk widget per populated slot.
    # On non-Synology hosts the for-loop's glob expands to literal
    # "/volume[0-9]*" which fails the [ -d ] test and nothing happens —
    # users can hand-add MONITORED_DISK_N to .env for their layout.
    if [ -f "$ENV_FILE" ]; then
        _disk_n=1
        for _vol in /volume[0-9]*; do
            [ -d "$_vol" ] || continue
            [ "$_disk_n" -le 4 ] || break
            if ! grep -q "^MONITORED_DISK_${_disk_n}=" "$ENV_FILE"; then
                echo "MONITORED_DISK_${_disk_n}=${_vol}" >> "$ENV_FILE"
                echo "  Detected storage volume $_vol → MONITORED_DISK_${_disk_n} in .env"
            fi
            _disk_n=$((_disk_n + 1))
        done
        unset _disk_n _vol
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

# Skip creating __pycache__/*.pyc files next to our Python helpers.
# Otherwise the bytecode files end up owned by whoever ran setup.sh
# (root, via sudo), and the next non-sudo run can't overwrite them
# — manifests as Permission denied during re-invocation. Costs us a
# few hundred ms of parse time on each invocation but py_compile
# isn't the bottleneck.
export PYTHONDONTWRITEBYTECODE=1

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

# ── Read .env helpers ────────────────────────────────────────────────────────

# Small helper for reading a value out of .env, strips inline comments
# and surrounding whitespace. Returns empty string if the key is absent.
env_val() {
    grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | sed 's/#.*//' | tr -d '\r' | xargs
}

# Default-ON semantics: missing or empty key counts as enabled, only
# the explicit "false" / "0" / "no" / "off" opts out. Matches the
# isEnabled() logic in env-render.ts so the wizard and setup.sh agree
# on which services are on for any given .env.
is_enabled() {
    local val
    val="$(env_val "$1" | tr '[:upper:]' '[:lower:]')"
    case "$val" in
        false|0|no|off) return 1 ;;
        *)              return 0 ;;
    esac
}

# ── Choose compose files based on VPN_ENABLED in .env ────────────────────────
# VPN is OFF by default. When VPN_ENABLED is anything other than 'true' / '1'
# / 'yes', the no-vpn override is applied — gluetun is excluded and
# qBittorrent runs on the regular bridge network, ports bound to LAN_IP.
# Set VPN_ENABLED=true and fill in WIREGUARD_PRIVATE_KEY to opt into gluetun.

VPN_ENABLED="$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]')"
VPN_ON=0
COMPOSE_FILES="-f docker-compose.yml"
if [ "$VPN_ENABLED" = "true" ] || [ "$VPN_ENABLED" = "1" ] || [ "$VPN_ENABLED" = "yes" ]; then
    VPN_ON=1
    echo "  Note: VPN_ENABLED=true — routing qBittorrent through gluetun."
else
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.no-vpn.yml"
    echo "  Note: VPN off (default). qBittorrent traffic will use your real public IP."
    echo "  Set VPN_ENABLED=true in .env and re-run to enable gluetun routing."
fi

# ── Build COMPOSE_PROFILES from ENABLE_* flags in .env ───────────────────────
# Each user-facing service in docker-compose.yml gets a `profiles:` key;
# COMPOSE_PROFILES tells docker compose which to start. Default-on
# semantics mean profiles created before service selection existed start
# every service exactly like before.
#
# prowlarr is intentionally NOT profile-gated (always on) — it's the
# indexer manager every arr depends on. flaresolverr (CloudFlare bypass)
# IS now opt-out via ENABLE_FLARESOLVERR (default-on): it's upstream-
# deprecated and crashes on arm64, so the installer disables it there.

# Media server selection — plex (default) or jellyfin. ENABLE_PLEX is the
# on/off master for the media-server group (server + Seerr/Jellyseerr
# request manager); MEDIA_SERVER picks WHICH server runs. The profile
# name is literally the MEDIA_SERVER value ("plex" or "jellyfin"), and
# seerr lives in BOTH profiles so it starts under either.
MEDIA_SERVER="$(env_val MEDIA_SERVER | tr '[:upper:]' '[:lower:]')"
[ "$MEDIA_SERVER" = "jellyfin" ] || MEDIA_SERVER="plex"

PROFILES=()
is_enabled ENABLE_PLEX        && PROFILES+=("$MEDIA_SERVER")
is_enabled ENABLE_SONARR      && PROFILES+=("sonarr")
is_enabled ENABLE_RADARR      && PROFILES+=("radarr")
is_enabled ENABLE_LIDARR      && PROFILES+=("lidarr")
is_enabled ENABLE_BAZARR      && PROFILES+=("bazarr")
is_enabled ENABLE_SABNZBD     && PROFILES+=("usenet")
is_enabled ENABLE_HOMEPAGE    && PROFILES+=("homepage")
is_enabled ENABLE_RECYCLARR   && PROFILES+=("recyclarr")
is_enabled ENABLE_UNPACKERR   && PROFILES+=("unpackerr")
is_enabled ENABLE_FLARESOLVERR && PROFILES+=("flaresolverr")
# qBittorrent's profile is "torrenting"; gluetun's is "vpn". Add the
# VPN profile only when the user enabled BOTH qBittorrent AND the VPN
# wrap — gluetun without qBittorrent serves no purpose, and qBittorrent
# without VPN_ENABLED=true is covered by the no-vpn override.
if is_enabled ENABLE_QBITTORRENT; then
    PROFILES+=("torrenting")
    [ $VPN_ON -eq 1 ] && PROFILES+=("vpn")
fi

if [ ${#PROFILES[@]} -gt 0 ]; then
    export COMPOSE_PROFILES="$(IFS=,; echo "${PROFILES[*]}")"
    echo "  Services enabled: ${COMPOSE_PROFILES//,/, } (+ prowlarr always on)"
else
    echo "  WARN: every service is disabled in .env. Only Prowlarr will start."
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

# Stop + remove containers for services the user opted out of since the
# last run. `docker compose up -d` with COMPOSE_PROFILES set only
# touches services in the active profile set — it doesn't stop services
# that *were* in a previously-active profile but aren't now. So a user
# who initially installs everything, then re-runs with ENABLE_LIDARR=
# false, would still have lidarr running afterwards. Reach in and
# explicitly stop+rm those containers so the stack matches the user's
# selection cleanly. Safe to run when nothing's running yet (the docker
# ps grep just returns nothing).
stop_disabled_services() {
    local pairs=(
        "plex:ENABLE_PLEX"        "tautulli:ENABLE_PLEX"  "seerr:ENABLE_PLEX"
        "sonarr:ENABLE_SONARR"    "radarr:ENABLE_RADARR"
        "lidarr:ENABLE_LIDARR"    "bazarr:ENABLE_BAZARR"
        "qbittorrent:ENABLE_QBITTORRENT" "gluetun:ENABLE_QBITTORRENT"
        "sabnzbd:ENABLE_SABNZBD"
        "homepage:ENABLE_HOMEPAGE"
        "recyclarr:ENABLE_RECYCLARR"
        "unpackerr:ENABLE_UNPACKERR"
    )
    local pair container flag stopped=0
    for pair in "${pairs[@]}"; do
        container="${pair%:*}"
        flag="${pair#*:}"
        # Service is enabled → leave the container alone, up -d will
        # (re-)create or update it as needed.
        is_enabled "$flag" && continue
        # Service is disabled but the container exists → stop + remove.
        if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$container"; then
            docker stop "$container" >/dev/null 2>&1 || true
            docker rm   "$container" >/dev/null 2>&1 || true
            echo "  ✔ Removed $container (now opted out via $flag=false)"
            stopped=$((stopped + 1))
        fi
    done
    # Media-server switch reaper. When the user flips MEDIA_SERVER, the
    # other server (and Plex-only Tautulli) drops out of the active
    # profile set — but `compose up -d` only (re)creates services IN the
    # active profiles; it never stops ones that left. Reap the stale
    # server's containers so plex + jellyfin don't both run (port-bind
    # clash on nothing shared, but wasted RAM + a confusing dashboard).
    local stale=""
    if is_enabled ENABLE_PLEX; then
        if [ "$MEDIA_SERVER" = "jellyfin" ]; then stale="plex tautulli"; else stale="jellyfin"; fi
    fi
    for container in $stale; do
        if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$container"; then
            docker stop "$container" >/dev/null 2>&1 || true
            docker rm   "$container" >/dev/null 2>&1 || true
            echo "  ✔ Removed $container (not used by MEDIA_SERVER=$MEDIA_SERVER)"
            stopped=$((stopped + 1))
        fi
    done
    if [ $stopped -eq 0 ]; then
        echo "  No previously-running services to remove."
    fi
}

# Pre-flight check: is any port we're about to bind already in use by
# something OTHER than one of our containers? `docker compose up -d`
# would fail late with a cryptic "driver failed programming external
# connectivity ... bind: address already in use" — better to fail fast
# here with a specific port + service + a likely-cause hint.
#
# The classic offender on Synology DSM: the Media Server package binds
# port 49152 for DLNA, which is exactly Sonarr's port in this stack.
# The IANA dynamic-port range (49152-65535) was picked here originally
# to avoid clashes with well-known service ports, but it overlaps with
# what DLNA/UPnP commonly uses. Surface this specifically when we see
# 49152 conflicts on a DSM host.
check_port_conflicts() {
    # Build a port-list paired with the service name. The list ONLY
    # includes services the user actually opted into for this install;
    # always-on services (prowlarr / flaresolverr) are added too.
    # Real bash array — earlier versions stored this as a space-separated
    # string and relied on word-splitting in `for pair in $pairs`, which
    # works but trips shellcheck (SC2178/SC2128) and silently breaks the
    # moment a service name ever contains whitespace.
    local pairs=("prowlarr:49150")
    is_enabled ENABLE_FLARESOLVERR && pairs+=("flaresolverr:8191")
    if is_enabled ENABLE_PLEX; then
        pairs+=("seerr:5056")
        if [ "$MEDIA_SERVER" = "jellyfin" ]; then
            pairs+=("jellyfin:8096")
        else
            pairs+=("plex:32400" "tautulli:8181")
        fi
    fi
    is_enabled ENABLE_SONARR      && pairs+=("sonarr:49152")
    is_enabled ENABLE_RADARR      && pairs+=("radarr:49151")
    is_enabled ENABLE_LIDARR      && pairs+=("lidarr:49154")
    is_enabled ENABLE_BAZARR      && pairs+=("bazarr:49153")
    is_enabled ENABLE_QBITTORRENT && pairs+=("qbittorrent:49156")
    # 6881 (BT default) is also bound by gluetun/qbittorrent on the host
    # but we don't pre-check it here — it's owned by gluetun-or-qbit
    # depending on VPN_ENABLED, and the simple svc-name match below would
    # false-positive that ownership. The compose-up error is clear enough
    # if another torrent client on the NAS already holds 6881.
    is_enabled ENABLE_SABNZBD     && pairs+=("sabnzbd:49155")
    is_enabled ENABLE_HOMEPAGE    && pairs+=("homepage:3000")

    local conflicts=""
    local pair port svc
    for pair in "${pairs[@]}"; do
        svc="${pair%:*}"
        port="${pair#*:}"
        # netstat present on every supported NAS family. Match :PORT
        # followed by whitespace to avoid catching :49152x or :4915.
        if netstat -lnt 2>/dev/null | awk -v p=":$port$" '$4 ~ p { found=1 } END { exit !found }'; then
            # Port is bound. Is it by OUR container of the same name?
            # If yes, it's not a conflict — compose will recreate that
            # container in step 6. If no, something foreign is holding
            # the port and step 6 will fail.
            if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$svc"; then
                conflicts="$conflicts $svc:$port"
            fi
        fi
    done

    if [ -n "$conflicts" ]; then
        echo ""
        echo "  ✘ Port conflict — these ports are bound by something other"
        echo "    than the wizard's containers, so docker compose up would"
        echo "    fail. Fix the conflict and re-run setup.sh:"
        echo ""
        for pair in $conflicts; do
            svc="${pair%:*}"
            port="${pair#*:}"
            echo "    • $svc needs port $port (currently in use)"
            # Synology-specific: 49152 + DSM = Media Server / DLNA almost
            # always. Surface the precise fix path so the user doesn't
            # have to dig.
            if [ "$port" = "49152" ] && [ -f /etc/synoinfo.conf ]; then
                echo "      Most likely cause: Synology Media Server (DLNA) package."
                echo "      Fix: DSM → Package Center → Media Server → Stop."
                echo "           (Or uninstall it if you don't use DLNA.)"
            fi
            echo "      Investigate what's holding it:"
            echo "        sudo netstat -lnp 2>/dev/null | grep :$port"
            echo "        sudo ss     -lnp 2>/dev/null | grep :$port"
            if command -v lsof >/dev/null 2>&1; then
                echo "        sudo lsof -i :$port"
            fi
            echo ""
        done
        return 1
    fi
    echo "  ✔ All required ports are free (or already held by our containers)."
    return 0
}

wait_for_services() {
    local max_wait=600
    local interval=10
    local elapsed=0
    # Wait only on services the user enabled in .env — checking a disabled
    # container loops forever because `docker inspect` returns "missing"
    # for the full max_wait timeout, killing the install with a false
    # "containers didn't come up" error. Prowlarr is always-on; flaresolverr
    # is opt-out (default-on, off on arm64) so it's gated here.
    local services="prowlarr"
    is_enabled ENABLE_FLARESOLVERR && services="$services flaresolverr"
    is_enabled ENABLE_SONARR      && services="$services sonarr"
    is_enabled ENABLE_RADARR      && services="$services radarr"
    is_enabled ENABLE_LIDARR      && services="$services lidarr"
    is_enabled ENABLE_BAZARR      && services="$services bazarr"
    is_enabled ENABLE_SABNZBD     && services="$services sabnzbd"
    # qBittorrent shares gluetun's network namespace when VPN is on,
    # so `docker inspect '{{.State.Status}}'` is the only readiness
    # signal we have for it. Real-world logs showed configure_qbit
    # consistently hitting empty-login responses because qbit hadn't
    # finished launching by the time step 7 ran — adding it to the
    # wait list buys ~30-60s of extra settle time and dramatically
    # reduces the retry-storm during configuration.
    is_enabled ENABLE_QBITTORRENT && services="$services qbittorrent"

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

# ── Legacy loose-script cleanup ──────────────────────────────────────────────
#
# v0.3.21 and earlier shipped all setup scripts loose at INSTALL_DIR root,
# next to docker-compose.yml. v0.3.22 moved them under scripts/. The Sync
# Scripts upload only ADDS files; it doesn't remove the now-stale copies
# at the root, which leaves the user with a confusing dual layout and the
# risk that a stale loose-copy gets run by hand instead of the new one
# under scripts/.
#
# We do this cleanup HERE (in setup.sh itself, not just the installer's
# Sync flow) so it covers every path: fresh installer install, installer
# Sync + step-rerun, AND `bash setup.sh` invoked directly over SSH. The
# guard `[ "$INSTALL_DIR" != "$SCRIPT_DIR" ]` keeps us from nuking the
# live scripts on a legacy loose-layout install (where there IS no
# scripts/ subdir, so SCRIPT_DIR == INSTALL_DIR and the new copies don't
# exist yet).
#
# Whitelist of exact filenames so a user's hand-placed file at the root
# is never touched. Order-independent; the loop just `rm -f`s each match.
if [ "$INSTALL_DIR" != "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR" ]; then
    LEGACY_LOOSE=(
        setup.sh setup-chmod.sh setup-folders.sh setup-firewall.sh
        setup-nordvpn.sh setup-validate.sh post-deploy-validate.sh
        setup-arr-config.py recyclarr-trigger.py recyclarr-sync.sh
        restart-qbit.sh tune-arrs.sh fix-imports.sh stop-all.sh
        boot-orchestrator.sh boot-orchestrator.log
        # v0.3.24 also moved the compose files + .env.example + docs +
        # .payload-sha into scripts/. Pre-v0.3.24 installs leave these
        # orphaned at the root after sync — clean them up too. (.env
        # is migrated separately below — it holds the user's secrets.)
        docker-compose.yml docker-compose.no-vpn.yml
        docker-compose.test-override.yml
        INDEXERS.md .env.example .setup.lock .payload-sha
    )
    removed=0
    for f in "${LEGACY_LOOSE[@]}"; do
        if [ -f "$INSTALL_DIR/$f" ] && [ -f "$SCRIPT_DIR/$f" ]; then
            # Belt-and-suspenders: only delete the loose copy when the
            # canonical copy under scripts/ actually exists, so we can't
            # remove a file we have no replacement for.
            rm -f "$INSTALL_DIR/$f" && removed=$((removed+1))
        fi
    done
    # The legacy `indexers/` lived directly at INSTALL_DIR; new layout
    # puts it under scripts/indexers/. Only nuke when the new path is
    # populated so we can't drop the user with no indexer scripts at all.
    if [ -d "$INSTALL_DIR/indexers" ] && [ -d "$SCRIPT_DIR/indexers" ]; then
        rm -rf "$INSTALL_DIR/indexers" && removed=$((removed+1))
    fi
    # .env handling: this file holds the user's secrets, so migrate
    # rather than delete. If the root .env exists AND scripts/.env
    # doesn't, MOVE it (so docker compose still picks up the right
    # values on the next compose call from scripts/). If both exist,
    # the wizard already wrote the canonical scripts/.env on Sync;
    # delete the now-stale root copy.
    if [ -f "$INSTALL_DIR/.env" ]; then
        if [ ! -f "$SCRIPT_DIR/.env" ]; then
            mv "$INSTALL_DIR/.env" "$SCRIPT_DIR/.env" \
                && echo "  ℹ Moved your existing .env into scripts/ (compose root)." \
                && removed=$((removed+1))
        else
            rm -f "$INSTALL_DIR/.env" && removed=$((removed+1))
        fi
    fi
    if [ "$removed" -gt 0 ]; then
        echo "  ℹ Migrated $removed legacy loose file(s) out of $INSTALL_DIR — canonical copies live under scripts/ now."
    fi
fi

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
echo "  Removing any containers the user opted out of since last run..."
stop_disabled_services

echo ""
echo "  Pre-flight: checking that no other process holds the ports we'll bind..."
if ! check_port_conflicts; then
    # Treat as step-6 failure so the wizard's stepper rail + retry banner
    # behave the same way they would if compose had hit the error. The
    # detailed remediation hints are already printed by the helper.
    FAIL=$((FAIL + 1))
    echo ""
    echo "  ✘ Step 6 (port pre-check) failed — fix the conflict and re-run."
    abort_if_failed
fi

# Multi-arch pre-flight — confirm each enabled image publishes a manifest for
# this host's CPU arch BEFORE the (long) pull, so a missing arm64 variant
# fails loud here instead of 15 min into `compose up`. Best-effort + non-
# blocking: `docker manifest inspect` can hit Docker Hub rate limits, so a
# query failure is treated as "unknown, let the pull decide", not an error.
check_image_arch() {
    command -v docker >/dev/null 2>&1 || return 0
    local hostm want
    hostm=$(uname -m)
    case "$hostm" in
        x86_64|amd64)  want=amd64 ;;
        aarch64|arm64) want=arm64 ;;
        armv7l|armv6l) want=arm   ;;
        *) echo "  ⏭ Unknown CPU arch '$hostm' — skipping image-arch pre-flight."; return 0 ;;
    esac
    docker manifest inspect hello-world >/dev/null 2>&1 \
        || { echo "  ⏭ 'docker manifest inspect' unavailable — skipping image-arch pre-flight."; return 0; }
    local images img missing=""
    images=$(cd "$SCRIPT_DIR" && $COMPOSE $COMPOSE_FILES config --images 2>/dev/null | sort -u)
    [ -z "$images" ] && return 0
    for img in $images; do
        docker manifest inspect "$img" >/dev/null 2>&1 || continue
        if ! docker manifest inspect "$img" 2>/dev/null | grep -qiE "\"architecture\":[[:space:]]*\"$want\""; then
            missing="$missing $img"
        fi
    done
    if [ -n "$missing" ]; then
        echo ""
        echo "  ⚠ These images may have no $want ($hostm) build:"
        for img in $missing; do echo "      • $img"; done
        echo "    The pull may fail or run an emulated/wrong-arch image; if a"
        echo "    service crash-loops after install, this is the likely cause."
    else
        echo "  ✔ All enabled images publish a $want manifest."
    fi
}

echo ""
echo "  Pre-flight: confirming images are available for this CPU architecture..."
check_image_arch

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

# Step 11: nudge the arrs to scan their completed-download folders.
#
# Even when everything's wired correctly, the arr ↔ download-client
# polling loop can be slow to notice files that completed BEFORE the
# arr was connected (e.g. fresh install when SAB or qBit already had
# a backlog of completed items, or a previous broken install left
# files in /data/Downloads/.../complete that the arr never picked up).
#
# fix-imports.sh fires DownloadedEpisodesScan / DownloadedMoviesScan /
# DownloadedAlbumsScan at each arr, pointing at every known completed-
# downloads root (torrent + usenet). The arr walks the dir, parses
# releases, imports anything it recognises. Idempotent — already-
# imported files are skipped. We mark this step "best effort" via the
# || true wrapper: a transient API hiccup here shouldn't fail the
# whole install, since the user can always re-run fix-imports.sh
# manually from the Help modal's troubleshooting entry.
echo ""
echo "  Note: nudging the arrs to scan completed-downloads folders"
echo "        (catches any backlog from previous runs or pre-existing files)"
run_step 11 "Import any download backlog" \
    bash -c "bash '$SCRIPT_DIR/fix-imports.sh' || true"

# Step 12: drain "Manual import required" queue items.
#
# Step 11 above tells the arrs to RE-SCAN — that fixes downloads where
# the arr never noticed the file at all. But some downloads land in a
# different stuck state: the arr DID see the file, DID identify the
# target media via grab history, but refused to auto-import because the
# parsed release title doesn't cleanly match the matched media's title.
# Classic Radarr log: "Found matching movie via grab history, but
# release was matched to movie by ID. Manual import required."
#
# auto-manual-import.py walks each arr's queue for those, fetches the
# arr's own manualimport candidates (which carry the matched media
# pre-populated from the grab history), and submits ManualImport for
# the conservative subset — only when matched media + quality are
# populated AND no codec/quality/language rejection blocks the import.
# Ambiguous items are left alone so the operator can resolve in the
# WebUI. Wrapped with `|| true` so a transient API hiccup here doesn't
# fail the whole install; the script is safe to re-run any time.
echo ""
echo "  Note: auto-resolving 'Manual Import Required' queue items"
echo "        (Sonarr/Radarr/Lidarr items where grab history identified"
echo "        the target media but the parser couldn't auto-confirm)"
run_step 12 "Auto-confirm manual imports" \
    bash -c "python3 '$SCRIPT_DIR/auto-manual-import.py' || true"

# ── Summary ───────────────────────────────────────────────────────────────────

LAN_IP=$(grep -m1 '^LAN_IP=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '\r')
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
# Print only the URLs for services the user actually enabled in .env so
# the post-install summary doesn't promise a Lidarr URL that's pointing
# at a container which never started. Always include Prowlarr +
# Flaresolverr since they're not profile-gated.
is_enabled ENABLE_HOMEPAGE && {
    echo "  ── Dashboard ──────────────────────────────────"
    echo "  Homepage     http://${IP}:3000           ← start here"
    echo ""
}
echo "  ── Services ───────────────────────────────────"
if is_enabled ENABLE_PLEX; then
    if [ "$MEDIA_SERVER" = "jellyfin" ]; then
        echo "  Jellyfin     http://${IP}:8096"
    else
        echo "  Plex         http://${IP}:32400/web"
    fi
fi
is_enabled ENABLE_SONARR      && echo "  Sonarr       http://${IP}:49152"
is_enabled ENABLE_RADARR      && echo "  Radarr       http://${IP}:49151"
is_enabled ENABLE_LIDARR      && echo "  Lidarr       http://${IP}:49154"
echo "  Prowlarr     http://${IP}:49150"
is_enabled ENABLE_SABNZBD     && echo "  SABnzbd      http://${IP}:49155"
is_enabled ENABLE_QBITTORRENT && echo "  qBittorrent  http://${IP}:49156"
is_enabled ENABLE_BAZARR      && echo "  Bazarr       http://${IP}:49153"
is_enabled ENABLE_PLEX        && echo "  Seerr        http://${IP}:5056"
{ is_enabled ENABLE_PLEX && [ "$MEDIA_SERVER" != "jellyfin" ]; } && echo "  Tautulli     http://${IP}:8181"
echo ""
echo "  ── Remaining manual steps ─────────────────────"
n=0
if is_enabled ENABLE_PLEX; then
    if [ "$MEDIA_SERVER" = "jellyfin" ]; then
        n=$((n + 1))
        echo "  $n. Jellyfin first-run: http://${IP}:8096"
        echo "     Complete the setup wizard (create your admin user, then add"
        echo "     libraries pointing at /media/Movies, /media/TV Shows, etc)."
        echo "     To let the arrs auto-refresh Jellyfin on import + wire the"
        echo "     request manager, generate an API key and re-run config:"
        echo "       Dashboard → API Keys → +  →  copy the key"
        echo "       set JELLYFIN_API_KEY=<key> in $ENV_FILE"
        echo "       python3 $SCRIPT_DIR/setup-arr-config.py"
        echo ""
        n=$((n + 1))
        echo "  $n. Requests (Jellyseerr): http://${IP}:5056"
        echo "     Sign in with Jellyfin, point it at http://jellyfin:8096,"
        echo "     then re-run: python3 $SCRIPT_DIR/setup-arr-config.py"
        echo ""
    else
        n=$((n + 1))
        echo "  $n. Seerr wizard: http://${IP}:5056"
        echo "     Connect Plex with: http://plex:32400"
        echo "     Then re-run: python3 $SCRIPT_DIR/setup-arr-config.py"
        echo ""
        n=$((n + 1))
        echo "  $n. Tautulli: http://${IP}:8181"
        echo "     Connect Plex with token from:"
        echo "     Plex → Settings → Troubleshooting → Get X-Plex-Token"
        echo ""
    fi
fi
if is_enabled ENABLE_SABNZBD; then
    n=$((n + 1))
    echo "  $n. SABnzbd usenet server: http://${IP}:49155"
    echo "     Add your usenet provider under Config → Servers"
    echo ""
fi
if is_enabled ENABLE_RECYCLARR; then
    n=$((n + 1))
    echo "  $n. Recyclarr TRaSH Guide sync (already ran once at install):"
    echo "     http://${IP}:8889                         # one-click Sync Now button"
    echo "     bash $SCRIPT_DIR/recyclarr-sync.sh        # manual re-run with logging"
    echo "     docker exec recyclarr recyclarr sync      # quick one-off (no log file)"
    echo ""
    echo "     To schedule weekly via Synology Task Scheduler:"
    echo "       Control Panel → Task Scheduler → Create → Scheduled Task →"
    echo "       User-defined script → run as root:"
    echo "         bash $SCRIPT_DIR/recyclarr-sync.sh"
    echo ""
    echo "     To change profiles: edit TRASH_SONARR_PROFILE / TRASH_RADARR_PROFILE"
    echo "     in .env and re-run setup.sh (recyclarr.yml gets regenerated)."
    echo ""
fi
echo "  ── Updates ────────────────────────────────────"
echo "  Pull newer images + recreate any whose hash changed:"
echo "  cd $SCRIPT_DIR"
# Surface the active profile set so a copy-pasted update command will
# actually update the user's selected services. Without COMPOSE_PROFILES
# the only services compose touches are the no-profile ones (Prowlarr +
# Flaresolverr) — every other service stays on its old image.
if [ -n "${COMPOSE_PROFILES:-}" ]; then
    echo "  export COMPOSE_PROFILES=$COMPOSE_PROFILES"
fi
echo "  $COMPOSE $COMPOSE_FILES pull && $COMPOSE $COMPOSE_FILES up -d"
echo ""
echo "  (Or use the Mediarr Installer's Update button — it reads .env"
echo "   and builds the right profile + compose-file flags automatically.)"
echo ""
echo "  To schedule monthly updates via Synology Task Scheduler:"
echo "    Control Panel → Task Scheduler → Create → Scheduled Task →"
echo "    User-defined script → run as root, schedule = monthly:"
echo "      cd $SCRIPT_DIR && $COMPOSE $COMPOSE_FILES pull && $COMPOSE $COMPOSE_FILES up -d"
if [ -n "${COMPOSE_PROFILES:-}" ]; then
    echo "    (prepend: export COMPOSE_PROFILES=$COMPOSE_PROFILES; )"
fi
echo ""
echo "  ── Tuning ─────────────────────────────────────"
echo "  If Sonarr / Radarr / Seerr feel slow on every page navigation"
echo "  (10s+ on each click), vacuum the SQLite DBs + disable broken"
echo "  indexers in one shot:"
echo "  sudo bash $SCRIPT_DIR/tune-arrs.sh"
echo ""
echo "  Drain 'Manual import required' queue items — arr identified the"
echo "  target media via grab history but won't auto-import because the"
echo "  parsed release title doesn't match. Conservative: skips items"
echo "  with quality/codec/language rejections so nothing wrong slips in."
echo "  python3 $SCRIPT_DIR/auto-manual-import.py"
echo ""
echo "  To schedule weekly via Synology Task Scheduler:"
echo "    Control Panel → Task Scheduler → Create → Scheduled Task →"
echo "    User-defined script → run as root, schedule = weekly:"
echo "      python3 $SCRIPT_DIR/auto-manual-import.py"
echo ""
echo "  ── Boot ordering (RECOMMENDED) ────────────────"
echo "  On NAS reboot, qBittorrent can get stuck on 'must join at least"
echo "  one network' because Docker restarts containers in arbitrary"
echo "  order — qBit sometimes tries before gluetun's namespace exists."
echo "  Fix: wire a boot-time task that brings the stack up via compose"
echo "  (which respects depends_on)."
echo ""
echo "  DSM → Control Panel → Task Scheduler → Create → Triggered Task"
echo "    Task name:  Mediarr stack — boot orchestrator"
echo "    User:       root"
echo "    Event:      Boot-up"
echo "    Run command:"
echo "      bash $SCRIPT_DIR/boot-orchestrator.sh"
