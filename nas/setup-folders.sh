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

# Resolve synoacltool / setfacl by checking PATH first, then known DSM
# locations, then a recursive find under /usr — SSH-non-interactive
# shells on Synology don't include /usr/syno/bin, /usr/syno/sbin,
# or /usr/local/bin by default and the binary's exact location varies
# by DSM version + which packages are installed (DSM6 vs DSM7,
# Container Manager replacing Docker, etc).
find_tool() {
    local name="$1"; shift
    if command -v "$name" >/dev/null 2>&1; then
        command -v "$name"
        return 0
    fi
    # Accept anything that exists at the candidate path. `-e` follows
    # symlinks, so symlinked binaries (common on DSM) match. `-x` was
    # too strict — synoacltool is a symlink whose target executable
    # bit doesn't always survive the resolution in the bash test, even
    # though the binary itself runs fine.
    for cand in "$@"; do
        if [ -e "$cand" ]; then echo "$cand"; return 0; fi
    done
    # Last resort: locate by name under /usr (and /bin as a sanity check).
    # `find -print -quit` returns the first match without scanning the
    # whole tree, which keeps this snappy on a NAS with many volumes.
    #
    # CRITICAL: -L tells find to follow symlinks. On DSM many system
    # binaries (synoacltool included) are symlinks; without -L the
    # `-type f` filter skips them and we falsely report "not found"
    # for tools that are actually present.
    local hit
    hit=$(find -L /usr /bin -maxdepth 6 -name "$name" -print -quit 2>/dev/null)
    [ -n "$hit" ] && { echo "$hit"; return 0; }
    return 1
}

SYNOACL=$(find_tool synoacltool \
    /usr/syno/bin/synoacltool \
    /usr/local/bin/synoacltool \
    /usr/syno/sbin/synoacltool \
    /usr/bin/synoacltool \
    /bin/synoacltool) || SYNOACL=""

SETFACL=$(find_tool setfacl \
    /usr/local/bin/setfacl \
    /usr/bin/setfacl \
    /bin/setfacl) || SETFACL=""

if [ -d "$DATA_ROOT" ]; then
    # Try getent first (works on most Linuxes including DSM7) but fall
    # back to awk over /etc/passwd — Synology's busybox doesn't always
    # ship getent, and an empty USERNAME used to wedge us into the
    # else branch reporting "no ACL tool found" even when synoacltool
    # was found at /usr/syno/bin.
    USERNAME=$(getent passwd "$PUID" 2>/dev/null | cut -d: -f1)
    if [ -z "$USERNAME" ]; then
        USERNAME=$(awk -F: -v u="$PUID" '$3==u{print $1; exit}' /etc/passwd 2>/dev/null)
    fi

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
    elif [ -n "$SYNOACL" ] && [ -z "$USERNAME" ]; then
        echo ""
        echo "  ⚠ Found $SYNOACL but couldn't resolve a username for"
        echo "    PUID=${PUID}. The Mediarr Installer wizard normally"
        echo "    applies the shared-folder ACL itself (and did, if you"
        echo "    see [acl] lines above this step) — this script's grant"
        echo "    is a backup. Continuing."
    else
        echo ""
        echo "  ⚠ No ACL tool found anywhere — synoacltool and setfacl both"
        echo "    missing from PATH, /usr, and /bin. This is unusual on DSM."
        echo ""
        echo "    The Mediarr Installer wizard usually applies the ACL itself"
        echo "    before this script runs — check the [acl] lines earlier in"
        echo "    the install log. If those reported success, you can ignore"
        echo "    this warning."
        echo ""
        echo "    Otherwise, grant write access manually in DSM:"
        echo "      Control Panel → Shared Folder → Data → Edit → Permissions"
        if [ -n "$USERNAME" ]; then
            echo "      Find user '${USERNAME}', check Read/Write, click Save."
        else
            echo "      Find the user matching PUID=${PUID}, check Read/Write, click Save."
        fi
        echo "    Then re-run: sudo bash /volume1/docker/media/setup.sh"
    fi
fi

# ── qBittorrent credentials + initial config ────────────────────────────────
#
# qBittorrent's WebUI password is stored as a PBKDF2-HMAC-SHA512 hash in
# qBittorrent.conf. The hash needs to be generated *somewhere* and the
# linuxserver/qbittorrent image is Alpine-based without python3, so we
# can't generate it inside the container (the previous "init script"
# approach failed silently when `python3` returned empty, leaving the
# container booting with its random temp password and the user unable
# to log in).
#
# Fix: generate the hash on the HOST (where setup.sh always has python3
# — it's a hard requirement of setup-arr-config.py) and pre-write the
# whole qBittorrent.conf before the container ever starts. Idempotent:
# only fires when the conf doesn't exist yet, so re-running the wizard
# doesn't clobber user changes from the qBittorrent UI.

# env_val helper — same idea as in setup-nordvpn.sh, scoped here so this
# script doesn't depend on a sourced helper module.
env_val() {
    grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | sed 's/#.*//' | tr -d '\r' | xargs
}
QB_CONF_DIR="/volume1/docker/media/qbittorrent/config/qBittorrent"
QB_CONF_FILE="$QB_CONF_DIR/qBittorrent.conf"
QB_USER=$(env_val QBITTORRENT_USER)
QB_PASS=$(env_val QBITTORRENT_PASS)
: "${QB_USER:=admin}"

