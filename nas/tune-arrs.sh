#!/bin/bash
# ── tune-arrs.sh — fix "everything is slow" on Synology / spinning-rust NAS ──
#
# Targets two persistent-slowness root causes:
#
#   1. SQLite fragmentation. Sonarr / Radarr / Lidarr / Prowlarr / Seerr all
#      use SQLite. After months of inserts (every queue item, history row,
#      blocklist entry, indexer health check) the DBs get fragmented and
#      every query gets slower. VACUUM + REINDEX rebuilds them. On a year-
#      old install this is typically 10-30% size reduction + 2-10× query
#      speedup. Safe + reversible (we back up first).
#
#   2. Dead indexers blocking status calls. Sonarr / Radarr ping their
#      indexers on every UI status call. A timing-out CloudFlare-bounded
#      indexer (e.g., 1337x when its anti-bot kicks in) adds 10s per ping.
#      6 dead indexers = 60s freeze every time you click around. We test
#      each indexer in Prowlarr, disable the failing ones, let Prowlarr's
#      sync propagate that to the arrs.
#
# Run when:
#   - "Sonarr / Radarr UI feels slow on every page navigation"
#   - "Seerr takes 30s to load search results"
#   - "post-deploy-validate.sh reports N of M indexers failing"
#
# Safe to re-run any time. Stops only the service being vacuumed (others
# stay up). Plex / qBit / SAB are not touched.
#
# Usage:
#   sudo bash /volume1/docker/media/tune-arrs.sh
#   sudo bash /volume1/docker/media/tune-arrs.sh --skip-vacuum     # only disable broken indexers
#   sudo bash /volume1/docker/media/tune-arrs.sh --skip-indexers   # only vacuum DBs
#   sudo bash /volume1/docker/media/tune-arrs.sh --dry-run         # show what WOULD change

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DRY_RUN=0
SKIP_VACUUM=0
SKIP_INDEXERS=0
for arg in "$@"; do
    case "$arg" in
        --dry-run)        DRY_RUN=1 ;;
        --skip-vacuum)    SKIP_VACUUM=1 ;;
        --skip-indexers)  SKIP_INDEXERS=1 ;;
        --help|-h)
            sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//' | head -n -2
            exit 0 ;;
        *)
            echo "Unknown argument: $arg" >&2
            echo "Try --help" >&2
            exit 2 ;;
    esac
done

if [ ! -f .env ]; then
    echo "✘ .env not found at $SCRIPT_DIR/.env"
    echo "  This script expects to live next to docker-compose.yml in the install dir."
    exit 1
fi

# Pull values from .env without `source`-ing it (which would
# execute any shell expansion in the values). grep + cut is safer
# for an installer-controlled file.
env_val() {
    grep -m1 "^$1=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '\r' | xargs
}
LAN_IP=$(env_val LAN_IP)
PROWLARR_KEY=$(env_val PROWLARR_API_KEY)

# Prowlarr's key sometimes isn't in .env (auto-discovered during install
# from config.xml). Fall back to extracting from there.
if [ -z "$PROWLARR_KEY" ] && [ -f "$SCRIPT_DIR/prowlarr/config/config.xml" ]; then
    PROWLARR_KEY=$(sed -n 's|.*<ApiKey>\([^<]*\)</ApiKey>.*|\1|p' \
                   "$SCRIPT_DIR/prowlarr/config/config.xml" 2>/dev/null | head -1)
fi

echo "=============================================="
echo "  tune-arrs — slow-NAS recovery"
[ "$DRY_RUN" -eq 1 ] && echo "  ** DRY RUN — no changes will be made **"
echo "=============================================="

# ──────────────────────────────────────────────────────────────────────
# Step 1 — SQLite VACUUM + REINDEX for each arr's DB
# ──────────────────────────────────────────────────────────────────────
#
# Each arr stores its main DB at <service>/config/<service>.db. Some
# also have a logs.db / index.db; we touch only the main one which
# is what most queries hit.
#
# Vacuum requires the DB to be unlocked, which means stopping the
# container. We do one arr at a time so service downtime is minimised
# (60-90s per arr). Plex stays up the whole time.

