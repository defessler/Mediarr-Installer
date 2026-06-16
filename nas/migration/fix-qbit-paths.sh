#!/bin/bash
# ── qBittorrent Path Fixer ──
#
# Moves torrents to their correct save paths based on category.
# Run this after changing directory structure or restoring from backup.
#
# Usage:
#   bash fix-qbit-paths.sh [--dry-run] [--recheck]
#
# Options:
#   --dry-run    Show what would change without making any changes
#   --recheck    Force a file recheck on every torrent after moving
#
# The script reads QB_HOST, QB_USER, QB_PASS from the .env file in the
# same directory, or you can override them as environment variables:
#
#   QB_PASS=mypassword bash fix-qbit-paths.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# .env lives one level up (nas/) — migration/ is a subdirectory
ENV_FILE="$SCRIPT_DIR/../.env"

# ── Options ───────────────────────────────────────────────────────────────────

DRY_RUN=false
DO_RECHECK=false

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --recheck) DO_RECHECK=true ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

# ── Config ────────────────────────────────────────────────────────────────────

# Read .env values (can be overridden by env vars; strips \r for Windows-edited files).
# Quote-aware reader matching setup-folders.sh (v0.11.4): the wizard's writer
# quotes + backslash-escapes any value with special chars, so a double-quoted
# value is un-escaped in a single pass and an unquoted value keeps the legacy
# whitespace-anchored inline-comment strip. The old `sed 's/#.*//' | xargs`
# truncated a QBITTORRENT_PASS containing '#' and choked on quotes.
env_val() {
    local raw
    raw="$(grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r')"
    case "$raw" in
        '"'*)
            printf '%s' "$raw" | awk '
                {
                    n = length($0); out = ""; i = 2
                    while (i <= n) {
                        c = substr($0, i, 1)
                        if (c == "\\" && i < n) {
                            d = substr($0, i + 1, 1)
                            if (d == "n") out = out "\n"
                            else if (d == "r") out = out "\r"
                            else out = out d
                            i += 2
                            continue
                        }
                        if (c == "\"") break
                        out = out c
                        i++
                    }
                    printf "%s", out
                }'
            ;;
        *)
            printf '%s' "$raw" | sed 's/[[:space:]]#.*//' | xargs
            ;;
    esac
}

QB_HOST="${QB_HOST:-$(env_val LAN_IP)}"
QB_PORT="${QB_PORT:-49156}"
QB_USER="${QB_USER:-$(env_val QBITTORRENT_USER)}"
QB_USER="${QB_USER:-admin}"
QB_PASS="${QB_PASS:-$(env_val QBITTORRENT_PASS)}"
QB_URL="http://${QB_HOST}:${QB_PORT}"

# ── Category → save path mapping ─────────────────────────────────────────────
#
# These must match the paths inside the container (/data/... not /volume1/...).
# Add or edit entries to match your categories.

declare -A CATEGORY_PATHS
CATEGORY_PATHS["tv-sonarr"]="/downloads/Completed/tv-sonarr"
CATEGORY_PATHS["radarr"]="/downloads/Completed/radarr"
CATEGORY_PATHS["lidarr"]="/downloads/Completed/lidarr"
# Torrents with no category land here
DEFAULT_PATH="/downloads/Completed"

# ── Helpers ───────────────────────────────────────────────────────────────────

COOKIE_FILE=$(mktemp)
trap 'rm -f "$COOKIE_FILE"' EXIT

qb_post() {
    # Usage: qb_post <endpoint> [curl form args...]
    local endpoint="$1"; shift
    curl -sf --cookie "$COOKIE_FILE" --cookie-jar "$COOKIE_FILE" \
        -X POST "${QB_URL}${endpoint}" "$@"
}

qb_get() {
    # Usage: qb_get <endpoint>
    local endpoint="$1"; shift
    curl -sf --cookie "$COOKIE_FILE" \
        "${QB_URL}${endpoint}" "$@"
}

# ── Login ─────────────────────────────────────────────────────────────────────

echo "Connecting to qBittorrent at ${QB_URL}..."

if [ -z "$QB_PASS" ]; then
    echo "Error: QB_PASS / QBITTORRENT_PASS is not set."
    echo "Set it in .env or run:  QB_PASS=yourpassword bash fix-qbit-paths.sh"
    exit 1
