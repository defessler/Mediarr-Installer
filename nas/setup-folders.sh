#!/bin/bash
# ── Media Stack Folder Setup ──
#
# Creates all required directories for the stack and sets correct ownership.
# Safe to run multiple times — skips folders that already exist.
#
# Usage:
#   sudo bash /volume1/docker/media/setup-folders.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Read PUID/PGID from .env — required, no fallback
if [ ! -f "$ENV_FILE" ]; then
    echo "Error: .env not found at $ENV_FILE"
    echo "Copy .env.example to .env and fill in your values."
    exit 1
fi

PUID=$(grep -m1 '^PUID=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r')
PGID=$(grep -m1 '^PGID=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r')

if [ -z "$PUID" ] || [ -z "$PGID" ]; then
    echo "Error: PUID and PGID must both be set in $ENV_FILE"
    exit 1
fi

echo "Using PUID=$PUID PGID=$PGID (from ${ENV_FILE})"
echo ""

# ── Config directories ─────────────────────────────────────────────────────────

CONFIG_DIRS=(
    /volume1/docker/media/plex/config
    /volume1/docker/media/tautulli/config
    /volume1/docker/media/seerr/config
    /volume1/docker/media/prowlarr/config
    /volume1/docker/media/sonarr/config
    /volume1/docker/media/radarr/config
    /volume1/docker/media/bazarr/config
    /volume1/docker/media/lidarr/config
    /volume1/docker/media/qbittorrent/config
    /volume1/docker/media/qbittorrent/config/.cache/qBittorrent
    /volume1/docker/media/qbittorrent/custom-cont-init.d
    /volume1/docker/media/sabnzbd/config
    /volume1/docker/media/recyclarr/config
    /volume1/docker/media/unpackerr/config
    /volume1/docker/media/homepage/config
)

# ── Media and download directories ────────────────────────────────────────────

DATA_DIRS=(
    "/volume1/Data/Media/Movies"
    "/volume1/Data/Media/TV Shows"
    "/volume1/Data/Media/Anime/Movies"
    "/volume1/Data/Media/Anime/TV Shows"
    /volume1/Data/Media/Music
    /volume1/Data/Downloads/Torrents/ToFetch
    /volume1/Data/Downloads/Torrents/InProgress
    /volume1/Data/Downloads/Torrents/Completed/tv-sonarr
    /volume1/Data/Downloads/Torrents/Completed/radarr
    /volume1/Data/Downloads/Usenet/incomplete
    /volume1/Data/Downloads/Usenet/complete
    /volume1/Data/Downloads/Usenet/complete/tv
    /volume1/Data/Downloads/Usenet/complete/movies
    /volume1/Data/Downloads/Usenet/complete/music
)

# ── Create and chown ───────────────────────────────────────────────────────────

echo "Creating config directories..."
for dir in "${CONFIG_DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        echo "  Created: $dir"
    else
        echo "  Exists:  $dir"
    fi
    chown -R $PUID:$PGID "$dir"
    chmod -R 755 "$dir"
done

echo ""
echo "Creating data directories..."
for dir in "${DATA_DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        echo "  Created: $dir"
    else
        echo "  Exists:  $dir"
    fi
    chown -R $PUID:$PGID "$dir"
    # 775 instead of 755 on the data tree — Sonarr/Radarr/etc all run
    # as the same PUID:PGID, and group write means peer containers can
    # cross-write into shared dirs (eg sonarr → /data/Media/TV Shows
    # while bazarr drops .srt files alongside).
    chmod -R 775 "$dir"
done

# ── Synology shared-folder ACL ────────────────────────────────────────────────
#
# /volume1/Data is a Synology Shared Folder. Shared folders have their
# own ACL layer LAYERED ON TOP of POSIX permissions — even if we chown
# the directory tree to PUID:PGID and chmod 775, the share's ACL can
# still deny write access to that user. The arr containers then report
# "Path /data/Media/TV Shows does not exist" because their writability
# probe fails (Sonarr uses ENOENT as a catch-all for "can't use this
# path", even when it's a permission issue, not a missing-file one).
#
# Detect available tooling and apply an explicit grant. We try both
# Synology's synoacltool and POSIX setfacl — synoacltool wins on DSM
# because it talks the same ACL language the share itself uses, but
# setfacl is a useful fallback if the directory tree is on a btrfs
# volume that supports POSIX ACLs directly.
DATA_ROOT="/volume1/Data"

# Resolve synoacltool / setfacl by checking PATH first and then their
# known DSM locations. SSH-non-interactive shells on Synology don't
# include /usr/syno/bin, /usr/syno/sbin, or /usr/local/bin by default,
# so `command -v synoacltool` returns nothing — but the tool is there.
find_tool() {
    local name="$1"; shift
    if command -v "$name" >/dev/null 2>&1; then
        command -v "$name"
        return 0
    fi
    for cand in "$@"; do
        if [ -x "$cand" ]; then echo "$cand"; return 0; fi
    done
    return 1
}

SYNOACL=$(find_tool synoacltool \
    /usr/syno/bin/synoacltool \
    /usr/local/bin/synoacltool \
    /usr/syno/sbin/synoacltool) || SYNOACL=""

SETFACL=$(find_tool setfacl \
    /usr/local/bin/setfacl \
    /usr/bin/setfacl \
    /bin/setfacl) || SETFACL=""

