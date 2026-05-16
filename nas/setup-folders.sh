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
INSTALL_DIR=$(grep -m1 '^INSTALL_DIR=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r' | sed 's/^"//; s/"$//')
DATA_ROOT=$(grep -m1 '^DATA_ROOT=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r' | sed 's/^"//; s/"$//')

if [ -z "$PUID" ] || [ -z "$PGID" ]; then
    echo "Error: PUID and PGID must both be set in $ENV_FILE"
    exit 1
fi
# NAS-family-portable path defaults. The wizard normally writes
# INSTALL_DIR + DATA_ROOT explicitly into .env; the fallbacks below
# only matter when this script runs against an older .env or stand-
# alone (someone tweaked their own setup and re-ran our scripts).
: "${INSTALL_DIR:=$SCRIPT_DIR}"
: "${DATA_ROOT:=/volume1/Data}"

echo "Using PUID=$PUID PGID=$PGID  (from ${ENV_FILE})"
echo "       INSTALL_DIR=$INSTALL_DIR  DATA_ROOT=$DATA_ROOT"
echo ""

# ── Config directories ─────────────────────────────────────────────────────────

CONFIG_DIRS=(
    "$INSTALL_DIR/plex/config"
    "$INSTALL_DIR/tautulli/config"
    "$INSTALL_DIR/seerr/config"
    "$INSTALL_DIR/prowlarr/config"
    "$INSTALL_DIR/sonarr/config"
    "$INSTALL_DIR/radarr/config"
    "$INSTALL_DIR/bazarr/config"
    "$INSTALL_DIR/lidarr/config"
    "$INSTALL_DIR/qbittorrent/config"
    "$INSTALL_DIR/qbittorrent/config/.cache/qBittorrent"
    "$INSTALL_DIR/qbittorrent/custom-cont-init.d"
    "$INSTALL_DIR/sabnzbd/config"
    "$INSTALL_DIR/recyclarr/config"
    "$INSTALL_DIR/unpackerr/config"
    "$INSTALL_DIR/homepage/config"
)

# ── Media and download directories ────────────────────────────────────────────
# All under $DATA_ROOT. The arrs see them as /data/Media/* and
# /data/Downloads/* via the bind mount in docker-compose.yml.

