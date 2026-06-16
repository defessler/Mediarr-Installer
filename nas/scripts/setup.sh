#!/bin/bash
# ── Media Stack Setup ──
#
# Complete first-time setup in one command.
# Safe to re-run — all steps are idempotent.
#
# Usage:
#   sudo bash /volume1/docker/media/scripts/setup.sh [--resume | --from N]
#
#     --resume   Skip steps already completed in a prior run (recorded in
#                .setup-state) and continue from the first unfinished step —
#                as long as .env hasn't changed since. Use after a step failed
#                partway and you've fixed the cause.
#     --from N   Start at step N (1-12), skipping everything before it. For
#                when you know the earlier steps are fine and just want to
#                re-run from a specific point.
#
#   With no flag, every step runs (each is individually idempotent).

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

# ── Resume / partial-run flags ───────────────────────────────────────────────
# --resume continues from the first unfinished step (per .setup-state, only if
# .env is unchanged). --from N forces a start at step N. Default: run all steps.
RESUME=0
FROM_STEP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --resume)   RESUME=1 ;;
        --from)     shift; FROM_STEP="${1:-0}" ;;
        --from=*)   FROM_STEP="${1#*=}" ;;
        -h|--help)
            grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -28
            exit 0 ;;
        *)          echo "  Note: ignoring unknown argument '$1'." ;;
    esac
    shift
done
# Guard against a non-numeric --from value.
case "$FROM_STEP" in (*[!0-9]*|'') FROM_STEP=0 ;; esac
STATE_FILE="$SCRIPT_DIR/.setup-state"

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

    # Auto-discover storage volumes so the Homepage resources widget shows real
    # disk-usage stats. Covers Synology /volume[0-9]+ AND TerraMaster TOS, whose
    # pool lives at /Volume[0-9]+ (capital V — see env-detector.ts). Each detected
    # volume gets MONITORED_DISK_N=/volumeN appended to .env (idempotent — re-runs
    # skip slots already set). docker-compose.yml's homepage service has
    # 4 conditional /diskN bind mounts that pick these up via
    # ${MONITORED_DISK_N:-/tmp} substitution; setup-arr-config.py's
    # render_homepage_widgets() emits a disk widget per populated slot.
    # On hosts with neither path the globs expand to their literal patterns,
    # which fail the [ -d ] test so nothing happens — users can hand-add
    # MONITORED_DISK_N to .env for their layout.
    if [ -f "$ENV_FILE" ]; then
        _disk_n=1
        for _vol in /volume[0-9]* /Volume[0-9]*; do
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
SKIP=0

# ── Detect docker compose command (Docker, else Podman) ──────────────────────
# DOCKER_SOCK in .env (set by the wizard when it detects Podman, or hand-added)
# points the Docker client library at a non-default socket. Export it as
# DOCKER_HOST BEFORE any compose/docker/python call so they all reach the same
# daemon. No effect on a normal Docker install (DOCKER_SOCK unset).
# (env_val isn't defined yet — inline the read. ENV_FILE is resolved above.)
# DOCKER_SOCK is a PLAIN socket path (so the compose bind mount can use it);
# DOCKER_HOST needs a unix:// URI. Accept either form and normalise.
DOCKER_SOCK="$(grep -m1 '^DOCKER_SOCK=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | sed 's/[[:space:]]#.*//' | tr -d '\r' | xargs)"
if [ -n "$DOCKER_SOCK" ]; then
    case "$DOCKER_SOCK" in
        unix://*|tcp://*|ssh://*) export DOCKER_HOST="$DOCKER_SOCK" ;;
        *)                        export DOCKER_HOST="unix://$DOCKER_SOCK" ;;
    esac
    echo "  Note: DOCKER_HOST=$DOCKER_HOST (from .env DOCKER_SOCK)."
fi

COMPOSE=""
CONTAINER_RUNTIME="docker"   # the `<rt> run` / `<rt> ps` CLI (docker | podman)
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
elif command -v podman >/dev/null 2>&1; then
    CONTAINER_RUNTIME="podman"
    # Podman fallback. Prefer the built-in `podman compose` (v4+), else the
    # `podman-compose` wrapper. Point DOCKER_HOST at Podman's socket if .env
    # didn't already set one, so the Python config steps (which use the Docker
    # SDK / talk to containers) reach Podman too.
    if podman compose version >/dev/null 2>&1; then
        COMPOSE="podman compose"
    elif command -v podman-compose >/dev/null 2>&1; then
        COMPOSE="podman-compose"
    else
        echo "Error: Podman is installed but no compose front-end found."
        echo "Install 'podman-compose' (pip install podman-compose) or upgrade to"
        echo "Podman 4+ which bundles 'podman compose', then re-run."
        exit 1
    fi
    if [ -z "$DOCKER_HOST" ]; then
        if [ -S "$HOME/.local/share/containers/podman/podman.sock" ]; then
            export DOCKER_HOST="unix://$HOME/.local/share/containers/podman/podman.sock"
        elif [ -S /run/podman/podman.sock ]; then
            export DOCKER_HOST="unix:///run/podman/podman.sock"
        fi
        [ -n "$DOCKER_HOST" ] && echo "  Note: using Podman ($COMPOSE) with DOCKER_HOST=$DOCKER_HOST."
    fi
    echo "  Note: Docker not found — using Podman ($COMPOSE)."
else
    echo "Error: no container runtime found (neither Docker nor Podman)."
    echo "Install Docker (or Podman + a compose front-end) first."
    exit 1
fi
# Export so the child scripts (setup-folders.sh, setup-arr-config.py, …) inherit
# the runtime we picked instead of re-detecting — keeps them consistent on the
# narrow host that has the docker CLI but only a podman compose front-end. (The
# run_python container path below deliberately does NOT forward it: that
# container ships the docker CLI talking to the mounted socket, so 'docker' is
# the right value inside it.)
export CONTAINER_RUNTIME

# ── Python runner (host python3, else a throwaway container) ──────────────────
# The config steps (setup-arr-config.py + the indexer/import helpers) and the
# qBittorrent password hash are Python. Rather than make python3 a hard host
# requirement, run them on the host's python3 when present, else inside a
# python:3-alpine container that has the docker CLI + socket + INSTALL_DIR +
# host network — so the NAS only needs Docker. The scripts reach the stack via
# http://LAN_IP:<published-port> and shell out to `docker`, which is exactly
# why the fallback uses --network host + the mounted docker.sock. (Same shape
# the recyclarr-trigger sidecar already uses to run setup-arr-config.py.)
HOST_PY3=""
command -v python3 >/dev/null 2>&1 && HOST_PY3="python3"
if [ -z "$HOST_PY3" ]; then
    echo "  Note: no host python3 — config steps will run in a throwaway python container (Docker is all that's needed)."
fi

