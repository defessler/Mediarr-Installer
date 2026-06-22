#!/bin/sh
# Mediarr — musicvideos downloader + scheduler.
#
# Two modes:
#   run.sh            (default / container CMD) — SCHEDULER. Self-update yt-dlp,
#                     install a crontab from MUSIC_VIDEO_CRON, optionally run one
#                     pass now, then exec crond in the foreground.
#   run.sh run        — ONE PASS. For every configured source: download music
#                     videos from YouTube (or any yt-dlp-compatible source) into
#                     the Music Videos library tree. Each source is independent —
#                     one failing never aborts the others.
#
# Output layout:
#   Explicit artist:  /media/<Artist>/<Artist> - <Title>.mp4
#   Bare URL:         /media/<yt-dlp artist meta>/<yt-dlp artist meta> - <Title>.mp4
#
# POSIX sh (BusyBox ash). No `set -e`: per-source errors must not abort the run.
# Unset-var safety via disciplined ${VAR:-default} use.

CRON_ENV=/app/cron.env
CRONTAB=/etc/crontabs/root
SCRIPT_DIR="$(dirname "$0")"

log()  { printf '%s musicvideos: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
warn() { log "WARN: $*" >&2; }
die()  { log "ERROR: $*" >&2; exit 1; }

# Trim leading/trailing whitespace from $1 (echoes the result).
trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }

# Make a string safe to use as a folder/file name component: drop path separators
# and control chars, collapse leading/trailing whitespace. Spaces are kept.
sanitize() {
    printf '%s' "$1" | sed 's#[/\\]#-#g; s/[[:cntrl:]]//g; s/^[[:space:]]*//; s/[[:space:]]*$//'
}

# ── yt-dlp flags shared by every download ───────────────────────────────────
# --download-archive  dedup: skip any URL already downloaded in a prior run
# -f                  prefer h264+aac in an mp4 container; fallback chain keeps
#                     the result playable on most clients without transcoding
# --merge-output-format mp4  always produce a single .mp4 (muxed by ffmpeg)
# --embed-metadata    write artist/title tags into the container
# --embed-thumbnail   poster art for the media-server UI
# --sleep-requests 1  be polite to YouTube (1 s between requests)
# --match-filter !is_live  NEVER start an infinite livestream download (a real
#                     footgun if a source channel has a 24/7 stream)
# --ignore-errors     one bad video in a playlist skips it, not the whole run
YTDLP_FLAGS='--download-archive /config/archive.txt
  -f bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080]+ba/b[height<=1080]
  --merge-output-format mp4
  --embed-metadata
  --embed-thumbnail
  --sleep-requests 1
  --match-filter !is_live
  --ignore-errors'

# ── pass-level lock ──────────────────────────────────────────────────────────
# Serialise overlapping passes (run-on-start vs cron vs manual `run.sh run`).
# `flock` is not in BusyBox; we use an atomic `mkdir` instead.
LOCKDIR=/config/mv.lock
PASS_LOCK_TTL=21600          # 6 h: any older lock is considered wedged

_pass_lock_release() {
    [ -d "$LOCKDIR" ] || return 0
    if [ "$(cat "$LOCKDIR/pid" 2>/dev/null || printf '')" = "$$" ]; then
        rm -rf "$LOCKDIR"
    fi
}

_pass_lock_acquire() {
    _try=0
    while [ "$_try" -lt 5 ]; do
        _try=$((_try+1))
        if mkdir "$LOCKDIR" 2>/dev/null; then
            printf '%s\n' "$$" > "$LOCKDIR/pid" 2>/dev/null
            date +%s           > "$LOCKDIR/ts"  2>/dev/null
            return 0
        fi
        _p="$(cat "$LOCKDIR/pid" 2>/dev/null || printf '')"
        _t="$(cat "$LOCKDIR/ts"  2>/dev/null || printf '')"
        if [ -n "$_p" ] && kill -0 "$_p" 2>/dev/null; then
            case "$_t" in ''|*[!0-9]*) return 1 ;; esac
            _age=$(( $(date +%s) - _t ))
            [ "$_age" -le "$PASS_LOCK_TTL" ] && return 1
        fi
        warn "stale pass lock (holder pid='${_p:-?}', ts='${_t:-?}') — reclaiming"
        rm -rf "$LOCKDIR"
    done
    return 1
}