vacuum_arr() {
    local name="$1" db_path="$2"
    local full_path="$SCRIPT_DIR/$db_path"

    if [ ! -f "$full_path" ]; then
        echo "  ⏭  $name — db not found ($db_path); skipping"
        return 0
    fi

    local size_before
    size_before=$(du -h "$full_path" 2>/dev/null | cut -f1)
    echo ""
    echo "  ── $name (db size: $size_before) ──"

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "    DRY: would stop $name, vacuum $db_path, restart $name"
        return 0
    fi

    # Stop the container so the DB isn't locked. `docker stop` waits
    # up to its grace period; the arrs handle SIGTERM cleanly.
    echo "    Stopping $name..."
    docker stop "$name" >/dev/null 2>&1

    # Need sqlite3 binary. Synology DSM 7 has it in /usr/bin/sqlite3
    # under recent versions; fall back to running it via a tiny
    # alpine container if the host doesn't have it. The container
    # path is hermetic — doesn't depend on the user's PATH.
    if command -v sqlite3 >/dev/null 2>&1; then
        # Run the host's sqlite3 directly. No subshell, no string-
        # interpolation gymnastics — argv[1] gets the literal db path
        # (handles spaces, single quotes, every other special char).
        SQLITE_MODE=host
    else
        echo "    sqlite3 not on PATH — using alpine container..."
        SQLITE_MODE=alpine
    fi

    # Backup first. If vacuum corrupts the DB (it shouldn't, but
    # SQLite has had bugs), the user has a known-good fallback.
    local bak="$full_path.before-vacuum-$(date +%Y%m%d-%H%M%S)"
    cp "$full_path" "$bak"
    echo "    Backed up → ${bak##*/}"

    # VACUUM rebuilds the DB file from scratch, removing free pages.
    # REINDEX rebuilds all indexes (helps with stale statistics).
    # Both can fail if the DB is corrupted — surface that loudly
    # rather than silently leaving a broken DB.
    # Unique error file per invocation so parallel runs (cron + manual)
    # don't trample each other's stderr.
    ERR_FILE=$(mktemp -t sqlite-err.XXXXXX 2>/dev/null || echo "/tmp/sqlite-err.$$")
    if [ "$SQLITE_MODE" = host ]; then
        # Direct invocation — sqlite3 gets the db path + SQL as separate
        # argv positions. No shell injection vector regardless of what's
        # in $full_path (spaces, quotes, etc.).
        sqlite3_result=0
        sqlite3 "$full_path" 'VACUUM; REINDEX;' 2>"$ERR_FILE" || sqlite3_result=$?
    else
        # Alpine container — mount the install dir, run sqlite3 on the
        # path relative to /wd. -v takes "host:container" so $SCRIPT_DIR
        # needs to be a real path with no spaces (true in our standard
        # NAS install dirs). The DB path passed to sqlite3 is the
        # container-side relative path, computed below.
        rel_db="${full_path#$SCRIPT_DIR/}"
        sqlite3_result=0
        docker run --rm -v "$SCRIPT_DIR:/wd" -w /wd alpine:latest \
            sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 "$1" "VACUUM; REINDEX;"' \
            -- "/wd/$rel_db" 2>"$ERR_FILE" || sqlite3_result=$?
    fi
    if [ "$sqlite3_result" -ne 0 ]; then
        echo "    ✘ Vacuum/reindex FAILED:"
        sed 's/^/      /' "$ERR_FILE"
        rm -f "$ERR_FILE"
        echo "    Restoring backup..."
        cp "$bak" "$full_path"
        docker start "$name" >/dev/null 2>&1
        return 1
    fi
    rm -f "$ERR_FILE"

    local size_after
    size_after=$(du -h "$full_path" 2>/dev/null | cut -f1)
    echo "    ✔ Vacuumed (size: $size_before → $size_after)"

    # Restart the arr. unless-stopped policy means it'd auto-start
    # on next compose up, but we want it running NOW so the user can
    # use it again immediately.
    echo "    Starting $name..."
    docker start "$name" >/dev/null 2>&1
}

if [ "$SKIP_VACUUM" -eq 0 ]; then
    echo ""
    echo "── Step 1: SQLite VACUUM + REINDEX ────────────────────────────"
    # arr db filenames are <service>.db, not always at the top of /config
    vacuum_arr sonarr   "sonarr/config/sonarr.db"
    vacuum_arr radarr   "radarr/config/radarr.db"
    vacuum_arr lidarr   "lidarr/config/lidarr.db"
    vacuum_arr prowlarr "prowlarr/config/prowlarr.db"
    vacuum_arr bazarr   "bazarr/config/db/bazarr.db"
    # Seerr's DB lives in /app/config/db — host-side path differs by
    # version (Overseerr fork vs Jellyseerr fork vs original Seerr).
    # Try the most likely paths in order.
    for seerr_db in "seerr/config/db/db.sqlite3" "seerr/config/data/db.sqlite3"; do
        if [ -f "$SCRIPT_DIR/$seerr_db" ]; then
            vacuum_arr seerr "$seerr_db"
            break
        fi
    done
else
    echo ""
    echo "── Step 1: SQLite VACUUM ── SKIPPED (--skip-vacuum) ──"
fi

# ──────────────────────────────────────────────────────────────────────
# Step 2 — Test every Prowlarr indexer; disable the failing ones
# ──────────────────────────────────────────────────────────────────────
#
# Sonarr/Radarr health-check their indexer connectivity periodically.
# A timing-out indexer adds ~10s to every status call. We test each
# indexer via Prowlarr's /api/v1/indexer/test endpoint (same probe
# Prowlarr's UI uses), then PUT enable=false on any that fail.
#
# Prowlarr syncs indexer config to the *arrs automatically; once an
# indexer is disabled here, the arrs see it as disabled within ~30s
# and stop pinging it.