run_python() {
    if [ -n "$HOST_PY3" ]; then
        "$HOST_PY3" "$@"
        return $?
    fi
    # Throwaway python container via whichever runtime is active (docker or
    # podman). Give the in-container docker CLI a way to reach the SAME daemon
    # this script is using, so the script can shell out to it for the rare
    # steps that need it. How we do that depends on DOCKER_HOST's scheme:
    #   unix://PATH  → bind-mount PATH at the default socket location.
    #   (unset)      → bind-mount the default /var/run/docker.sock.
    #   tcp://, ssh://→ there is NO local socket to mount; pass -e DOCKER_HOST
    #                  so the CLI dials the remote daemon over the host network.
    # The old code did `-v "${DOCKER_HOST#unix://}":...` unconditionally — a
    # no-op strip for tcp://host:2375 / ssh://host, so it bind-mounted a
    # literal "tcp://host:2375" path (docker creates it as an empty dir) and
    # the CLI inside still had no working endpoint. Branch on the scheme.
    local _docker_args=()
    case "$DOCKER_HOST" in
        tcp://*|ssh://*)
            _docker_args+=(-e "DOCKER_HOST=$DOCKER_HOST")
            ;;
        unix://*)
            _docker_args+=(-v "${DOCKER_HOST#unix://}":/var/run/docker.sock)
            ;;
        *)  # unset/empty (normal local Docker) — mount the default socket.
            _docker_args+=(-v /var/run/docker.sock:/var/run/docker.sock)
            ;;
    esac
    "$CONTAINER_RUNTIME" run --rm -i --network host \
        -v "$SCRIPT_DIR":"$SCRIPT_DIR" \
        -v "$INSTALL_DIR":"$INSTALL_DIR" \
        "${_docker_args[@]}" \
        -w "$SCRIPT_DIR" \
        -e INSTALL_DIR="$INSTALL_DIR" \
        --entrypoint sh \
        mirror.gcr.io/library/python:3-alpine \
        -c 'command -v docker >/dev/null 2>&1 || apk add --no-cache docker-cli >/dev/null 2>&1 || true; exec python3 "$@"' _ "$@"
}
# Best-effort variant for the optional steps — never fails the install.
run_python_besteffort() { run_python "$@" || true; }

# ── Read .env helpers ────────────────────────────────────────────────────────

# Small helper for reading a value out of .env, strips inline comments
# and surrounding whitespace. Returns empty string if the key is absent.
env_val() {
    grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | sed 's/[[:space:]]#.*//' | tr -d '\r' | xargs
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

# Opt-IN semantics: the OPPOSITE default of is_enabled. A missing or empty
# key counts as DISABLED; only an explicit true / 1 / yes / on opts in.
# Used for ENABLE_SOULSEEK (and any future opt-in service) so an existing
# install upgraded from a pre-Soulseek .env — which has no ENABLE_SOULSEEK
# key — stays OFF instead of silently turning Soulseek on. Mirrors
# isOptInEnabled() in env-render.ts / the explicit-true check in
# env-schema.ts / is_optin_enabled in setup-arr-config.py.
is_optin_enabled() {
    local val
    val="$(env_val "$1" | tr '[:upper:]' '[:lower:]')"
    case "$val" in
        true|1|yes|on) return 0 ;;
        *)             return 1 ;;
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
if [ "$VPN_ENABLED" = "true" ] || [ "$VPN_ENABLED" = "1" ] || [ "$VPN_ENABLED" = "yes" ] || [ "$VPN_ENABLED" = "on" ]; then
    VPN_ON=1
    echo "  Note: VPN_ENABLED=$VPN_ENABLED — routing qBittorrent through gluetun."
else
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.no-vpn.yml"
    echo "  Note: VPN off (default). qBittorrent traffic will use your real public IP."
    echo "  Set VPN_ENABLED=true in .env and re-run to enable gluetun routing."
    # !reset GUARD — fail fast instead of hanging. The no-vpn override drops
    # qBittorrent's gluetun dependency via `depends_on: !reset null` (Compose
    # Spec 2.20+). podman-compose can't parse it, and docker-compose v1 / docker
    # compose <2.20 SILENTLY IGNORE it, so qBittorrent waits forever for a
    # gluetun the no-vpn project never starts — the install hangs at "Start the
    # stack" for the full timeout, then fails with a generic error. Catch it
    # here with an actionable message. Only the VPN-off path uses this override.
    # Blocks ONLY when we're confident (podman-compose, or a definite <2.20);
    # an unparseable/odd version is treated as modern so we never false-block.
    # NOTE: shipped without a live cross-runtime test — verify on podman /
    # pre-2.20 hosts before relying on it.
    case "$COMPOSE" in
        *podman-compose*)
            echo ""
            echo "  ✘ podman-compose can't run the VPN-off config — it can't parse the"
            echo "    Compose 2.20+ '!reset' tag the no-vpn override uses, so the stack"
            echo "    would hang on start. Pick one:"
            echo "      • Turn the VPN on (VPN_ENABLED=true in .env) — qBittorrent then"
            echo "        runs inside gluetun and needs no override; or"
            echo "      • Use 'docker compose' v2.20+; or"
            echo "      • Remove qBittorrent's 'depends_on: gluetun' from"
            echo "        docker-compose.yml and run without docker-compose.no-vpn.yml."
            exit 1
            ;;
    esac
    _cv="$($COMPOSE version --short 2>/dev/null || $COMPOSE version 2>/dev/null | sed -n 's/.*v\([0-9.]*\).*/\1/p' | head -1)"
    if [ -n "$_cv" ]; then
        _cmaj="$(echo "$_cv" | cut -d. -f1)"
        _cmin="$(echo "$_cv" | cut -d. -f2)"
        case "$_cmaj" in (''|*[!0-9]*) _cmaj="" ;; esac
        case "$_cmin" in (''|*[!0-9]*) _cmin=0 ;; esac
        if [ -n "$_cmaj" ] && { [ "$_cmaj" -lt 2 ] || { [ "$_cmaj" -eq 2 ] && [ "$_cmin" -lt 20 ]; }; }; then
            echo ""
            echo "  ✘ Your Docker Compose (v$_cv) is too old for the VPN-off config — it"
            echo "    uses a v2.20+ feature ('!reset') that older Compose silently ignores,"
            echo "    which hangs the stack on start. Pick one:"
            echo "      • Upgrade Compose to v2.20+ (Synology: Container Manager → Update); or"
            echo "      • Turn the VPN on (VPN_ENABLED=true in .env); or"
            echo "      • Remove qBittorrent's 'depends_on: gluetun' from docker-compose.yml"
            echo "        and run without docker-compose.no-vpn.yml."
            exit 1
        fi
    fi
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

# FlareSolverr's bundled Chromium crash-loops on arm64. The wizard's Detect
# screen disables it there, but a manual `bash setup.sh`, an imported x86
# profile, or a re-run on a pre-arm64-logic .env would re-arm the crash-loop.
# Normalize ENABLE_FLARESOLVERR=false in .env on ARM so EVERY downstream gate
# (the profile below, wait_for_services, check_port_conflicts,
# stop_disabled_services, AND post-deploy-validate) consistently sees it off —
# not just this one profile line. Idempotent: once false, is_enabled returns
# false and this is a no-op on re-runs.
case "$(uname -m 2>/dev/null)" in
    aarch64|arm64|armv7l|armv6l)
        if is_enabled ENABLE_FLARESOLVERR; then
            if grep -q '^ENABLE_FLARESOLVERR=' "$ENV_FILE" 2>/dev/null; then
                sed -i 's|^ENABLE_FLARESOLVERR=.*|ENABLE_FLARESOLVERR=false|' "$ENV_FILE"
            else
                printf 'ENABLE_FLARESOLVERR=false\n' >> "$ENV_FILE"
            fi
            echo "  Note: FlareSolverr disabled on $(uname -m) — its bundled Chromium crash-loops on ARM."
        fi
        ;;
