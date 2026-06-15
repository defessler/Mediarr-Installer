#!/bin/bash
# ── Mediarr diagnostics bundle ────────────────────────────────────────────────
#
# Collects a single redacted tarball of everything a human (or the project's
# issue tracker) needs to debug a broken install — WITHOUT leaking secrets.
# Opt-in only: nothing is uploaded anywhere. The installer's "Download
# diagnostics" button runs this over SSH and pulls the tarball back to your PC;
# you can also run it by hand:
#
#   bash /volume1/docker/media/scripts/collect-diagnostics.sh
#
# The final stdout line is `DIAGNOSTICS_TARBALL=<path>` so the wizard can find
# the file to fetch. All human-readable progress goes to stderr.
#
# What's inside: system + Docker metadata, disk space (install dir, data root,
# AND Docker's data-root), a SECRET-MASKED copy of .env, container state +
# per-service log tails, network/tun/iptables state, and a dmesg tail.
# What's NOT: passwords, API keys, WireGuard keys, Plex claim tokens — every
# value whose key looks sensitive is replaced with ***MASKED***.

# Keep going on individual failures — a diagnostics run should gather whatever
# it can rather than abort on the first missing tool.
set +e

# ── Locate ourselves (mirrors setup.sh) ──────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    INSTALL_DIR="$SCRIPT_DIR"
fi

ENV_FILE="$SCRIPT_DIR/.env"
[ -f "$ENV_FILE" ] || ENV_FILE="$INSTALL_DIR/.env"

# Read a single .env value (comment-stripped, trimmed). Empty if absent.
env_val() {
    grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | sed 's/[[:space:]]#.*//' | tr -d '\r' | xargs
}

DATA_ROOT="$(env_val DATA_ROOT)"

# ── Container runtime (Docker or Podman) ─────────────────────────────────────
# Mirror setup.sh so diagnostics work on a Podman-only host too. DOCKER_SOCK in
# .env (set when Podman is the runtime) → export DOCKER_HOST so $RT/$COMPOSE
# reach the right socket; pick the runtime CLI + compose front-end.
DOCKER_SOCK="$(env_val DOCKER_SOCK)"
if [ -n "$DOCKER_SOCK" ]; then
    case "$DOCKER_SOCK" in
        unix://*|tcp://*|ssh://*) export DOCKER_HOST="$DOCKER_SOCK" ;;
        *)                        export DOCKER_HOST="unix://$DOCKER_SOCK" ;;
    esac
fi
RT="docker"
COMPOSE=""
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
elif command -v podman >/dev/null 2>&1; then
    RT="podman"
    if podman compose version >/dev/null 2>&1; then COMPOSE="podman compose"
    elif command -v podman-compose >/dev/null 2>&1; then COMPOSE="podman-compose"; fi
    # Resolve a Podman socket for the CLI if .env didn't pin one.
    if [ -z "$DOCKER_HOST" ]; then
        if [ -S "$HOME/.local/share/containers/podman/podman.sock" ]; then
            export DOCKER_HOST="unix://$HOME/.local/share/containers/podman/podman.sock"
        elif [ -S /run/podman/podman.sock ]; then
            export DOCKER_HOST="unix:///run/podman/podman.sock"
        fi
    fi
fi

# ── Scratch dir + tarball name (timestamp from the NAS itself) ────────────────
STAMP="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo unknown)"
WORK="$(mktemp -d 2>/dev/null || echo "/tmp/mediarr-diag-$STAMP")"
mkdir -p "$WORK"
OUT="/tmp/mediarr-diagnostics-${STAMP}.tar.gz"

log() { echo "[diag] $*" >&2; }

log "Collecting diagnostics into $WORK ..."

