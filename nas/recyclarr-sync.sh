#!/bin/bash
# ── Recyclarr sync (TRaSH Guide quality profiles → Sonarr / Radarr) ──
#
# Re-applies the TRaSH Guide profile + custom-format bundles defined in
# recyclarr.yml to Sonarr and Radarr. The wizard runs `recyclarr sync`
# once at install time (after writing recyclarr.yml from the profile
# picks in .env); this script lets you re-run it any time:
#
#   - After the TRaSH Guides team publishes updates (weekly-ish)
#   - After hand-editing recyclarr.yml's include list
#   - After changing TRASH_SONARR_PROFILE / TRASH_RADARR_PROFILE in .env
#     and re-running the wizard
#
# Usage:
#   bash /volume1/docker/media/recyclarr-sync.sh
#
# Schedule weekly via Synology Task Scheduler (Control Panel → Task
# Scheduler → Create → Scheduled Task → User-defined script):
#
#   Run command:
#     bash /volume1/docker/media/recyclarr-sync.sh
#   Schedule: Weekly, day of your choice, e.g. Sunday 04:00
#   User: root (the script uses docker; needs the docker group)
#
# Output:
#   - Stdout: recyclarr's normal sync log (box-drawn tables of changes)
#   - $INSTALL_DIR/recyclarr/config/.last-sync — timestamp + profile
#     picks; surfaced on the Homepage dashboard's Recyclarr tile.
#   - $INSTALL_DIR/recyclarr/config/sync.log — appended log of recent
#     runs so you can diagnose "the cron ran but profiles look stale".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
    echo "✘ .env not found at $SCRIPT_DIR/.env"
    echo "  This script expects to live next to docker-compose.yml in the install dir."
    exit 1
fi

# Load INSTALL_DIR / TRASH_*_PROFILE so we can write the timestamp file
# in the right place and stamp it with the profile picks. set -a /
# set +a auto-exports every var the .env defines, but only for the
# duration of the source — wrapped in a subshell-ish block via braces.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
RECYCLARR_CONFIG_DIR="$INSTALL_DIR/recyclarr/config"
STAMP_FILE="$RECYCLARR_CONFIG_DIR/.last-sync"
LOG_FILE="$RECYCLARR_CONFIG_DIR/sync.log"

# Verify the container is running. We don't try to `docker compose up
# -d recyclarr` automatically — the user's compose profile selection
# might exclude recyclarr deliberately, and we shouldn't override
# that without consent. If the container isn't running, surface why.
if ! docker ps --format '{{.Names}}' | grep -qx 'recyclarr'; then
    echo "✘ recyclarr container isn't running."
    echo "  Bring it up first:  docker compose --profile recyclarr up -d recyclarr"
    echo "  Or set ENABLE_RECYCLARR=true in .env and re-run setup.sh."
    exit 1
fi

# Run the sync. tee both to stdout (so cron mail / Task Scheduler
# captures it) and to sync.log (so the user can review history). The
# `|| rc=$?` pattern preserves recyclarr's exit code through the
# pipe without `set -e` killing us on rc!=0 — we want to log the
# failure rather than die silently.
echo "── recyclarr sync starting at $(date -Is) ──" | tee -a "$LOG_FILE"
rc=0
docker exec recyclarr recyclarr sync 2>&1 | tee -a "$LOG_FILE" || rc=$?

if [ "$rc" -eq 0 ]; then
    # Write the .last-sync stamp Homepage's tile reads. Same format
    # configure_recyclarr() writes — timestamp + the two profile picks.
    {
        date -Is
        echo "sonarr_profile=${TRASH_SONARR_PROFILE:-web-1080p}"
        echo "radarr_profile=${TRASH_RADARR_PROFILE:-hd-bluray-web}"
    } > "$STAMP_FILE"
    echo "── recyclarr sync OK at $(date -Is) ──" | tee -a "$LOG_FILE"
else
    # Non-zero exit — don't update .last-sync, but DO log so the next
    # cron-run-failed page hits the user's eyes. Common causes:
    #   - Sonarr / Radarr API key changed (re-run the wizard to refresh)
    #   - Sonarr / Radarr down (gluetun timeout, container restart loop)
    #   - recyclarr.yml hand-edit introduced a YAML syntax error
    echo "✘ recyclarr sync exited with rc=$rc" | tee -a "$LOG_FILE"
    echo "  Inspect:  docker exec recyclarr recyclarr sync   (run interactively)"
    echo "  Or:       tail -50 $LOG_FILE"
    exit "$rc"
fi
