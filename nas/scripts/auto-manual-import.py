#!/usr/bin/env python3
"""
auto-manual-import.py — drain "Manual import required" queue items

Sonarr / Radarr / Lidarr park a download in the queue with
trackedDownloadState=importBlocked when the file IS downloaded and
the arr DOES know which media it belongs to (via the grab history
the arr wrote at search time), but the parsed release title doesn't
cleanly match the matched media's title. The classic Radarr log
message:

    "Found matching movie via grab history, but release was matched
     to movie by ID. Manual import required."

In the WebUI you'd resolve this with Activity → Manual Import →
select the file → Import. This script does the same thing via API.

Workflow (per arr):
    1. GET /queue?pageSize=500 → filter items with
       trackedDownloadState=importBlocked + downloadId set.
    2. For each item, GET /manualimport?downloadId=<hash> → arr
       returns candidate files with the matched media (movie /
       series+episodes / artist+album+tracks) pre-populated from
       the grab history.
    3. Conservative filter — only auto-import a candidate when:
         (a) matched media is populated (arr already identified target)
         (b) quality is populated (arr already chose a quality)
         (c) the rejections list, if any, contains ONLY grab-history
             style title-mismatch reasons — never quality / language /
             custom-format rejections (those are legitimate "no, this
             release shouldn't be imported" signals).
    4. POST /command with name=ManualImport, importMode=Auto. Auto
       picks Copy for torrent downloads (keeps seeding) and Move for
       usenet — same logic the WebUI's Manual Import dialog uses.

Anything not matching the conservative filter is logged and skipped
so the operator can review in the WebUI. Idempotent — re-runs only
touch what's still blocked at the time of the run.

Wired into setup.sh as Step 12 and shipped as a standalone script
that can be re-run on demand or scheduled (e.g. Synology Task
Scheduler → User-defined script weekly, see setup.sh summary).

Usage:
    python3 /volume1/docker/media/scripts/auto-manual-import.py

Reads .env for LAN_IP + arr API keys (SONARR_API_KEY, RADARR_API_KEY,
LIDARR_API_KEY) — same shape as setup-arr-config.py. Falls back to
each arr's config.xml when the .env doesn't carry the key, matching
fix-imports.sh's behaviour.
"""

import json
import os
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


# ── Terminal colours (same palette as setup-arr-config.py) ──────────────────

GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
DIM    = "\033[2m"
BOLD   = "\033[1m"
RESET  = "\033[0m"


def ok(msg):    print(f"  {GREEN}✔{RESET}  {msg}")
def skip(msg):  print(f"  –  {msg}")
def info(msg):  print(f"  {DIM}ℹ{RESET}  {msg}")
def warn(msg):  print(f"  {YELLOW}!{RESET}  {msg}")
def fail(msg):  print(f"  {RED}✘{RESET}  {msg}")
def section(title):
    print(f"\n{BOLD}━━━ {title} {'━' * max(0, 52 - len(title))}{RESET}")


# Line-buffer stdout so heartbeats flush immediately when piped
# (setup.sh streams this through to the wizard's run-screen panel).
# Same pattern as setup-arr-config.py.
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass


# ── .env reading ─────────────────────────────────────────────────────────────

def _read_env_file(path):
    """Parse a .env-style file into a dict. Strips inline comments,
    surrounding whitespace, and matched quotes. Returns {} when the
    file's missing (caller decides whether absence is fatal)."""
    env = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for raw in f:
                line = raw.strip().lstrip('﻿')
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                v = v.split('#', 1)[0].strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
                    v = v[1:-1]
                env[k.strip()] = v
    except FileNotFoundError:
        pass
    return env


def _find_env_file():
    """Locate .env relative to this script. v0.3.23+ puts it in
    scripts/ alongside docker-compose.yml; older layouts had it at
    install-dir root above scripts/. Prefer the new location."""
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, '.env'),
                 os.path.join(here, '..', '.env')):
        if os.path.isfile(cand):
            return cand
    return None


def _extract_api_key(xml_path):
    """Pull <ApiKey>...</ApiKey> out of an arr's config.xml — same
    fallback fix-imports.sh uses when a key isn't in .env yet. Returns
    '' on any error so the caller can short-circuit."""
    try:
        with open(xml_path, 'r', encoding='utf-8') as f:
            m = re.search(r'<ApiKey>\s*([^<\s]+)\s*</ApiKey>', f.read())
            return m.group(1) if m else ''
    except OSError:
        return ''


def _is_enabled(env, key):
    """Default-on opt-out semantics matching setup.sh's is_enabled()."""
    val = (env.get(key, '') or '').strip().lower()
    return val not in ('false', '0', 'no', 'off')