# ── 1. System + Docker metadata ──────────────────────────────────────────────
{
    echo "=== generated ==="; date 2>/dev/null
    echo; echo "=== install ==="
    echo "INSTALL_DIR=$INSTALL_DIR"
    echo "SCRIPT_DIR=$SCRIPT_DIR"
    echo "DATA_ROOT=$DATA_ROOT"
    echo "ENV_FILE=$ENV_FILE"
    [ -f "$SCRIPT_DIR/.payload-sha" ] && { echo -n "payload_sha="; cat "$SCRIPT_DIR/.payload-sha"; }
    echo; echo "=== os ==="
    uname -a 2>/dev/null
    [ -f /etc/os-release ] && { echo "--- /etc/os-release ---"; cat /etc/os-release; }
    echo "arch=$(uname -m 2>/dev/null)"
    [ -r /sys/class/dmi/id/sys_vendor ] && echo "dmi_vendor=$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"
    echo; echo "=== nas family markers ==="
    for m in /etc/synoinfo.conf /etc/nas.conf /etc/tos /DATA /volume0 /volume1 /Volume1 \
             /share/CACHEDEV1_DATA /mnt/user /etc/unraid-version; do
        [ -e "$m" ] && echo "present: $m"
    done
    echo; echo "=== memory ==="
    [ -r /proc/meminfo ] && head -3 /proc/meminfo 2>/dev/null
    echo; echo "=== container runtime ($RT) ==="
    $RT version 2>&1
    echo "--- $RT info (key fields) ---"
    $RT info 2>/dev/null | grep -iE 'server version|storage driver|docker root|graphroot|cgroup|operating system|kernel|total memory|rootless|security' 2>/dev/null
} > "$WORK/system.txt" 2>&1

# ── 2. Disk space: install dir, data root, AND Docker's data-root ────────────
{
    echo "=== df: install dir ==="; df -Ph "$INSTALL_DIR" 2>/dev/null
    [ -n "$DATA_ROOT" ] && { echo; echo "=== df: data root ==="; df -Ph "$DATA_ROOT" 2>/dev/null; }
    DROOT="$($RT info -f '{{.DockerRootDir}}' 2>/dev/null)"
    # Podman reports its store under .Store.GraphRoot, not .DockerRootDir.
    [ -n "$DROOT" ] || DROOT="$($RT info -f '{{.Store.GraphRoot}}' 2>/dev/null)"
    if [ -n "$DROOT" ]; then
        echo; echo "=== df: docker data-root ($DROOT) ==="
        # Walk up to the nearest existing ancestor so df has a real path.
        while [ -n "$DROOT" ] && [ ! -d "$DROOT" ]; do DROOT="$(dirname "$DROOT")"; done
        df -Ph "$DROOT" 2>/dev/null
    fi
} > "$WORK/disk.txt" 2>&1

# ── 3. SECRET-MASKED copy of .env ────────────────────────────────────────────
# Mask the VALUE of any key whose name looks sensitive. Comment + blank lines
# pass through untouched. Splitting on the first '=' keeps values that contain
# '=' intact for the (rare) non-masked case.
if [ -f "$ENV_FILE" ]; then
    awk -F= 'BEGIN { OFS="=" }
        /^[ \t]*#/ || $0 !~ /=/ { print; next }
        {
            # Case-insensitive key match so e.g. a lowercase var is still caught.
            # No bare "WIREGUARD" here: WIREGUARD_PRIVATE_KEY / _PRESHARED_KEY /
            # _PUBLIC_KEY are already caught by KEY/PRIVATE, while
            # WIREGUARD_ADDRESSES (the non-secret tunnel client IP) must stay
            # visible -- it is exactly the value needed to debug a VPN that
            # will not connect. (Keep this comment apostrophe-free: it lives
            # inside a single-quoted awk program.)
            # CUSTOM|JSON catch the two free-form escape-hatch blobs whose KEY
            # name looks innocent but whose VALUE carries nested secrets:
            # CUSTOM_VPN_ENV (holds WIREGUARD_PRIVATE_KEY / OPENVPN_PASSWORD)
            # and CUSTOM_INDEXERS_JSON (each entry holds a live apiKey). Without
            # these tokens the name-based mask wrote both verbatim into the
            # shareable bundle.
            key = toupper($1)
            if (key ~ /PASS|TOKEN|SECRET|KEY|PRIVATE|CLAIM|API|CRED|COOKIE|AUTH|SESSION|_PID|_USER|CUSTOM|JSON/)
                print $1 "=***MASKED***"
            else
                print
        }' "$ENV_FILE" > "$WORK/env.masked.txt" 2>/dev/null
