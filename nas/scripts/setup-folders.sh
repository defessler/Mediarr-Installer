#!/bin/bash
# ── Media Stack Folder Setup ──
#
# Creates all required directories for the stack and sets correct ownership.
# Safe to run multiple times — folders that already exist keep their contents;
# only the directory NODE's own ownership/mode is re-asserted on a re-run, NOT
# the whole tree underneath it. (A blanket `chown -R`/`chmod -R` on every re-run
# would rewrite the user's multi-TB Media + Plex tree each pass: set the execute
# bit on every .mkv, force group-write onto files locked down on purpose, strip
# Plex's 755 SQLite/cache perms, and clobber ownership a peer app set. The
# recursive sweep is reserved for an explicit opt-in.)
#
# Usage:
#   sudo bash /volume1/docker/media/setup-folders.sh
#   # Force a one-time recursive ownership/mode repair of EVERY dir+file
#   # (use only after a known permissions breakage — it is an O(inodes) walk):
#   sudo MEDIARR_FIX_PERMS=1 bash /volume1/docker/media/setup-folders.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Compose root = scripts/ parent in the new layout, or SCRIPT_DIR
# itself in legacy loose-scripts installs.
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    INSTALL_DIR_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    INSTALL_DIR_DEFAULT="$SCRIPT_DIR"
fi
if [ -f "$SCRIPT_DIR/.env" ]; then
    ENV_FILE="$SCRIPT_DIR/.env"
else
    ENV_FILE="$INSTALL_DIR_DEFAULT/.env"
fi

# Container runtime (docker | podman). Honour CONTAINER_RUNTIME if setup.sh
# exported one, else detect docker-first the same way setup.sh does — so a
# Podman-only host can still generate the qBit password hash and restart qBit
# (the run / ps / restart commands below are syntax-identical across both).
RT="${CONTAINER_RUNTIME:-}"
if [ -z "$RT" ]; then
    RT=docker
    command -v docker >/dev/null 2>&1 || { command -v podman >/dev/null 2>&1 && RT=podman; }
fi

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
: "${INSTALL_DIR:=$INSTALL_DIR_DEFAULT}"
: "${DATA_ROOT:=/volume1/Data}"

# Opt-in full recursive ownership/mode repair. Default OFF: a normal re-run only
# (re-)asserts the directory NODE's own ownership + mode, so re-toggling one
# service never rewrites the user's whole multi-TB library tree. Set
# MEDIARR_FIX_PERMS=1 to force the old O(inodes) `chown -R`/`chmod -R` sweep over
# every dir AND file — only wanted after an actual permissions breakage.
FIX_PERMS=0
case "${MEDIARR_FIX_PERMS:-}" in 1|true|yes|on) FIX_PERMS=1 ;; esac

echo "Using PUID=$PUID PGID=$PGID  (from ${ENV_FILE})"
echo "       INSTALL_DIR=$INSTALL_DIR  DATA_ROOT=$DATA_ROOT"
[ "$FIX_PERMS" -eq 1 ] && echo "       MEDIARR_FIX_PERMS=1 — forcing recursive ownership/mode repair"
echo ""

# ── Config directories ─────────────────────────────────────────────────────────