if [ "$SKIP_INDEXERS" -eq 0 ]; then
    echo ""
    echo "── Step 2: Disable broken Prowlarr indexers ───────────────────"

    if [ -z "$PROWLARR_KEY" ]; then
        echo "  ⚠ Prowlarr API key not found in .env or config.xml — skipping"
        echo "    Re-run setup-arr-config.py to auto-discover it."
    elif ! command -v python3 >/dev/null 2>&1; then
        echo "  ⚠ python3 not on PATH — skipping"
    elif [ -z "$LAN_IP" ]; then
        echo "  ⚠ LAN_IP not set in .env — skipping"
    else
        PROWLARR_URL="http://$LAN_IP:49150"
        echo "  Testing every indexer in Prowlarr..."

        # The work happens in Python: it's cleaner than shelling out
        # to jq + curl + arithmetic in bash, and we already require
        # python3 for the indexer test in post-deploy-validate.sh.
        python3 - <<PY
import json, sys, urllib.request, urllib.error

URL = "$PROWLARR_URL"
KEY = "$PROWLARR_KEY"
DRY = $DRY_RUN

def api(method, path, body=None):
    req = urllib.request.Request(
        URL + path, method=method,
        headers={'X-Api-Key': KEY, 'Content-Type': 'application/json'},
    )
    if body is not None:
        req.data = json.dumps(body).encode()
    return urllib.request.urlopen(req, timeout=20)

try:
    indexers = json.loads(api('GET', '/api/v1/indexer').read())
except Exception as e:
    print(f"  ✘ Could not list indexers: {e}")
    sys.exit(1)

if not indexers:
    print("  ⚠ Prowlarr has 0 indexers — nothing to test")
    sys.exit(0)

print(f"  Found {len(indexers)} indexer(s). Testing each (20s timeout)...")

disabled, failed_to_test = [], []
for ix in indexers:
    name = ix.get('name', '?')
    if not ix.get('enable', True):
        print(f"    ⏭  {name} — already disabled, skipping")
        continue
    try:
        api('POST', '/api/v1/indexer/test', ix)
        print(f"    ✔ {name}")
    except urllib.error.HTTPError as e:
        # Test endpoint returns 400 with details on failure
        msg = ''
        try:
            err = json.loads(e.read().decode(errors='replace'))
            if isinstance(err, list) and err:
                msg = err[0].get('errorMessage', '') or err[0].get('detailedDescription', '')
            elif isinstance(err, dict):
                msg = err.get('message', '') or err.get('errorMessage', '')
        except Exception:
            pass
        print(f"    ✘ {name} — {msg[:100] or 'test failed'}")
        if DRY:
            disabled.append((name, msg[:80]))
            continue
        # Disable: PUT the indexer back with enable=False
        ix_off = dict(ix); ix_off['enable'] = False
        try:
            api('PUT', f"/api/v1/indexer/{ix['id']}", ix_off)
            print(f"      → disabled")
            disabled.append((name, msg[:80]))
        except Exception as e2:
            print(f"      ✘ could not disable: {e2}")
            failed_to_test.append((name, str(e2)[:80]))
    except Exception as e:
        print(f"    ✘ {name} — could not test: {e}")
        failed_to_test.append((name, str(e)[:80]))

print()
if disabled:
    verb = "Would disable" if DRY else "Disabled"
    print(f"  {verb} {len(disabled)} broken indexer(s):")
    for n, m in disabled:
        print(f"    - {n}  ({m})")
    if not DRY:
        print()
        print("  Prowlarr's app-sync will propagate the disabled state to Sonarr/")
        print("  Radarr/Lidarr within ~30s. Refresh your arr UI after that — page")
        print("  loads should be noticeably faster.")
else:
    print(f"  ✔ All {len(indexers)} indexers responding — nothing to disable.")
PY
        rc=$?
        if [ "$rc" -ne 0 ]; then
            echo "  ⚠ Indexer-test step exited non-zero (rc=$rc) — check output above"
        fi
    fi
else
    echo ""
    echo "── Step 2: Disable broken indexers ── SKIPPED (--skip-indexers) ──"
fi

echo ""
echo "── Done ──────────────────────────────────────────────────────"
if [ "$DRY_RUN" -eq 1 ]; then
    echo "  Dry run finished — no changes made. Re-run without --dry-run to apply."
else
    echo "  Try Sonarr / Seerr / etc. now. Page nav should be noticeably faster."
    echo "  If it's STILL slow, the remaining suspect is Plex hogging the box:"
    echo "    docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'"
fi
echo "=============================================="
