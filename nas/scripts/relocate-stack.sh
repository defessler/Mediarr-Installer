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
# RESUMED_FROM_STATE marks PAIRS as a recorded-but-incomplete relocation (the
# user already consented to it on the run that wrote the state file). The
# narrow-rerun consent gate below is skipped for these — re-asking would dead-end
# an interrupted move — and dest_blocked treats a partial dest as resumable
# rather than a pre-existing library.
RESUMED_FROM_STATE=0
if [ ${#PAIRS[@]} -eq 0 ] && [ -f "$RELOCATE_STATE" ]; then
    while IFS='|' read -r o n l; do
        [ -n "$o" ] && [ -n "$n" ] && [ "$o" != "$n" ] && [ -d "$o" ] && PAIRS+=("$o|$n|$l")
    done < "$RELOCATE_STATE"
    [ ${#PAIRS[@]} -gt 0 ] && { RESUMED_FROM_STATE=1; echo "  Resuming an interrupted relocation (${#PAIRS[@]} item(s) left)…"; }
    # Recover the install roots the original run recorded: on a resume the live
    # containers are already gone, so OLD_INSTALL can't be re-derived from them.
    # Without this the first-install marker never reaches the new root and the
    # next run reverts every arr/qBit UI customization (the harm R7 prevents).
    [ -z "$OLD_INSTALL" ] && OLD_INSTALL="$(grep -m1 '^OLD_INSTALL=' "$RELOCATE_STATE" 2>/dev/null | cut -d= -f2-)"
    [ -z "$NEW_INSTALL" ] && NEW_INSTALL="$(grep -m1 '^NEW_INSTALL=' "$RELOCATE_STATE" 2>/dev/null | cut -d= -f2-)"
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

# ── Narrow-rerun consent gate ────────────────────────────────────────────────
# A full (no-flag) setup run auto-relocates on a real path change — that's the
# intended "auto-move when safe" behaviour. But under an explicit --from N /
# --resume (setup.sh exports MEDIARR_NARROW_RERUN=1) the user asked for a NARROW
# idempotent re-run, NOT a relocation; if .env's INSTALL_DIR/DATA_ROOT has drifted
# from the live mounts (typo, half-finished edit, imported profile), silently
# tearing the stack down to move every config subtree is the opposite of what they
# asked for. So: detect a LIVE path change (RESUMED_FROM_STATE=0 — a state-file
# resume was already consented to and must continue) and require explicit consent
# (MEDIARR_RELOCATE=1) before proceeding; otherwise stop without touching the
# running stack. The dest_blocked / cross-fs guards below still apply once consent
# is given.
if [ "$RESUMED_FROM_STATE" -eq 0 ] && [ "${MEDIARR_NARROW_RERUN:-}" = "1" ] && [ "${MEDIARR_RELOCATE:-}" != "1" ]; then
    echo "  ✘ A path change was detected, but you ran setup with --from / --resume — a"
    echo "    narrow re-run, not a relocation. Moving now would STOP and recreate the stack:"
    stop_list=""
    for c in $STACK_CONTAINERS; do container_exists "$c" && stop_list="$stop_list $c"; done
    [ -n "$stop_list" ] && echo "      containers that would stop:$stop_list"
    echo "    Nothing has been moved and the stack is still running. Either:"
    echo "      • If you DID mean to relocate to the new paths, re-run WITHOUT --from/--resume"
    echo "        (a full run auto-moves), or re-run as-is with MEDIARR_RELOCATE=1 to confirm."
    echo "      • If the new paths are wrong, fix INSTALL_DIR / DATA_ROOT in .env to match the"
    echo "        live install, then re-run."
    exit 1
fi

# ── PRE-FLIGHT every move BEFORE touching the running stack ──────────────────
for ch in "${PAIRS[@]}"; do
    IFS='|' read -r o n l <<<"$ch"
    pair_same_fs=0
    same_fs "$o" "$n" && pair_same_fs=1
    if dest_blocked "$n"; then
        # A non-empty dest is a hard block for a FRESH move (refuse to overwrite
        # a real library). But when this is a RESUMED relocation, that dest is the
        # user's OWN partial copy from the interrupted run — frame it as such
        # instead of mis-reporting it as a pre-existing library.
        if [ "$RESUMED_FROM_STATE" -eq 1 ] && [ "$pair_same_fs" -eq 0 ]; then
            # Cross-fs resume: rsync -aHAX is restart-safe and reconciles into the
            # partial dest. Don't abort here — fall through to the cross-fs block,
            # which proceeds when re-confirmed (MEDIARR_RELOCATE=1) or otherwise
            # prints the manual resume steps.
            [ "${MEDIARR_RELOCATE:-}" = "1" ] && {
                echo "  ↻ $l: resuming into the partial copy left at $n (rsync reconciles)."
                echo "      The original at $o is intact and is only removed once the copy verifies."
            }
        elif [ "$RESUMED_FROM_STATE" -eq 1 ]; then
            # Same-fs resume with a non-empty dest: an atomic rename leaves no
            # partial state, so this is unexpected — name it precisely.
            echo "  ✘ $l: $n is the partial copy left by the interrupted relocation of $o."
            echo "      The original at $o is intact. It is safe to delete $n and re-run setup to resume."
            exit 1
        else
            echo "  ✘ $l: destination already exists and is not empty:"
            echo "      $n"
            echo "    Refusing to overwrite an existing config/library. Move it aside, then re-run setup."
            exit 1
        fi
    fi
    if [ "$pair_same_fs" -eq 0 ]; then
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
        # Best-effort free-space guard: refuse an undersized destination BEFORE
        # teardown (like the rsync-missing guard above), so a multi-TB cross-disk
        # move onto a too-small disk doesn't tear the stack down, half-fill the
        # target, and fail mid-rsync. Skip silently if du/df output isn't numeric
        # so a quirky environment never blocks a legitimate move. Only checked for
        # a FRESH move: on a resume the partial copy already occupies the dest, so
        # df reports less free than a full `du $o` needs and we'd false-refuse a
        # legitimate resume (rsync only writes the remaining delta anyway).
        if [ "$RESUMED_FROM_STATE" -eq 0 ]; then
            need_k="$(du -sk "$o" 2>/dev/null | awk '{print $1}')"
            free_k="$(df -Pk "$(nearest_existing "$n")" 2>/dev/null | awk 'NR==2{print $4}')"
            # Both must be present AND all-digits — a blank or odd value skips the
            # check (best-effort) rather than crashing the arithmetic below.
            case "${need_k:-x}|${free_k:-x}" in
                *[!0-9]*\|*|*\|*[!0-9]*) : ;;   # either side non-numeric → skip
                *)
                    # Require ~5% headroom (filesystem reserve + slack).
                    if [ "$free_k" -lt "$((need_k + need_k / 20))" ]; then
                        echo "  ✘ $l won't fit on the destination disk:"
                        echo "      need ~$((need_k / 1048576)) GiB, have ~$((free_k / 1048576)) GiB free at $n"
                        echo "    Free up space (or pick a larger DATA_ROOT/INSTALL_DIR) and re-run. The stack"
                        echo "    is still running and nothing has been moved."
                        exit 1
                    fi
                    ;;
            esac
        fi
    fi
done

# ── Record the plan, THEN stop the stack, THEN move ──────────────────────────
: > "$RELOCATE_STATE" 2>/dev/null || true
for ch in "${PAIRS[@]}"; do printf '%s\n' "$ch" >> "$RELOCATE_STATE" 2>/dev/null || true; done
# Also record the install roots so a (re-)resume can carry the first-install
# marker even after teardown. No "|" → the pair reader above skips these lines.
if [ -n "$OLD_INSTALL" ] && [ "$OLD_INSTALL" != "$NEW_INSTALL" ]; then
    printf 'OLD_INSTALL=%s\n' "$OLD_INSTALL" >> "$RELOCATE_STATE" 2>/dev/null || true
    printf 'NEW_INSTALL=%s\n' "$NEW_INSTALL" >> "$RELOCATE_STATE" 2>/dev/null || true
fi

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
# Carry the first-install marker to the NEW root. The per-service move never
# touches this top-level one-line file, so it stays at OLD_INSTALL — which would
# leave the next setup-arr-config.py run seeing REINSTALL_PRESERVE=False at the
# new path and re-stamping wizard defaults over every arr/qBit UI customization
# the marker machinery exists to protect. Tiny file → just copy it (no cross-fs
# concern). Only relevant when INSTALL_DIR actually moved.
if [ -n "$OLD_INSTALL" ] && [ "$OLD_INSTALL" != "$NEW_INSTALL" ]; then
    [ -f "$OLD_INSTALL/.wizard-stack-installed" ] && { mkdir -p "$NEW_INSTALL"; cp -p "$OLD_INSTALL/.wizard-stack-installed" "$NEW_INSTALL/.wizard-stack-installed" 2>/dev/null; }
fi
echo "  ✔ Relocation complete. Restarting the stack at the new paths…"
exit 75   # sentinel: relocation performed, stack is DOWN — setup.sh must run start_stack