CONFIG_DIRS=(
    "$INSTALL_DIR/plex/config"
    "$INSTALL_DIR/jellyfin/config"
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
    # Soulseek (opt-in). slskd keeps its config in /app; soularr in /data.
    # slskd is NOT a linuxserver image (no self-chown safety net) and runs as
    # PUID:PGID, so these MUST be owned up front or it can't write its config.
    "$INSTALL_DIR/slskd/config"
    "$INSTALL_DIR/soularr/config"
    # Playlist Sync (opt-in). Holds the generated sockseek.conf + per-playlist
    # skip indexes. Not a linuxserver image; created up front like slskd's.
    "$INSTALL_DIR/playlistsync/config"
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
    # Playlist Sync downloads + per-playlist .m3u live here (one subfolder per
    # mirrored playlist). Same Music tree Plex scans, so the .m3u paths resolve.
    "$DATA_ROOT/Media/Music/Playlists"
    "$DATA_ROOT/Downloads/Torrents/ToFetch"
    "$DATA_ROOT/Downloads/Torrents/InProgress"
    "$DATA_ROOT/Downloads/Torrents/Completed/tv-sonarr"
    "$DATA_ROOT/Downloads/Torrents/Completed/radarr"
    # Lidarr's torrent download category. fix-imports.sh and setup-arr-
    # config.py both reference this path; without it the first Lidarr
    # download lands in a missing dir and imports never trigger.
    "$DATA_ROOT/Downloads/Torrents/Completed/lidarr"
    "$DATA_ROOT/Downloads/Usenet/incomplete"
    "$DATA_ROOT/Downloads/Usenet/complete"
    "$DATA_ROOT/Downloads/Usenet/complete/tv"
    "$DATA_ROOT/Downloads/Usenet/complete/movies"
    "$DATA_ROOT/Downloads/Usenet/complete/music"
    # Recycle bin dirs for each arr — referenced by Media Management
    # config (configure_media_management() in setup-arr-config.py).
    # MUST exist with PUID:PGID ownership BEFORE the arr's
    # /config/mediamanagement PUT, because the arrs validate the
    # recycleBin path is writable by their abc user (PUID-mapped)
    # and reject the whole PUT with HTTP 400 if not. Real symptom:
    # "Folder '/data/.recycle/sonarr' is not writable by user 'abc'"
    # cascading into every Media Management setting failing to apply
    # (not just the recycle bin field).
    "$DATA_ROOT/.recycle/sonarr"
    "$DATA_ROOT/.recycle/radarr"
    "$DATA_ROOT/.recycle/lidarr"
    # Soulseek (opt-in) shared download dir: slskd + soularr see it as
    # /downloads, Lidarr imports it as /data/Downloads/Soulseek. Must be
    # PUID:PGID-owned so slskd can write + Lidarr can hardlink/import.
    "$DATA_ROOT/Downloads/Soulseek"
)

# ── Create and chown ───────────────────────────────────────────────────────────
#
# Permission strategy (see header): a re-run must NOT walk an existing dir's
# whole tree. So we only `chown -R`/`chmod -R` a dir this script just CREATED
# (its subtree is brand-new and ours) or when MEDIARR_FIX_PERMS=1 forces a full
# repair. For a dir that already existed we re-assert ONLY the node itself. And
# the recursive case splits dir vs file modes so plain files (.mkv, .db, .conf)
# never get the execute bit a flat `chmod -R 7xx` would set on everything.
#
#   apply_perms <dir> <created?0|1> <owner> <dirmode> <filemode>
apply_perms() {
    local dir="$1" created="$2" owner="$3" dmode="$4" fmode="$5"
    if [ "$created" -eq 1 ] || [ "$FIX_PERMS" -eq 1 ]; then
        chown -R "$owner" "$dir"
        find "$dir" -type d -exec chmod "$dmode" {} +
        find "$dir" -type f -exec chmod "$fmode" {} +
    else
        # Existing dir on a re-run: touch only the directory node, never its
        # contents — preserves any per-file ownership/mode the user or a peer
        # app set, and avoids the O(inodes) walk over multi-TB libraries.
        chown "$owner" "$dir"
        chmod "$dmode" "$dir"
    fi
}

echo "Creating config directories..."
for dir in "${CONFIG_DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        echo "  Created: $dir"
        created=1
    else
        echo "  Exists:  $dir"
        created=0
    fi
    # Config: 755 dirs / 644 files (no group-write; matches Plex's own layout).
    apply_perms "$dir" "$created" "$PUID:$PGID" 755 644
done