esac

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
# Soulseek is OPT-IN (default off) — use is_optin_enabled, NOT is_enabled,
# so a pre-Soulseek .env (no key) stays off. slskd lives in gluetun's
# namespace, so when VPN is on Soulseek must ALSO pull in the "vpn"
# sidecar (same coupling as qBittorrent). The case-guard avoids a
# duplicate "vpn" entry when both qBittorrent and Soulseek are on.
if is_optin_enabled ENABLE_SOULSEEK; then
    PROFILES+=("soulseek")
    if [ $VPN_ON -eq 1 ]; then
        case " ${PROFILES[*]} " in
            *" vpn "*) : ;;
            *)         PROFILES+=("vpn") ;;
        esac
    fi
fi
# AzuraCast (broadcast radio) is OPT-IN (default off) — use is_optin_enabled,
# NOT is_enabled, so a pre-AzuraCast .env (no key) stays off. Unlike Soulseek,
# AzuraCast is NOT VPN-coupled: it must be LAN-reachable for listeners, so it
# stays on the regular bridge and never pulls in the "vpn" sidecar.
is_optin_enabled ENABLE_AZURACAST && PROFILES+=("radio")

if [ ${#PROFILES[@]} -gt 0 ]; then
    export COMPOSE_PROFILES="$(IFS=,; echo "${PROFILES[*]}")"
    echo "  Services enabled: ${COMPOSE_PROFILES//,/, } (+ prowlarr always on)"
else
    echo "  WARN: every service is disabled in .env. Only Prowlarr will start."
fi

# Soulseek: auto-generate the slskd↔soularr REST key when it's blank, so the
# user never has to invent one. It is an INTERNAL shared secret between the two
# containers (NOT a Soulseek login). We mint + persist it to .env HERE —
# before `docker compose up` (slskd reads ${SLSKD_API_KEY}) and before
# setup-arr-config.py writes soularr's config.ini from the same .env — so both
# ends agree on one key. Idempotent: only fires when Soulseek is opted in AND
# the key is empty, so re-runs/updates keep the existing key. Hex output is
# [0-9a-f] only, so it is safe unquoted in .env and in compose ${VAR} expansion.
if is_optin_enabled ENABLE_SOULSEEK && [ -z "$(env_val SLSKD_API_KEY)" ]; then
    _slskd_key="$(openssl rand -hex 24 2>/dev/null \
        || head -c 24 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    if [ -n "$_slskd_key" ]; then
        if grep -q '^SLSKD_API_KEY=' "$ENV_FILE"; then
            # Replace the empty SLSKD_API_KEY= line in place (| delimiter — hex
            # has no |; -i works on both GNU and BusyBox/DSM sed).
            sed -i "s|^SLSKD_API_KEY=.*|SLSKD_API_KEY=${_slskd_key}|" "$ENV_FILE"
        else
            echo "SLSKD_API_KEY=${_slskd_key}" >> "$ENV_FILE"
        fi
        echo "  Generated the slskd API key for you (saved to .env) — nothing to set."
    else
        echo "  ⚠ Couldn't generate an slskd API key (no openssl, and /dev/urandom+od unavailable)."
        echo "    Set SLSKD_API_KEY to any 16–255 random characters in .env and re-run."
    fi
    unset _slskd_key
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

# Retry a command with exponential backoff. Usage:
#   retry <max_attempts> <label> <command...>
# Returns the command's exit status once it succeeds, or non-zero after the
# last attempt. Used to wrap network-bound steps (image pull, NordVPN fetch)
# so a transient registry blip or DNS hiccup doesn't fail the whole install.
retry() {
    local max="$1" label="$2"
    shift 2
    local attempt=1 delay=2 rc=0
    while true; do
        if "$@"; then
            return 0
        else
            rc=$?
        fi
        # Exit code 2 = a PERMANENT failure the command has already diagnosed
        # (e.g. missing token, no python runtime, malformed key). Retrying would
        # deterministically fail the same way, so abort now — no backoff sleeps,
        # no triplicated error output. Transient failures use exit 1 and retry.
        if [ "$rc" -eq 2 ]; then
            echo "  ⚠ $label failed permanently — not retrying."
            return "$rc"
        fi
        if [ "$attempt" -ge "$max" ]; then
            echo "  ⚠ $label failed after ${attempt} attempt(s)."
            return 1
        fi
        echo "  … $label failed (attempt ${attempt}/${max}) — retrying in ${delay}s."
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
}

# ── Checkpoint / resume state ─────────────────────────────────────────────────
# .setup-state (alongside .setup.lock in the scripts dir) records the last
# step that completed plus a hash of .env at that time. --resume reads it to
# skip already-finished steps; a changed .env invalidates the checkpoint so
# the directory/firewall/validate steps re-run against the new config.

# Hash .env portably: prefer a native digest tool, fall back to Python
# (host or the throwaway container) so this works on busybox-only NAS units
# that ship neither sha256sum nor shasum.
compute_env_hash() {
    [ -f "$ENV_FILE" ] || { echo "none"; return 0; }
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$ENV_FILE" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$ENV_FILE" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$ENV_FILE" 2>/dev/null | awk '{print $NF}'
    else
        # Pass the path as argv[1] rather than interpolating it into the Python
        # source — a path containing a quote/special char would otherwise break
        # the literal (and could inject code).
        run_python -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ENV_FILE" 2>/dev/null || echo "nohash"
    fi
}

# Overwrite the checkpoint with the latest completed step + the .env hash AS OF
# NOW. Recomputed fresh (not the start-of-run snapshot) because a step can
# legitimately edit .env mid-run — step 4 writes the fetched WireGuard key — and
# a stale frozen hash would make the next --resume think the config changed and
# restart from step 1. Single-record (latest only) since steps run in order.
# Best-effort — a read-only scripts dir just means resume won't be available.
mark_step_done() {
    printf 'env_hash=%s\nlast_completed=%s\n' "$(compute_env_hash)" "$1" > "$STATE_FILE" 2>/dev/null || true
}

run_step() {
    local step="$1" description="$2"
    shift 2

    # Resume / --from: skip steps below the computed start point. They either
    # completed in a prior run (recorded in .setup-state) or the user asserted
    # they're fine via --from N.
    if [ "$step" -lt "$START_STEP" ]; then
        echo ""
        echo "  ⏭ Step $step ($description) — skipped (already done / --from)."
        SKIP=$((SKIP + 1))
        return 0
    fi

    echo ""
    echo "┌─────────────────────────────────────────────"
    echo "│ Step $step: $description"
    echo "└─────────────────────────────────────────────"

    if "$@"; then
        echo ""
        echo "  ✔ Step $step complete."
        PASS=$((PASS + 1))
        # Only advance the resume checkpoint while the run is still clean.
        # mark_step_done records last_completed=<step>, and --resume restarts
        # at last_completed+1. If an EARLIER step already failed (FAIL>0) but a
        # later step happens to succeed, marking it here would advance the
        # checkpoint PAST the failed step — so --resume would skip the failed
        # step entirely and print "Setup complete!". Gating on FAIL==0 keeps
        # the checkpoint as an unbroken prefix, so --resume always lands on the
        # first step that didn't finish.
        if [ "$FAIL" -eq 0 ]; then
            mark_step_done "$step"
        fi
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
        echo "  Resume from the first unfinished step:"
        echo "    sudo bash $SCRIPT_DIR/setup.sh --resume"
        echo "  (or re-run without --resume — all steps are idempotent.)"
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
        "jellyfin:ENABLE_PLEX"
        "sonarr:ENABLE_SONARR"    "radarr:ENABLE_RADARR"
        "lidarr:ENABLE_LIDARR"    "bazarr:ENABLE_BAZARR"
        "qbittorrent:ENABLE_QBITTORRENT" "gluetun:ENABLE_QBITTORRENT"
        "sabnzbd:ENABLE_SABNZBD"
        "homepage:ENABLE_HOMEPAGE"
        "recyclarr:ENABLE_RECYCLARR"
        "unpackerr:ENABLE_UNPACKERR"
        "flaresolverr:ENABLE_FLARESOLVERR"
        "slskd:ENABLE_SOULSEEK"   "soularr:ENABLE_SOULSEEK"
        "azuracast:ENABLE_AZURACAST"
    )
    local pair container flag stopped=0
    for pair in "${pairs[@]}"; do
        container="${pair%:*}"
        flag="${pair#*:}"
        # Service is enabled → leave the container alone, up -d will
        # (re-)create or update it as needed. ENABLE_SOULSEEK / ENABLE_AZURACAST
        # are OPT-IN, so use the explicit-true helper; the default-on is_enabled
        # would treat a missing key as "enabled" and never reap slskd/soularr or
        # azuracast.
        if [ "$flag" = "ENABLE_SOULSEEK" ] || [ "$flag" = "ENABLE_AZURACAST" ]; then
            is_optin_enabled "$flag" && continue
        else
            is_enabled "$flag" && continue
        fi
        # Service is disabled but the container exists → stop + remove.
        if $CONTAINER_RUNTIME ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$container"; then
            $CONTAINER_RUNTIME stop "$container" >/dev/null 2>&1 || true
            $CONTAINER_RUNTIME rm   "$container" >/dev/null 2>&1 || true
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
        if $CONTAINER_RUNTIME ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$container"; then
            $CONTAINER_RUNTIME stop "$container" >/dev/null 2>&1 || true
            $CONTAINER_RUNTIME rm   "$container" >/dev/null 2>&1 || true
            echo "  ✔ Removed $container (not used by MEDIA_SERVER=$MEDIA_SERVER)"
            stopped=$((stopped + 1))
        fi
    done
    # VPN-mode reconcile. qBittorrent's network mode is IMMUTABLE on a live
    # container: VPN-on it runs inside gluetun's namespace (network_mode:
    # container:gluetun), VPN-off it runs on the bridge publishing its own
    # ports. Toggling VPN_ENABLED between runs leaves the RUNNING qBittorrent
    # in the wrong mode, and `compose up -d` can't change it in place — so a
    # bare re-run errors with "container name /qbittorrent already in use" or
    # leaves a stale container holding ${LAN_IP}:49156 → "port is already
    # allocated". And gluetun, once VPN is turned OFF, is an orphan (not in
    # the no-vpn project) that still holds that port. Reap both here so
    # start_stack recreates qBittorrent cleanly in the correct mode.
    if [ "$VPN_ON" -eq 0 ] \
       && $CONTAINER_RUNTIME ps -a --format '{{.Names}}' 2>/dev/null | grep -qx gluetun; then
        $CONTAINER_RUNTIME stop gluetun >/dev/null 2>&1 || true
        $CONTAINER_RUNTIME rm   gluetun >/dev/null 2>&1 || true
        echo "  ✔ Removed gluetun (VPN is off — it would hold qBittorrent's port)"
        stopped=$((stopped + 1))
    fi
    if is_enabled ENABLE_QBITTORRENT \
       && $CONTAINER_RUNTIME ps -a --format '{{.Names}}' 2>/dev/null | grep -qx qbittorrent; then
        local qbmode mismatch=0
        qbmode=$($CONTAINER_RUNTIME inspect -f '{{.HostConfig.NetworkMode}}' qbittorrent 2>/dev/null || echo "")
        if [ "$VPN_ON" -eq 1 ]; then
            case "$qbmode" in container:*) : ;; *) mismatch=1 ;; esac   # want gluetun namespace, have bridge
        else
            case "$qbmode" in container:*) mismatch=1 ;; esac           # want bridge, have gluetun namespace
        fi
        if [ "$mismatch" -eq 1 ]; then
            $CONTAINER_RUNTIME stop qbittorrent >/dev/null 2>&1 || true
            $CONTAINER_RUNTIME rm   qbittorrent >/dev/null 2>&1 || true
            echo "  ✔ Removed qBittorrent so it recreates in the correct network mode (VPN toggled)"
            stopped=$((stopped + 1))
        fi
    fi
    # slskd inherits the exact same immutable-network-mode wedge as
    # qBittorrent (VPN-on: container:gluetun namespace; VPN-off: bridge).
    # Toggling VPN_ENABLED strands the running slskd on the wrong mode and
    # `compose up -d` can't change it in place. Reap it on mismatch so
    # start_stack recreates it cleanly. Opt-in: only when Soulseek is on.
    if is_optin_enabled ENABLE_SOULSEEK \
       && $CONTAINER_RUNTIME ps -a --format '{{.Names}}' 2>/dev/null | grep -qx slskd; then
        local slmode slmismatch=0
        slmode=$($CONTAINER_RUNTIME inspect -f '{{.HostConfig.NetworkMode}}' slskd 2>/dev/null || echo "")
        if [ "$VPN_ON" -eq 1 ]; then
            case "$slmode" in container:*) : ;; *) slmismatch=1 ;; esac   # want gluetun namespace, have bridge
        else
            case "$slmode" in container:*) slmismatch=1 ;; esac           # want bridge, have gluetun namespace
        fi
        if [ "$slmismatch" -eq 1 ]; then
            $CONTAINER_RUNTIME stop slskd >/dev/null 2>&1 || true
            $CONTAINER_RUNTIME rm   slskd >/dev/null 2>&1 || true
            echo "  ✔ Removed slskd so it recreates in the correct network mode (VPN toggled)"
            stopped=$((stopped + 1))
        fi
    fi
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
    # recyclarr-trigger has no compose profile (always-on) and publishes host
    # port 8889 even when ENABLE_RECYCLARR is off — pre-check it unconditionally
    # so a foreign holder of 8889 fails fast HERE with a clear message instead
    # of late in `docker compose up` with the cryptic bind-address error.
    local pairs=("prowlarr:49150" "recyclarr-trigger:8889")
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
    # slskd's WebUI (5030) is published by GLUETUN when VPN is on (slskd
    # uses network_mode: container:gluetun) — the ":$port->" published-port
    # match below handles that indirection exactly like qBittorrent's
    # 49156. 50300 (Soulseek peer listen) is omitted for the same reason
    # 6881 is: best-effort + owned by gluetun-or-slskd depending on VPN mode.
    #
    # 5030 must be pre-checked whenever GLUETUN will run, not just when
    # Soulseek is opted in: gluetun publishes ${LAN_IP}:5030:5030
    # unconditionally in its ports: block, and the "vpn" profile starts
    # gluetun when VPN is on AND qBittorrent is enabled — even with
    # Soulseek off. Gating solely on ENABLE_SOULSEEK would let a foreign
    # 5030 holder slip past the pre-check and fail gluetun's bind late in
    # compose up. Gate on (gluetun-will-run) OR (Soulseek opted in); the
    # case-guard avoids a duplicate slskd:5030 entry when both hold.
    if is_optin_enabled ENABLE_SOULSEEK \
       || { [ "$VPN_ON" -eq 1 ] && is_enabled ENABLE_QBITTORRENT; }; then
        case " ${pairs[*]} " in
            *" slskd:5030 "*) : ;;
            *)                pairs+=("slskd:5030") ;;
        esac
    fi
    # AzuraCast (opt-in): pre-check its web UI port (AZURACAST_HTTP_PORT, default
    # 49157, published bound to ${LAN_IP}) and the bottom of its Icecast stream
    # range (8000 — the first port AzuraCast publishes for a station). Both are
    # plain LAN binds (NOT VPN-namespaced), so a foreign holder would fail the
    # compose-up bind late; surface it here. Only the lowest stream port is
    # pre-checked — the rest of 8000-8029 is best-effort like 6881/50300.
    if is_optin_enabled ENABLE_AZURACAST; then
        local az_http
        az_http="$(env_val AZURACAST_HTTP_PORT)"
        case "$az_http" in (''|*[!0-9]*) az_http=49157 ;; esac
        pairs+=("azuracast:$az_http" "azuracast:8000")
    fi

    # Snapshot the listening sockets ONCE, up front. netstat is NOT
    # installed by default on Debian-12 / UGREEN UGOS (net-tools is a
    # separate package), so the old per-port `netstat -lnt 2>/dev/null`
    # silently produced no output there — the awk then saw nothing, never
    # set `found`, and reported EVERY port as free. That fails OPEN: the
    # whole pre-check no-ops and the late compose-up bind error returns.
    # Prefer `ss -ltn` (ships in iproute2, present on every modern NAS
    # including UGREEN), fall back to `netstat -lnt`, and if NEITHER tool
    # exists, skip the pre-check explicitly rather than pretend all ports
    # are free — compose-up's own bind error is the backstop then.
    local listen_snapshot=""
    if command -v ss >/dev/null 2>&1; then
        listen_snapshot="$(ss -ltn 2>/dev/null)"
    elif command -v netstat >/dev/null 2>&1; then
        listen_snapshot="$(netstat -lnt 2>/dev/null)"
    else
        echo "  ⏭ Skipping port pre-check (no ss/netstat on this host)."
        echo "    If a port is already taken, compose up will report it below."
        return 0
    fi

    # Snapshot the host ports OUR running containers publish, ONCE — used below
    # to exclude a port that IS bound but bound by US (compose will reuse the
    # container). `{{.Ports}}` lists BOTH single mappings (":49156->49156") and
    # RANGE mappings: AzuraCast publishes its Icecast stream ports as one range,
    # "<ip>:8000-8029->8000-8029". The old per-port ":$port->" grep matched the
    # single form ONLY, so it never recognised our own AzuraCast already holding
    # 8000 and false-flagged it as a foreign conflict — halting a re-install that
    # had a prior AzuraCast still running. The range-aware test below fixes that.
    local published_snapshot
    published_snapshot="$($CONTAINER_RUNTIME ps --format '{{.Ports}}' 2>/dev/null)"

    local conflicts=""
    local pair port svc
    for pair in "${pairs[@]}"; do
        svc="${pair%:*}"
        port="${pair#*:}"
        # Match :PORT at the end of the socket's local-address column
        # ($4 in both `ss -ltn` and `netstat -lnt` output) so we don't
        # catch :49152x or :4915. Reads the snapshot captured above, so
        # this works identically whether ss or netstat produced it.
        if printf '%s\n' "$listen_snapshot" | awk -v p=":$port$" '$4 ~ p { found=1 } END { exit !found }'; then
            # Port is bound. Is it PUBLISHED by one of OUR running containers?
            # If yes, it's not a conflict — compose will recreate/reuse that
            # container in the next step. If no container publishes it, some-
            # thing foreign holds the port and the compose-up would fail.
            #
            # Check by published host port, NOT by container name. Under VPN,
            # qBittorrent's WebUI (49156) is published by GLUETUN — qBit uses
            # network_mode: container:gluetun — and the qbittorrent container is
            # often stopped/wedged on a re-install (the classic "qBit lost its
            # network" state). A name match on "$svc" then sees no running
            # "qbittorrent" and wrongly flags our OWN gluetun-fronted port as a
            # foreign conflict, halting the install. Matching ":$port->" in any
            # container's published-ports list handles the gluetun indirection
            # (and a stopped qBit) and works the same on docker + podman.
            # Pull every host-side mapping from the snapshot — ":N->" or a range
            # ":LO-HI->" — and test whether $port is that single port OR falls
            # inside that range (8000 ∈ 8000-8029). A match means our own
            # container already publishes it, so it is NOT a foreign conflict.
            if ! printf '%s\n' "$published_snapshot" \
                 | grep -oE ':[0-9]+(-[0-9]+)?->' \
                 | sed 's/^://; s/->$//' \
                 | awk -F- -v p="$port" \
                     'NF==1 && $1==p { f=1 } NF==2 && p>=$1 && p<=$2 { f=1 } END { exit !f }'; then
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
    # slskd shares gluetun's namespace when VPN is on, exactly like
    # qBittorrent — `.State.Status` is the only readiness signal. soularr
    # is a plain bridge service. Opt-in, so use the explicit-true helper.
    is_optin_enabled ENABLE_SOULSEEK && services="$services slskd soularr"
    # AzuraCast is a plain bridge service (not VPN-namespaced); .State.Status
    # is the readiness signal. Opt-in, so use the explicit-true helper.
    is_optin_enabled ENABLE_AZURACAST && services="$services azuracast"

    echo ""
    echo "  Waiting for containers to become healthy..."
    echo "  (First run pulls images — this may take 5-15 minutes)"
    echo ""

    while [ $elapsed -lt $max_wait ]; do
        local all_up=true
        local status_line="  ${elapsed}s  "

        for svc in $services; do
            local state
            state=$($CONTAINER_RUNTIME inspect --format='{{.State.Status}}' "$svc" 2>/dev/null || echo "missing")
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
        boot-orchestrator.sh boot-orchestrator.log .boot-orchestrator.lock
        install-boot-resilience.sh qbit-guardian.sh qbit-guardian.log
        .qbit-guardian.lock
        # v0.3.24 also moved the compose files + .env.example + docs +
        # .payload-sha into scripts/. Pre-v0.3.24 installs leave these
        # orphaned at the root after sync — clean them up too. (.env
        # is migrated separately below — it holds the user's secrets.)
        docker-compose.yml docker-compose.no-vpn.yml
        docker-compose.test-override.yml
        INDEXERS.md .env.example .setup.lock .setup-state .payload-sha
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