# ── HTTP helpers ─────────────────────────────────────────────────────────────

def _arr_get(base, key, path, timeout=15):
    """GET <base><path> with X-Api-Key. Returns parsed JSON or None on
    any error (network, HTTP, JSON parse). Errors are intentionally
    swallowed at this layer — the caller has more context and decides
    whether to warn() or fail() based on the situation."""
    try:
        req = Request(f"{base}{path}", headers={'X-Api-Key': key})
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (HTTPError, URLError, json.JSONDecodeError, TimeoutError, OSError):
        return None


def _arr_post(base, key, path, body, timeout=15):
    """POST JSON body to <base><path> with X-Api-Key. Returns parsed
    JSON response (or {} when arr returns empty body — happens on
    202 Accepted command submissions) or None on any error."""
    try:
        req = Request(
            f"{base}{path}",
            data=json.dumps(body).encode('utf-8'),
            headers={
                'X-Api-Key': key,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            method='POST',
        )
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except (HTTPError, URLError, json.JSONDecodeError, TimeoutError, OSError) as e:
        return None


# ── Rejection classification ─────────────────────────────────────────────────
#
# When the arr returns a manualimport candidate with a non-empty
# `rejections` list, each entry tells us WHY the auto-import didn't
# happen. We only override the "the arr knew the target media but the
# release title is ugly" family — never the "the release fails policy"
# family (codec, quality, custom format, language).
#
# Reasons are free-form strings from the arr's source. The patterns
# below are anchored to phrases that haven't changed in years across
# Sonarr/Radarr/Lidarr v3/v4/v5 source; if the arr renames them we'd
# false-skip (safe) rather than false-import (unsafe).

GRAB_HISTORY_SAFE = [
    # Radarr — exact phrase from user's report:
    #   "Found matching movie via grab history, but release was
    #    matched to movie by ID. Manual import required."
    re.compile(r'matching (movie|series|album|artist) via grab history', re.I),
    re.compile(r'release was matched to \w+ by id', re.I),
    re.compile(r'manual import required', re.I),
    # Parser failures — when the filename is so generic the parser
    # gave up, but the grab history tells us what it is anyway.
    re.compile(r'unable to parse (release title|episode)', re.I),
    re.compile(r'release title cannot null or empty', re.I),
    # Sonarr-specific: "Episode parse failed for ..." but series
    # matched via grab history.
    re.compile(r'episode parse failed', re.I),
]


def _rejection_text(rejection):
    """Each rejection is normally a dict with 'reason' (and sometimes
    'type'). Older arr versions returned bare strings. Handle both."""
    if isinstance(rejection, dict):
        return rejection.get('reason') or rejection.get('message') or ''
    return str(rejection)


def _rejections_safe(rejections):
    """True iff the rejection list is empty OR every entry matches a
    grab-history pattern. A single hard rejection (quality, format,
    language) → False, and the candidate gets skipped for manual
    review. Better to leave one stuck than auto-import the wrong thing."""
    if not rejections:
        return True
    for r in rejections:
        text = _rejection_text(r)
        if not any(p.search(text) for p in GRAB_HISTORY_SAFE):
            return False
    return True


# ── Per-arr workflows ────────────────────────────────────────────────────────
#
# Sonarr/Radarr/Lidarr all expose the same manualimport shape but the
# matched-media field names differ (movie vs series+episodes vs
# artist+album+tracks). One worker function per arr keeps the field
# mapping legible at the cost of a little duplication — abstracting it
# would buy nothing since each arr only ships one media type anyway.


def _format_rejections(rejections):
    """One-line summary of rejection reasons for the skipped-item log."""
    if not rejections:
        return '(no rejections)'
    reasons = [_rejection_text(r) for r in rejections]
    joined = ' / '.join(r for r in reasons if r)
    return joined[:120] + ('...' if len(joined) > 120 else '')


def _drain_arr(label, base, key, api_version, media_field, build_file_payload,
               include_query):
    """Generic workhorse shared by Radarr/Sonarr/Lidarr:

        label              — human name for log lines ("Radarr")
        base               — http://LAN_IP:port
        key                — X-Api-Key value
        api_version        — "api/v3" (Sonarr/Radarr) or "api/v1" (Lidarr)
        media_field        — JSON key for the matched-media object on a
                             manualimport candidate ('movie' / 'series' /
                             'artist'). Used as a quick "did arr identify
                             this?" probe.
        build_file_payload — fn(candidate, download_id) → POST file dict.
                             Encapsulates per-arr field mapping (movieId
                             vs seriesId+episodeIds vs artistId+albumId
                             +trackIds).
        include_query      — query-string fragment for /queue to inline
                             the media object (varies per arr — Sonarr
                             needs includeSeries+includeEpisode, Radarr
                             includeMovie, Lidarr includeArtist+
                             includeAlbum). Used only for prettier log
                             lines; not load-bearing."""
    section(label)
    if not key:
        skip(f"{label.upper()}_API_KEY not set and config.xml lookup empty — skipping")
        return

    queue = _arr_get(base, key, f"/{api_version}/queue?pageSize=500{include_query}")
    if queue is None:
        warn(f"can't read {label} queue (arr down, wrong key, or wrong port?)")
        return

    records = queue.get('records', []) if isinstance(queue, dict) else (queue or [])
    blocked = [
        r for r in records
        if (r.get('trackedDownloadState') or '').lower() == 'importblocked'
        and r.get('downloadId')
    ]

    if not blocked:
        skip(f"no import-blocked items (queue has {len(records)} record(s))")
        return

    info(f"{len(blocked)} import-blocked item(s) — fetching manualimport candidates...")

    submitted = 0
    items_skipped = 0
    for item in blocked:
        download_id = item['downloadId']
        title = (
            item.get('title')
            or (item.get(media_field) or {}).get('title')
            or item.get('sourceTitle')
            or '(unknown title)'
        )
        # filterExistingFiles=false: include candidates even when the
        # arr's library already has a file at the target path. Without
        # this the manualimport endpoint silently filters out any
        # candidate whose target exists — but a re-import with the same
        # filename is exactly the case the user usually wants resolved.
        candidates = _arr_get(
            base, key,
            f"/{api_version}/manualimport?downloadId={download_id}&filterExistingFiles=false",
        )
        if not candidates:
            warn(f"  {title[:80]} — manualimport returned no candidates")
            items_skipped += 1
            continue

        importable = []
        skipped_reasons = []
        for c in candidates:
            media = c.get(media_field) or {}
            quality = c.get('quality') or {}
            rejections = c.get('rejections') or []

            if not media.get('id'):
                skipped_reasons.append(f"no {media_field} matched")
                continue
            if not quality:
                skipped_reasons.append("no quality matched")
                continue
            if not _rejections_safe(rejections):
                skipped_reasons.append(
                    f"hard rejection — {_format_rejections(rejections)}"
                )
                continue
            payload = build_file_payload(c, download_id)
            if payload is not None:
                importable.append(payload)

        if not importable:
            items_skipped += 1
            reason = '; '.join(skipped_reasons[:2]) if skipped_reasons else 'no usable candidate'
            warn(f"  {title[:80]} — skipped ({reason})")
            continue

        # importMode=Auto: arr picks Copy for torrent downloads (keeps
        # the file in /downloads so qBit can keep seeding) and Move for
        # usenet (where there's no seeding to preserve). Matches the
        # behaviour the WebUI's Manual Import dialog applies when you
        # don't override the dropdown.
        result = _arr_post(base, key, f"/{api_version}/command", {
            'name':       'ManualImport',
            'importMode': 'Auto',
            'files':      importable,
        })
        if result is None:
            fail(f"  {title[:80]} — ManualImport command POST failed")
            items_skipped += 1
            continue

        submitted += 1
        ok(f"  {title[:80]} ({len(importable)} file(s)) → ManualImport queued")
        # Gentle pacing — back-to-back POSTs on a sleepy arr can stack
        # in the command queue and slow down the user's other API work
        # for a few seconds. 250ms is invisible at human scale.
        time.sleep(0.25)

    summary_parts = []
    if submitted:
        summary_parts.append(f"{GREEN}{submitted} submitted{RESET}")
    if items_skipped:
        summary_parts.append(f"{YELLOW}{items_skipped} needs review{RESET}")
    if summary_parts:
        info(f"{label}: {' │ '.join(summary_parts)}")


def _radarr_file_payload(candidate, download_id):
    """Radarr ManualImport file shape: per-file movieId + quality +
    languages + downloadId. releaseGroup is optional but the arr stores
    it on the imported file for naming/format use, so pass through what
    the parser found."""
    movie = candidate.get('movie') or {}
    return {
        'path':         candidate['path'],
        'movieId':      movie['id'],
        'quality':      candidate.get('quality') or {},
        'languages':    candidate.get('languages') or [],
        'downloadId':   download_id,
        'releaseGroup': candidate.get('releaseGroup') or '',
        'indexerFlags': candidate.get('indexerFlags', 0),
    }


def _sonarr_file_payload(candidate, download_id):
    """Sonarr ManualImport file shape: seriesId + episodeIds list per
    file. A multi-episode file (S01E01E02) carries multiple episode
    IDs; the arr matches each up internally. Skip candidates without
    at least one episode matched — auto-importing a TV file with no
    episode context creates orphan media."""
    series = candidate.get('series') or {}
    episodes = candidate.get('episodes') or []
    episode_ids = [e['id'] for e in episodes if e.get('id')]
    if not episode_ids:
        return None
    return {
        'path':         candidate['path'],
        'seriesId':     series['id'],
        'episodeIds':   episode_ids,
        'quality':      candidate.get('quality') or {},
        'languages':    candidate.get('languages') or [],
        'downloadId':   download_id,
        'releaseGroup': candidate.get('releaseGroup') or '',
        'indexerFlags': candidate.get('indexerFlags', 0),
    }


def _lidarr_file_payload(candidate, download_id):
    """Lidarr ManualImport file shape: artistId + albumId + trackIds.
    Skip if no track matched (same orphan-file logic as Sonarr above —
    music file without track metadata creates a useless entry)."""
    artist = candidate.get('artist') or {}
    album = candidate.get('album') or {}
    tracks = candidate.get('tracks') or []
    track_ids = [t['id'] for t in tracks if t.get('id')]
    # Guard artist.id alongside album/tracks. Lidarr rejects a ManualImport
    # file whose artistId is null (it can't attach the track to an artist),
    # and candidate['artist'] is sometimes an unmatched stub with no 'id' —
    # so without this check we'd POST artistId: None and the whole command
    # fails. Same orphan-skip rationale as the album/track guards.
    if not artist.get('id') or not album.get('id') or not track_ids:
        return None
    return {
        'path':         candidate['path'],
        'artistId':     artist['id'],
        'albumId':      album['id'],
        'trackIds':     track_ids,
        'quality':      candidate.get('quality') or {},
        # Lidarr uses 'releaseGroup' too, plus 'additionalFile' bool that
        # the WebUI omits for normal imports.
        'releaseGroup': candidate.get('releaseGroup') or '',
        'downloadId':   download_id,
    }


# ── Entry point ──────────────────────────────────────────────────────────────

def main():
    env_path = _find_env_file()
    env = _read_env_file(env_path) if env_path else {}

    lan_ip = env.get('LAN_IP', '').strip()
    if not lan_ip:
        fail("LAN_IP not set in .env — can't reach the arrs.")
        return 1

    # Discover keys: .env first, then each arr's config.xml as fallback.
    # Same precedence fix-imports.sh uses (some keys are config.xml-only
    # until setup-arr-config.py's writeback step has run).
    install_dir = env.get('INSTALL_DIR') or os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))
    )
    sonarr_key = env.get('SONARR_API_KEY') or _extract_api_key(
        os.path.join(install_dir, 'sonarr', 'config', 'config.xml'))
    radarr_key = env.get('RADARR_API_KEY') or _extract_api_key(
        os.path.join(install_dir, 'radarr', 'config', 'config.xml'))
    lidarr_key = env.get('LIDARR_API_KEY') or _extract_api_key(
        os.path.join(install_dir, 'lidarr', 'config', 'config.xml'))

    print(f"\n{BOLD}╔{'═' * 44}╗")
    print(f"║  Auto Manual-Import Drainer                {' ':<2}║")
    print(f"╚{'═' * 44}╝{RESET}")
    print(f"  Sonarr: {('found ' + sonarr_key[:8] + '...') if sonarr_key else 'MISSING'}")
    print(f"  Radarr: {('found ' + radarr_key[:8] + '...') if radarr_key else 'MISSING'}")
    print(f"  Lidarr: {('found ' + lidarr_key[:8] + '...') if lidarr_key else 'MISSING'}")

    if _is_enabled(env, 'ENABLE_RADARR'):
        _drain_arr(
            "Radarr", f"http://{lan_ip}:49151", radarr_key,
            api_version="api/v3", media_field="movie",
            build_file_payload=_radarr_file_payload,
            include_query="&includeMovie=true",
        )
    else:
        section("Radarr"); skip("ENABLE_RADARR=false")

    if _is_enabled(env, 'ENABLE_SONARR'):
        _drain_arr(
            "Sonarr", f"http://{lan_ip}:49152", sonarr_key,
            api_version="api/v3", media_field="series",
            build_file_payload=_sonarr_file_payload,
            include_query="&includeSeries=true&includeEpisode=true",
        )
    else:
        section("Sonarr"); skip("ENABLE_SONARR=false")

    if _is_enabled(env, 'ENABLE_LIDARR'):
        _drain_arr(
            "Lidarr", f"http://{lan_ip}:49154", lidarr_key,
            api_version="api/v1", media_field="album",
            build_file_payload=_lidarr_file_payload,
            include_query="&includeArtist=true&includeAlbum=true",
        )
    else:
        section("Lidarr"); skip("ENABLE_LIDARR=false")

    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