else
    echo "(.env not found at $ENV_FILE)" > "$WORK/env.masked.txt"
fi

# ── 4. Container state + per-service log tails ───────────────────────────────
{
    echo "=== $RT ps -a ==="
    $RT ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null
    if [ -n "$COMPOSE" ]; then
        echo; echo "=== compose ps ==="
        ( cd "$SCRIPT_DIR" && $COMPOSE ps 2>&1 )
        echo; echo "=== compose images ==="
        ( cd "$SCRIPT_DIR" && $COMPOSE config --images 2>/dev/null | sort -u )
    fi
} > "$WORK/containers.txt" 2>&1

mkdir -p "$WORK/logs"
# Scrub secrets that services print into their own logs — API keys in URLs,
# bearer tokens, passwords, WireGuard keys. Defence-in-depth on top of the
# .env masking, since a "redacted" bundle must not leak via log tails.
scrub_secrets() {
    sed -E \
        -e 's/([Aa]pi[_-]?[Kk]ey=)[^&"'"'"' ]+/\1***/g' \
        -e 's/(X-Api-Key:[[:space:]]*)[^[:space:]"'"'"']+/\1***/g' \
        -e 's/([Aa]uthorization:[[:space:]]*[Bb]earer[[:space:]]+)[A-Za-z0-9._~+/=-]+/\1***/g' \
        -e 's/([Bb]earer[[:space:]]+)[A-Za-z0-9._-]{12,}/\1***/g' \
        -e 's/([Cc]ookie:[[:space:]]*)[^[:space:]"'"'"']+/\1***/g' \
        -e 's/([Tt]oken[=:"[:space:]]+)[A-Za-z0-9._-]{8,}/\1***/g' \
        -e 's/([Pp]ass(word)?[=:"[:space:]]+)[^[:space:]"'"'"']+/\1***/g' \
        -e 's/(provided for this session:[[:space:]]*)[^[:space:]"'"'"']+/\1***/g' \
        -e 's/([Ww][Ii][Rr][Ee][Gg][Uu][Aa][Rr][Dd]_[Pp][Rr][Ii][Vv][Aa][Tt][Ee]_[Kk][Ee][Yy][=:[:space:]]+)[^[:space:]"'"'"']+/\1***/g'
}
# Tail logs ONE service at a time (low fd pressure on Synology) for every
# stack container that exists. Last 200 lines is plenty to spot a crash loop.
for c in plex jellyfin tautulli seerr sonarr radarr lidarr prowlarr bazarr \
         qbittorrent gluetun sabnzbd homepage recyclarr unpackerr flaresolverr; do
    if $RT ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
        $RT logs --tail 200 "$c" 2>&1 | scrub_secrets > "$WORK/logs/$c.log"
    fi
done

# ── 5. Network / tun / iptables state ────────────────────────────────────────
{
    echo "=== ip addr ==="; (ip addr 2>/dev/null || ifconfig 2>/dev/null)
    echo; echo "=== listening tcp ==="; (netstat -lnt 2>/dev/null || ss -lnt 2>/dev/null)
    echo; echo "=== /dev/net/tun ==="; ls -l /dev/net/tun 2>&1
    echo; echo "=== iptables (filter) ==="; (iptables -L -n 2>/dev/null | head -60 || echo "iptables unavailable / needs root")
} > "$WORK/network.txt" 2>&1

# ── 6. dmesg tail (best-effort; often root-only) ─────────────────────────────
dmesg 2>/dev/null | tail -100 > "$WORK/dmesg.txt" 2>&1
[ -s "$WORK/dmesg.txt" ] || echo "(dmesg unavailable — usually needs root)" > "$WORK/dmesg.txt"

# ── 7. Tar it up ─────────────────────────────────────────────────────────────
log "Packing tarball ..."
if tar -czf "$OUT" -C "$WORK" . 2>/dev/null; then
    rm -rf "$WORK" 2>/dev/null
    log "Done. Bundle written to $OUT"
    # Machine-readable sentinel for the installer to locate + fetch the file.
    # MUST be the final stdout line.
    echo "DIAGNOSTICS_TARBALL=$OUT"
    exit 0
else
    log "ERROR: failed to create tarball at $OUT"
    exit 1
fi
