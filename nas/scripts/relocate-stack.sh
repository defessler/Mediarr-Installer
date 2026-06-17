#!/bin/bash
# ── relocate-stack.sh — safely move the stack when INSTALL_DIR / DATA_ROOT change ──
#
# Run by setup.sh as a PRE-FLIGHT (before any folders are created). NO-OP unless
# an existing stack's LIVE containers are bind-mounted to a different
# INSTALL_DIR / DATA_ROOT than .env now specifies — i.e. the user is relocating.
#
# Why: Docker recreates a container when its bind-mount SOURCE changes, pointing
# it at the NEW (empty) path and silently orphaning the old config/media. The
# safe order is: stop the stack, MOVE the data, then bring it back up. Container-
# SIDE mounts here are fixed (/config, /data, /media), so moving the HOST dirs
# needs no in-app path rewriting.
#
# Policy (user-chosen — "auto-move when safe, guide otherwise"):
#   • Same filesystem  → atomic `mv` (instant rename; no copy, no delete). Auto.
#   • Cross filesystem → ABORT with manual rsync steps (a multi-TB DATA_ROOT copy
#     isn't done silently). Opt in with MEDIARR_RELOCATE=1 for copy→verify→delete.
#
# INSTALL_DIR is relocated PER-SERVICE: the installer has already uploaded the
# fresh scripts/ + .env into the NEW INSTALL_DIR, so we must NOT move the whole
# root (that would drag scripts/ out from under the running setup.sh and clobber
# the new scaffolding). Instead we move each `<INSTALL_DIR>/<svc>` config subtree.
# DATA_ROOT (a standalone media tree) is moved whole.
#
# Exit codes:  0 = nothing to do (the common case)   1 = aborted, nothing moved
#             75 = relocation PERFORMED, stack is DOWN — caller MUST run start_stack
#
# SAFETY INVARIANTS:
#   - Never touches data unless a real, confirmed change is detected.
#   - Refuses NESTED INSTALL_DIR/DATA_ROOT (one inside the other) — an atomic mv
#     can't preserve a parent/child split — with manual guidance, BEFORE teardown.
#   - Pre-flights EVERY move (dest-empty / same-fs) BEFORE stopping any container,
#     so it never tears the stack down and then discovers it can't move something.
#   - Never overwrites a non-empty destination.
#   - Records the pending moves to a state file BEFORE teardown. A same-filesystem
#     move is an atomic rename, so an interruption leaves no partial state and the
#     next run resumes cleanly from the state file. A cross-filesystem copy
#     (MEDIARR_RELOCATE=1) never deletes the source until the copy verifies, so an
#     interruption never loses data — you may just need to clear the partial
#     destination before re-running. The state file is cleared only on full success.
#   - `mv` / `rsync -aHAX` preserve ownership + permissions.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    INSTALL_DIR_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    INSTALL_DIR_DEFAULT="$SCRIPT_DIR"
fi
if [ -f "$SCRIPT_DIR/.env" ]; then ENV_FILE="$SCRIPT_DIR/.env"; else ENV_FILE="$INSTALL_DIR_DEFAULT/.env"; fi
[ -f "$ENV_FILE" ] || exit 0

RT="${CONTAINER_RUNTIME:-}"
if [ -z "$RT" ]; then
    RT=docker
    command -v docker >/dev/null 2>&1 || { command -v podman >/dev/null 2>&1 && RT=podman; }
fi
command -v "$RT" >/dev/null 2>&1 || exit 0
$RT info >/dev/null 2>&1 || exit 0

env_val() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r' | sed 's/^"//; s/"$//'; }
NEW_INSTALL="$(env_val INSTALL_DIR)"
NEW_DATA="$(env_val DATA_ROOT)"
# Normalize trailing slashes so the .env-sourced NEW paths match the OLD paths
# docker inspect reports (already clean) — otherwise a habitual
# "DATA_ROOT=/volume1/Data/" looks like a path change and wedges a legit re-run.
# Loop is multi-trailing-slash safe and preserves a bare "/".
strip_slash() { local p="$1"; while [ "$p" != "/" ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done; printf '%s' "$p"; }
NEW_INSTALL="$(strip_slash "$NEW_INSTALL")"
NEW_DATA="$(strip_slash "$NEW_DATA")"

# Resume state lives next to .setup-state, in scripts/ — which the per-service
# strategy never moves, so it survives a relocation and an SFTP re-upload (merge).
RELOCATE_STATE="$SCRIPT_DIR/.relocate-state"

# Per-service config dirs under INSTALL_DIR (the dirs docker bind-mounts as
# ${INSTALL_DIR}/<svc>/config — azuracast has several subdirs under azuracast/).
SERVICE_DIRS="plex jellyfin tautulli seerr prowlarr sonarr radarr lidarr bazarr qbittorrent sabnzbd recyclarr unpackerr homepage slskd soularr azuracast playlistsync"

# The stack's fixed container_names. gluetun LAST (its namespace-sharers must be
# removed first, or Docker refuses to rm it).
STACK_CONTAINERS="plex jellyfin tautulli seerr prowlarr sonarr radarr lidarr bazarr qbittorrent sabnzbd recyclarr recyclarr-trigger unpackerr flaresolverr homepage slskd soularr azuracast playlistsync gluetun"

container_exists() { $RT inspect "$1" >/dev/null 2>&1; }
mount_src() { $RT inspect -f "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" "$1" 2>/dev/null; }

# ── Derive OLD paths from live container mounts ──────────────────────────────
OLD_INSTALL=""
for c in sonarr radarr lidarr bazarr prowlarr qbittorrent sabnzbd plex jellyfin tautulli recyclarr unpackerr homepage playlistsync; do
    container_exists "$c" || continue
    src="$(mount_src "$c" /config)"
    [ -n "$src" ] || continue
    case "$src" in */"$c"/config) OLD_INSTALL="${src%/"$c"/config}"; break ;; esac
