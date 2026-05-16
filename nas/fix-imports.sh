#!/bin/bash
# ── Fix arr import backlogs ──
#
# When Sonarr/Radarr/Lidarr say a download is "Completed" but they
# never move it into /data/Media, the cure is to tell each arr "scan
# your completed-downloads folder right now" via its REST API. The
# scan bypasses the qBit/SAB polling chain entirely — the arr walks
# the directory, parses each release filename, matches to library
# entries it tracks, and imports anything it recognises. Already-
# imported files are skipped, so this is fully idempotent.
#
# This script:
#   1. Pulls each arr's API key from .env, falling back to the auto-
#      generated config.xml when the .env doesn't cache it (the wizard's
#      validator notes that some keys are config.xml-only).
#   2. Fires DownloadedEpisodesScan / DownloadedMoviesScan /
#      DownloadedAlbumsScan against every standard completed-downloads
#      path the wizard creates — both torrent and usenet roots.
#   3. After 30s, dumps any items still stuck in each arr's queue along
#      with the EXACT statusMessages the arr's Web UI shows on hover,
#      so the operator gets a precise root cause without clicking
#      through the UI.
#   4. Reports library + backlog file counts so success is verifiable
#      at a glance.
#
# Deliberately NO `set -e` — we want every step attempted even if an
# earlier step fails. Most failures are recoverable (one arr disabled,
# one path missing, transient API hiccup); a single early exit would
# block all the other fixes from running. Each step traps its own
# errors and reports cleanly.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "✘ .env not found at $ENV_FILE — this script must live next to docker-compose.yml."
    exit 1
fi

env_val() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r'; }

# Default-on opt-out semantics matching the rest of the toolchain.
is_enabled() {
    local val
    val="$(env_val "$1" | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$val" in
        false|0|no|off) return 1 ;;
        *)              return 0 ;;
    esac
}

# Portable ApiKey extraction. Used to use `grep -oP` with a lookbehind
# which depends on PCRE support — fine on Synology DSM's GNU grep but
# the wizard supports multi-NAS (Unraid, QNAP, TrueNAS, OMV, plain
# Linux), some of which ship busybox grep. sed is in everything's base
# image. The regex matches "<ApiKey>VALUE</ApiKey>" on one line and
# captures VALUE; head -1 is defensive against malformed files with
# duplicate tags.
extract_api_key() {
    local xml="$1"
    [ -f "$xml" ] || return 0
    sed -n 's|.*<ApiKey>\([^<]*\)</ApiKey>.*|\1|p' "$xml" 2>/dev/null | head -1
}

LAN_IP="$(env_val LAN_IP)"
SONARR_KEY="$(env_val SONARR_API_KEY)"
RADARR_KEY="$(env_val RADARR_API_KEY)"
LIDARR_KEY="$(env_val LIDARR_API_KEY)"

[ -z "$SONARR_KEY" ] && SONARR_KEY="$(extract_api_key "$SCRIPT_DIR/sonarr/config/config.xml")"
[ -z "$RADARR_KEY" ] && RADARR_KEY="$(extract_api_key "$SCRIPT_DIR/radarr/config/config.xml")"
[ -z "$LIDARR_KEY" ] && LIDARR_KEY="$(extract_api_key "$SCRIPT_DIR/lidarr/config/config.xml")"

if [ -z "$LAN_IP" ]; then
    echo "✘ LAN_IP not set in .env — can't reach the arrs."
    exit 1
fi

# Sanity check docker is reachable from this shell. On Synology DSM
# the SSH user must be in the 'docker' group (which the wizard's prep
# step + post-install instructions handle); if they're not, every
# `docker exec` below would error in a confusing way. Catch it once
# at the top with a clear message.
if ! docker ps >/dev/null 2>&1; then
    echo "✘ docker not reachable from this shell."
    echo "  Either the daemon's down, or your user isn't in the 'docker' group."
    echo "  Try: sudo bash $0"
    exit 1
fi