if [ -d "$DATA_ROOT" ]; then
    USERNAME=$(getent passwd "$PUID" 2>/dev/null | cut -d: -f1)

    if [ -n "$SYNOACL" ] && [ -n "$USERNAME" ]; then
        echo ""
        echo "Granting Synology shared-folder ACL: $USERNAME (rwx, inherited) on $DATA_ROOT..."
        echo "  (using $SYNOACL)"
        # Permission mask: rwx + create file (p) + delete file (d) +
        # delete subfolder (D) + read/write attrs (a/A) + read/write
        # xattrs (R/W) + read/change perms (c/C) + take ownership (o).
        # Inheritance: file + directory (fd--).
        if "$SYNOACL" -add "$DATA_ROOT" "user:${USERNAME}:allow:rwxpdDaARWcCo:fd--"; then
            echo "  ✔ ACL granted to user $USERNAME"
        else
            echo "  ⚠ synoacltool -add failed — grant write access manually in"
            echo "    DSM → Control Panel → Shared Folder → Data → Edit → Permissions"
        fi
        # Re-apply ACLs from parent to all existing children so paths
        # the arrs need are usable on first run, not just new ones.
        if "$SYNOACL" -enforce-inherit "$DATA_ROOT" 2>/dev/null; then
            echo "  ✔ Inheritance propagated to existing children"
        else
            echo "  ⚠ enforce-inherit failed — older child files may still"
            echo "    use the original ACL. New files will inherit correctly."
        fi
    elif [ -n "$SETFACL" ]; then
        echo ""
        echo "Granting POSIX ACL: uid=$PUID (rwx, inherited) on $DATA_ROOT..."
        echo "  (using $SETFACL)"
        # -m sets access ACL; -d sets the default ACL (applied to new
        # entries created inside). -R is recursive on existing entries.
        "$SETFACL" -R -m  "u:${PUID}:rwx" "$DATA_ROOT" 2>/dev/null && \
        "$SETFACL" -R -d -m "u:${PUID}:rwx" "$DATA_ROOT" 2>/dev/null && \
            echo "  ✔ POSIX ACL applied" || \
            echo "  ⚠ setfacl failed — filesystem may not support ACLs"
    else
        echo ""
        echo "  ⚠ No ACL tool found (looked for synoacltool and setfacl in PATH"
        echo "    and standard DSM locations). If containers can't write to"
        echo "    /data/Media or /data/Downloads, grant access via DSM →"
        echo "    Control Panel → Shared Folder → Data → Permissions."
    fi
fi

# ── qBittorrent credential + config init script ────────────────────────────────
#
# This script runs inside the qBittorrent container at startup (custom-cont-init.d).
# Sets credentials, download paths, and the watched folder (/downloads/ToFetch).
# A sentinel file ensures it only runs once — config is never wiped on restart.

echo ""
echo "Deploying qBittorrent init script..."
INIT_DST="/volume1/docker/media/qbittorrent/custom-cont-init.d/set-credentials.sh"
cat > "$INIT_DST" << 'INITEOF'
#!/bin/bash
# Sets qBittorrent credentials, download paths, and watched folder.
# Runs inside the container at startup via /custom-cont-init.d.
# Only runs once — sentinel file prevents re-running on restart.

[ -z "$WEBUI_PASSWORD" ] && exit 0

CONF_DIR="/config/qBittorrent"
CONF_FILE="$CONF_DIR/qBittorrent.conf"
SENTINEL="/config/.credentials-set"

if [ -f "$SENTINEL" ]; then
    echo "[init] qBittorrent already initialised — skipping"
    exit 0
fi

mkdir -p "$CONF_DIR"

USERNAME="${WEBUI_USERNAME:-admin}"

# Generate PBKDF2-HMAC-SHA512 hash — qBittorrent's WebUI password format
HASH=$(python3 - <<'PYEOF'
import hashlib, os, base64
password = os.environ.get('WEBUI_PASSWORD', '').encode('utf-8')
salt = os.urandom(16)
key = hashlib.pbkdf2_hmac('sha512', password, salt, 100000)
print('@ByteArray(' + base64.b64encode(salt).decode() + ':' + base64.b64encode(key).decode() + ')')
PYEOF
)

if [ -z "$HASH" ]; then
    echo "[init] WARNING: failed to generate password hash — credentials not set"
    exit 1
fi

if [ ! -f "$CONF_FILE" ]; then
    printf '[LegalNotice]\nAccepted=true\n\n[BitTorrent]\nSession\\DefaultSavePath=/downloads/Completed\nSession\\TempPath=/downloads/InProgress\nSession\\TempPathEnabled=true\n\n[Preferences]\nDownloads\\SavePath=/downloads/Completed\nDownloads\\TempPath=/downloads/InProgress\nDownloads\\TempPathEnabled=true\nWebUI\\Username=%s\nWebUI\\Password_PBKDF2="%s"\nWebUI\\AuthSubnetWhitelistEnabled=true\nWebUI\\AuthSubnetWhitelist=192.168.0.0/16\n\n[ScanDirs]\nsize=1\n1\\dir=/downloads/ToFetch\n' \
        "$USERNAME" "$HASH" > "$CONF_FILE"
else
    printf '\nWebUI\\Username=%s\nWebUI\\Password_PBKDF2="%s"\nWebUI\\AuthSubnetWhitelistEnabled=true\nWebUI\\AuthSubnetWhitelist=192.168.0.0/16\n\n[ScanDirs]\nsize=1\n1\\dir=/downloads/ToFetch\n' \
        "$USERNAME" "$HASH" >> "$CONF_FILE"
fi

touch "$SENTINEL"
echo "[init] qBittorrent configured (user: $USERNAME, watched: /downloads/ToFetch)"
INITEOF

chown $PUID:$PGID "$INIT_DST"
chmod 755 "$INIT_DST"
echo "  Deployed: $INIT_DST"

echo ""
echo "Done. All folders are ready."