done
OLD_DATA=""
for c in sonarr radarr lidarr bazarr unpackerr; do   # mount ${DATA_ROOT}:/data EXACTLY (NOT sabnzbd/playlistsync)
    container_exists "$c" || continue
    src="$(mount_src "$c" /data)"
    [ -n "$src" ] && { OLD_DATA="$src"; break; }
done
if [ -z "$OLD_DATA" ]; then
    for c in plex jellyfin; do
        container_exists "$c" || continue
        src="$(mount_src "$c" /media)"
        case "$src" in */Media) OLD_DATA="${src%/Media}"; break ;; esac
    done
fi

# ── Nesting guard ────────────────────────────────────────────────────────────
# If INSTALL_DIR and DATA_ROOT are nested (one inside the other) or equal AND a
# path is changing, an automatic move can't preserve the parent/child split —
# abort with manual steps BEFORE touching anything (stack stays up).
is_within() { case "$1/" in "$2"/*) return 0 ;; *) return 1 ;; esac; }   # $1 within (or ==) $2
if [ -n "$OLD_INSTALL" ] && [ -n "$OLD_DATA" ] \
   && { is_within "$OLD_DATA" "$OLD_INSTALL" || is_within "$OLD_INSTALL" "$OLD_DATA"; } \
   && { [ "$OLD_INSTALL" != "$NEW_INSTALL" ] || [ "$OLD_DATA" != "$NEW_DATA" ]; }; then
    echo "  ✘ INSTALL_DIR and DATA_ROOT are nested (one lives inside the other) and a path is"
    echo "    changing. Auto-moving can't safely split a nested layout. Relocate manually with"
    echo "    the stack stopped:"
    echo "      sudo bash $SCRIPT_DIR/stop-all.sh        # or: docker compose down"
    echo "      # mv (or rsync) each of INSTALL_DIR and DATA_ROOT to its new path"
    echo "      # edit .env so INSTALL_DIR / DATA_ROOT name the new paths"
    echo "      sudo bash $SCRIPT_DIR/setup.sh"
    exit 1
fi

# ── Build the move set (old|new|label) ───────────────────────────────────────
PAIRS=()
add_pair() { [ -n "$1" ] && [ -n "$2" ] && [ "$1" != "$2" ] && [ -d "$1" ] && PAIRS+=("$1|$2|$3"); }
# INSTALL_DIR → per-service subtrees (NOT the whole root: scripts/ + the fresh
# .env the installer just uploaded must stay put).
if [ -n "$OLD_INSTALL" ] && [ "$OLD_INSTALL" != "$NEW_INSTALL" ]; then
    for svc in $SERVICE_DIRS; do
        add_pair "$OLD_INSTALL/$svc" "$NEW_INSTALL/$svc" "$svc config"
    done
fi
# DATA_ROOT → whole tree.
add_pair "$OLD_DATA" "$NEW_DATA" "DATA_ROOT"

# ── Resume: if live detection found nothing, a prior run may have been
# interrupted AFTER teardown (containers gone). Rebuild from the state file. ──
if [ ${#PAIRS[@]} -eq 0 ] && [ -f "$RELOCATE_STATE" ]; then
    while IFS='|' read -r o n l; do
        [ -n "$o" ] && [ -n "$n" ] && [ "$o" != "$n" ] && [ -d "$o" ] && PAIRS+=("$o|$n|$l")
    done < "$RELOCATE_STATE"
    [ ${#PAIRS[@]} -gt 0 ] && echo "  Resuming an interrupted relocation (${#PAIRS[@]} item(s) left)…"
fi
[ ${#PAIRS[@]} -eq 0 ] && { rm -f "$RELOCATE_STATE" 2>/dev/null; exit 0; }   # nothing to do / resume finished

# ── Helpers ──────────────────────────────────────────────────────────────────
nearest_existing() { local p="$1"; while [ ! -e "$p" ] && [ "$p" != / ] && [ -n "$p" ]; do p="$(dirname "$p")"; done; printf '%s' "$p"; }
same_fs() {
    local da db
    da="$(stat -c %d "$1" 2>/dev/null)" || return 1
    db="$(stat -c %d "$(nearest_existing "$2")" 2>/dev/null)" || return 1
    [ -n "$da" ] && [ -n "$db" ] && [ "$da" = "$db" ]
}
dest_blocked() { [ -e "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }
verify_copy() { [ -z "$(rsync -aHAXn "$1"/ "$2"/ 2>/dev/null)" ]; }

echo "────────────────────────────────────────────────────────────────────"
echo "  Path change detected on an existing install. Relocating so your data"
echo "  isn't orphaned at the old location:"
for ch in "${PAIRS[@]}"; do IFS='|' read -r o n l <<<"$ch"; echo "    • $l: $o  →  $n"; done
echo "────────────────────────────────────────────────────────────────────"

# ── PRE-FLIGHT every move BEFORE touching the running stack ──────────────────
for ch in "${PAIRS[@]}"; do
    IFS='|' read -r o n l <<<"$ch"
    if dest_blocked "$n"; then
        echo "  ✘ $l: destination already exists and is not empty:"
        echo "      $n"
        echo "    Refusing to overwrite an existing config/library. Move it aside, then re-run setup."
        exit 1
    fi
    if ! same_fs "$o" "$n"; then
        if [ "${MEDIARR_RELOCATE:-}" != "1" ]; then
            echo "  ✘ $l would move ACROSS filesystems (different disk/volume):"
            echo "      $o  →  $n"
            echo "    A cross-disk move can be very large/slow, so it isn't done automatically."
            echo "    With the stack stopped, relocate it yourself:"
            echo "      sudo bash $SCRIPT_DIR/stop-all.sh        # or: docker compose down"
            echo "      rsync -aHAX \"$o/\" \"$n/\"  &&  rm -rf \"$o\""
            echo "      sudo bash $SCRIPT_DIR/setup.sh"
            echo "    Or re-run setup with MEDIARR_RELOCATE=1 to have it copy→verify→delete for you."
            exit 1
        fi
        # Opted into the cross-fs copy — but it needs rsync. Assert it HERE (before
        # the teardown below) so a missing tool never leaves the stack stopped and
        # then fails with a misleading "copy failed" message.
        command -v rsync >/dev/null 2>&1 || {
            echo "  ✘ $l: MEDIARR_RELOCATE=1 needs rsync, which isn't installed."
            echo "    Install rsync, or do the cross-disk move manually (stop-all.sh, then mv/cp, then setup.sh)."
            exit 1
        }
    fi
done

# ── Record the plan, THEN stop the stack, THEN move ──────────────────────────
: > "$RELOCATE_STATE" 2>/dev/null || true
for ch in "${PAIRS[@]}"; do printf '%s\n' "$ch" >> "$RELOCATE_STATE" 2>/dev/null || true; done

echo "  Stopping the stack so no files are in use…"
for c in $STACK_CONTAINERS; do
    container_exists "$c" || continue
    $RT stop "$c" >/dev/null 2>&1 || true
    $RT rm   "$c" >/dev/null 2>&1 || true
done

relocate_one() {
    local old="$1" new="$2" label="$3"
    if same_fs "$old" "$new"; then
        mkdir -p "$(dirname "$new")"
        [ -d "$new" ] && rmdir "$new" 2>/dev/null   # drop an empty pre-made dir so mv is a clean rename
        if mv "$old" "$new"; then echo "  ✔ $label: moved (same filesystem) → $new"; return 0; fi
        echo "  ✘ $label: mv failed ($old → $new)"; return 1
    fi
    echo "  → $label: different filesystem — copying $old → $new (this can take a while)…"
    mkdir -p "$new"
    if rsync -aHAX "$old"/ "$new"/ && verify_copy "$old" "$new"; then
        rm -rf "$old"; echo "  ✔ $label: copied → $new and removed the original"; return 0
    fi
    echo "  ✘ $label: cross-filesystem copy failed or verify mismatch — BOTH copies left in"
    echo "    place (nothing deleted). Resolve $old / $new manually."
    return 1
}

rc=0
for ch in "${PAIRS[@]}"; do
    IFS='|' read -r o n l <<<"$ch"
    relocate_one "$o" "$n" "$l" || { rc=1; break; }   # stop on first failure; state file keeps the rest for resume
done

if [ "$rc" -ne 0 ]; then
    echo "  ✘ Relocation did not fully complete (see above). The stack is stopped and the"
    echo "    remaining moves are recorded — fix the issue and re-run setup.sh to RESUME."
    exit 1
fi
rm -f "$RELOCATE_STATE" 2>/dev/null
echo "  ✔ Relocation complete. Restarting the stack at the new paths…"
exit 75   # sentinel: relocation performed, stack is DOWN — setup.sh must run start_stack