fi

LOGIN_RESULT=$(qb_post /api/v2/auth/login \
    --data-urlencode "username=${QB_USER}" \
    --data-urlencode "password=${QB_PASS}")

if [ "$LOGIN_RESULT" != "Ok." ]; then
    echo "Login failed (got: '$LOGIN_RESULT'). Check QB_USER / QB_PASS."
    exit 1
fi

echo "Logged in as ${QB_USER}."
echo ""

# ── Fetch torrent list ────────────────────────────────────────────────────────

RAW=$(qb_get "/api/v2/torrents/info")

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 is required to parse the torrent list."
    exit 1
fi

# Parse with python3 — outputs: HASH|CATEGORY|SAVE_PATH|NAME (one per line)
TORRENT_LIST=$(echo "$RAW" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for t in data:
    h    = t.get("hash", "")
    cat  = t.get("category", "")
    path = t.get("save_path", "")
    name = t.get("name", "")
    print(f"{h}|{cat}|{path}|{name}")
')

TOTAL=$(echo "$TORRENT_LIST" | grep -c '|' || true)
echo "Found $TOTAL torrent(s)."
echo ""

if $DRY_RUN; then
    echo "*** DRY RUN — no changes will be made ***"
    echo ""
fi

# ── Process each torrent ──────────────────────────────────────────────────────

MOVED=0
SKIPPED=0
ERRORS=0

while IFS='|' read -r HASH CATEGORY CURRENT_PATH NAME; do
    if [ -z "$HASH" ]; then continue; fi

    # Determine the correct path for this torrent
    if [ -n "$CATEGORY" ] && [ -n "${CATEGORY_PATHS[$CATEGORY]+_}" ]; then
        TARGET_PATH="${CATEGORY_PATHS[$CATEGORY]}"
    else
        TARGET_PATH="$DEFAULT_PATH"
    fi

    # Normalise: strip trailing slash for comparison
    CURRENT_NORM="${CURRENT_PATH%/}"
    TARGET_NORM="${TARGET_PATH%/}"

    if [ "$CURRENT_NORM" = "$TARGET_NORM" ]; then
        echo "  OK       [${CATEGORY:-no category}] $NAME"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    echo "  MOVE     [${CATEGORY:-no category}] $NAME"
    echo "           $CURRENT_PATH  →  $TARGET_PATH"

    if ! $DRY_RUN; then
        # -s = silent, -w = write HTTP status code, -o = capture body separately
        RESP_BODY=$(mktemp)
        HTTP_STATUS=$(curl -s -o "$RESP_BODY" -w "%{http_code}" \
            --cookie "$COOKIE_FILE" --cookie-jar "$COOKIE_FILE" \
            -X POST "${QB_URL}/api/v2/torrents/setLocation" \
            --data-urlencode "hashes=${HASH}" \
            --data-urlencode "location=${TARGET_PATH}" 2>&1) || HTTP_STATUS="000"
        BODY=$(cat "$RESP_BODY" 2>/dev/null); rm -f "$RESP_BODY"

        if [ "$HTTP_STATUS" = "200" ]; then
            echo "  OK       moved"
            MOVED=$((MOVED + 1))
        else
            echo "  ERROR    HTTP $HTTP_STATUS${BODY:+ — $BODY}"
            ERRORS=$((ERRORS + 1))
        fi

        if $DO_RECHECK; then
            curl -s --cookie "$COOKIE_FILE" \
                -X POST "${QB_URL}/api/v2/torrents/recheck" \
                --data-urlencode "hashes=${HASH}" > /dev/null 2>&1 || true
        fi
    else
        MOVED=$((MOVED + 1))
    fi

done <<< "$TORRENT_LIST"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "============================================="
if $DRY_RUN; then
    echo "  Dry run complete."
    echo "  Would move: $MOVED   Already correct: $SKIPPED"
    echo "  Re-run without --dry-run to apply changes."
else
    echo "  Done."
    echo "  Moved: $MOVED   Skipped: $SKIPPED   Errors: $ERRORS"
    if $DO_RECHECK; then
        echo "  Rechecks queued for all moved torrents."
    else
        echo "  Tip: add --recheck to force a file integrity check after moving."
    fi
fi
echo "============================================="

[ $ERRORS -eq 0 ] && exit 0 || exit 1
