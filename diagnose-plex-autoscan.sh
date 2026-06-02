#!/bin/bash
# Diagnose why Plex isn't auto-detecting new content.
#
# Run on the NAS:
#   bash /volume1/docker/media/diagnose-plex-autoscan.sh
# Or scp + run:
#   scp diagnose-plex-autoscan.sh user@nas:/tmp/
#   ssh user@nas "bash /tmp/diagnose-plex-autoscan.sh"

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Find the install dir — try common spots.
for candidate in \
    "$SCRIPT_DIR" \
    "$SCRIPT_DIR/scripts/.." \
    /volume1/docker/media \
    /volume1/docker/media/scripts/.. ; do
    if [ -f "$candidate/.env" ] || [ -f "$candidate/scripts/.env" ]; then
        INSTALL_DIR="$(cd "$candidate" && pwd)"
        break
    fi
done
INSTALL_DIR="${INSTALL_DIR:-/volume1/docker/media}"

if [ -f "$INSTALL_DIR/scripts/.env" ]; then
    ENV_FILE="$INSTALL_DIR/scripts/.env"
elif [ -f "$INSTALL_DIR/.env" ]; then
    ENV_FILE="$INSTALL_DIR/.env"
else
    echo "Couldn't find .env under $INSTALL_DIR — set INSTALL_DIR env var and re-run."
    exit 1
fi

env_val() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r'; }

LAN_IP="$(env_val LAN_IP)"
SONARR_KEY="$(env_val SONARR_API_KEY)"
RADARR_KEY="$(env_val RADARR_API_KEY)"

# Use loopback for arr API calls (avoids LAN-firewall issues during diag).
ARR_HOST="127.0.0.1"
SONARR="http://$ARR_HOST:49152"
RADARR="http://$ARR_HOST:49151"
PLEX="http://$ARR_HOST:32400"

section() { echo ""; echo "── $1 ─────────────────────────────────────────────"; }
indent() { sed 's/^/    /'; }

section "Environment"
echo "  INSTALL_DIR=$INSTALL_DIR"
echo "  ENV_FILE=$ENV_FILE"
echo "  LAN_IP=$LAN_IP"
echo "  SONARR_API_KEY=$([ -n "$SONARR_KEY" ] && echo present || echo MISSING)"
echo "  RADARR_API_KEY=$([ -n "$RADARR_KEY" ] && echo present || echo MISSING)"

section "Plex Preferences"
PREFS="$INSTALL_DIR/plex/config/Library/Application Support/Plex Media Server/Preferences.xml"
if [ -f "$PREFS" ]; then
    PLEX_TOKEN="$(grep -oE 'PlexOnlineToken="[^"]+"' "$PREFS" | sed 's/.*="//;s/"$//')"
    if [ -n "$PLEX_TOKEN" ]; then
        echo "  PlexOnlineToken: present (...${PLEX_TOKEN: -4})"
    else
        echo "  PlexOnlineToken: MISSING — server not claimed via plex.tv"
    fi
    for key in ScheduledLibraryUpdatesEnabled ScannerLowPriority autoEmptyTrash; do
        v="$(grep -oE "${key}=\"[^\"]+\"" "$PREFS" | sed 's/.*="//;s/"$//')"
        echo "  $key=${v:-<default>}"
    done
else
    echo "  Preferences.xml not found at:"
    echo "    $PREFS"
    PLEX_TOKEN=""
fi

section "Sonarr → Plex notification"
if [ -n "$SONARR_KEY" ]; then
    SONARR_NOTIFS="$(curl -s -m 10 "$SONARR/api/v3/notification?apikey=$SONARR_KEY")"
    if [ -z "$SONARR_NOTIFS" ]; then
        echo "  (no response from Sonarr API)"
    else
        echo "$SONARR_NOTIFS" | python3 - <<'PY' 2>&1 | indent
import sys, json
try:
    data = json.loads(sys.stdin.read())
except Exception as e:
    print(f"parse error: {e}"); sys.exit()
plex = [n for n in data if n.get('implementation') == 'PlexServer']
print(f"PlexServer notifications: {len(plex)}")
for n in plex:
    print(f"  id={n['id']} name={n['name']!r}")
    print(f"    onDownload={n.get('onDownload')} onUpgrade={n.get('onUpgrade')} onRename={n.get('onRename')}")
    fields = {f['name']: f.get('value') for f in n.get('fields', [])}
    print(f"    host={fields.get('host')} port={fields.get('port')} "
          f"useSsl={fields.get('useSsl')} updateLibrary={fields.get('updateLibrary')}")
    tok = fields.get('authToken') or ''
    print(f"    authToken={'present (...'+tok[-4:]+')' if tok else 'MISSING'}")
PY
        # Test the notification
        NID="$(echo "$SONARR_NOTIFS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); plex=[n for n in d if n.get('implementation')=='PlexServer']; print(plex[0]['id'] if plex else '')")"
        if [ -n "$NID" ]; then
            echo "  Running 'Test' on notification $NID..."
            BODY="$(curl -s "$SONARR/api/v3/notification/$NID?apikey=$SONARR_KEY")"
            TEST_RESULT="$(curl -s -o /dev/null -w "%{http_code}" -X POST -m 30 \
                "$SONARR/api/v3/notification/test?apikey=$SONARR_KEY" \
                -H 'Content-Type: application/json' \
                -d "$BODY")"
            echo "  → HTTP $TEST_RESULT $([ "$TEST_RESULT" = "200" ] && echo '(OK — Plex partial-scan endpoint reachable from Sonarr)' || echo '(FAILED — see sonarr logs below)')"
        fi
    fi