echo "============================================="
echo "  Fix arr import backlogs"
echo "============================================="
printf "  Sonarr key: %s\n" "${SONARR_KEY:+found (${SONARR_KEY:0:8}...)}${SONARR_KEY:-MISSING}"
printf "  Radarr key: %s\n" "${RADARR_KEY:+found (${RADARR_KEY:0:8}...)}${RADARR_KEY:-MISSING}"
printf "  Lidarr key: %s\n" "${LIDARR_KEY:+found (${LIDARR_KEY:0:8}...)}${LIDARR_KEY:-MISSING}"
echo ""

# ── 1. Trigger DownloadedXxxScan against every completed dir ──────────────────
#
# Both download clients write to these well-known paths inside each
# arr's container view. The wizard creates them in setup-folders.sh
# with these exact names; if the user customised, the scan command
# either no-ops on a missing path or returns 4xx, which we tolerate.
#
# We send the command, don't wait for it inline — the arr processes
# scans asynchronously and we sleep below before checking results.

scan() {
    local name=$1 url=$2 key=$3 cmd=$4 path=$5
    [ -z "$key" ] && { echo "    ⏭ $name skipped (no API key)"; return; }
    local http
    http=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" -X POST \
        -H "X-Api-Key: $key" \
        -H "Content-Type: application/json" \
        "$url/command" \
        -d "{\"name\": \"$cmd\", \"path\": \"$path\"}" 2>/dev/null)
    case "$http" in
        20*|201) echo "    ✔ $name $cmd  ($path)" ;;
        *)       echo "    ✘ $name $cmd  ($path) — HTTP $http" ;;
    esac
}

echo "── Triggering import scans on every completed-downloads path ──"
if is_enabled ENABLE_SONARR; then
    scan Sonarr "http://$LAN_IP:49152/api/v3" "$SONARR_KEY" DownloadedEpisodesScan /data/Downloads/Torrents/Completed/tv-sonarr
    scan Sonarr "http://$LAN_IP:49152/api/v3" "$SONARR_KEY" DownloadedEpisodesScan /data/Downloads/Usenet/complete/tv
fi
if is_enabled ENABLE_RADARR; then
    scan Radarr "http://$LAN_IP:49151/api/v3" "$RADARR_KEY" DownloadedMoviesScan /data/Downloads/Torrents/Completed/radarr
    scan Radarr "http://$LAN_IP:49151/api/v3" "$RADARR_KEY" DownloadedMoviesScan /data/Downloads/Usenet/complete/movies
fi
if is_enabled ENABLE_LIDARR; then
    scan Lidarr "http://$LAN_IP:49154/api/v1" "$LIDARR_KEY" DownloadedAlbumsScan /data/Downloads/Torrents/Completed/lidarr
    scan Lidarr "http://$LAN_IP:49154/api/v1" "$LIDARR_KEY" DownloadedAlbumsScan /data/Downloads/Usenet/complete/music
fi
echo ""

# Scans run async on the arr side. 30s is the typical time to process
# a backlog of a few hundred items on Synology spinning rust; well
# above the floor (a few seconds for one item) and well below the
# floor of "user thinks the script hung." Hardcoded — keeping config
# surface area minimal.
echo "  Waiting 30s for scans to process..."
sleep 30
echo ""

# ── 2. Dump anything still stuck, with the exact error ────────────────────────
#
# The arr's `queue` endpoint returns `statusMessages` arrays for any
# item with a non-trivial status. This is the SAME info the Web UI
# shows on hover. Surfacing it here means the operator doesn't have
# to click through 100 items.