echo ""
echo "Creating data directories..."
for dir in "${DATA_DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        echo "  Created: $dir"
        created=1
    else
        echo "  Exists:  $dir"
        created=0
    fi
    # 775 dirs / 664 files on the data tree — Sonarr/Radarr/etc all run as the
    # same PUID:PGID, and group write means peer containers can cross-write into
    # shared dirs (eg sonarr → /data/Media/TV Shows while bazarr drops .srt
    # files alongside). Files get 664 (group-write, NO execute) instead of the
    # old flat 775 that put +x on every .mkv/.mp4.
    apply_perms "$dir" "$created" "$PUID:$PGID" 775 664
done

# ── AzuraCast (opt-in) persistence dirs — chown 1000:1000, NOT PUID:PGID ──────
#
# AzuraCast (broadcast radio) is OPT-IN: only an explicit true/1/yes/on in
# .env stands it up, so a pre-AzuraCast .env (no key) stays OFF. We can't
# fold these into CONFIG_DIRS/DATA_DIRS above because those loops chown to
# $PUID:$PGID — and AzuraCast is the one service that does NOT honor
# PUID/PGID. The ghcr.io/azuracast/azuracast image runs its internal
# services (MariaDB, Nginx, Liquidsoap, PHP-FPM) as its OWN baked-in user
# UID/GID 1000, regardless of what we pass. Bind mounts owned by anyone
# else (eg a wizard PUID of 1026 on Synology) leave MariaDB unable to write
# /var/lib/mysql and the container crash-loops on first boot. So these four
# dirs are deliberately chown'd to the fixed 1000:1000 the container expects.
# (env_val / is_optin_enabled aren't defined this early in the script, so we
# do the explicit-true .env read inline here — same true|1|yes|on opt-in
# semantics as setup.sh's is_optin_enabled / the Soulseek firewall rule.)
case "$(grep -m1 '^ENABLE_AZURACAST=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r' | tr '[:upper:]' '[:lower:]' | xargs)" in
    true|1|yes|on)
        echo ""
        echo "Creating AzuraCast directories (owned 1000:1000 — its own UID, not PUID:PGID)..."
        # Bind mounts (not anon volumes) so the Update flow can't wipe the
        # station DB. Targets map to AzuraCast's official container paths:
        #   station_data → /var/azuracast/stations   db_data → /var/lib/mysql
        #   www_uploads  → /var/azuracast/storage/uploads (album art etc)
        #   backups      → /var/azuracast/backups
        #   acme         → /var/azuracast/storage/acme (self-signed TLS cert)
        AZ_DIRS=(
            "$INSTALL_DIR/azuracast/station_data"
            "$INSTALL_DIR/azuracast/db_data"
            "$INSTALL_DIR/azuracast/www_uploads"
            "$INSTALL_DIR/azuracast/backups"
            "$INSTALL_DIR/azuracast/acme"
        )
        for dir in "${AZ_DIRS[@]}"; do
            if [ ! -d "$dir" ]; then
                mkdir -p "$dir"
                echo "  Created: $dir"
                created=1
            else
                echo "  Exists:  $dir"
                created=0
            fi
            # Fixed 1000:1000 — see the WHY note above. AzuraCast ignores
            # PUID/PGID; chowning to the wizard's PUID/PGID would crash-loop it.
            # Gated like CONFIG_DIRS/DATA_DIRS: only sweep the tree on a dir we
            # just created (subtree empty + ours) or under MEDIARR_FIX_PERMS=1; a
            # re-run touches only the node. We never `chmod -R` the FILES here —
            # db_data is MariaDB's live /var/lib/mysql and it manages its own
            # per-file modes (some 600/660 on keys); a flat file-mode rewrite
            # would corrupt them. Only directory modes are normalised.
            if [ "$created" -eq 1 ] || [ "$FIX_PERMS" -eq 1 ]; then
                chown -R 1000:1000 "$dir"
                find "$dir" -type d -exec chmod 755 {} +
            else
                chown 1000:1000 "$dir"
                chmod 755 "$dir"
            fi
        done
        ;;