# ── one source ───────────────────────────────────────────────────────────────
# Download all videos from a single source entry.
#   $1 = raw source entry (may be "Artist | URL" or bare "URL")
process_source() {
    _entry="$(trim "$1")"
    [ -n "$_entry" ] || return 0

    case "$_entry" in
        *"|"*)
            # Explicit "Artist | URL" — reliable grouping regardless of metadata.
            _artist="$(trim "${_entry%%|*}")"
            _url="$(trim "${_entry#*|}")"
            _san="$(sanitize "$_artist")"
            [ -n "$_san" ] || { warn "empty artist after sanitize for entry '$_entry' — skipping"; return 1; }
            [ -n "$_url" ] || { warn "empty URL for artist '$_artist' — skipping"; return 1; }
            _tmpl="/media/${_san}/${_san} - %(title)s.%(ext)s"
            log "[${_san}] downloading from: $_url"
            ;;
        *)
            # Bare URL — artist derived per-video from yt-dlp metadata.
            # Works well on VEVO / YouTube-Music "Topic" channels that carry real
            # `artist` metadata; may produce "Various Artist / uploader" on
            # generic channels. Use "Artist | URL" for reliable grouping.
            _url="$_entry"
            _tmpl='/media/%(artist,album_artist,creator,uploader)s/%(artist,album_artist,creator,uploader)s - %(title)s.%(ext)s'
            log "[bare-url] downloading from: $_url"
            ;;
    esac

    # shellcheck disable=SC2086
    # SC2086: YTDLP_FLAGS is intentionally word-split (multi-flag string).
    yt-dlp $YTDLP_FLAGS -o "$_tmpl" "$_url"
    _rc=$?
    if [ "$_rc" -ne 0 ]; then
        warn "yt-dlp exited $_rc for '${_san:-bare-url}' — partial results may still exist"
        return 1
    fi
    log "[${_san:-bare-url}] done."
    return 0
}

# ── one full pass ────────────────────────────────────────────────────────────
run_pass() {
    mkdir -p /config /media

    if [ -z "${MUSIC_VIDEO_SOURCES:-}" ]; then
        warn "MUSIC_VIDEO_SOURCES is empty — nothing to do (set it in .env)"
        return 0
    fi

    _ok=0
    _fail=0

    # Split MUSIC_VIDEO_SOURCES on commas AND newlines.
    # Strategy: normalise newlines to commas first, then split on comma with IFS.
    _sources="$(printf '%s' "$MUSIC_VIDEO_SOURCES" | tr '\n' ',')"
    _OLDIFS=$IFS
    IFS=','
    for _src in $_sources; do
        IFS=$_OLDIFS
        _src="$(trim "$_src")"
        [ -n "$_src" ] || { IFS=','; continue; }
        if process_source "$_src"; then
            _ok=$((_ok+1))
        else
            _fail=$((_fail+1))
        fi
        IFS=','
    done
    IFS=$_OLDIFS

    # Fix ownership so Plex/Jellyfin and the host user can read the files.
    chown -R "${PUID:-1000}:${PGID:-1000}" /media 2>/dev/null || true

    log "pass complete: $_ok source(s) succeeded, $_fail failed."
    [ "$_fail" -eq 0 ]
}

# run_pass under the lock. Non-fatal when another pass is already running so the
# scheduler still comes up and the cron keeps trying.
run_pass_locked() {
    if ! _pass_lock_acquire; then
        warn "another musicvideos pass is already running — skipping to avoid conflicts"
        return 0
    fi
    trap '_pass_lock_release' EXIT INT TERM HUP
    run_pass
    _rc=$?
    _pass_lock_release
    trap - EXIT INT TERM HUP
    return "$_rc"
}

# ── scheduler ────────────────────────────────────────────────────────────────
# die_slow: like die() but waits before exit so a bad config doesn't burn all
# restart attempts in seconds. Container is `restart: on-failure:5`.
die_slow() { log "ERROR: $*" >&2; sleep 60; exit 1; }

validate() {
    [ -n "${MUSIC_VIDEO_SOURCES:-}" ] \
        || die_slow "MUSIC_VIDEO_SOURCES is required. Set it in .env and re-run setup."
}

scheduler() {
    validate

    # Self-update yt-dlp so YouTube extractor fixes are picked up without
    # rebuilding the image (yt-dlp releases multiple times per week).
    log "checking for yt-dlp updates ..."
    yt-dlp -U || true

    _cron="${MUSIC_VIDEO_CRON:-0 4 * * *}"

    # BusyBox cron runs jobs with a bare env — snapshot ours (mode 600 because
    # it contains MUSIC_VIDEO_SOURCES) for the cron job to source.
    ( umask 077; export -p > "$CRON_ENV" )

    mkdir -p "$(dirname "$CRONTAB")"
    printf '%s /bin/sh -c ". %s; %s run" >> /proc/1/fd/1 2>&1\n' \
        "$_cron" "$CRON_ENV" "$SCRIPT_DIR/run.sh" > "$CRONTAB"
    chmod 600 "$CRONTAB"
    log "scheduled: '$_cron' — $(grep -c . "$CRONTAB") job(s)"

    # Run one pass immediately unless the user opts out. Failure is non-fatal:
    # the scheduler must still come up so the cron keeps running.
    if [ "${MUSIC_VIDEO_RUN_ON_START:-true}" = "true" ]; then
        log "running initial pass (MUSIC_VIDEO_RUN_ON_START=true) ..."
        run_pass_locked || warn "initial pass had failures — the schedule will retry"
    fi

    log "handing off to crond (foreground)."
    exec crond -f -l 8 -L /dev/stdout
}

case "${1:-}" in
    run)            shift; run_pass_locked ;;
    scheduler|"")   scheduler ;;
    *)              die "unknown mode '$1' (use: no args = scheduler, or 'run' = one pass)" ;;
esac