dump_stuck() {
    local name=$1 url=$2 key=$3
    [ -z "$key" ] && return
    echo "── $name queue diagnostics ───────────────────────"
    # Pipe the JSON response on stdin to avoid ARG_MAX (a queue with
    # 100+ records can be hundreds of KB). curl handles compression and
    # streaming; if the API endpoint times out we get an empty body
    # which Python parses as "" and falls into the error branch.
    curl -sS -m 10 -H "X-Api-Key: $key" "$url/queue?pageSize=100" 2>/dev/null | \
        python3 -c "
import sys, json
try:
    q = json.loads(sys.stdin.read())
except Exception as e:
    print(f'  (could not parse queue response: {e})')
    sys.exit(0)
records = q.get('records', [])
stuck = [r for r in records
         if r.get('trackedDownloadStatus','ok') != 'ok'
         or r.get('statusMessages')
         or r.get('errorMessage')]
print(f'  total: {q.get(\"totalRecords\", 0)}  stuck: {len(stuck)}')
# Cap at 10 — they usually all share the same root cause; one good
# error message is enough to act on.
for r in stuck[:10]:
    print()
    title = r.get('title') or r.get('sourceTitle') or '?'
    print(f'  TITLE:  {title[:90]}')
    status = r.get('status', '?')
    tds = r.get('trackedDownloadStatus', '-')
    state = r.get('trackedDownloadState', '-')
    print(f'  STATUS: {status}  trackedDownloadStatus={tds}  state={state}')
    for m in r.get('statusMessages', []):
        for mm in m.get('messages', []):
            print(f'    -> {mm[:140]}')
    err = r.get('errorMessage')
    if err:
        print(f'    err: {err[:140]}')
if len(stuck) > 10:
    print(f'\n  ... and {len(stuck) - 10} more stuck items (likely the same root cause).')
"
    echo ""
}

is_enabled ENABLE_SONARR && dump_stuck Sonarr "http://$LAN_IP:49152/api/v3" "$SONARR_KEY"
is_enabled ENABLE_RADARR && dump_stuck Radarr "http://$LAN_IP:49151/api/v3" "$RADARR_KEY"
is_enabled ENABLE_LIDARR && dump_stuck Lidarr "http://$LAN_IP:49154/api/v1" "$LIDARR_KEY"

# ── 3. Library + backlog counts — was the scan effective? ─────────────────────
#
# Counts live files in each library folder + each completed-downloads
# folder. Library count up + backlog count down between runs = imports
# are working. Both numbers static across runs = the queue dump above
# names the actual blocker.

count_dir() {
    local container=$1 path=$2
    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$container"; then
        printf "    %-50s — (container not running)\n" "$container:$path"
        return
    fi
    local count
    count=$(docker exec "$container" find "$path" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l)
    printf "    %-50s — %s items\n" "$container:$path" "$count"
}

echo "── Library state — what's actually on disk ──"
is_enabled ENABLE_SONARR && {
    count_dir sonarr "/data/Media/TV Shows"
    count_dir sonarr "/data/Media/Anime/TV Shows"
}
is_enabled ENABLE_RADARR && {
    count_dir radarr "/data/Media/Movies"
    count_dir radarr "/data/Media/Anime/Movies"
}
is_enabled ENABLE_LIDARR && count_dir lidarr "/data/Media/Music"

echo ""
echo "── Backlog — files still waiting in completed-downloads dirs ──"
is_enabled ENABLE_SONARR && {
    count_dir sonarr "/data/Downloads/Torrents/Completed/tv-sonarr"
    count_dir sonarr "/data/Downloads/Usenet/complete/tv"
}
is_enabled ENABLE_RADARR && {
    count_dir radarr "/data/Downloads/Torrents/Completed/radarr"
    count_dir radarr "/data/Downloads/Usenet/complete/movies"
}
is_enabled ENABLE_LIDARR && {
    count_dir lidarr "/data/Downloads/Torrents/Completed/lidarr"
    count_dir lidarr "/data/Downloads/Usenet/complete/music"
}

echo ""
echo "============================================="
echo "  Done"
echo "============================================="
echo ""
echo "If 'Backlog' counts above are > 0, the queue dump above names the"
echo "exact reason. Common cures by error:"
echo ""
echo "  • 'No files found are eligible for import' → the arr is looking"
echo "    at a different path than where the files actually are. Check"
echo "    Settings → Download Clients → <client> → Remote Path Mappings."
echo ""
echo "  • 'Unable to parse release title' → the filename doesn't match"
echo "    any series/movie in the arr's library. Either add the series"
echo "    first, or use the UI's Manual Import (Activity → Manual Import)."
echo ""
echo "  • 'Sample' or 'Other (size)' → file rejected as too small (most"
echo "    common with Radarr). Settings → Media Management → adjust"
echo "    minimum file size."
echo ""
echo "  • 'Unable to copy file' / permission denied → ACL on /data/Media"
echo "    is wrong. Re-run setup.sh; the [acl] step will repair it."