# A stale .setup-state at INSTALL_DIR root (wrong location, or a pre-this-feature
# artifact) would mislead --resume — the canonical spot is SCRIPT_DIR. Drop it.
[ "$INSTALL_DIR" != "$SCRIPT_DIR" ] && rm -f "$INSTALL_DIR/.setup-state" 2>/dev/null || true

# Re-resolve ENV_FILE: the legacy migration above may have MOVED .env from
# INSTALL_DIR root into SCRIPT_DIR, leaving the earlier (line ~98) resolution
# pointing at a path that no longer exists. Re-point at the canonical copy so
# the hash + the summary's LAN_IP read the file that's actually there now.
ENV_FILE="$SCRIPT_DIR/.env"
[ -f "$ENV_FILE" ] || ENV_FILE="$INSTALL_DIR/.env"

# ── Resolve where to start (resume / --from) ─────────────────────────────────
# ENV_HASH fingerprints the *final* .env (after the migration above) so a
# checkpoint is only honoured when the config is unchanged.
ENV_HASH="$(compute_env_hash)"
# There are exactly this many numbered run_step calls below (1..N). --from is
# validated against it: without an upper bound, `--from 99` would make every
# run_step skip (step < START_STEP is always true), do NOTHING, and still
# print "✔ Setup complete!" — a silent no-op that looks like success. Reject
# an out-of-range value loudly instead. Keep this in sync if steps are added.
TOTAL_STEPS=12
START_STEP=1
if [ "$FROM_STEP" -gt 0 ]; then
    if [ "$FROM_STEP" -gt "$TOTAL_STEPS" ]; then
        echo "✘ --from $FROM_STEP is out of range — there are only $TOTAL_STEPS steps (1-$TOTAL_STEPS)."
        echo "  Re-run with a step in that range, e.g. --from $TOTAL_STEPS to run just the last step,"
        echo "  or drop --from entirely to run the whole install (every step is idempotent)."
        exit 1
    fi
    START_STEP="$FROM_STEP"
    echo "  ▶ --from $FROM_STEP: starting at step $FROM_STEP (earlier steps skipped)."