esac

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
        ACE_WAS_PRESENT=0
        if "$SYNOACL" -get "$DATA_ROOT" 2>/dev/null | grep -qF "$TARGET_ACE"; then
            echo "  ✔ ACL ACE already present for $USERNAME (skipped to avoid duplicate)"
            ACE_WAS_PRESENT=1
        elif "$SYNOACL" -add "$DATA_ROOT" "$TARGET_ACE"; then
            echo "  ✔ ACL granted to user $USERNAME"
        else
            echo "  ⚠ synoacltool -add failed — grant write access manually in"
            echo "    DSM → Control Panel → Shared Folder → Data → Edit → Permissions"
        fi
        # Re-apply ACLs from parent to all existing children so paths the arrs
        # need are usable on first run, not just new ones. This is an O(inodes)
        # recursive walk, so only run it when we ACTUALLY (re)established the ACE
        # — i.e. it wasn't already present (the first install, or a renumbered
        # PUID) — or when MEDIARR_FIX_PERMS=1 forces a repair. On a plain re-run
        # the grant + inheritance are already in place, so re-propagating each
        # time just re-walks the whole multi-TB share for no change.
        if [ "$ACE_WAS_PRESENT" -eq 0 ] || [ "$FIX_PERMS" -eq 1 ]; then
            if "$SYNOACL" -enforce-inherit "$DATA_ROOT" 2>/dev/null; then
                echo "  ✔ Inheritance propagated to existing children"
            else
                echo "  ⚠ enforce-inherit failed — older child files may still"
                echo "    use the original ACL. New files will inherit correctly."
            fi
        else
            echo "  ⏭ Inheritance already propagated (skipping recursive re-walk;"
            echo "    run with MEDIARR_FIX_PERMS=1 to force a full re-propagation)."
        fi
    elif [ -n "$SETFACL" ]; then
        echo ""
        echo "Granting POSIX ACL: uid=$PUID (rwx, inherited) on $DATA_ROOT..."
        echo "  (using $SETFACL)"
        # -m sets access ACL; -d sets the default ACL (applied to new entries
        # created inside). -R is recursive on existing entries.
        #
        # The default ACL on the DATA_ROOT node is cheap and makes every NEW
        # child inherit u:PUID:rwx, so we always (re)set it. The RECURSIVE
        # access-ACL rewrite (`-R -m`) is the O(inodes) walk over the whole
        # multi-TB tree, so we only run it when the ACL isn't already in place
        # (first install) or when MEDIARR_FIX_PERMS=1 forces a repair — a plain
        # re-run shouldn't re-walk the library to re-apply an ACL that's already
        # there. getfacl is setfacl's sibling (same `acl` package); if it can't
        # be probed we fall back to the recursive path (safe, matches old behavior).
        ACL_PRESENT=0
        if command -v getfacl >/dev/null 2>&1; then
            getfacl -pn "$DATA_ROOT" 2>/dev/null | grep -q "^user:${PUID}:" && ACL_PRESENT=1
        fi
        "$SETFACL" -d -m "u:${PUID}:rwx" "$DATA_ROOT" 2>/dev/null
        if [ "$ACL_PRESENT" -eq 0 ] || [ "$FIX_PERMS" -eq 1 ]; then
            "$SETFACL" -R -m  "u:${PUID}:rwx" "$DATA_ROOT" 2>/dev/null && \
            "$SETFACL" -R -d -m "u:${PUID}:rwx" "$DATA_ROOT" 2>/dev/null && \
                echo "  ✔ POSIX ACL applied" || \
                echo "  ⚠ setfacl failed — filesystem may not support ACLs"
        else
            echo "  ⏭ POSIX ACL already present (set default on $DATA_ROOT for new"
            echo "    children; skipping recursive re-walk — MEDIARR_FIX_PERMS=1 to force)."
        fi
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
            echo "    Then re-run: sudo bash \"$SCRIPT_DIR/setup.sh\"   # (setup.sh lives next to this script)"
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
    local raw
    raw="$(grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r')"
    case "$raw" in
        '"'*)
            # Double-quoted by the wizard's ESCAPE (env-render.ts): strip the
            # outer quotes and reverse the backslash-escaping in a single
            # left-to-right pass (\\ \" \$ \` -> the literal char; \n \r ->
            # newline/CR), so a secret containing " $ ` \ round-trips intact and
            # a literal backslash can't be mis-paired. (The old `| xargs` left
            # the escapes in place AND aborted outright on a literal \", which
            # emptied the value and locked qBittorrent behind a random temp
            # password.) Text past the closing quote is an inline comment.
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
        "'"*)
            # Single-quoted (hand-edited .env): strip the wrapping quotes and take
            # the literal content up to the closing quote — matches setup.sh /
            # setup-arr-config.py so all three readers agree. (The bare *) branch
            # below would feed a single-quoted value to xargs, which aborts on the
            # unmatched quote and silently empties it — e.g. blanking QBITTORRENT_PASS.)
            raw="${raw#"'"}"
            printf '%s' "${raw%%"'"*}"
            ;;
        *)
            # Unquoted (the common case: enable flags, ports, paths): strip a
            # whitespace-anchored inline comment and trim — unchanged behavior.
            printf '%s' "$raw" | sed 's/[[:space:]]#.*//' | xargs
            ;;
    esac
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
# Compute the qBit AuthSubnetWhitelist. Two pieces:
#   1. 127.0.0.0/8 — REQUIRED for gluetun's VPN_PORT_FORWARDING_UP_COMMAND.
#      That wget hits http://127.0.0.1:49156 from inside gluetun's
#      namespace (which qBit shares); without 127.0.0.0/8 it 403s on
#      every reconnect.
#   2. The LAN subnet — derived from LAN_IP in .env so only the user's
#      actual home network bypasses auth, not the union of all RFC1918
#      ranges. Narrows attack surface against compromised IoT devices
#      on the same LAN. Fails CLOSED (loopback only — login required on the
#      LAN) when LAN_IP isn't readable, rather than opening the password
#      bypass to all of RFC1918.
LAN_IP_VAL=$(env_val LAN_IP)
LAN_SUBNET_VAL=$(env_val LAN_SUBNET)
if [ -n "$LAN_SUBNET_VAL" ]; then
    QB_LAN="$LAN_SUBNET_VAL"