echo ""
echo "Writing qBittorrent config (with WebUI credentials)..."

# Decide whether to (re-)write the conf. A file we wrote will contain
# our distinctive subnet whitelist; a file qBittorrent wrote on its own
# (during a previous install where our credential-write failed silently)
# won't. Re-write in that case so the user's QBITTORRENT_PASS actually
# takes effect. Trust the user's manual UI edits when our signature is
# present — re-running setup.sh shouldn't clobber custom settings.
QB_SIGNATURE="WebUI\\\\AuthSubnetWhitelist=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12"
WROTE_CONF=false

if [ -z "$QB_PASS" ]; then
    echo "  ⚠ QBITTORRENT_PASS empty in .env — qBittorrent will boot with"
    echo "    a random temp password (see 'docker logs qbittorrent' once it's up)."
elif [ -f "$QB_CONF_FILE" ] && grep -qF "$QB_SIGNATURE" "$QB_CONF_FILE" 2>/dev/null; then
    echo "  ⏭ $QB_CONF_FILE already has our signature — leaving user's changes alone."
    echo "    To reset to wizard defaults: delete that file and re-run setup.sh."
else
    mkdir -p "$QB_CONF_DIR"
    # Generate PBKDF2-HMAC-SHA512 hash on the host. 100k iters is what
    # qBittorrent's own GUI uses when you set a password through it.
    HASH=$(python3 - "$QB_PASS" <<'PYEOF'
import sys, hashlib, os, base64
password = sys.argv[1].encode('utf-8')
salt = os.urandom(16)
key = hashlib.pbkdf2_hmac('sha512', password, salt, 100000)
print('@ByteArray(' + base64.b64encode(salt).decode() + ':' + base64.b64encode(key).decode() + ')')
PYEOF
    )
    if [ -z "$HASH" ]; then
        echo "  ✘ python3 PBKDF2 generation failed — install python3 on the NAS"
        echo "    (Package Center → Python 3) and re-run setup.sh."
    else
        # If a non-signature conf is here it was written by qBittorrent
        # itself during a botched previous install (the python3-in-
        # container hash generator silently failed, qBittorrent booted
        # without our creds, generated a temp password and wrote its
        # own conf). Back it up before clobbering so the user can
        # inspect later if anything in there was customised by hand.
        if [ -f "$QB_CONF_FILE" ]; then
            BACKUP="$QB_CONF_FILE.before-mediarr-$(date +%Y%m%d-%H%M%S).bak"
            cp "$QB_CONF_FILE" "$BACKUP" 2>/dev/null \
                && echo "  Backed up previous conf → $BACKUP"
        fi
        mkdir -p "$QB_CONF_DIR"
        cat > "$QB_CONF_FILE" <<EOF
[LegalNotice]
Accepted=true

[BitTorrent]
Session\\DefaultSavePath=/downloads/Completed
Session\\TempPath=/downloads/InProgress
Session\\TempPathEnabled=true

[Preferences]
Downloads\\SavePath=/downloads/Completed
Downloads\\TempPath=/downloads/InProgress
Downloads\\TempPathEnabled=true
WebUI\\Username=$QB_USER
WebUI\\Password_PBKDF2="$HASH"
WebUI\\AuthSubnetWhitelistEnabled=true
WebUI\\AuthSubnetWhitelist=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12

[ScanDirs]
size=1
1\\dir=/downloads/ToFetch
EOF
        chown -R $PUID:$PGID /volume1/docker/media/qbittorrent/config
        chmod 644 "$QB_CONF_FILE"
        echo "  ✔ $QB_CONF_FILE written (user: $QB_USER, watched: /downloads/ToFetch)"
        WROTE_CONF=true
    fi
fi

# If the qBittorrent container is already running (re-run of setup.sh
# after a botched first install) and we just rewrote its conf, the
# daemon won't pick up the new credentials until it restarts —
# `docker compose up -d` later only recreates containers whose IMAGE
# changed, not bind-mounted config files. Restart explicitly.
if [ "$WROTE_CONF" = true ]; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^qbittorrent$'; then
        echo "  Restarting qbittorrent so it picks up the new credentials..."
        if docker restart qbittorrent >/dev/null 2>&1; then
            echo "  ✔ qbittorrent restarted"
        else
            echo "  ⚠ docker restart qbittorrent failed — please run it manually:"
            echo "      docker compose restart qbittorrent"
        fi
    fi
fi

# Best-effort cleanup of the old custom-cont-init.d stub from previous
# wizard versions — it tried to do the same PBKDF2 work INSIDE the
# container and silently no-op'd because the linuxserver image has no
# python3. Removing it avoids the "init script failed, qBittorrent
# booted with temp password" trap from older installs that re-run setup.
OLD_INIT="/volume1/docker/media/qbittorrent/custom-cont-init.d/set-credentials.sh"
if [ -f "$OLD_INIT" ]; then
    rm -f "$OLD_INIT"
    echo "  Cleaned up legacy in-container init script."
fi

echo ""
echo "Done. All folders are ready."