elif [ "$RESUME" = 1 ]; then
    if [ -f "$STATE_FILE" ]; then
        _saved_hash="$(grep -m1 '^env_hash=' "$STATE_FILE" 2>/dev/null | cut -d= -f2-)"
        _last="$(grep -m1 '^last_completed=' "$STATE_FILE" 2>/dev/null | cut -d= -f2-)"
        case "$_last" in (''|*[!0-9]*) _last=0 ;; esac
        if [ "$_saved_hash" = "$ENV_HASH" ] && [ "$_last" -gt 0 ]; then
            START_STEP=$((_last + 1))
            echo "  ▶ --resume: last completed step was $_last — resuming at step $START_STEP."
        else
            echo "  ▶ --resume: .env changed since the last run (or no progress recorded) — running all steps."
        fi
        unset _saved_hash _last
    else
        echo "  ▶ --resume: no checkpoint found ($STATE_FILE) — running all steps."
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
# bar regardless of which path was taken. On non-DSM we run the read-only
# diagnose-firewall.sh (family-aware GUIDANCE — detects an active host
# firewall and prints the exact ports to open; never writes a rule), which
# also emits a clean exit 0 so run_step records "✔ Step 3 complete".
if [ -f /etc/synoinfo.conf ]; then
    run_step 3 "Apply firewall rules" \
        bash "$SCRIPT_DIR/setup-firewall.sh"