elif [[ "$LAN_IP_VAL" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.[0-9]+$ ]]; then
    QB_LAN="${BASH_REMATCH[1]}.0/24"
else
    # No LAN info — fail CLOSED. Whitelist only loopback (below) and leave the
    # normal login prompt for LAN browsers, rather than auto-bypassing the
    # password for ALL of RFC1918. The old fail-OPEN default handed
    # unauthenticated qBit control (add torrents, change save paths) to any
    # device on any private network — the exact compromised-IoT threat the /24
    # narrowing exists to address. LAN_IP is effectively always set by the
    # wizard, so this strict path only affects rare hand-runs.
    QB_LAN=""
fi
# Loopback is ALWAYS whitelisted — gluetun's port-forward + WebUI reconnect
# need it (without 127.0.0.0/8 qBit 403s on every reconnect). The LAN subnet is
# appended only when we actually know it; a missing LAN_IP must NOT fall open.
if [ -n "$QB_LAN" ]; then
    QB_WHITELIST="127.0.0.0/8,$QB_LAN"
else
    QB_WHITELIST="127.0.0.0/8"
fi

# "Have WE configured this conf before?" is detected by the PRESENCE of
# structural settings we write that qBittorrent's own defaults never have:
# AuthSubnetWhitelistEnabled=true and HostHeaderValidation=false. This is
# deliberately VALUE-INDEPENDENT. Earlier versions keyed on the full
# AuthSubnetWhitelist VALUE, so renumbering your LAN (or a wizard change in
# how the subnet is derived) flipped the signature and triggered a FULL
# rewrite of the minimal template — which silently wiped every user-tuned
# key qBittorrent persists in this same file: seed/ratio limits, global
# speed caps, max-active-torrent counts. That was the "qBit forgets my
# settings every time I run the installer" bug. Now, once our conf is in
# place we leave it ENTIRELY alone (delete the file to reset to defaults).
# A qBittorrent-self-written conf from a botched first install has NEITHER
# marker (qBit defaults are Enabled=false and HostHeaderValidation
# absent/true), so those still get rewritten + recovered as before.
# NOTE: 127.0.0.0/8 is always whitelisted, so gluetun's loopback port-
# forward command keeps working; a stale LAN entry only means the browser
# gets the normal login prompt (never a lockout), so not re-deriving it on
# every run is a safe trade for never clobbering user settings.
QB_MARK_A='WebUI\AuthSubnetWhitelistEnabled=true'
QB_MARK_B='WebUI\HostHeaderValidation=false'
# Dedicated value-independent sentinel, written into a [Mediarr] section of
# the template below. Unlike MARK_A/MARK_B it mirrors NO WebUI control, so it
# survives even if the user flips both auth toggles back toward qBit's
# defaults (the one residual way the marker check could otherwise misfire and
# clobber settings). MARK_A/B are kept so confs written BEFORE this sentinel
# existed are still recognised as already-configured.
QB_MARK_C='ConfManagedBy=mediarr-wizard'
WROTE_CONF=false