else
    echo "  SONARR_API_KEY missing — skipping."
fi

section "Radarr → Plex notification"
if [ -n "$RADARR_KEY" ]; then
    RADARR_NOTIFS="$(curl -s -m 10 "$RADARR/api/v3/notification?apikey=$RADARR_KEY")"
    if [ -z "$RADARR_NOTIFS" ]; then
        echo "  (no response from Radarr API)"
    else
        echo "$RADARR_NOTIFS" | python3 - <<'PY' 2>&1 | indent
import sys, json
try:
    data = json.loads(sys.stdin.read())
except Exception as e:
    print(f"parse error: {e}"); sys.exit()
plex = [n for n in data if n.get('implementation') == 'PlexServer']
print(f"PlexServer notifications: {len(plex)}")
for n in plex:
    print(f"  id={n['id']} name={n['name']!r}")
    print(f"    onDownload={n.get('onDownload')} onUpgrade={n.get('onUpgrade')} onRename={n.get('onRename')}")
    fields = {f['name']: f.get('value') for f in n.get('fields', [])}
    print(f"    host={fields.get('host')} port={fields.get('port')} "
          f"useSsl={fields.get('useSsl')} updateLibrary={fields.get('updateLibrary')}")
    tok = fields.get('authToken') or ''
    print(f"    authToken={'present (...'+tok[-4:]+')' if tok else 'MISSING'}")
PY
        NID="$(echo "$RADARR_NOTIFS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); plex=[n for n in d if n.get('implementation')=='PlexServer']; print(plex[0]['id'] if plex else '')")"
        if [ -n "$NID" ]; then
            echo "  Running 'Test' on notification $NID..."
            BODY="$(curl -s "$RADARR/api/v3/notification/$NID?apikey=$RADARR_KEY")"
            TEST_RESULT="$(curl -s -o /dev/null -w "%{http_code}" -X POST -m 30 \
                "$RADARR/api/v3/notification/test?apikey=$RADARR_KEY" \
                -H 'Content-Type: application/json' \
                -d "$BODY")"
            echo "  → HTTP $TEST_RESULT $([ "$TEST_RESULT" = "200" ] && echo '(OK — Plex partial-scan endpoint reachable from Radarr)' || echo '(FAILED — see radarr logs below)')"
        fi
    fi
else
    echo "  RADARR_API_KEY missing — skipping."
fi

section "Plex library sections"
if [ -n "${PLEX_TOKEN:-}" ]; then
    curl -s -m 10 -H "X-Plex-Token: $PLEX_TOKEN" -H 'Accept: application/json' \
        "$PLEX/library/sections" \
        | python3 - <<'PY' 2>&1 | indent
import sys, json
try:
    mc = json.loads(sys.stdin.read())['MediaContainer']
except Exception as e:
    print(f"parse error: {e}"); sys.exit()
dirs = mc.get('Directory', [])
print(f"Libraries: {len(dirs)}")
for s in dirs:
    print(f"  [{s['key']}] {s['title']!r} type={s['type']}")
    print(f"      agent={s.get('agent')}  scanner={s.get('scanner')}  refreshing={s.get('refreshing')}")
    for loc in s.get('Location', []):
        print(f"      path={loc['path']}")
PY
else
    echo "  No Plex token available — skipping."
fi

section "Recent arr → Plex log lines"
for c in sonarr radarr; do
    echo ""
    echo "  [[ $c logs grep 'plex' (last 30) ]]"
    docker logs --tail 1000 "$c" 2>&1 | grep -iE "plex|partial.scan|update.library" | tail -30 | indent
done

section "Recent Plex scan log lines"
echo "  [[ plex logs grep 'scanner|partial|sections.refresh' (last 30) ]]"
docker logs --tail 2000 plex 2>&1 | grep -iE "scanner|partial|sections.refresh|library update|new media" | tail -30 | indent

section "inotify watch usage"
WATCH_LIMIT="$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo '?')"
echo "  kernel max_user_watches = $WATCH_LIMIT"
PLEX_PID="$(docker inspect -f '{{.State.Pid}}' plex 2>/dev/null)"
if [ -n "$PLEX_PID" ] && [ "$PLEX_PID" != "0" ]; then
    # Count inotify watches held by the Plex container's process tree.
    WATCH_COUNT="$(find /proc/$PLEX_PID/task -name fdinfo -type d 2>/dev/null \
        -exec sh -c 'cat "$1"/* 2>/dev/null | grep -c "^inotify "' _ {} \; \
        | awk '{s+=$1} END{print s+0}')"
    echo "  plex pid=$PLEX_PID  inotify watches held ≈ $WATCH_COUNT"
else
    echo "  plex container not running (or docker inspect failed)"
fi

section "Summary"
echo "  Look for:"
echo "    1. 'PlexServer notifications: 0' in either arr → Connect notification was never created (re-run setup-arr-config.py)."
echo "    2. Test result HTTP != 200 → token stale or plex:32400 unreachable from arr container."
echo "    3. authToken MISSING in notification → arr has the notification but no token; will silently 401."
echo "    4. Library 'path=' doesn't match what the arr imports to → partial scan fires on wrong section."
echo "    5. inotify watches ≈ max_user_watches → kernel limit hit; Plex silently stops watching new dirs."
echo ""