DATA_DIRS=(
    "$DATA_ROOT/Media/Movies"
    "$DATA_ROOT/Media/TV Shows"
    "$DATA_ROOT/Media/Anime/Movies"
    "$DATA_ROOT/Media/Anime/TV Shows"
    "$DATA_ROOT/Media/Music"
    "$DATA_ROOT/Downloads/Torrents/ToFetch"
    "$DATA_ROOT/Downloads/Torrents/InProgress"
    "$DATA_ROOT/Downloads/Torrents/Completed/tv-sonarr"
    "$DATA_ROOT/Downloads/Torrents/Completed/radarr"
    "$DATA_ROOT/Downloads/Usenet/incomplete"
    "$DATA_ROOT/Downloads/Usenet/complete"
    "$DATA_ROOT/Downloads/Usenet/complete/tv"
    "$DATA_ROOT/Downloads/Usenet/complete/movies"
    "$DATA_ROOT/Downloads/Usenet/complete/music"
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
# Resolve synoacltool / setfacl by checking PATH first, then known DSM
# locations, then a recursive find under /usr — SSH-non-interactive
# shells on Synology don't include /usr/syno/bin, /usr/syno/sbin,
# or /usr/local/bin by default and the binary's exact location varies
# by DSM version + which packages are installed (DSM6 vs DSM7,
# Container Manager replacing Docker, etc).
#
# On non-Synology NASes (Unraid, QNAP, TrueNAS, generic Linux), there's
# no synoacltool. setfacl handles POSIX ACL on filesystems that support
# it (ext4, xfs, btrfs, zfs in SCALE). If neither is available we fall
# all the way back to chgrp + chmod g+rwx which works on plain POSIX.
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
    # Try getent first (works on most Linuxes) but fall back to awk
    # over /etc/passwd — Synology's busybox doesn't always ship
    # getent, and an empty USERNAME used to wedge us into the else
    # branch reporting "no ACL tool found" even when synoacltool was
    # at /usr/syno/bin.
    USERNAME=$(getent passwd "$PUID" 2>/dev/null | cut -d: -f1)
    if [ -z "$USERNAME" ]; then
        USERNAME=$(awk -F: -v u="$PUID" '$3==u{print $1; exit}' /etc/passwd 2>/dev/null)
    fi
    GROUPNAME=$(getent group "$PGID" 2>/dev/null | cut -d: -f1)
    if [ -z "$GROUPNAME" ]; then
        GROUPNAME=$(awk -F: -v g="$PGID" '$3==g{print $1; exit}' /etc/group 2>/dev/null)
    fi

    if [ -n "$SYNOACL" ] && [ -n "$USERNAME" ]; then
        echo ""
        echo "Granting Synology shared-folder ACL: $USERNAME (rwx, inherited) on $DATA_ROOT..."
        echo "  (using $SYNOACL)"
        # Permission mask: rwx + create file (p) + delete file (d) +
        # delete subfolder (D) + read/write attrs (a/A) + read/write
        # xattrs (R/W) + read/change perms (c/C) + take ownership (o).
        # Inheritance: file + directory (fd--).
        #
        # synoacltool -add is NOT idempotent — it appends a new ACE
        # even when a matching one already exists. Real-world logs
        # have shown 6+ identical heoki ACEs accumulated after a few
        # re-runs of the wizard. Grep -get output first; only -add
        # when the target ACE isn't already present.
        TARGET_ACE="user:${USERNAME}:allow:rwxpdDaARWcCo:fd--"
        if "$SYNOACL" -get "$DATA_ROOT" 2>/dev/null | grep -qF "$TARGET_ACE"; then
            echo "  ✔ ACL ACE already present for $USERNAME (skipped to avoid duplicate)"
        elif "$SYNOACL" -add "$DATA_ROOT" "$TARGET_ACE"; then
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
        echo "  No ACL tool found (synoacltool / setfacl). Falling back to"
        echo "  pure POSIX permissions (chgrp + chmod g+rwx on $DATA_ROOT)."
        echo "  This works for Unraid / TrueNAS / generic Linux where ext4 /"
        echo "  xfs / zfs honor POSIX semantics without an ACL layer on top."
        if [ -n "$GROUPNAME" ] && chgrp -R "$GROUPNAME" "$DATA_ROOT" 2>/dev/null; then
            echo "  ✔ Group ownership set to $GROUPNAME on $DATA_ROOT"
        fi
        if chmod -R g+rwX "$DATA_ROOT" 2>/dev/null; then
            echo "  ✔ Group rwx granted on $DATA_ROOT"
        fi
        # On Synology specifically, POSIX may not be enough — DSM's
        # share-level ACL can still deny writes regardless of chmod.
        # Surface the DSM Control Panel walkthrough in that case.
        if [ -f /etc/synoinfo.conf ]; then
            echo ""
            echo "  ⚠ This looks like a Synology DSM box but synoacltool wasn't"
            echo "    found. The Mediarr Installer wizard usually applies the"
            echo "    Synology ACL itself before this script runs — check the"
            echo "    [acl] lines earlier in the install log. If those reported"
            echo "    success, you can ignore this. Otherwise, grant write"
            echo "    access manually in DSM:"
            echo "      Control Panel → Shared Folder → Data → Edit → Permissions"
            if [ -n "$USERNAME" ]; then
                echo "      Find user '${USERNAME}', check Read/Write, click Save."
            else
                echo "      Find the user matching PUID=${PUID}, check Read/Write, click Save."
            fi
            echo "    Then re-run: sudo bash \"$SCRIPT_DIR/setup.sh\""
        fi
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

# Default-on opt-out check, matching the rest of the toolchain.
is_enabled() {
    local val
    val="$(env_val "$1" | tr '[:upper:]' '[:lower:]')"
    case "$val" in
        false|0|no|off) return 1 ;;
        *)              return 0 ;;
    esac
}

# Skip the whole qBittorrent config-write when the user opted out — no
# container will ever read the file we'd write, and the empty
# QBITTORRENT_PASS path below would print a misleading "qBittorrent
# will boot with a random temp password" message.
if ! is_enabled ENABLE_QBITTORRENT; then
    echo ""
    echo "Skipping qBittorrent config (ENABLE_QBITTORRENT=false)."
fi

if is_enabled ENABLE_QBITTORRENT; then

QB_CONF_DIR="$INSTALL_DIR/qbittorrent/config/qBittorrent"
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
# HostHeaderValidation guards qBit against DNS-rebinding attacks by
# rejecting requests whose Host header doesn't match a known-good
# value. In a NAS install reached from multiple hostnames (LAN IP,
# .local mDNS, Tailscale name, etc.), the strict default is a
# silent-401 trap that no error log explains clearly. With the
# AuthSubnetWhitelist already restricting trust to LAN ranges, this
# extra layer just causes friction. Turn it off — the whitelist is
# the actual security boundary.
WebUI\\HostHeaderValidation=false

[ScanDirs]
size=1
1\\dir=/downloads/ToFetch
EOF
        chown -R $PUID:$PGID "$INSTALL_DIR/qbittorrent/config"
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

fi    # end: if is_enabled ENABLE_QBITTORRENT

# Best-effort cleanup of the old custom-cont-init.d stub from previous
# wizard versions — it tried to do the same PBKDF2 work INSIDE the
# container and silently no-op'd because the linuxserver image has no
# python3. Removing it avoids the "init script failed, qBittorrent
# booted with temp password" trap from older installs that re-run setup.
OLD_INIT="$INSTALL_DIR/qbittorrent/custom-cont-init.d/set-credentials.sh"
if [ -f "$OLD_INIT" ]; then
    rm -f "$OLD_INIT"
    echo "  Cleaned up legacy in-container init script."
fi

echo ""
echo "Done. All folders are ready."