else
    # Can't safely write firewall rules off-DSM (no rc.d boot dir, and the
    # host firewall — if any — is the user's to manage). Instead of a static
    # "open these ports" blurb, diagnose-firewall.sh inspects the actual host
    # firewall (ufw/firewalld/nftables/iptables) and prints copy-paste unblock
    # commands for ONLY the enabled services' ports — or confirms nothing is
    # blocking. Read-only and always exits 0, so the step never goes red.
    run_step 3 "Apply firewall rules" \
        bash "$SCRIPT_DIR/diagnose-firewall.sh"
fi

echo "  Note: fetches your WireGuard private key from the NordVPN API"
# Network-bound: the NordVPN API call can time out on a flaky connection.
# retry() re-runs the (idempotent) fetch with backoff. A no-op when VPN is
# disabled — the script exits 0 on the first attempt.
run_step 4 "Fetch NordVPN WireGuard key" \
    retry 3 "NordVPN key fetch" bash "$SCRIPT_DIR/setup-nordvpn.sh"

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
    command -v "$CONTAINER_RUNTIME" >/dev/null 2>&1 || return 0
    local hostm want images total img safe tmpd missing="" launched n out TO
    hostm=$(uname -m)
    case "$hostm" in
        x86_64|amd64)  want=amd64 ;;
        aarch64|arm64) want=arm64 ;;
        armv7l|armv6l) want=arm   ;;
        *) echo "  ⏭ Unknown CPU arch '$hostm' — skipping image-arch pre-flight."; return 0 ;;
    esac
    # Bound each registry query so a hung registry/proxy/DNS can't wedge the
    # parallel `wait` forever (which would reintroduce the silent stall this
    # rewrite kills). Opt-in: use GNU timeout if present, no-op on a busybox NAS.
    TO=''; command -v timeout >/dev/null 2>&1 && TO='timeout 20'
    # Probe via the mirror (not bare hello-world = Docker Hub) so this capability
    # check doesn't itself burn a Docker Hub anonymous pull / hit its rate limit.
    $CONTAINER_RUNTIME manifest inspect mirror.gcr.io/library/hello-world >/dev/null 2>&1 \
        || { echo "  ⏭ 'manifest inspect' unavailable — skipping image-arch pre-flight."; return 0; }
    images=$(cd "$SCRIPT_DIR" && $COMPOSE $COMPOSE_FILES config --images 2>/dev/null | sort -u)
    [ -z "$images" ] && return 0
    total=$(printf '%s\n' "$images" | grep -c .)
    # Each `manifest inspect` is a registry round-trip. The old version ran them
    # ONE IMAGE AT A TIME and called inspect TWICE per image (~2x the round-trips)
    # while printing nothing — so a ~17-image stack sat silent for over a minute.
    # Now: ONE timeout-bounded inspect per image, ALL fanned out at once (these
    # are lightweight metadata GETs against lscr.io/ghcr.io/mirror.gcr.io — no
    # Docker Hub rate limit), with a live counter; wall-clock ~= the single
    # slowest image. Sequential-with-counter fallback when mktemp is unavailable.
    tmpd=$(mktemp -d 2>/dev/null) || tmpd=""
    if [ -n "$tmpd" ]; then
        launched=0
        for img in $images; do
            safe=$(printf '%s' "$img" | tr -c 'A-Za-z0-9._-' '_')
            # One background query per image. A subshell (not a function) so no
            # `local`; it writes the image NAME into a flag file only when the
            # wanted arch is absent. A failed/timed-out query exits 0 →
            # "unknown, let the pull decide", same best-effort policy as before.
            (
                # Already pulled locally → already this host's arch (Docker won't run a
                # wrong-arch image and we request no emulation), so the registry
                # round-trip is redundant. Skip it; the later `compose pull` is the
                # authoritative arch gate for anything it actually (re)fetches.
                $CONTAINER_RUNTIME image inspect "$img" >/dev/null 2>&1 && exit 0
                out=$($TO $CONTAINER_RUNTIME manifest inspect "$img" 2>/dev/null) || exit 0
                printf '%s' "$out" | grep -qiE "\"architecture\":[[:space:]]*\"$want\"" \
                    || printf '%s\n' "$img" > "$tmpd/$safe.missing" 2>/dev/null
            ) &
            launched=$((launched + 1))
            printf '\r  checking %d/%d image manifests...' "$launched" "$total"
        done
        wait
        printf '\r  checked %d/%d image manifests.            \n' "$total" "$total"
        missing=$(cat "$tmpd"/*.missing 2>/dev/null | tr '\n' ' ')
        rm -rf "$tmpd"
    else
        n=0
        for img in $images; do
            n=$((n + 1))
            printf '\r  checking %d/%d: %-40.40s' "$n" "$total" "$img"
            # Locally present → already host-arch; skip the redundant registry query.
            $CONTAINER_RUNTIME image inspect "$img" >/dev/null 2>&1 && continue
            out=$($TO $CONTAINER_RUNTIME manifest inspect "$img" 2>/dev/null) || continue
            printf '%s' "$out" | grep -qiE "\"architecture\":[[:space:]]*\"$want\"" \
                || missing="$missing $img"
        done
        printf '\r%*s\r' 60 ''
    fi
    if [ -n "$missing" ]; then
        echo "  ⚠ These images may have no $want ($hostm) build:"
        for img in $missing; do echo "      • $img"; done
        echo "    The pull may fail or run an emulated/wrong-arch image; if a"
        echo "    service crash-loops after install, this is the likely cause."
    else
        echo "  ✔ All enabled images publish a $want manifest."
    fi
}

# Free space where Docker actually stores images + container layers. This is
# the daemon's data-root (default /var/lib/docker), which on many NAS units is
# a DIFFERENT, smaller mount than INSTALL_DIR — the installer checks INSTALL_DIR
# free space, but the ~10 GiB of stack images land here. A near-full data-root
# is a classic "pull fails halfway with no space left on device" trap, so warn
# early. Non-blocking + best-effort: skips cleanly if df/docker info don't
# cooperate.
MIN_DROOT_GIB=10
check_docker_dataroot_space() {
    command -v "$CONTAINER_RUNTIME" >/dev/null 2>&1 || return 0
    local droot free_kb free_gib
    droot=$($CONTAINER_RUNTIME info -f '{{.DockerRootDir}}' 2>/dev/null)
    [ -n "$droot" ] || return 0
    # Walk up to the nearest existing ancestor so df has a real path to stat.
    while [ -n "$droot" ] && [ ! -d "$droot" ]; do droot=$(dirname "$droot"); done
    [ -d "$droot" ] || return 0
    free_kb=$(df -Pk "$droot" 2>/dev/null | awk 'NR==2 {print $4}')
    case "$free_kb" in (*[!0-9]*|'') return 0 ;; esac
    free_gib=$((free_kb / 1024 / 1024))
    if [ "$free_gib" -lt "$MIN_DROOT_GIB" ]; then
        echo "  ⚠ Docker's image store ($droot) has only ${free_gib} GiB free."
        echo "    The stack pulls ~${MIN_DROOT_GIB} GiB of images on first run; a near-full"
        echo "    data-root fails mid-pull with 'no space left on device'. This mount"
        echo "    can differ from your install dir — free space here, or relocate the"
        echo "    Docker data-root, before the pull."
    else
        echo "  ✔ Docker image store ($droot): ${free_gib} GiB free."
    fi
}

# Registry egress dry-run — pull one tiny image to confirm the DAEMON can
# actually reach a registry and pull layers. We test via mirror.gcr.io (a
# transparent Docker Hub pull-through cache) rather than Docker Hub directly:
# the stack itself now pulls from lscr.io / ghcr.io / mirror.gcr.io (NOT Docker
# Hub — see docker-compose.yml), so a Docker-Hub-rate-limited test would
# false-warn even when the real pulls succeed. The daemon has its own network
# stack/DNS/proxy config, so a host that "has internet" can still have a daemon
# that can't pull. Failing here with a specific message beats 15 min into a
# silent compose-up hang. Non-blocking (transient blips shouldn't halt the
# install) but loud. Cleans up the test image if we were the ones who pulled it.
check_registry_egress() {
    command -v "$CONTAINER_RUNTIME" >/dev/null 2>&1 || return 0
    local test_img="mirror.gcr.io/library/hello-world"
    local had_hw
    had_hw=$($CONTAINER_RUNTIME image inspect "$test_img" >/dev/null 2>&1 && echo 1 || echo 0)
    # WHY: retry the test pull a few times (sleeping 3s then 6s) before
    # concluding failure — a transient network blip shouldn't false-alarm when
    # the real image pull in the next step still succeeds. Only warn if EVERY
    # attempt fails. Still non-blocking + quick (worst case ~9s of sleeps on a
    # genuinely unreachable daemon).
    local ok=0 attempt delay
    for attempt in 1 2 3; do
        if $CONTAINER_RUNTIME pull -q "$test_img" >/dev/null 2>&1; then
            ok=1
            break
        fi
        [ "$attempt" -lt 3 ] && { delay=$((attempt * 3)); sleep "$delay"; }
    done
    if [ "$ok" -eq 1 ]; then
        echo "  ✔ Docker daemon can reach the registry (pulled a test image)."
    else
        echo "  ⚠ Docker daemon could NOT pull a test image ($test_img)."
        echo "    The image pull in the next step may fail too. Common causes: the"
        echo "    daemon's DNS/proxy isn't set (check /etc/docker/daemon.json + the"
        echo "    docker service's HTTP_PROXY), or an outbound firewall blocks the"
        echo "    daemon. The stack pulls from lscr.io + ghcr.io; verify with:"
        echo "        $CONTAINER_RUNTIME pull $test_img"
    fi
    [ "$had_hw" = 0 ] && $CONTAINER_RUNTIME rmi "$test_img" >/dev/null 2>&1 || true
}

echo ""
echo "  Pre-flight: confirming images are available for this CPU architecture..."
check_image_arch

echo ""
echo "  Pre-flight: checking Docker's image store has room + can reach the registry..."
check_docker_dataroot_space
check_registry_egress

# AzuraCast RAM guardrail (opt-in service, ~2 GB hungry: MariaDB + PHP-FPM + nginx
# + Redis + Liquidsoap). On a small NAS it gets OOM-killed and its now-playing API
# then resets the dashboard widget (curl/ECONNRESET) — a phantom "bug" that's really
# memory pressure. Warn (never block — it's their call) when the box looks too small.
if is_optin_enabled ENABLE_AZURACAST && [ -r /proc/meminfo ]; then
    _mem_tot_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
    if [ -n "$_mem_tot_kb" ] && [ "$_mem_tot_kb" -lt 4194304 ]; then
        _mem_tot_gb=$(( (_mem_tot_kb + 524288) / 1048576 ))
        echo ""
        echo "  ⚠ AzuraCast is enabled, but this NAS has only ~${_mem_tot_gb} GB RAM."
        echo "    AzuraCast needs ~2 GB on top of the rest of the stack; on a box this"
        echo "    small the kernel can OOM-kill it — the dashboard's now-playing tile"
        echo "    then shows connection-reset errors. If that happens, set"
        echo "    ENABLE_AZURACAST=false and re-run; the rest of the stack is unaffected."
    fi
    unset _mem_tot_kb _mem_tot_gb
fi

# Bring the stack up. Split the pull out of `up -d` and wrap it in retry() so a
# transient registry/network blip during the long first-run pull doesn't fail
# the whole step — `up -d` afterwards is the authority on success and re-pulls
# anything still missing. Runs as a function (not `bash -c`) so retry() is in
# scope. cd into the compose root first; a failed cd must fail the step.
start_stack() {
    cd "$SCRIPT_DIR" || return 1
    retry 3 "Image pull" $COMPOSE $COMPOSE_QUIET_FLAGS $COMPOSE_FILES pull \
        || echo "  ⚠ Some images didn't pull after retries — 'up -d' will try again."
    $COMPOSE $COMPOSE_QUIET_FLAGS $COMPOSE_FILES up -d
    local up_rc=$?

    # Post-up reconcile (VPN on): the pull above may have RECREATED gluetun
    # with a new container id. An already-running qBittorrent is welded to
    # gluetun's OLD id (network_mode: container:gluetun is frozen at create
    # time and immutable), so compose left it on a now-dead namespace. If
    # qBit's frozen namespace id != the live gluetun id, rm it and bring it
    # back up once so it rejoins the new gluetun — same fix restart-qbit.sh
    # does, applied inline so a fresh install/update is clean without waiting
    # for the 5-min self-heal cron.
    if [ "$VPN_ON" -eq 1 ] && is_enabled ENABLE_QBITTORRENT; then
        local nm gid
        nm=$($CONTAINER_RUNTIME inspect -f '{{.HostConfig.NetworkMode}}' qbittorrent 2>/dev/null || echo "")
        gid=$($CONTAINER_RUNTIME inspect -f '{{.Id}}' gluetun 2>/dev/null || echo "")
        case "$nm" in container:*) nm="${nm#container:}" ;; *) nm="" ;; esac
        if [ -n "$nm" ] && [ -n "$gid" ] && [ "$nm" != "$gid" ]; then
            echo "  qBittorrent is on a stale gluetun namespace — recreating it..."
            $CONTAINER_RUNTIME rm -f qbittorrent >/dev/null 2>&1 || true
            $COMPOSE $COMPOSE_QUIET_FLAGS $COMPOSE_FILES up -d gluetun qbittorrent
            up_rc=$?
        fi
    fi
    # Same stale-namespace reconcile for slskd — it shares gluetun's
    # namespace under the soulseek profile exactly like qBittorrent, so a
    # gluetun recreate welds it to a dead namespace too. Opt-in only.
    if [ "$VPN_ON" -eq 1 ] && is_optin_enabled ENABLE_SOULSEEK; then
        local slnm slgid
        slnm=$($CONTAINER_RUNTIME inspect -f '{{.HostConfig.NetworkMode}}' slskd 2>/dev/null || echo "")
        slgid=$($CONTAINER_RUNTIME inspect -f '{{.Id}}' gluetun 2>/dev/null || echo "")
        case "$slnm" in container:*) slnm="${slnm#container:}" ;; *) slnm="" ;; esac
        if [ -n "$slnm" ] && [ -n "$slgid" ] && [ "$slnm" != "$slgid" ]; then
            echo "  slskd is on a stale gluetun namespace — recreating it..."
            $CONTAINER_RUNTIME rm -f slskd >/dev/null 2>&1 || true
            $COMPOSE $COMPOSE_QUIET_FLAGS $COMPOSE_FILES up -d gluetun slskd
            up_rc=$?
        fi
    fi
    return $up_rc
}

echo ""
echo "  Note: first run will pull all Docker images — this can take 5-15 minutes"
run_step 6 "Start the stack" start_stack

abort_if_failed

wait_for_services || { FAIL=$((FAIL + 1)); abort_if_failed; }

# ── API Configuration ─────────────────────────────────────────────────────────

echo ""
echo "  Note: configuring Sonarr, Radarr, Lidarr, Prowlarr, SABnzbd, Bazarr, Seerr,"
echo "        Flaresolverr proxy, qBittorrent watch folder, and more via API."
echo "        Skips anything already configured."
run_step 7 "Configure all services" \
    run_python "$SCRIPT_DIR/setup-arr-config.py"

echo ""
echo "  Note: adding public torrent indexers (1337x, YTS, Nyaa, TPB...) and any"
echo "        usenet/private indexers whose credentials are set in .env"
run_step 8 "Add Prowlarr indexers" \
    run_python "$SCRIPT_DIR/indexers/setup-indexers.py"

echo ""
echo "  Note: enabling free subtitle providers and any account-based providers"
echo "        (OpenSubtitles, Addic7ed) configured in .env"
run_step 9 "Enable Bazarr subtitle providers" \
    run_python "$SCRIPT_DIR/indexers/setup-bazarr-providers.py"

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
    run_python_besteffort "$SCRIPT_DIR/auto-manual-import.py"

# ── Boot + self-heal resilience (best-effort, unnumbered) ─────────────────────
# Auto-wire a boot hook (boot-orchestrator.sh) + a periodic qBittorrent self-heal
# (qbit-guardian.sh) so NAS reboots and gluetun recreations never strand qBit on
# "must join at least one network". UNNUMBERED on purpose: it must run on EVERY
# pass (including --resume / --from N) so existing installs pick it up, and it
# must never flip the install red — install-boot-resilience.sh is idempotent and
# graceful-degrades to printed manual steps, always exiting 0. Not part of the
# run_step / .setup-state accounting, so it never strands resume.
bash "$SCRIPT_DIR/install-boot-resilience.sh" || true

# ── Summary ───────────────────────────────────────────────────────────────────

LAN_IP=$(grep -m1 '^LAN_IP=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r')
IP="${LAN_IP:-<NAS-IP>}"

echo ""
echo "============================================="
if [ "$SKIP" -gt 0 ]; then
    echo "  Results: $PASS passed, $FAIL failed, $SKIP skipped"
else
    echo "  Results: $PASS passed, $FAIL failed"
fi
echo "============================================="

if [ $FAIL -gt 0 ]; then
    echo ""
    echo "  One or more steps failed — review the output above."
    echo "  Fix the issue, then re-run to retry just the unfinished steps:"
    echo "    sudo bash $SCRIPT_DIR/setup.sh --resume"
    echo "  (or re-run without --resume to run every step again — all idempotent.)"
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
is_optin_enabled ENABLE_SOULSEEK && echo "  slskd        http://${IP}:5030"
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
if is_optin_enabled ENABLE_SOULSEEK; then
    n=$((n + 1))
    echo "  $n. slskd dashboard: http://${IP}:5030"
    echo "     Log in with username 'slskd' password 'slskd' — the DASHBOARD"
    echo "     login, NOT your Soulseek account (that's already configured)."
    echo "     Change it via web.authentication in"
    echo "     ${INSTALL_DIR}/slskd/config/slskd.yml then: docker restart slskd"
    echo "     (soularr runs headlessly alongside slskd — no UI; follow it"
    echo "     with: docker logs -f soularr)"
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
echo "  ── Boot + self-heal resilience ────────────────"
echo "  setup.sh tried to wire this up for you — see the 'Boot + self-heal"
echo "  resilience' section in the output above for what installed on THIS"
echo "  platform:"
echo "    • Boot hook — brings the stack up in dependency order on every"
echo "      reboot (gluetun before qBittorrent), so qBit never gets stuck"
echo "      on 'must join at least one network'. (Manual on QNAP.)"
echo "    • Self-heal — when VPN + qBittorrent are on, a check runs every"
echo "      5 min and recovers qBit if gluetun is recreated under it."
echo "  If that section printed a ⚠ or ℹ (e.g. QNAP, a non-root run, or an"
echo "  unknown platform), wire the boot hook manually:"
echo "    DSM → Control Panel → Task Scheduler → Triggered Task → Boot-up,"
echo "      run as root:  bash $SCRIPT_DIR/boot-orchestrator.sh"
echo "    Linux/UGREEN →  sudo crontab -e, add:"
echo "      @reboot sleep 30 && bash $SCRIPT_DIR/boot-orchestrator.sh"