if [ -z "$QB_PASS" ]; then
    echo "  ⚠ QBITTORRENT_PASS empty in .env — qBittorrent will boot with"
    echo "    a random temp password (see 'docker logs qbittorrent' once it's up)."
elif [ -f "$QB_CONF_FILE" ] && { grep -qF "$QB_MARK_C" "$QB_CONF_FILE" 2>/dev/null || grep -qF "$QB_MARK_A" "$QB_CONF_FILE" 2>/dev/null || grep -qF "$QB_MARK_B" "$QB_CONF_FILE" 2>/dev/null; }; then
    echo "  ⏭ qBittorrent already configured — preserving your settings as-is"
    echo "    (seed/ratio limits, speed caps, active-torrent counts are kept)."
    echo "    To reset to wizard defaults: delete $QB_CONF_FILE and re-run setup.sh."
else
    mkdir -p "$QB_CONF_DIR"
    # Generate the PBKDF2-HMAC-SHA512 hash (100k iters — what qBittorrent's
    # own GUI uses). It's pure stdlib (no docker socket / network), so we use
    # host python3 when present, else a throwaway python:3-alpine container —
    # the NAS only needs Docker. Password is piped on stdin (not argv) so it
    # never shows up in process args.
    QB_HASH_PY='import sys,hashlib,os,base64
pw=sys.stdin.readline().rstrip("\n").encode("utf-8")
salt=os.urandom(16)
key=hashlib.pbkdf2_hmac("sha512",pw,salt,100000)
print("@ByteArray("+base64.b64encode(salt).decode()+":"+base64.b64encode(key).decode()+")")'
    if command -v python3 >/dev/null 2>&1; then
        HASH=$(printf '%s\n' "$QB_PASS" | python3 -c "$QB_HASH_PY")
    else
        HASH=$(printf '%s\n' "$QB_PASS" | $RT run --rm -i mirror.gcr.io/library/python:3-alpine python3 -c "$QB_HASH_PY")
    fi
    if [ -z "$HASH" ]; then
        echo "  ✘ qBittorrent password-hash generation failed (no host python3,"
        echo "    and the python:3-alpine fallback container couldn't run). Make"
        echo "    sure Docker works (or install python3), then re-run setup.sh."
    else
        # If a non-signature conf is here it was written by qBittorrent
        # itself during a botched previous install (the python3-in-
        # container hash generator silently failed, qBittorrent booted
        # without our creds, generated a temp password and wrote its
        # own conf). Back it up before clobbering so the user can
        # inspect later if anything in there was customised by hand.
        if [ -f "$QB_CONF_FILE" ]; then
            BACKUP="$QB_CONF_FILE.before-mediarr-$(date +%Y%m%d-%H%M%S).bak"
            if cp "$QB_CONF_FILE" "$BACKUP" 2>/dev/null; then
                # The backup carries the same WebUI password hash as the live
                # conf, so lock it down to 600 too (cp inherits the source
                # mode, which may still be a world-readable qBit-written 644).
                chmod 600 "$BACKUP" 2>/dev/null || true
                echo "  Backed up previous conf → $BACKUP"
            fi
        fi
        mkdir -p "$QB_CONF_DIR"
        cat > "$QB_CONF_FILE" <<EOF
[LegalNotice]
Accepted=true

[Mediarr]
# Value-independent sentinel: a re-run greps for ConfManagedBy to know it
# already configured this conf and must leave your settings alone, even if
# you later change the WebUI auth toggles. qBit/QSettings round-trips this
# unknown key verbatim; no WebUI control touches it.
ConfManagedBy=mediarr-wizard

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
# 127.0.0.0/8 is REQUIRED for gluetun's VPN_PORT_FORWARDING_UP_COMMAND.
# The LAN subnet is derived from LAN_IP / LAN_SUBNET in .env above —
# only YOUR home subnet bypasses auth, not all of RFC1918. Set
# LAN_SUBNET in .env to override (e.g. for /16 networks).
WebUI\\AuthSubnetWhitelist=$QB_WHITELIST
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
        # 600, not 644: this file holds the salted PBKDF2 WebUI password hash,
        # the username, and the LAN AuthSubnetWhitelist — the same secret class
        # that lives at 600 in .env. World-readable invited offline brute-force
        # by any local user/process. Already chowned to $PUID:$PGID (the qBit
        # container UID), so the container still reads it fine.
        chmod 600 "$QB_CONF_FILE"
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
    if $RT ps --format '{{.Names}}' 2>/dev/null | grep -q '^qbittorrent$'; then
        echo "  Restarting qbittorrent so it picks up the new credentials..."
        if $RT restart qbittorrent >/dev/null 2>&1; then
            echo "  ✔ qbittorrent restarted"
        else
            echo "  ⚠ $RT restart qbittorrent failed — please run it manually:"
            echo "      $RT compose restart qbittorrent"
        fi
    fi
fi

fi    # end: if is_enabled ENABLE_QBITTORRENT

# ── inotify watch limits (Plex library auto-detect) ──────────────────────
#
# Plex watches every library folder via inotify for "Update my library
# automatically". The kernel's per-process inotify watch limit caps how
# many directories it can monitor — once exhausted, Plex silently stops
# noticing new files (manifests as "added a movie to /data/Media but
# Plex won't pick it up until a scheduled scan"). Synology DSM 7 ships
# with `fs.inotify.max_user_watches=8192` which is fine for ~5000 files
# but tight for serious libraries.
#
# We don't auto-tune the kernel sysctl from here (touching /etc/sysctl
# from a setup script is invasive). Just probe + warn loudly. The
# upgrade path is a one-line Task Scheduler boot-up entry the user
# can paste.
INOTIFY_LIMIT=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo 0)
if [ "$INOTIFY_LIMIT" -gt 0 ] && [ "$INOTIFY_LIMIT" -lt 524288 ]; then
    echo ""
    echo "ℹ Kernel inotify watch limit is $INOTIFY_LIMIT (Plex may stop"
    echo "  auto-detecting new files in libraries >${INOTIFY_LIMIT} dirs)."
    echo "  To raise it permanently (Synology Task Scheduler → Triggered"
    echo "  Task → Boot-up → run as root):"
    echo "    sysctl -w fs.inotify.max_user_watches=524288"
fi

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
