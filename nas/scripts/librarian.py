#!/usr/bin/env python3
"""
librarian.py — "where did my disk go, and what should I re-grab?"

The arrs each know, precisely, how many bytes every movie / series /
artist occupies and at what quality they grabbed it. Nobody ever puts
those three answers on one page, so the question "what is actually
eating my array?" turns into an evening of clicking through Radarr's
list view. This script answers it in one shot.

Two modes, one file:

  * CLI      `python3 librarian.py --report`   → text report on stdout
             `python3 librarian.py --json`     → the same data as JSON
    Runs on the NAS host, reaches the arrs on their published LAN ports.

  * Server   `python3 librarian.py` (no args)  → web UI on :8890
    Runs in the `librarian` container, reaches the arrs by container
    name on the `media` network. This is what the Homepage tile links
    to. Modelled on recyclarr-trigger.py: single-file bind mount, stdlib
    only, CSRF-guarded POST, single-flight lock.

Endpoint discovery handles both without being told which it is: every
arr gets a candidate list (container name first, then LAN_IP + the
published port, then loopback) and the first base that answers
system/status with our API key wins.

What it reports
  Disks             free / total per mount, straight from the arr's own
                    /diskspace — no host mount needed, and it reports
                    the mount the arr's root folder actually lives on.
  Libraries         per-arr totals: items, files, bytes, mean size.
  Unaccounted       disk used minus the sum of what the arrs claim.
                    This is the orphan detector — failed imports, stray
                    extras, half-deleted seasons, a download folder you
                    forgot was on the media volume.
  Top offenders     biggest items, with quality, codec and BYTES PER
                    HOUR. Raw size just finds long shows; bytes-per-hour
                    finds genuinely bloated files, which is what you
                    actually want when deciding what to re-grab smaller.
  Quality mix       bytes and counts grouped by quality tier. This is
                    the input for "what would I save by dropping my
                    Remux-2160p collection to Bluray-1080p".
  Upgrade backlog   each arr's cutoff-unmet count — items it already
                    wants to replace.
  Watch data        last-played / play-count per item when Tautulli
                    (Plex) or Jellyfin can supply it, which unlocks the
                    only view that really matters: big AND never
                    watched. Degrades silently to size-only.

Write mode is ON by default, so the page offers re-grab alongside the
report:

  Upgrade  set a higher quality profile on the selected items, then
           search. Nothing is deleted. Each existing file stays until a
           better release actually imports.
  Shrink   set a LOWER profile FIRST, then delete the current files
           through the arr, then search. The order is the whole point:
           search before the profile change and you re-grab the release
           you were trying to replace.

Set LIBRARIAN_ALLOW_ACTIONS=false to drop back to a read-only report.
Left off, this script issues nothing but GETs, so it cannot edit a
profile, trigger a search, or delete a file.

Either way nothing destructive happens on one click. A delete refuses
unless the arr has a Recycle Bin configured, every action is planned and
then confirmed against a single-use token, runs are capped, and what was
done (including deleted paths) is appended to an audit log.
"""

import argparse
import configparser
import html
import json
import os
import re
import secrets
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer

# ── Where things live ────────────────────────────────────────────────
#
# In the container the install dir is bind-mounted read-only at
# /install-dir (compose does this); on the host we're sitting in
# <install>/scripts/ next to the .env we need. _resolve_path walks the
# candidates in order and hands back the first that exists, falling
# back to the last so callers get a stable string to put in an error
# message rather than None.
CONTAINER_INSTALL_DIR = '/install-dir'

DEFAULT_PORT = 8890

# How long an analysis stays fresh before the next page load re-scans.
# A full pull is a handful of API calls plus one per series, so it's
# seconds — but not something to redo on every browser refresh.
CACHE_TTL_SECONDS = 600

# Series-detail fetches run concurrently. Eight is comfortable for a
# Synology-class box: enough to hide per-request latency on a 300-series
# library, not enough to make Sonarr's SQLite contend with itself.
DETAIL_WORKERS = 8

# Per-arr wiring: internal container name + port, the LAN port compose
# publishes, and the API version prefix. Keep in step with
# docker-compose.yml — these ports are asserted by post-deploy-validate.
ARRS = {
    'radarr': {
        'label': 'Movies (Radarr)',
        'internal': ('radarr', 7878),
        'lan_port': 49151,
        'api': 'v3',
        'env_key': 'RADARR_API_KEY',
        'enable_key': 'ENABLE_RADARR',
    },
    'sonarr': {
        'label': 'TV (Sonarr)',
        'internal': ('sonarr', 8989),
        'lan_port': 49152,
        'api': 'v3',
        'env_key': 'SONARR_API_KEY',
        'enable_key': 'ENABLE_SONARR',
    },
    'lidarr': {
        'label': 'Music (Lidarr)',
        'internal': ('lidarr', 8686),
        'lan_port': 49154,
        'api': 'v1',
        'env_key': 'LIDARR_API_KEY',
        'enable_key': 'ENABLE_LIDARR',
    },
}


def _resolve_path(*candidates):
    """First existing path, else the last candidate so the caller can
    put a concrete path in its error message."""
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return candidates[-1] if candidates else ''


def install_dir():
    """Root of the install (the dir holding scripts/, tautulli/, ...).

    Container: the read-only bind mount. Host: one level up from this
    script, since the wizard places helper scripts in <install>/scripts.
    """
    if os.path.isdir(CONTAINER_INSTALL_DIR):
        return CONTAINER_INSTALL_DIR
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(here) if os.path.basename(here) == 'scripts' else here


def env_file():
    root = install_dir()
    return _resolve_path(
        os.path.join(root, 'scripts', '.env'),   # v0.3.23+
        os.path.join(root, '.env'),              # legacy
    )


def read_env(path=None):
    """Parse .env into a dict. Deliberately forgiving: this file is
    hand-edited by users often enough that one malformed line must not
    take the whole report down. Strips `export ` prefixes, matching
    quotes, inline comments on unquoted values, and CRLF."""
    path = path or env_file()
    env = {}
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for raw in f:
                line = raw.strip().lstrip('﻿')
                if not line or line.startswith('#') or '=' not in line:
                    continue
                if line.startswith('export '):
                    line = line[len('export '):].lstrip()
                key, _, val = line.partition('=')
                key = key.strip()
                if not key:
                    continue
                val = val.strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                    val = val[1:-1]
                elif '#' in val:
                    # Unquoted value: an inline comment is a comment.
                    val = val.split('#', 1)[0].strip()
                env[key] = val
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f'librarian: could not read {path}: {e}', file=sys.stderr)
    return env


def is_enabled(env, key, default_on=True):
    """Truthiness with the stack's default-on / opt-in split. A MISSING
    key means "on" for the services that predate service selection and
    "off" for opt-in ones — same rule as is_enabled / is_optin_enabled
    in setup.sh, and getting it wrong here would just mean we probe an
    arr that isn't running and warn, so this is a nicety not a gate."""
    raw = (env.get(key) or '').strip().lower()
    if not raw:
        return default_on
    return raw in ('1', 'true', 'yes', 'on')


# ── HTTP ─────────────────────────────────────────────────────────────

def http_json(url, headers=None, timeout=20):
    """GET → parsed JSON, or None on any failure. Every caller treats a
    None as "this source isn't available" and carries on with a warning:
    a report that renders three of four libraries beats a traceback."""
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        # 401 is worth distinguishing — it's a wrong/stale API key, not
        # a down service, and the fix is completely different.
        detail = 'unauthorized (check the API key in .env)' if e.code == 401 else f'HTTP {e.code}'
        raise LibrarianSourceError(detail) from e
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise LibrarianSourceError(str(e)) from e


class LibrarianSourceError(Exception):
    """One data source failed. Never fatal — collected into report
    warnings so the page can say which panel is missing and why."""


def arr_headers(key):
    return {'X-Api-Key': key, 'Accept': 'application/json',
            'User-Agent': 'mediarr-librarian/1.0'}


def candidate_bases(spec, lan_ip):
    """Ordered guesses for one arr's base URL.

    Container name first: inside the `media` network that's the fast,
    always-correct answer. Then the LAN_IP + published port, which is
    how the CLI mode on the NAS host reaches it. Then loopback, for a
    host whose LAN_IP in .env has gone stale (DHCP moved it) — the
    published port is bound to LAN_IP so this only helps on some
    setups, but it costs one refused connection to try.
    """
    host, port = spec['internal']
    bases = [f'http://{host}:{port}']
    if lan_ip:
        bases.append(f'http://{lan_ip}:{spec["lan_port"]}')
    bases.append(f'http://127.0.0.1:{spec["lan_port"]}')
    return bases


def discover_base(spec, key, lan_ip):
    """First candidate base that answers system/status with our key.

    Probing beats configuring: the same file has to work from inside the
    docker network and from an SSH shell on the host, and asking the
    user to tell us which is a question we can answer ourselves in under
    a second."""
    last_err = None
    for base in candidate_bases(spec, lan_ip):
        url = f'{base}/api/{spec["api"]}/system/status'
        try:
            data = http_json(url, arr_headers(key), timeout=6)
            if isinstance(data, dict) and data.get('appName'):
                return base, None
            last_err = 'unexpected response from system/status'
        except LibrarianSourceError as e:
            last_err = str(e)
    return None, last_err


# ── Small helpers ────────────────────────────────────────────────────

def human_bytes(n):
    """1.4 TB, 940.2 GB, 512 B. Base-1024 with TB-style labels because
    that's what every NAS UI in this stack already shows."""
    try:
        n = float(n or 0)
    except (TypeError, ValueError):
        return '0 B'
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if abs(n) < 1024 or unit == 'TB':
            return f'{n:,.0f} {unit}' if unit == 'B' else f'{n:,.1f} {unit}'
        n /= 1024
    return f'{n:,.1f} TB'


def pct(part, whole):
    try:
        return (float(part) / float(whole)) * 100.0 if whole else 0.0
    except (TypeError, ValueError, ZeroDivisionError):
        return 0.0


def bytes_per_hour(size, minutes):
    """Bytes/hour, or None when we don't know the runtime.

    The headline number in the top-offenders table. A 90 GB 12-hour
    series is normal; a 90 GB 2-hour film is a remux you probably didn't
    mean to keep. Sorting by raw size only ever finds long things."""
    try:
        size = float(size or 0)
        minutes = float(minutes or 0)
    except (TypeError, ValueError):
        return None
    if size <= 0 or minutes <= 0:
        return None
    return size / (minutes / 60.0)


def fuzzy_score(query, text):
    """Score `text` against `query`. Returns (matched, score).

    A plain subsequence match on its own ranks terribly: searching "bat"
    would score "Batman" and "The Great British Bake Off" alike, because
    both contain b, a and t in order. So matches are weighted by how
    contiguous and how word-aligned they are, which is what makes a
    short query feel like it found the obvious thing.

    A multi-word query is AND across terms, each scored separately, so
    "remux 2160" finds Remux-2160p without caring about the order or
    what sits between them.

    Mirrored by fuzzyScore() in the page's JavaScript. Change one and
    change the other, or the same search ranks differently depending on
    whether you typed it into the CLI or the browser.
    """
    if not query:
        return True, 0
    text_l = str(text).lower()
    total = 0
    for term in str(query).lower().split():
        ok, s = _fuzzy_term(term, text_l)
        if not ok:
            return False, 0
        total += s
    return True, total


def _fuzzy_term(term, text_l):
    """One whitespace-free term against pre-lowercased text."""
    if not term:
        return True, 0

    # Contiguous substring is always the better match, and a hit at a
    # word boundary is better still: "man" should prefer "Man of Steel"
    # over "Batman".
    idx = text_l.find(term)
    if idx != -1:
        score = 1000 - min(idx, 100) * 2
        if idx == 0 or not text_l[idx - 1].isalnum():
            score += 60
        return True, score

    # Scattered subsequence. Reward consecutive characters and hits that
    # start a word, and penalise long gaps.
    pos = 0
    score = 0
    prev = -2
    for ch in term:
        found = text_l.find(ch, pos)
        if found == -1:
            return False, 0
        if found == prev + 1:
            score += 10
        if found == 0 or not text_l[found - 1].isalnum():
            score += 8
        score += max(0, 12 - (found - pos))
        prev = found
        pos = found + 1
    return True, score


def item_haystack(it):
    """The text a search runs against. Title carries most of the intent,
    but folding in quality, codec and the arr name means "sonarr remux"
    or "x265" work without a separate syntax for them."""
    return ' '.join(str(x) for x in (
        it.get('title', ''),
        it.get('year') or '',
        it.get('quality', ''),
        it.get('codec', ''),
        it.get('arr', ''),
        it.get('kind', ''),
    ) if x)


def filter_items(items, query='', min_size=0, quality='', unplayed=False, arr='',
                 min_rate=0):
    """Apply every filter, then sort by relevance when a query is given
    and by size when one isn't. Filters are AND, which is what people
    expect from a row of controls.

    min_rate is bytes per hour, and it's the one filter that finds a
    bloated remux of a 90-minute film. min_size can't: the film is
    smaller than any long series. An item with no runtime has no rate,
    so it can never clear a rate floor and drops out."""
    out = []
    for it in items:
        if min_size and (it.get('size') or 0) < min_size:
            continue
        if min_rate and (it.get('per_hour') or 0) < min_rate:
            continue
        if quality and quality.lower() not in (it.get('quality') or '').lower():
            continue
        if arr and it.get('arr') != arr:
            continue
        if unplayed and (it.get('plays') or 0) > 0:
            continue
        if query:
            ok, score = fuzzy_score(query, item_haystack(it))
            if not ok:
                continue
            out.append((score, it))
        else:
            out.append((0, it))
    if query:
        # Relevance first, size as the tie-break, so equally-good matches
        # still lead with the one worth acting on.
        out.sort(key=lambda p: (p[0], p[1].get('size') or 0), reverse=True)
    else:
        out.sort(key=lambda p: p[1].get('size') or 0, reverse=True)
    return [it for _, it in out]


def parse_size(text):
    """'500MB', '4.5 GB', '1t' -> bytes. Returns 0 on anything
    unparseable, so a typo widens the search rather than silently
    hiding everything."""
    if not text:
        return 0
    m = re.match(r'^\s*([\d.]+)\s*([kmgt]?)b?\s*$', str(text).lower())
    if not m:
        return 0
    try:
        n = float(m.group(1))
    except ValueError:
        return 0
    return int(n * {'': 1, 'k': 1024, 'm': 1024**2,
                    'g': 1024**3, 't': 1024**4}[m.group(2)])


def norm_title(s):
    """Loose title key for cross-app joins. Lowercase, drop everything
    that isn't alphanumeric or space, collapse runs of space. Plex,
    Jellyfin and the arrs each punctuate differently ("Marvel's Agents
    of S.H.I.E.L.D." vs "Marvels Agents of SHIELD")."""
    s = (s or '').lower()
    s = re.sub(r'[^a-z0-9 ]+', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def _iso_date(value):
    """Trim an arr/Jellyfin ISO timestamp to just the date. These come
    back in a few shapes (with Z, with microseconds, sometimes empty)
    and the report only ever shows the day."""
    if not value:
        return ''
    return str(value)[:10]


def _epoch_date(value):
    """Tautulli hands back unix seconds for last_played."""
    try:
        ts = int(value)
    except (TypeError, ValueError):
        return ''
    if ts <= 0:
        return ''
    return time.strftime('%Y-%m-%d', time.localtime(ts))


# ── Collectors ───────────────────────────────────────────────────────
#
# Each returns (items, extras, warning). `items` is a list of plain
# dicts with a shared shape so the aggregator and both renderers stay
# app-agnostic:
#
#   kind      'movie' | 'series' | 'artist'
#   title     display title
#   year      int or None
#   size      bytes on disk
#   files     file count
#   quality   quality tier name ('Bluray-1080p'), '' if mixed/unknown
#   codec     video codec where the arr exposes mediaInfo
#   minutes   total runtime, for the bytes-per-hour column
#   path      library path (used for the watch-data join)
#   added     ISO date the item entered the library
#   monitored bool
#   arr       'radarr' | 'sonarr' | 'lidarr' — which app owns it
#   id        that app's own id for the item
#   profile   its current quality-profile id
#
# `arr`, `id` and `profile` exist so an action can address the item
# later. The report alone never needs them.

def collect_radarr(base, key, api):
    """Radarr gives us everything in one call: /movie carries sizeOnDisk,
    the movieFile with its quality + mediaInfo, and runtime. No per-item
    follow-up needed, which is why movies are the cheapest library to
    report on."""
    data = http_json(f'{base}/api/{api}/movie', arr_headers(key), timeout=90)
    items, files = [], []
    for m in data or []:
        if not isinstance(m, dict):
            continue
        size = m.get('sizeOnDisk') or 0
        if not size:
            continue  # not downloaded yet — belongs in the wanted list, not here
        mf = m.get('movieFile') or {}
        mi = mf.get('mediaInfo') or {}
        quality = ((mf.get('quality') or {}).get('quality') or {}).get('name') or ''
        items.append({
            'kind': 'movie',
            'title': m.get('title') or '(untitled)',
            'year': m.get('year') or None,
            'size': size,
            'files': 1 if mf else 0,
            'quality': quality,
            'codec': mi.get('videoCodec') or '',
            'minutes': m.get('runtime') or 0,
            'path': mf.get('path') or m.get('path') or '',
            'added': _iso_date(m.get('added')),
            'monitored': bool(m.get('monitored')),
            'arr': 'radarr',
            'id': m.get('id'),
            'profile': m.get('qualityProfileId'),
            'fileId': mf.get('id'),
        })
        if mf.get('id') is not None:
            files.append({
                'arr': 'radarr', 'kind': 'movie',
                'file_id': mf['id'], 'item_id': m.get('id'),
                'item': m.get('title') or '(untitled)',
                'name': os.path.basename(mf.get('relativePath') or mf.get('path') or '')
                        or (m.get('title') or 'file'),
                'size': size, 'quality': quality,
                'codec': mi.get('videoCodec') or '',
                'path': mf.get('path') or '',
                # A movie has exactly one file, so there are no siblings
                # to compare it against. Bytes-per-hour already carries
                # the "is this bloated" signal for movies.
                'ratio': None,
            })
    return items, {'files': files}, None


def collect_sonarr(base, key, api, want_quality_detail=True):
    """Series totals come from /series (statistics.sizeOnDisk). Quality
    is per-EPISODE-FILE though, so a quality mix costs one
    /episodefile?seriesId=N call per series.

    That's the expensive part of the whole report, so it's behind a flag
    and runs in a small thread pool. The series list alone is enough for
    the overview and the top-offenders table; only the quality-mix panel
    needs the detail."""
    data = http_json(f'{base}/api/{api}/series', arr_headers(key), timeout=90)
    items = []
    id_by_index = []
    for s in data or []:
        if not isinstance(s, dict):
            continue
        stats = s.get('statistics') or {}
        size = stats.get('sizeOnDisk') or 0
        if not size:
            continue
        file_count = stats.get('episodeFileCount') or 0
        per_ep = s.get('runtime') or 0
        items.append({
            'kind': 'series',
            'title': s.get('title') or '(untitled)',
            'year': s.get('year') or None,
            'size': size,
            'files': file_count,
            'quality': '',            # filled in below when detail is on
            'codec': '',
            'minutes': per_ep * file_count if per_ep and file_count else 0,
            'path': s.get('path') or '',
            'added': _iso_date(s.get('added')),
            'monitored': bool(s.get('monitored')),
            'arr': 'sonarr',
            'id': s.get('id'),
            'profile': s.get('qualityProfileId'),
            'fileId': None,   # series own many files; resolved at action time
        })
        id_by_index.append(s.get('id'))

    quality_bytes, files = {}, []
    if want_quality_detail and items:
        quality_bytes, files = _sonarr_quality_mix(base, key, api, items, id_by_index)

    return items, {'quality_bytes': quality_bytes, 'files': files}, None


def _median(values):
    v = sorted(values)
    if not v:
        return 0
    mid = len(v) // 2
    return v[mid] if len(v) % 2 else (v[mid - 1] + v[mid]) / 2


def _sonarr_quality_mix(base, key, api, items, series_ids):
    """Bytes-by-quality across every episode file, a per-series dominant
    quality + codec written back onto `items`, and the individual file
    records.

    Keeping the files costs nothing extra: this pass already fetches
    every one of them to tally the quality mix, and used to discard them.
    Without them a series is a single row, so one bloated episode inside
    an otherwise sane show is invisible, and the only available remedy is
    deleting all of its files at once.

    Failures here are per-series and swallowed: one series whose files
    the API won't enumerate shouldn't cost us the other 299."""
    totals = {}
    all_files = []

    def one(idx_and_id):
        idx, sid = idx_and_id
        if sid is None:
            return None
        try:
            files = http_json(
                f'{base}/api/{api}/episodefile?seriesId={sid}',
                arr_headers(key), timeout=45)
        except LibrarianSourceError:
            return None
        local, codecs, recs = {}, {}, []
        for f in files or []:
            if not isinstance(f, dict):
                continue
            size = f.get('size') or 0
            q = ((f.get('quality') or {}).get('quality') or {}).get('name') or 'Unknown'
            local[q] = local.get(q, 0) + size
            codec = ((f.get('mediaInfo') or {}).get('videoCodec') or '')
            if codec:
                codecs[codec] = codecs.get(codec, 0) + 1
            if f.get('id') is None or not size:
                continue
            path = f.get('relativePath') or f.get('path') or ''
            recs.append({
                'arr': 'sonarr', 'kind': 'episode',
                'file_id': f['id'], 'item_id': sid,
                'name': os.path.basename(path) or f'file {f["id"]}',
                'size': size, 'quality': q, 'codec': codec,
                'path': f.get('path') or '',
            })
        return idx, local, codecs, recs

    with ThreadPoolExecutor(max_workers=DETAIL_WORKERS) as pool:
        for result in pool.map(one, list(enumerate(series_ids))):
            if not result:
                continue
            idx, local, codecs, recs = result
            for q, b in local.items():
                totals[q] = totals.get(q, 0) + b
            if local:
                # "Dominant" = the tier holding the most bytes. A series
                # part-upgraded to 2160p reads as 2160p once most of it
                # is, which is the honest summary for a one-line cell.
                items[idx]['quality'] = max(local.items(), key=lambda kv: kv[1])[0]
            if codecs:
                items[idx]['codec'] = max(codecs.items(), key=lambda kv: kv[1])[0]

            # Ratio against the series' own median. This is the signal
            # that finds the odd episode somebody grabbed as a remux:
            # "40 GB" means nothing on its own, "6x the rest of this
            # show" is immediately actionable.
            med = _median([r['size'] for r in recs])
            for r in recs:
                r['item'] = items[idx]['title']
                r['ratio'] = round(r['size'] / med, 1) if med else None
            all_files.extend(recs)
    return totals, all_files


def collect_lidarr(base, key, api):
    """Artists only. Per-track quality exists but a bytes-by-quality
    chart of a music library is noise — the actionable music question is
    "which artists are huge", and that's artist-level."""
    data = http_json(f'{base}/api/{api}/artist', arr_headers(key), timeout=90)
    items = []
    for a in data or []:
        if not isinstance(a, dict):
            continue
        stats = a.get('statistics') or {}
        size = stats.get('sizeOnDisk') or 0
        if not size:
            continue
        items.append({
            'kind': 'artist',
            'title': a.get('artistName') or '(unknown artist)',
            'year': None,
            'size': size,
            'files': stats.get('trackFileCount') or 0,
            'quality': '',
            'codec': '',
            'minutes': 0,       # Lidarr doesn't total runtime per artist
            'path': a.get('path') or '',
            'added': _iso_date(a.get('added')),
            'monitored': bool(a.get('monitored')),
            'arr': 'lidarr',
            'id': a.get('id'),
            'profile': a.get('qualityProfileId'),
            'fileId': None,
        })
    return items, {}, None


def collect_diskspace(base, key, api):
    """/diskspace as the arr sees it. Using the arr's own view (rather
    than a df on a mount we'd have to bind in) means we get exactly the
    filesystem its root folder sits on, and librarian needs no access to
    the media volume at all."""
    data = http_json(f'{base}/api/{api}/diskspace', arr_headers(key), timeout=20)

    # DEDUPLICATE BY FILESYSTEM. /diskspace lists every mount point the
    # container can see, and several of them are routinely the SAME
    # underlying filesystem: /data and /data/Media are one volume, and a
    # bind mount shows up alongside the path it was mounted from. Each
    # entry then reports that volume's full size, so summing them counts
    # one array two or three times — which is how a 38 TB NAS reports
    # more used space than it physically has.
    #
    # The API exposes no device id, so identical totalSpace AND
    # freeSpace is the available signal. Two genuinely separate disks
    # agreeing on both, to the byte, is vanishingly unlikely, and if it
    # ever happened the result would be a slight UNDER-count rather than
    # the impossible over-count this replaces.
    #
    # The shortest path wins, because that's the mount root rather than
    # something nested inside it.
    by_fs = {}
    for d in data or []:
        if not isinstance(d, dict):
            continue
        total = d.get('totalSpace') or 0
        free = d.get('freeSpace') or 0
        if not total:
            continue
        path = d.get('path') or '?'
        fs_key = (total, free)
        prev = by_fs.get(fs_key)
        if prev and len(prev['path']) <= len(path):
            continue
        by_fs[fs_key] = {
            'path': path,
            'label': d.get('label') or '',
            'total': total,
            'free': free,
            'used': max(total - free, 0),
        }
    return sorted(by_fs.values(), key=lambda d: d['path'])


def collect_rootfolders(base, key, api):
    """The paths the arr actually stores media under.

    Needed to tell a media mount from a config mount in /diskspace:
    Radarr happily reports both `/data` and `/config`, and folding the
    config volume into "used space" would inflate the unaccounted figure
    by the size of an entirely unrelated filesystem."""
    data = http_json(f'{base}/api/{api}/rootfolder', arr_headers(key), timeout=20)
    return [d.get('path') for d in (data or []) if isinstance(d, dict) and d.get('path')]


def collect_cutoff_unmet(base, key, api):
    """Count of items the arr already wants to replace — its own opinion
    on what needs upgrading, free with a pageSize=1 call."""
    data = http_json(
        f'{base}/api/{api}/wanted/cutoff?page=1&pageSize=1',
        arr_headers(key), timeout=30)
    if isinstance(data, dict):
        return data.get('totalRecords') or 0
    return 0


# ── Re-grab actions ──────────────────────────────────────────────────
#
# Everything above this line reads. Everything below can change your
# library, so the guard rails matter more than the features.
#
# Actions are ON by default, and still carry their own flag separately
# from ENABLE_LIBRARIAN. This web UI has no authentication, so anyone
# who can reach the port can use whatever it exposes. Keeping the switch
# separate is what lets a LAN you don't fully trust drop back to a
# read-only report with LIBRARIAN_ALLOW_ACTIONS=false, without giving up
# the report itself.
#
# What keeps the default safe, in order:
#   * a delete refuses outright unless the arr has a Recycle Bin path
#     configured, so anything removed is recoverable
#   * every action is planned first and applied second, against a
#     single-use token, so nothing happens without someone seeing the
#     exact list
#   * a per-run cap bounds the blast radius of one mistake
#   * every applied action is appended to an audit log with the paths
#     that were deleted, which is what makes a restore possible

ACTION_TOKENS = {}
ACTION_TOKEN_TTL = 600
_ACTION_LOCK = threading.Lock()

DEFAULT_MAX_BATCH = 25


def actions_enabled(env):
    """Default ON, off only for an explicit false / 0 / no / off. This
    follows the default-on `is_enabled` convention the rest of the stack
    uses for ENABLE_* flags, NOT the explicit-true opt-in rule that gates
    ENABLE_LIBRARIAN itself. Keep the disabled set in step with
    ENABLE_DISABLED_VALUES in env-render.ts and is_enabled in
    setup-arr-config.py, or the wizard and the page disagree about
    whether the delete button exists."""
    return (env.get('LIBRARIAN_ALLOW_ACTIONS') or '').strip().lower() not in (
        'false', '0', 'no', 'off')


def max_batch(env):
    try:
        n = int((env.get('LIBRARIAN_MAX_BATCH') or '').strip())
        return n if n > 0 else DEFAULT_MAX_BATCH
    except (TypeError, ValueError):
        return DEFAULT_MAX_BATCH


def state_dir():
    """Somewhere writable for the audit log. The install dir is mounted
    read-only on purpose, so compose supplies a narrow writable mount at
    /state; on the host we fall back to <install>/librarian."""
    if os.path.isdir('/state'):
        return '/state'
    d = os.path.join(install_dir(), 'librarian')
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        return ''
    return d


def audit(entry):
    """Append one JSON line to the audit log. Best effort: failing to
    write the log must not abort an action that already half-happened,
    but it is reported so a silent loss of the record is visible."""
    d = state_dir()
    if not d:
        return 'no writable state directory — action not logged'
    try:
        with open(os.path.join(d, 'actions.log'), 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry, default=str) + '\n')
        return ''
    except OSError as e:
        return f'could not write audit log: {e}'


def arr_request(base, key, path, method='GET', data=None, timeout=60):
    """A write-capable sibling of http_json. Separate so every mutating
    call is visibly a different function from the read path."""
    body = json.dumps(data).encode() if data is not None else None
    headers = dict(arr_headers(key))
    if body is not None:
        # urllib labels an unlabelled body application/x-www-form-urlencoded,
        # and the arrs' [FromBody] binder answers that with 415 Unsupported
        # Media Type before it ever looks at the payload. Every mutating call
        # here sends JSON, so say so. Without this line PUT /movie/editor
        # fails on the first step of both Upgrade and Shrink.
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(f'{base}{path}', data=body,
                                 headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return {}
            try:
                return json.loads(raw)
            except ValueError:
                return {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')[:200]
        raise LibrarianSourceError(f'HTTP {e.code} on {method} {path}: {detail}')
    except (urllib.error.URLError, OSError) as e:
        raise LibrarianSourceError(f'{method} {path} failed: {e}')


def collect_quality_profiles(base, key, api):
    """[{id, name}] for the profile pickers."""
    data = http_json(f'{base}/api/{api}/qualityprofile', arr_headers(key), timeout=30)
    return [{'id': p.get('id'), 'name': p.get('name'), 'rank': profile_rank(p)}
            for p in (data or []) if isinstance(p, dict) and p.get('id') is not None]


def profile_rank(profile):
    """How good a profile is allowed to get, as an index into the arr's own
    quality ordering (worst first). Returns -1 when it can't be worked out.

    This is what lets one button decide between upgrading and shrinking:
    compare the item's current profile against the target and the direction
    falls out. It's comparable across profiles because every profile in an
    app lists the SAME qualities in the SAME order, and only the `allowed`
    flags differ. Groups nest, and a group being allowed carries down to
    the qualities inside it.

    A profile whose rank can't be read ranks -1, which reads as "no lower
    than anything" and so never triggers a delete. Guessing wrong in that
    direction costs a re-download; guessing wrong the other way costs the
    file."""
    best = [-1]
    idx = [0]

    def walk(items, inherited=False):
        for entry in items or []:
            if not isinstance(entry, dict):
                continue
            allowed = bool(entry.get('allowed')) or inherited
            kids = entry.get('items') or []
            if kids:
                walk(kids, allowed)
            else:
                if allowed:
                    best[0] = max(best[0], idx[0])
                idx[0] += 1

    walk(profile.get('items'))
    return best[0]


def recycle_config(base, key, api):
    """The arr's Recycle Bin path and how long it keeps things.

    Two settings answering one question: where deleted files go, and when
    they stop existing. cleanup_days of 0 means the arr never clears it
    on its own, which is a patient way to fill a disk."""
    data = http_json(f'{base}/api/{api}/config/mediamanagement',
                     arr_headers(key), timeout=30)
    if not isinstance(data, dict):
        return {'path': '', 'cleanup_days': 0}
    try:
        days = int(data.get('recycleBinCleanupDays') or 0)
    except (TypeError, ValueError):
        days = 0
    return {'path': (data.get('recycleBin') or '').strip(), 'cleanup_days': days}


def recycle_bin_path(base, key, api):
    """Just the path. The delete guards only care whether one is set at
    all: it's the difference between a delete you can undo and one you
    cannot, because deleting through the arr's API moves the file here
    rather than unlinking it."""
    return recycle_config(base, key, api)['path']


# Where compose bind-mounts ${DATA_ROOT}/.recycle for us. The arrs see the
# same tree as /data/.recycle, so only the last segment carries across.
CONTAINER_RECYCLE_DIR = '/recycle'


def _contained(path, root):
    """True when path resolves inside root. This is the guard that keeps
    an unexpected recycleBin value from turning a purge into something
    much worse, so it resolves symlinks before comparing."""
    try:
        real_root = os.path.realpath(root)
        real = os.path.realpath(path)
    except OSError:
        return False
    return real == real_root or real.startswith(real_root + os.sep)


def recycle_local_path(bin_path, env):
    """Where THIS process can reach that recycle bin, or '' if it can't.

    The arrs report a path in their own namespace (/data/.recycle/sonarr).
    In the container we see the same tree at /recycle; on the host the CLI
    resolves it under DATA_ROOT instead. Anything that doesn't land inside
    a directory we actually hold is reported unreadable rather than
    guessed at, because the next thing someone does with this path is
    delete what's under it."""
    name = os.path.basename((bin_path or '').rstrip('/'))
    if not name or name in ('.', '..'):
        return ''
    for root in (CONTAINER_RECYCLE_DIR,
                 os.path.join((env.get('DATA_ROOT') or '').strip(), '.recycle')
                 if (env.get('DATA_ROOT') or '').strip() else ''):
        if not root or not os.path.isdir(root):
            continue
        local = os.path.join(root, name)
        if os.path.isdir(local) and _contained(local, root):
            return local
    return ''


def recycle_host_path(bin_path, env):
    """The path as it reads on the NAS. The arrs see DATA_ROOT as /data;
    nobody typing into an SSH session does."""
    root = (env.get('DATA_ROOT') or '').strip().rstrip('/')
    if root and bin_path.startswith('/data/'):
        return root + bin_path[len('/data'):]
    return bin_path


def recycle_usage(local_path):
    """(bytes, files) under local_path. lstat, and never follow a link
    out: a symlink's target is somebody else's disk usage, not ours."""
    total = files = 0
    for dirpath, _dirnames, filenames in os.walk(local_path, followlinks=False):
        for fn in filenames:
            try:
                total += os.lstat(os.path.join(dirpath, fn)).st_size
                files += 1
            except OSError:
                pass
    return total, files


def purge_dir(root):
    """Delete everything INSIDE root and leave root itself standing.

    Leaving the directory matters: the arrs validate that the recycleBin
    path exists and is writable by their own user, and reject the WHOLE
    media-management update if it isn't. Removing it here would break the
    next wizard run in a way that looks nothing like this function.

    Returns (files, bytes, errors). Symlinks are unlinked, never followed.
    """
    freed = files = 0
    errors = []
    try:
        entries = list(os.scandir(root))
    except OSError as e:
        return 0, 0, [f'{root}: {e}']
    for entry in entries:
        try:
            if entry.is_symlink():
                os.unlink(entry.path)
                files += 1
            elif entry.is_dir(follow_symlinks=False):
                sub_bytes, sub_files = recycle_usage(entry.path)
                shutil.rmtree(entry.path)
                freed += sub_bytes
                files += sub_files
            else:
                freed += entry.stat(follow_symlinks=False).st_size
                os.unlink(entry.path)
                files += 1
        except OSError as e:
            errors.append(f'{entry.name}: {e}')
    return files, freed, errors


# Per-arr action wiring. Kept as data so the plan/apply code doesn't
# grow a branch per app.
ACTION_SPEC = {
    'radarr': {
        'editor': '/movie/editor', 'ids_field': 'movieIds',
        'search_cmd': 'MoviesSearch', 'search_ids': 'movieIds',
        'search_one': None,
        'files': lambda i: f'/moviefile?movieId={i}',
        'delete_file': lambda f: f'/moviefile/{f}',
        'can_shrink': True,
    },
    'sonarr': {
        'editor': '/series/editor', 'ids_field': 'seriesIds',
        'search_cmd': 'SeriesSearch', 'search_ids': None,  # one call per series
        'search_one': 'seriesId',
        'files': lambda i: f'/episodefile?seriesId={i}',
        'delete_file': lambda f: f'/episodefile/{f}',
        'can_shrink': True,
    },
    'lidarr': {
        'editor': '/artist/editor', 'ids_field': 'artistIds',
        'search_cmd': 'ArtistSearch', 'search_ids': None,
        'search_one': 'artistId',
        'files': lambda i: f'/trackfile?artistId={i}',
        'delete_file': lambda f: f'/trackfile/{f}',
        # Shrinking an artist means deleting every track file they own,
        # which is a far blunter action than shrinking one film. Upgrade
        # works; shrink is refused rather than made easy to fire.
        'can_shrink': False,
    },
}


def build_plan(report, env, arr_name, profile_id, item_ids):
    """Work out exactly what changing quality would do, without doing it.

    There is no "upgrade" or "shrink" to choose between any more. You pick
    the profile you want and the direction falls out of the comparison,
    per item: anything currently ABOVE the target needs its files deleted
    before the search, or the arr just re-grabs what you were replacing.
    Anything at or below it only needs the profile change, because an arr
    replaces a file with a better one on its own.

    That also means one selection can go both ways at once, and this is
    where that's resolved rather than being pushed back onto the user as
    two buttons they have to choose between correctly.

    Returns a plan dict. Raises LibrarianSourceError with a plain-English
    reason when the action isn't allowed, which the UI shows verbatim.
    """
    if not actions_enabled(env):
        raise LibrarianSourceError(
            'Actions are turned off. LIBRARIAN_ALLOW_ACTIONS is set to false '
            'in .env — set it back to true (or untick "read-only" in the '
            'installer and re-run) to enable them.')

    spec = ACTION_SPEC.get(arr_name)
    conn = (report.get('connections') or {}).get(arr_name)
    if not spec or not conn:
        raise LibrarianSourceError(f'{arr_name} is not reachable right now')

    cap = max_batch(env)
    wanted = set(item_ids)
    items = [i for i in report['items']
             if i.get('arr') == arr_name and i.get('id') in wanted]
    if not items:
        raise LibrarianSourceError('None of the selected items were found in the current scan')
    if len(items) > cap:
        raise LibrarianSourceError(
            f'{len(items)} items selected but the per-run cap is {cap}. '
            'Do it in smaller batches, or raise LIBRARIAN_MAX_BATCH.')

    profiles = conn.get('profiles') or []
    target = next((p for p in profiles if p['id'] == profile_id), None)
    if not target:
        raise LibrarianSourceError('That quality profile no longer exists')
    rank_of = {p['id']: p.get('rank', -1) for p in profiles}
    target_rank = target.get('rank', -1)

    # Direction, per item. An unknown current profile ranks -1 and so never
    # reads as "above the target": the fallback is always the path that
    # doesn't delete anything.
    entries = []
    for i in items:
        current = rank_of.get(i.get('profile'), -1)
        down = (target_rank >= 0 and current >= 0 and current > target_rank)
        entries.append({
            'id': i['id'], 'title': i['title'], 'year': i.get('year'),
            'size': i.get('size') or 0, 'quality': i.get('quality') or '',
            'path': i.get('path') or '',
            'direction': 'down' if down else 'up',
        })
    down_items = [e for e in entries if e['direction'] == 'down']

    if down_items and not spec['can_shrink']:
        raise LibrarianSourceError(
            f'That profile is lower than what {len(down_items)} of the selected '
            f'item(s) use, and shrinking is not offered for {arr_name}: it would '
            'mean deleting every file the item owns, which is too blunt to put '
            'behind one button. Pick a profile that is not a downgrade, or '
            'change it in the app.')

    plan = {
        'mode': 'apply',
        'arr': arr_name,
        'label': ARRS[arr_name]['label'],
        'profile_id': profile_id,
        'profile_name': target['name'],
        'items': entries,
        'down_ids': [e['id'] for e in down_items],
        'total_size': sum(e['size'] for e in entries),
        'down_size': sum(e['size'] for e in down_items),
        'deletes_files': bool(down_items),
        'recycle_bin': '',
        'steps': [],
    }

    up_count = len(entries) - len(down_items)
    if not down_items:
        plan['steps'] = [
            f'Set the quality profile of {len(entries)} item(s) to "{target["name"]}".',
            'Trigger a search for each one.',
            'Nothing is deleted. This profile is not lower than what any of '
            'them use, so each existing file stays until a better release '
            'actually imports.',
        ]
    else:
        bin_path = recycle_bin_path(conn['base'], conn['key'], conn['api'])
        plan['recycle_bin'] = bin_path
        if not bin_path:
            raise LibrarianSourceError(
                'Refusing to delete: this app has no Recycle Bin configured, so '
                'the files would be gone for good. Set one in Settings → Media '
                'Management → Recycle Bin, then try again.')
        plan['steps'] = [
            f'Set the quality profile of {len(entries)} item(s) to '
            f'"{target["name"]}" FIRST.',
            f'Delete the current files of the {len(down_items)} item(s) already '
            f'above that profile, which the Recycle Bin at {bin_path} will catch.',
        ]
        if up_count:
            plan['steps'].append(
                f'Leave the other {up_count} item(s) alone. They are at or below '
                'the target, so the arr replaces them on its own when something '
                'better shows up.')
        plan['steps'] += [
            'Trigger a search under the new profile.',
            'Order matters: profile first, or the search re-grabs the same '
            'release you are replacing. Anything that lost a file is '
            'unavailable until a new release imports.',
        ]
    return plan


def build_file_plan(report, env, arr_name, file_ids):
    """Plan a REPLACE of specific files.

    Distinct from shrink, which works on whole items and changes the
    quality profile. This one is surgical: delete these exact files and
    search for just what they covered, at the profile already set. It
    exists because the common real case is one bad file — somebody
    hand-grabbed a remux into an otherwise 1080p show — and the item-level
    remedy for that is deleting all sixty of the show's files.
    """
    if not actions_enabled(env):
        raise LibrarianSourceError(
            'Actions are turned off. LIBRARIAN_ALLOW_ACTIONS is set to false '
            'in .env — set it back to true (or untick "read-only" in the '
            'installer and re-run) to enable them.')

    spec = ACTION_SPEC.get(arr_name)
    conn = (report.get('connections') or {}).get(arr_name)
    if not spec or not conn:
        raise LibrarianSourceError(f'{arr_name} is not reachable right now')

    wanted = set(file_ids)
    files = [f for f in report.get('files') or []
             if f.get('arr') == arr_name and f.get('file_id') in wanted]
    if not files:
        raise LibrarianSourceError('None of the selected files were found in the current scan')

    cap = max_batch(env)
    if len(files) > cap:
        raise LibrarianSourceError(
            f'{len(files)} files selected but the per-run cap is {cap}. '
            'Do it in smaller batches, or raise LIBRARIAN_MAX_BATCH.')

    bin_path = recycle_bin_path(conn['base'], conn['key'], conn['api'])
    if not bin_path:
        raise LibrarianSourceError(
            'Refusing to delete: this app has no Recycle Bin configured, so '
            'the files would be gone for good. Set one in Settings → Media '
            'Management → Recycle Bin, then try again.')

    return {
        'mode': 'replace',
        'arr': arr_name,
        'label': ARRS[arr_name]['label'],
        'profile_id': None,
        'profile_name': 'unchanged',
        'deletes_files': True,
        'recycle_bin': bin_path,
        'files': [{'file_id': f['file_id'], 'item_id': f['item_id'],
                   'label': f.get('label') or f['name'], 'size': f['size'],
                   'quality': f.get('quality') or '', 'ratio': f.get('ratio'),
                   'path': f.get('path') or ''} for f in files],
        'items': [],
        'total_size': sum(f['size'] for f in files),
        'steps': [
            f'Delete {len(files)} file(s), which the Recycle Bin at {bin_path} will catch.',
            'Search for exactly what those files covered, and nothing else.',
            'The quality profile is left alone: this replaces a specific bad '
            'file rather than re-grading the whole item. Each file is missing '
            'until its replacement imports.',
        ],
    }


def execute_file_plan(report, env, plan):
    """Apply a replace plan. Per file, so one failure strands nothing."""
    arr_name = plan['arr']
    spec = ACTION_SPEC[arr_name]
    conn = report['connections'][arr_name]
    base, key, api = conn['base'], conn['key'], conn['api']
    pre = f'/api/{api}'
    results = {'ok': [], 'failed': [], 'deleted_files': 0, 'notes': []}

    # Sonarr needs episode ids to run a targeted search, and the mapping
    # from file to episodes only exists WHILE the file does. Build it
    # before deleting anything, or the search afterwards has nothing to
    # aim at and the only fallback is re-searching the entire series.
    episodes_for = {}
    if arr_name == 'sonarr':
        for series_id in {f['item_id'] for f in plan['files']}:
            try:
                eps = http_json(f'{base}{pre}/episode?seriesId={series_id}',
                                arr_headers(key), timeout=60) or []
            except LibrarianSourceError as e:
                results['failed'].append(f'could not list episodes for series {series_id}: {e}')
                continue
            for ep in eps:
                if not isinstance(ep, dict) or ep.get('episodeFileId') in (None, 0):
                    continue
                episodes_for.setdefault(ep['episodeFileId'], []).append(ep.get('id'))

    search_eps, search_movies = [], set()
    for f in plan['files']:
        try:
            arr_request(base, key, f'{pre}{spec["delete_file"](f["file_id"])}', 'DELETE')
            results['deleted_files'] += 1
            results['ok'].append(f['label'])
            if arr_name == 'sonarr':
                search_eps.extend(e for e in episodes_for.get(f['file_id'], []) if e)
            else:
                search_movies.add(f['item_id'])
            note = audit({
                'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
                'action': 'replace-file',
                'arr': arr_name,
                'file': f['label'],
                'file_id': f['file_id'],
                'size': f['size'],
                'recycle_bin': plan['recycle_bin'],
                'deleted_path': f.get('path') or '',
            })
            if note:
                results['notes'].append(note)
        except LibrarianSourceError as e:
            results['failed'].append(f'{f["label"]}: {e}')

    # Targeted search, once, for everything that just lost a file.
    try:
        if arr_name == 'sonarr' and search_eps:
            arr_request(base, key, f'{pre}/command', 'POST',
                        {'name': 'EpisodeSearch', 'episodeIds': search_eps})
        elif search_movies:
            arr_request(base, key, f'{pre}/command', 'POST',
                        {'name': spec['search_cmd'],
                         spec['search_ids']: sorted(search_movies)})
        elif arr_name == 'sonarr' and results['deleted_files']:
            results['notes'].append(
                'Files were deleted but no episode ids resolved, so no search '
                'was triggered. Run a season search in Sonarr to refill them.')
    except LibrarianSourceError as e:
        results['failed'].append(f'search: {e}')

    return results


def build_empty_plan(report, env):
    """Plan for emptying the recycle bins.

    The odd one out among the actions: it touches the filesystem directly
    rather than going through an arr, because no arr exposes "purge the
    bin now" — their own cleanup only removes what's already older than
    recycleBinCleanupDays. It's also the only delete here that is truly
    final, since the recycle bin IS the safety net."""
    if not actions_enabled(env):
        raise LibrarianSourceError(
            'Actions are turned off. LIBRARIAN_ALLOW_ACTIONS is set to false '
            'in .env — set it back to true to enable them.')
    entries = [r for r in (report.get('recycle') or [])
               if r.get('readable') and r.get('files')]
    if not entries:
        unreadable = [r for r in (report.get('recycle') or [])
                      if r.get('path') and not r.get('readable')]
        if unreadable:
            raise LibrarianSourceError(
                "The recycle bins aren't reachable from here. Compose mounts "
                '${DATA_ROOT}/.recycle at /recycle for this; re-run the wizard '
                'so the container picks the mount up.')
        raise LibrarianSourceError('The recycle bins are already empty.')
    total = sum(e['bytes'] for e in entries)
    return {
        'mode': 'empty',
        'arr': '',
        'label': 'Recycle bins',
        'profile_id': 0,
        'profile_name': '',
        'items': [],
        'files': [],
        'recycle': entries,
        'recycle_bin': ', '.join(e['host_path'] for e in entries),
        'total_size': total,
        'deletes_files': True,
        'steps': [
            f'Permanently delete {sum(e["files"] for e in entries):,} file(s) '
            f'from {len(entries)} recycle bin(s), freeing '
            f'{human_bytes(total)}.',
            'Leave the bin folders themselves in place, because the arrs '
            'refuse their whole media-management config if the path is gone.',
            'Write what was removed to the audit log.',
        ],
    }


def execute_empty_plan(report, env, plan):
    """Empty the bins listed in the plan. Each is independent, so one
    unwritable bin doesn't strand the rest."""
    results = {'ok': [], 'failed': [], 'deleted_files': 0, 'notes': []}
    for entry in plan['recycle']:
        local = recycle_local_path(entry['path'], env)
        if not local:
            results['failed'].append(
                f'{entry["label"]}: recycle bin is no longer reachable')
            continue
        files, freed, errors = purge_dir(local)
        results['deleted_files'] += files
        for e in errors:
            results['failed'].append(f'{entry["label"]}: {e}')
        if files:
            results['ok'].append(
                f'{entry["label"]} — {files:,} file(s), {human_bytes(freed)}')
        note = audit({
            'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'action': 'empty-recycle-bin',
            'arr': entry['arr'],
            'recycle_bin': entry['host_path'],
            'deleted_files': files,
            'freed_bytes': freed,
            'errors': errors,
        })
        if note:
            results['notes'].append(note)
    if not results['ok'] and not results['failed']:
        results['notes'].append('Nothing was there to remove.')
    return results


def execute_plan(report, env, plan):
    """Apply a plan that was already built and confirmed. Returns a
    result dict. Each item is handled independently, so one failure
    doesn't strand the rest half-done."""
    arr_name = plan['arr']
    spec = ACTION_SPEC[arr_name]
    conn = report['connections'][arr_name]
    base, key, api = conn['base'], conn['key'], conn['api']
    pre = f'/api/{api}'
    ids = [i['id'] for i in plan['items']]
    results = {'ok': [], 'failed': [], 'deleted_files': 0, 'notes': []}

    # 1. Profile first, always. On a shrink this is what stops the
    #    search that follows re-grabbing the release being replaced.
    try:
        arr_request(base, key, f'{pre}{spec["editor"]}', 'PUT',
                    {spec['ids_field']: ids, 'qualityProfileId': plan['profile_id']})
    except LibrarianSourceError as e:
        results['failed'].append(f'Could not set the quality profile: {e}')
        return results

    # 2. Delete only what the target profile is actually a downgrade for,
    #    and only through the arr so the Recycle Bin applies. Items at or
    #    below the target keep their files: the arr swaps those out by
    #    itself once something better lands.
    if plan['deletes_files']:
        down = set(plan.get('down_ids') or [])
        for item in plan['items']:
            if item['id'] not in down:
                continue
            try:
                files = http_json(f'{base}{pre}{spec["files"](item["id"])}',
                                  arr_headers(key), timeout=60) or []
                paths = [f.get('path') for f in files if isinstance(f, dict)]
                for f in files:
                    if not isinstance(f, dict) or f.get('id') is None:
                        continue
                    arr_request(base, key, f'{pre}{spec["delete_file"](f["id"])}', 'DELETE')
                    results['deleted_files'] += 1
                note = audit({
                    'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
                    'action': 'shrink-delete',
                    'arr': arr_name,
                    'item': item['title'],
                    'item_id': item['id'],
                    'new_profile': plan['profile_name'],
                    'recycle_bin': plan['recycle_bin'],
                    'deleted_paths': paths,
                })
                if note:
                    results['notes'].append(note)
            except LibrarianSourceError as e:
                results['failed'].append(f'{item["title"]}: {e}')
                continue

    # 3. Search last.
    for item in plan['items']:
        try:
            if spec['search_ids']:
                continue  # this arr takes every id in one call, done below
            arr_request(base, key, f'{pre}/command', 'POST',
                        {'name': spec['search_cmd'], spec['search_one']: item['id']})
            results['ok'].append(item['title'])
        except LibrarianSourceError as e:
            results['failed'].append(f'search for {item["title"]}: {e}')
    if spec['search_ids']:
        try:
            arr_request(base, key, f'{pre}/command', 'POST',
                        {'name': spec['search_cmd'], spec['search_ids']: ids})
            results['ok'].extend(i['title'] for i in plan['items'])
        except LibrarianSourceError as e:
            results['failed'].append(f'search: {e}')

    note = audit({
        'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'action': plan['mode'],
        'arr': arr_name,
        'profile': plan['profile_name'],
        'items': [i['title'] for i in plan['items']],
        'ok': len(results['ok']),
        'failed': len(results['failed']),
    })
    if note:
        results['notes'].append(note)
    return results


# ── Watch data (optional) ────────────────────────────────────────────

def tautulli_watch_map(env, lan_ip):
    """{join key → {last_played, plays}} from Tautulli.

    The API key lives in Tautulli's own config.ini under [General], which
    we can read because the install dir is mounted. Movies join on the
    file's basename (the one string Plex and Radarr are guaranteed to
    agree on, whatever their respective path prefixes are); series join
    on a normalised title.
    """
    ini = os.path.join(install_dir(), 'tautulli', 'config', 'config.ini')
    if not os.path.exists(ini):
        raise LibrarianSourceError('Tautulli config.ini not found (is Tautulli enabled?)')

    cp = configparser.ConfigParser(interpolation=None)
    cp.optionxform = str
    try:
        cp.read(ini)
    except Exception as e:
        raise LibrarianSourceError(f'could not parse Tautulli config.ini: {e}')

    key = ''
    for section in ('General', 'general'):
        if cp.has_section(section):
            key = (cp[section].get('api_key') or '').strip()
            if key:
                break
    if not key:
        raise LibrarianSourceError(
            'Tautulli has no api_key yet — open Tautulli once to finish setup')

    bases = ['http://tautulli:8181']
    if lan_ip:
        bases.append(f'http://{lan_ip}:8181')
    bases.append('http://127.0.0.1:8181')

    libraries, base_ok = None, None
    last_err = 'no Tautulli endpoint answered'
    for base in bases:
        try:
            resp = http_json(
                f'{base}/api/v2?apikey={urllib.parse.quote(key)}&cmd=get_libraries',
                timeout=15)
            libraries = ((resp or {}).get('response') or {}).get('data') or []
            base_ok = base
            break
        except LibrarianSourceError as e:
            last_err = str(e)
    if base_ok is None:
        raise LibrarianSourceError(last_err)

    watch = {}
    for lib in libraries:
        if not isinstance(lib, dict):
            continue
        section_id = lib.get('section_id')
        section_type = (lib.get('section_type') or '').lower()
        if section_id is None or section_type not in ('movie', 'show'):
            continue
        params = urllib.parse.urlencode({
            'apikey': key,
            'cmd': 'get_library_media_info',
            'section_id': section_id,
            'length': 10000,
            'refresh': 'false',
        })
        try:
            resp = http_json(f'{base_ok}/api/v2?{params}', timeout=90)
        except LibrarianSourceError:
            continue  # one library short is better than none
        rows = (((resp or {}).get('response') or {}).get('data') or {}).get('data') or []
        for row in rows:
            if not isinstance(row, dict):
                continue
            entry = {
                'last_played': _epoch_date(row.get('last_played')),
                'plays': int(row.get('play_count') or 0),
            }
            if section_type == 'movie':
                fp = row.get('file') or ''
                if fp:
                    watch[('file', os.path.basename(fp))] = entry
            title = norm_title(row.get('title'))
            if title:
                watch[('title', title)] = entry
    return watch


def jellyfin_watch_map(env, lan_ip):
    """Same shape as tautulli_watch_map, from Jellyfin's UserData.

    An API key carries no user context, so we resolve a user first (the
    first administrator) exactly like playlistsync's jellyfin-upload.py
    does — UserData is per-user and comes back empty without it."""
    key = (env.get('JELLYFIN_API_KEY') or '').strip()
    if not key:
        raise LibrarianSourceError('JELLYFIN_API_KEY is not set in .env')

    bases = ['http://jellyfin:8096']
    if lan_ip:
        bases.append(f'http://{lan_ip}:8096')
    bases.append('http://127.0.0.1:8096')

    headers = {'X-Emby-Token': key, 'Accept': 'application/json',
               'User-Agent': 'mediarr-librarian/1.0'}

    base_ok, users = None, None
    last_err = 'no Jellyfin endpoint answered'
    for base in bases:
        try:
            users = http_json(f'{base}/Users', headers, timeout=15)
            base_ok = base
            break
        except LibrarianSourceError as e:
            last_err = str(e)
    if base_ok is None:
        raise LibrarianSourceError(last_err)

    if isinstance(users, dict):
        users = users.get('Items') or []
    if not users:
        raise LibrarianSourceError('Jellyfin has no users yet')
    user_id = None
    for u in users:
        if (u.get('Policy') or {}).get('IsAdministrator'):
            user_id = u.get('Id')
            break
    user_id = user_id or users[0].get('Id')

    q = urllib.parse.urlencode({
        'Recursive': 'true',
        'IncludeItemTypes': 'Movie,Series',
        'Fields': 'Path,UserData',
        'userId': user_id,
        'EnableTotalRecordCount': 'false',
    }, quote_via=urllib.parse.quote)
    data = http_json(f'{base_ok}/Items?{q}', headers, timeout=90)

    watch = {}
    for it in (data or {}).get('Items', []):
        if not isinstance(it, dict):
            continue
        ud = it.get('UserData') or {}
        entry = {
            'last_played': _iso_date(ud.get('LastPlayedDate')),
            'plays': int(ud.get('PlayCount') or 0),
        }
        path = it.get('Path') or ''
        if path and it.get('Type') == 'Movie':
            watch[('file', os.path.basename(path))] = entry
        title = norm_title(it.get('Name'))
        if title:
            watch[('title', title)] = entry
    return watch


def attach_watch_data(items, watch):
    """Layered join: exact file basename first, normalised title second.

    Movies get a filename match (unambiguous). Series never do — a show
    is many files — so they fall through to the title match, which is
    why norm_title has to be aggressive about punctuation."""
    for it in items:
        entry = None
        if it['path']:
            entry = watch.get(('file', os.path.basename(it['path'])))
        if entry is None:
            entry = watch.get(('title', norm_title(it['title'])))
        it['last_played'] = (entry or {}).get('last_played', '')
        it['plays'] = (entry or {}).get('plays', 0)
    return items


# ── Aggregation ──────────────────────────────────────────────────────

def build_report(top_n=25, quality_detail=True):
    """Pull every source and fold it into the single dict both renderers
    consume. Never raises for a missing source — everything recoverable
    lands in report['warnings'] and the affected panel renders empty."""
    started = time.time()
    env = read_env()
    lan_ip = (env.get('LAN_IP') or '').strip()

    report = {
        'generated': time.strftime('%Y-%m-%d %H:%M:%S'),
        'libraries': [],
        'items': [],
        'disks': [],
        'quality_bytes': {},
        'cutoff': {},
        'warnings': [],
        'watch_source': None,
        'root_paths': [],
        # Individual files, not just the items that own them. A series is
        # one item but sixty files, and the fat one is invisible at item
        # level.
        'files': [],
        # Per-arr base URL, API key, api version and quality profiles.
        # Actions need them. NOTHING may serialise this: see
        # public_report(), which strips it before anything leaves the
        # process. An API key in /api/report.json would be a credential
        # leak to anyone who can reach the port.
        'connections': {},
    }

    collectors = {
        'radarr': lambda b, k, a: collect_radarr(b, k, a),
        'sonarr': lambda b, k, a: collect_sonarr(b, k, a, quality_detail),
        'lidarr': lambda b, k, a: collect_lidarr(b, k, a),
    }

    for name, spec in ARRS.items():
        if not is_enabled(env, spec['enable_key']):
            continue
        key = (env.get(spec['env_key']) or '').strip()
        if not key:
            report['warnings'].append(
                f'{spec["label"]}: no {spec["env_key"]} in .env, so it was skipped.')
            continue

        base, err = discover_base(spec, key, lan_ip)
        if not base:
            report['warnings'].append(f'{spec["label"]}: unreachable ({err}).')
            continue

        try:
            items, extras, _ = collectors[name](base, key, spec['api'])
        except LibrarianSourceError as e:
            report['warnings'].append(f'{spec["label"]}: {e}')
            continue

        report['files'].extend(extras.get('files') or [])

        for q, b in (extras.get('quality_bytes') or {}).items():
            report['quality_bytes'][q] = report['quality_bytes'].get(q, 0) + b
        if name == 'radarr':
            # Movies carry their quality inline, so fold them into the
            # same tally the Sonarr detail pass builds.
            for it in items:
                q = it['quality'] or 'Unknown'
                report['quality_bytes'][q] = report['quality_bytes'].get(q, 0) + it['size']

        total = sum(it['size'] for it in items)
        report['libraries'].append({
            'name': name,
            'label': spec['label'],
            'items': len(items),
            'files': sum(it['files'] for it in items),
            'size': total,
            'mean': (total / len(items)) if items else 0,
        })
        report['items'].extend(items)

        # Disks come from whichever arr answers first — they all see the
        # same volume, so one report is enough.
        if not report['disks']:
            try:
                report['disks'] = collect_diskspace(base, key, spec['api'])
            except LibrarianSourceError as e:
                report['warnings'].append(f'Disk space: {e}')

        # Keep the connection so an action can reach this arr later, and
        # fetch its quality profiles for the pickers.
        try:
            profiles = collect_quality_profiles(base, key, spec['api'])
        except LibrarianSourceError:
            profiles = []
        report['connections'][name] = {
            'base': base, 'key': key, 'api': spec['api'], 'profiles': profiles,
        }

        # Root folders from EVERY arr, though — movies, TV and music can
        # legitimately sit on different volumes.
        try:
            report['root_paths'].extend(collect_rootfolders(base, key, spec['api']))
        except LibrarianSourceError:
            pass

        try:
            report['cutoff'][spec['label']] = collect_cutoff_unmet(base, key, spec['api'])
        except LibrarianSourceError:
            pass  # a missing upgrade count is not worth a warning line

    # ── watch data, best effort ──────────────────────────────────────
    media_server = (env.get('MEDIA_SERVER') or 'plex').strip().lower()
    if report['items']:
        try:
            if media_server == 'jellyfin':
                watch = jellyfin_watch_map(env, lan_ip)
                report['watch_source'] = 'Jellyfin'
            else:
                watch = tautulli_watch_map(env, lan_ip)
                report['watch_source'] = 'Tautulli'
            attach_watch_data(report['items'], watch)
        except LibrarianSourceError as e:
            report['watch_source'] = None
            report['warnings'].append(
                f'Watch history unavailable ({e}) — sizes still shown.')
            for it in report['items']:
                it.setdefault('last_played', '')
                it.setdefault('plays', 0)

    # ── derived views ────────────────────────────────────────────────
    library_bytes = sum(lib['size'] for lib in report['libraries'])
    report['library_bytes'] = library_bytes

    # Unaccounted = what the filesystem says is used minus what the arrs
    # claim. Everything else on that volume lands here: failed imports,
    # the download folder, extras, and genuinely orphaned files. It is a
    # pointer, not an accusation — hence the caveat in the renderers.
    #
    # Only mounts that actually hold a root folder count. Without that
    # filter the arr's /config volume gets folded in and the figure is
    # nonsense. If we couldn't read any root folder we suppress the
    # number entirely rather than publish a wrong one.
    def _under(root, mount):
        """Is `root` on this `mount`? A raw startswith would count
        /database as living under /data, so require the match to land on
        a path separator (or be the whole string)."""
        if not root or not mount:
            return False
        m = mount.rstrip('/')
        if not m:            # mount is '/', everything is under it
            return True
        return root == m or root.startswith(m + '/')

    for d in report['disks']:
        d['is_media'] = any(_under(r, d['path']) for r in report['root_paths'])
    media_used = sum(d['used'] for d in report['disks'] if d.get('is_media'))
    report['media_used'] = media_used
    report['unaccounted'] = max(media_used - library_bytes, 0) if media_used else 0

    for it in report['items']:
        it['per_hour'] = bytes_per_hour(it['size'], it['minutes'])

    # ── recycle bins ─────────────────────────────────────────────────
    # Worth sitting next to the disk figures rather than buried in an
    # arr's settings: the bin lives on the SAME filesystem as the media,
    # so a shrink frees nothing at all until the arr clears it, and until
    # then everything in here counts toward unaccounted space.
    report['recycle'] = []
    for name, conn in (report['connections'] or {}).items():
        try:
            cfg = recycle_config(conn['base'], conn['key'], conn['api'])
        except LibrarianSourceError:
            continue
        local = recycle_local_path(cfg['path'], env) if cfg['path'] else ''
        used, count = recycle_usage(local) if local else (0, 0)
        report['recycle'].append({
            'arr': name,
            'label': ARRS[name]['label'],
            'path': cfg['path'],
            'host_path': recycle_host_path(cfg['path'], env) if cfg['path'] else '',
            'cleanup_days': cfg['cleanup_days'],
            'bytes': used,
            'files': count,
            'readable': bool(local),
        })
    report['recycle_bytes'] = sum(r['bytes'] for r in report['recycle'])

    # ── file-level views ─────────────────────────────────────────────
    # An "outlier" is a file well out of step with its siblings. That is
    # the one worth replacing: 40 GB is meaningless alone, 6x the rest of
    # the same show is not. OUTLIER_RATIO is deliberately not 1.5 — a
    # long season finale legitimately runs bigger than a normal episode.
    OUTLIER_RATIO = 2.5
    for f in report['files']:
        f['is_outlier'] = bool(f.get('ratio') and f['ratio'] >= OUTLIER_RATIO)
        f['label'] = (f"{f['item']} - {f['name']}"
                      if f.get('item') and f['kind'] == 'episode' else f.get('item') or f['name'])

    files_by_size = sorted(report['files'], key=lambda f: f['size'], reverse=True)
    report['top_files'] = files_by_size[:top_n]
    # Outliers ranked by how far out of step they are rather than by raw
    # size, so a 12 GB file among 1 GB siblings outranks a 30 GB one
    # among 25 GB siblings. The second is just a big show.
    report['outlier_files'] = sorted(
        [f for f in report['files'] if f['is_outlier']],
        key=lambda f: (f['ratio'], f['size']), reverse=True)[:top_n]
    report['outlier_bytes'] = sum(f['size'] for f in report['files'] if f['is_outlier'])
    # Keep the payload bounded on a large library: everything that is
    # rendered or searchable, and nothing else.
    keep = {id(f) for f in files_by_size[:400]}
    keep |= {id(f) for f in report['files'] if f['is_outlier']}
    report['files'] = [f for f in report['files'] if id(f) in keep]

    by_size = sorted(report['items'], key=lambda i: i['size'], reverse=True)
    report['top_by_size'] = by_size[:top_n]
    report['top_by_rate'] = sorted(
        [i for i in report['items'] if i['per_hour']],
        key=lambda i: i['per_hour'], reverse=True)[:top_n]

    if report['watch_source']:
        # The view that actually decides things: big, and nobody has ever
        # pressed play. Movies only — an unwatched series is usually one
        # you're mid-way through, and the play count is per-show anyway.
        report['big_unwatched'] = [
            i for i in by_size
            if i['kind'] == 'movie' and not i['plays']
        ][:top_n]
    else:
        report['big_unwatched'] = []

    report['elapsed'] = round(time.time() - started, 1)
    return report


def public_report(report):
    """The report minus anything secret, for JSON output.

    `connections` holds each arr's API key so actions can authenticate.
    Serialising the report verbatim would publish those keys to anyone
    who can GET /api/report.json, which on a LAN-bound service with no
    auth is everyone on the network. Profiles are kept because the UI
    needs them and they are not sensitive."""
    if not report:
        return {}
    safe = dict(report)
    safe['connections'] = {
        name: {'profiles': c.get('profiles') or []}
        for name, c in (report.get('connections') or {}).items()
    }
    return safe


# ── Text rendering (CLI) ─────────────────────────────────────────────

def _row(cells, widths):
    return '  '.join(str(c)[:w].ljust(w) for c, w in zip(cells, widths))


def render_text(report):
    out = []
    add = out.append

    add('')
    add('  Mediarr LibrARRian · storage report')
    add(f'  generated {report["generated"]}  ({report["elapsed"]}s)')
    f = report.get('filtered')
    if f:
        bits = []
        if f['query']:    bits.append(f'match "{f["query"]}"')
        if f['min_size']: bits.append(f'≥ {f["min_size"]}')
        if f.get('min_rate'): bits.append(f'≥ {f["min_rate"]}/h')
        if f['quality']:  bits.append(f'quality ~ {f["quality"]}')
        if f['arr']:      bits.append(f['arr'])
        if f['unplayed']: bits.append('never played')
        add(f'  filtered: {", ".join(bits)}  →  {f["matched"]} of {f["of"]} items')
    add('  ' + '─' * 74)

    if report['disks']:
        add('')
        add('  DISKS')
        for d in report['disks']:
            used_pct = pct(d['used'], d['total'])
            add(f'    {d["path"]:<24} {human_bytes(d["free"]):>12} free '
                f'of {human_bytes(d["total"]):>12}   ({used_pct:.0f}% used)')

    add('')
    add('  LIBRARIES')
    widths = (22, 9, 9, 14, 12)
    add('    ' + _row(('Library', 'Items', 'Files', 'Size', 'Mean'), widths))
    for lib in report['libraries']:
        add('    ' + _row((lib['label'], f'{lib["items"]:,}', f'{lib["files"]:,}',
                           human_bytes(lib['size']), human_bytes(lib['mean'])), widths))
    add('    ' + _row(('TOTAL', '', '', human_bytes(report['library_bytes']), ''), widths))
    if report['unaccounted']:
        add('')
        add(f'    Unaccounted on disk: {human_bytes(report["unaccounted"])}'
            f'  ({pct(report["unaccounted"], report["media_used"]):.0f}% of used space)')
        add('      Downloads in progress, extras, other shares on the same volume,')
        add('      and anything the arrs no longer track. Worth a look, not an alarm.')

    if report.get('recycle'):
        add('')
        add('  RECYCLE BINS (deleted files, still on the same disk)')
        for r in report['recycle']:
            if not r['path']:
                add(f'    {r["label"]:<10} not configured')
                continue
            kept = f'{r["cleanup_days"]}d' if r['cleanup_days'] else 'forever'
            size = human_bytes(r['bytes']) if r['readable'] else 'unreadable'
            add(f'    {r["label"]:<10} {size:>10}  {r["files"]:>6,} files  '
                f'kept {kept:<8} {r["host_path"]}')
        if report.get('recycle_bytes'):
            add(f'    {"total":<10} {human_bytes(report["recycle_bytes"]):>10}')

    if report['cutoff']:
        add('')
        add('  UPGRADE BACKLOG (the arr already wants a better release)')
        for label, count in report['cutoff'].items():
            add(f'    {label:<22} {count:,} below cutoff')

    if report['quality_bytes']:
        add('')
        add('  SPACE BY QUALITY')
        total_q = sum(report['quality_bytes'].values()) or 1
        for q, b in sorted(report['quality_bytes'].items(),
                           key=lambda kv: kv[1], reverse=True):
            bar = '█' * max(int(round(pct(b, total_q) / 4)), 0)
            add(f'    {q:<22} {human_bytes(b):>12}  {pct(b, total_q):5.1f}%  {bar}')

    def item_table(title, items, note=None):
        if not items:
            return
        add('')
        add(f'  {title}')
        if note:
            add(f'    {note}')
        w = (38, 11, 17, 10, 11)
        add('    ' + _row(('Title', 'Size', 'Quality', 'Per hour', 'Last played'), w))
        for it in items:
            year = f' ({it["year"]})' if it.get('year') else ''
            rate = human_bytes(it['per_hour']) + '/h' if it.get('per_hour') else '—'
            add('    ' + _row((
                it['title'] + year,
                human_bytes(it['size']),
                it['quality'] or '—',
                rate,
                it.get('last_played') or ('never' if report['watch_source'] else '—'),
            ), w))

    def file_table(title, files, note=None):
        if not files:
            return
        add('')
        add(f'  {title}')
        if note:
            add(f'    {note}')
        w = (52, 11, 17, 8)
        add('    ' + _row(('File', 'Size', 'Quality', 'vs sibs'), w))
        for f in files:
            add('    ' + _row((
                f.get('label') or f.get('name', ''),
                human_bytes(f['size']),
                f.get('quality') or '—',
                f'{f["ratio"]}x' if f.get('ratio') else '—',
            ), w))

    if report.get('outlier_files'):
        file_table(
            'FILES OUT OF STEP WITH THEIR SHOW', report['outlier_files'],
            'Much larger than the other files in the same series. '
            f'{human_bytes(report.get("outlier_bytes") or 0)} total.')
    file_table('LARGEST INDIVIDUAL FILES', report.get('top_files') or [])

    item_table('BIGGEST ITEMS', report['top_by_size'])
    item_table('MOST BLOATED (bytes per hour)', report['top_by_rate'],
               'High rate + low runtime is usually a remux you can re-grab smaller.')
    if report['big_unwatched']:
        item_table(f'BIG AND NEVER PLAYED (via {report["watch_source"]})',
                   report['big_unwatched'])

    if report['warnings']:
        add('')
        add('  NOTES')
        for w_ in report['warnings']:
            add(f'    ! {w_}')

    add('')
    return '\n'.join(out)


# ── HTML rendering (server) ──────────────────────────────────────────
#
# Palette and structure deliberately mirror recyclarr-trigger.py so the
# two sidecar pages read as one tool. Kept as a plain constant (not a
# .format template) so the CSS needs no brace-doubling.

CSS = """
/* Monokai, matching the docs site at dougfessler.com/Mediarr-Installer
   and the portfolio it takes its cues from. The two sidecar pages and
   the dashboard share this so the whole stack reads as one hand rather
   than three separate tools that happen to be installed together.

   Class names are unchanged from the slate/emerald version this
   replaces — this is a restyle, not a re-layout. */
:root {
  --mk-bg:      #1e1e1e;
  --mk-surface: #2d2d2d;
  --mk-gutter:  #141414;
  --mk-fg:      #F8F8F2;
  --mk-comment: #75715E;
  --mk-pink:    #F92672;
  --mk-orange:  #FD971F;
  --mk-yellow:  #E6DB74;
  --mk-green:   #A6E22E;
  --mk-cyan:    #66D9EF;
  --mk-purple:  #AE81FF;
  --mk-border:  #49483E;

  /* --mk-comment is the colour of commented-OUT code. It is built to
     recede, which is wrong for anything meant to be read. Body text and
     labels use --dim instead; --mk-comment is kept for the decorative
     comment marks only. */
  --dim:        #BFBBAA;
  --radius:     3px;
  --font: 'JetBrains Mono', 'Fira Code', 'Cascadia Mono', Consolas, monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font);
  background: var(--mk-bg);
  color: var(--mk-fg);
  line-height: 1.6;
  font-size: 15px;
  padding: 2rem 1rem;
  max-width: 1100px;
  margin: 0 auto;
  word-break: break-word;
}

/* Scanlines, same as the docs site. Subtle enough to read through. */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  background: repeating-linear-gradient(
    0deg, transparent, transparent 3px,
    rgba(0,0,0,0.06) 3px, rgba(0,0,0,0.06) 4px);
  pointer-events: none;
  z-index: 9999;
}

h1 {
  font-weight: 700;
  font-size: 1.6rem;
  color: var(--mk-green);
  margin-bottom: 0.25rem;
  text-shadow: 0.03em 0 0 rgba(249,38,114,0.4), -0.03em 0 0 rgba(102,217,239,0.4);
}
h1::before { content: '> '; color: var(--mk-comment); }

h2 { font-size: 1rem; font-weight: 700; color: var(--mk-green); margin-bottom: 0.6rem; }

.muted { color: var(--dim); font-size: 0.875rem; }
.dim   { color: var(--dim); }

a { color: var(--mk-cyan); text-decoration: none; }
a:hover { color: #A8E9F7; text-decoration: underline; }

::selection { background: rgba(166,226,46,0.25); color: var(--mk-fg); }
:focus-visible { outline: 2px solid var(--mk-cyan); outline-offset: 2px; }

/* ── Cards ───────────────────────────────────────────────────────── */
.card {
  background: var(--mk-surface);
  border: 1px solid var(--mk-border);
  border-left: 3px solid var(--mk-border);
  border-radius: var(--radius);
  padding: 1rem 1.15rem;
  margin: 1rem 0;
}
/* Cycling accent down the page, the same device the docs site uses on
   its card grid. Purely rhythmic — no card means anything by its
   colour, so nothing is lost if you cannot tell them apart. */
.card:nth-of-type(6n+1) { border-left-color: var(--mk-pink);   }
.card:nth-of-type(6n+2) { border-left-color: var(--mk-orange); }
.card:nth-of-type(6n+3) { border-left-color: var(--mk-yellow); }
.card:nth-of-type(6n+4) { border-left-color: var(--mk-green);  }
.card:nth-of-type(6n+5) { border-left-color: var(--mk-cyan);   }
.card:nth-of-type(6n+6) { border-left-color: var(--mk-purple); }

.label {
  color: var(--mk-green);
  font-size: 0.72rem;
  letter-spacing: 0.05em;
  margin-bottom: 0.75rem;
  font-weight: 700;
}
.label::before { content: '/* '; color: var(--mk-comment); font-weight: 400; }
.label::after  { content: ' */'; color: var(--mk-comment); font-weight: 400; }

.row {
  display: flex; justify-content: space-between; gap: 1rem;
  padding: 0.3rem 0; align-items: center;
}
.row strong { font-weight: 600; color: var(--mk-fg); }

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
.stat { font-size: 1.45rem; font-weight: 700; color: var(--mk-fg); }

/* ── Forms ───────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 0.35rem; margin: 0.75rem 0; }
.field label { font-size: 0.8rem; color: var(--dim); }

select, input[type="search"], input[type="text"] {
  background: var(--mk-gutter);
  color: var(--mk-fg);
  border: 1px solid var(--mk-border);
  border-radius: var(--radius);
  padding: 0.5rem 0.65rem;
  font: inherit;
  font-size: 0.875rem;
}
select:focus, input:focus { outline: 2px solid var(--mk-cyan); outline-offset: 1px; }

/* Drop the native dropdown button. On Windows it renders as a pale grey
   square that ignores every colour on this page. The chevron is an inline
   data URI so there is still exactly one file to serve. */
select {
  -webkit-appearance: none;
  appearance: none;
  padding-right: 1.9rem;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath fill='%2375715E' d='M0 0h10L5 6z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.65rem center;
  cursor: pointer;
}
select:hover, input[type="search"]:hover { border-color: var(--mk-comment); }
/* A filter that is doing something should not look like one that isn't.
   apply() puts .set on any control holding a non-default value, so you
   can see at a glance why the list is short. */
select.set {
  border-color: var(--mk-cyan);
  color: var(--mk-cyan);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath fill='%2366D9EF' d='M0 0h10L5 6z'/%3E%3C/svg%3E");
}
/* Windows draws the open list from the OS palette unless told otherwise. */
option { background: var(--mk-surface); color: var(--mk-fg); }
input[type="search"]::placeholder { color: var(--mk-comment); }
input[type="search"]::-webkit-search-cancel-button { filter: invert(0.7); cursor: pointer; }

.actions { display: flex; gap: 0.7rem; flex-wrap: wrap; align-items: center; margin-top: 0.5rem; }

/* Solid fills, the treatment Window Layout Manager uses for its primary
   action. An outline among outlines reads as another label; a fill reads
   as the thing to press. */
button {
  background: var(--mk-green);
  color: var(--mk-bg);
  border: 1px solid transparent;
  padding: 0.6rem 1.2rem;
  font: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background 0.12s ease;
}
button::before { content: '$ '; opacity: 0.55; }
button:hover  { background: #B9EE4F; }
button:active { background: #8FC423; }
button:disabled { opacity: 0.4; cursor: not-allowed; }

button.secondary { background: var(--mk-surface); color: var(--dim); border-color: var(--mk-border); }
button.secondary:hover { background: #3a3a30; color: var(--mk-fg); }

button.danger { background: var(--mk-pink); color: var(--mk-bg); }
button.danger:hover  { background: #FF4D8D; }
button.danger:active { background: #D91A5B; }

/* ── Code ────────────────────────────────────────────────────────── */
pre {
  background: var(--mk-gutter);
  border: 1px solid var(--mk-border);
  border-left: 3px solid var(--mk-green);
  border-radius: var(--radius);
  padding: 0.9rem 1rem;
  overflow: auto;
  font-size: 0.8125rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 60vh;
  color: var(--mk-fg);
}
code {
  background: var(--mk-gutter);
  color: var(--mk-yellow);
  border: 1px solid var(--mk-border);
  padding: 0.1rem 0.35rem;
  border-radius: var(--radius);
  font-size: 0.875em;
}

/* ── Banners ─────────────────────────────────────────────────────── */
.banner {
  border-radius: var(--radius);
  padding: 0.8rem 1rem;
  margin: 1rem 0;
  font-size: 0.9rem;
  border: 1px solid var(--mk-border);
}
.banner.ok   { background: rgba(166,226,46,0.10);  border-left: 3px solid var(--mk-green);  color: var(--mk-green); }
.banner.warn { background: rgba(230,219,116,0.10); border-left: 3px solid var(--mk-yellow); color: var(--mk-yellow); }
.banner.err  { background: rgba(249,38,114,0.10);  border-left: 3px solid var(--mk-pink);   color: #FF7FAE; }

/* ── Tables ──────────────────────────────────────────────────────── */
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th {
  text-align: left;
  color: var(--mk-comment);
  font-weight: 500;
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 0 0.6rem 0.5rem 0;
  border-bottom: 1px solid var(--mk-border);
  white-space: nowrap;
}
/* Sortable headers. The idle glyph is deliberately faint but always
   present, so the column reads as clickable before you hover it. */
th.sortable { cursor: pointer; user-select: none; -webkit-user-select: none; }
th.sortable:hover { color: var(--mk-fg); }
th.sortable:focus-visible { outline: 1px solid var(--mk-cyan); outline-offset: 2px; }
/* Drawn with borders rather than a glyph. The arrow characters (\2195 and
   friends) are missing from JetBrains Mono and every other font in the
   stack, so they came out as tofu boxes. A triangle always renders. */
th.sortable::after {
  content: '';
  display: inline-block;
  vertical-align: middle;
  margin-left: 0.45em;
  width: 0;
  height: 0;
  border-left: 3px solid transparent;
  border-right: 3px solid transparent;
  border-top: 4px solid currentColor;
  opacity: 0.35;
}
th.sorted-asc::after {
  border-top: 0;
  border-bottom: 4px solid var(--mk-cyan);
  opacity: 1;
}
th.sorted-desc::after { border-top-color: var(--mk-cyan); opacity: 1; }
th.sorted-asc, th.sorted-desc { color: var(--mk-fg); }
td {
  padding: 0.45rem 0.6rem 0.45rem 0;
  border-bottom: 1px solid #322f28;
  vertical-align: top;
}
tr:last-child td { border-bottom: none; }
tbody tr:nth-child(even) { background: rgba(255,255,255,0.015); }
td.num, th.num { text-align: right; }

/* ── Meters ──────────────────────────────────────────────────────── */
.meter {
  height: 0.4rem;
  background: var(--mk-gutter);
  border: 1px solid var(--mk-border);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 0.35rem;
}
.meter > span { display: block; height: 100%; background: var(--mk-green); }
.meter.warn > span { background: var(--mk-yellow); }
.meter.hot  > span { background: var(--mk-pink); }

/* ── Tags ────────────────────────────────────────────────────────── */
.tag {
  display: inline-block;
  background: var(--mk-gutter);
  color: var(--mk-cyan);
  font-size: 0.7rem;
  font-weight: 500;
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius);
  border: 1px solid var(--mk-border);
}

/* ── Search / filter ─────────────────────────────────────────────── */
.filters { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.9rem; }
/* Wide enough that the placeholder isn't cut mid-word. Below that the
   row wraps instead, which beats squeezing the one control you type in. */
.filters input[type="search"] { flex: 1 1 18rem; min-width: 15rem; }
.filters label { font-size: 0.8rem; color: var(--dim); display: flex; align-items: center; gap: 0.35rem; }
.filter-count { font-size: 0.8rem; color: var(--mk-comment); margin-left: auto; }
input[type="checkbox"] { accent-color: var(--mk-cyan); width: 0.95rem; height: 0.95rem; }

/* Scope tabs (Titles / Files). Radios rather than buttons so the choice
   is one control with one value, and keyboard arrows move between them
   the way a radio group already does. */
.scope { display: flex; gap: 0.4rem; margin-bottom: 0.85rem; }
.scope-tab input { position: absolute; opacity: 0; pointer-events: none; }
.scope-tab span {
  display: inline-block;
  padding: 0.35rem 0.85rem;
  border: 1px solid var(--mk-border);
  border-radius: var(--radius);
  font-size: 0.8rem;
  color: var(--mk-comment);
  cursor: pointer;
}
.scope-tab span b { font-weight: 500; opacity: 0.65; margin-left: 0.35rem; }
.scope-tab span:hover { color: var(--mk-fg); }
.scope-tab input:checked + span {
  background: var(--mk-cyan);
  border-color: var(--mk-cyan);
  color: var(--mk-bg);
}
.scope-tab input:focus-visible + span { outline: 1px solid var(--mk-cyan); outline-offset: 2px; }

/* Quick views. Deliberately quieter than the real buttons: these only
   move the sort and the filters, they never touch your library. */
.presets { display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.85rem; }
.presets .muted { font-size: 0.75rem; }
button.preset {
  background: transparent;
  border: 1px solid var(--mk-border);
  color: var(--mk-comment);
  padding: 0.25rem 0.65rem;
  font-size: 0.75rem;
  font-weight: 400;
}
button.preset::before { content: none; }
button.preset:hover { background: transparent; color: var(--mk-fg); border-color: var(--mk-cyan); }
tr.hidden-row { display: none; }
.no-matches { color: var(--dim); font-size: 0.875rem; padding: 0.75rem 0; }
.ratio-hot { color: var(--mk-pink); font-weight: 700; }

/* ── Selection + action bars ─────────────────────────────────────── */
td.sel, th.sel { width: 1.75rem; padding-right: 0.35rem; }
input[type="checkbox"] { accent-color: var(--mk-green); }

.action-bar {
  position: sticky; bottom: 0; z-index: 5;
  background: var(--mk-surface);
  border: 1px solid var(--mk-border);
  border-left: 3px solid var(--mk-cyan);
  border-radius: var(--radius);
  padding: 0.75rem 1rem; margin-top: 1rem;
  display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap;
  box-shadow: 0 -4px 16px rgba(0,0,0,0.5);
}
.action-bar[hidden] { display: none; }
.action-bar .sel-count { font-weight: 700; color: var(--mk-fg); font-size: 0.875rem; }

/* ── Plan / confirm ──────────────────────────────────────────────── */
.plan-steps { margin: 0.5rem 0 1rem 1.2rem; }
.plan-steps li { font-size: 0.875rem; line-height: 1.6; margin-bottom: 0.4rem; }
.plan-steps li::marker { color: var(--mk-cyan); font-weight: 700; }
.plan-warn {
  background: rgba(249,38,114,0.10);
  border: 1px solid var(--mk-border);
  border-left: 3px solid var(--mk-pink);
  color: #FF9EC4;
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
  margin: 1rem 0;
  font-size: 0.9rem;
  line-height: 1.6;
}

/* ── Footer note ─────────────────────────────────────────────────── */
.hint {
  font-size: 0.8rem;
  color: var(--dim);
  margin-top: 1.75rem;
  line-height: 1.65;
  border-top: 1px solid var(--mk-border);
  padding-top: 1rem;
}
.hint::before { content: '// '; color: var(--mk-comment); }

@media (max-width: 640px) {
  body { padding: 1.25rem 0.75rem; font-size: 14px; }
  .grid { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.001ms !important; }
}
"""


def _meter(used_pct):
    cls = 'meter hot' if used_pct >= 90 else 'meter warn' if used_pct >= 75 else 'meter'
    return (f'<div class="{cls}"><span style="width:{min(used_pct, 100):.1f}%"></span></div>')


# Client-side filtering and selection. Deliberately plain: the page has
# to work from a NAS with no internet, so there is no framework and no
# CDN. fuzzyScore mirrors fuzzy_score() in this same file — keep the two
# in step or the CLI and the browser rank the same search differently.
SCRIPT = r"""
// The word-boundary test. Unicode-aware on purpose, to mirror Python's
// str.isalnum(): with a plain [a-z0-9] an accented letter reads as a
// boundary here and as a letter there, so "Låtar" scored differently in
// the browser than on the CLI.
var ALNUM = /[\p{L}\p{N}]/u;

function fuzzyTerm(term, text) {
  if (!term) return [true, 0];
  var idx = text.indexOf(term);
  if (idx !== -1) {
    var s = 1000 - Math.min(idx, 100) * 2;
    if (idx === 0 || !ALNUM.test(text[idx - 1])) s += 60;
    return [true, s];
  }
  var pos = 0, score = 0, prev = -2;
  for (var i = 0; i < term.length; i++) {
    var found = text.indexOf(term[i], pos);
    if (found === -1) return [false, 0];
    if (found === prev + 1) score += 10;
    if (found === 0 || !ALNUM.test(text[found - 1])) score += 8;
    score += Math.max(0, 12 - (found - pos));
    prev = found; pos = found + 1;
  }
  return [true, score];
}

function fuzzyScore(query, text) {
  if (!query) return [true, 0];
  // Lower the HAYSTACK too, not just the query. Python's fuzzy_score
  // does (text_l = str(text).lower()) and the two have to agree, or the
  // same search finds different rows in the browser than on the CLI.
  // Left uncased, "rmx" matched Arrival but not Dune, because only
  // Arrival happened to carry a lowercase r before the Remux.
  var hay = String(text).toLowerCase();
  var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  var total = 0;
  for (var i = 0; i < terms.length; i++) {
    var r = fuzzyTerm(terms[i], hay);
    if (!r[0]) return [false, 0];
    total += r[1];
  }
  return [true, total];
}

(function () {
  var q = document.getElementById('q');
  var arrSel = document.getElementById('f-arr');
  var minSel = document.getElementById('f-min');
  var rateSel = document.getElementById('f-rate');
  var qualSel = document.getElementById('f-qual');
  var unplayed = document.getElementById('f-unplayed');
  var scopeRadios = Array.prototype.slice.call(
    document.querySelectorAll('input[name="scope"]'));
  var countEl = document.getElementById('filter-count');
  if (!q) return;

  var tables = Array.prototype.slice.call(document.querySelectorAll('table'));

  // ── Column sorting ────────────────────────────────────────────────
  // Click a header to sort by it, click again to flip. Numeric columns
  // sort on data-sort-value (raw bytes) rather than the rendered text,
  // because "900 MB" sorts above "4 TB" as a string. State lives on the
  // table element so tables sort independently, and apply() finishes by
  // calling applySort so a chosen column survives filtering.
  function cellKey(row, idx, numeric) {
    var cell = row.children[idx];
    if (!cell) return numeric ? -Infinity : '';
    if (numeric) {
      var raw = cell.getAttribute('data-sort-value');
      var n = raw === null ? NaN : parseFloat(raw);
      return isNaN(n) ? -Infinity : n;
    }
    return (cell.textContent || '').trim().toLowerCase();
  }

  function applySort(table) {
    if (table.sortCol == null) return;
    var body = table.querySelector('tbody');
    if (!body) return;
    var idx = table.sortCol, numeric = table.sortNum, dir = table.sortDir;
    var rows = Array.prototype.slice.call(body.children);
    rows.sort(function (a, b) {
      var x = cellKey(a, idx, numeric), y = cellKey(b, idx, numeric);
      if (x < y) return -dir;
      if (x > y) return dir;
      return 0;
    });
    rows.forEach(function (r) { body.appendChild(r); });
  }

  tables.forEach(function (table) {
    var heads = Array.prototype.slice.call(table.querySelectorAll('thead th'));
    heads.forEach(function (th, idx) {
      // The checkbox column, and any unlabelled spacer, has nothing to
      // sort on. Their headers are still counted, so idx keeps lining up
      // with the cells in each row.
      if (th.classList.contains('sel') || !th.textContent.trim()) return;
      th.classList.add('sortable');
      th.tabIndex = 0;
      th.setAttribute('role', 'button');
      function toggle() {
        if (table.sortCol === idx) {
          table.sortDir = -table.sortDir;
        } else {
          table.sortCol = idx;
          table.sortNum = th.classList.contains('num');
          // Numbers open descending. The end of every number column on
          // this page worth looking at first is the big one.
          table.sortDir = table.sortNum ? -1 : 1;
        }
        heads.forEach(function (h) {
          h.classList.remove('sorted-asc', 'sorted-desc');
          h.removeAttribute('aria-sort');
        });
        var asc = table.sortDir === 1;
        th.classList.add(asc ? 'sorted-asc' : 'sorted-desc');
        th.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
        applySort(table);
      }
      // Exposed so the quick views can drive a column without faking a
      // click event on a header the user never touched.
      th.sortToggle = toggle;
      th.addEventListener('click', toggle);
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  });

  // ── Scope (Titles / Files) ────────────────────────────────────────
  // Two tables, exactly one of them on screen. They aren't one list:
  // a title carries a runtime and a play count, a file carries neither,
  // and they have different actions. So the controls that only mean
  // something for a title hide themselves when you switch to files,
  // rather than sitting there doing nothing.
  function currentScope() {
    for (var i = 0; i < scopeRadios.length; i++) {
      if (scopeRadios[i].checked) return scopeRadios[i].value;
    }
    return 'items';
  }

  function syncPanels() {
    var s = currentScope();
    document.querySelectorAll('[data-scope-panel]').forEach(function (el) {
      el.hidden = el.getAttribute('data-scope-panel') !== s;
    });
    document.querySelectorAll('[data-items-only]').forEach(function (el) {
      el.hidden = s !== 'items';
    });
  }

  function setScope(s) {
    scopeRadios.forEach(function (r) { r.checked = (r.value === s); });
    syncPanels();
  }

  /** Sort a scope's table by a named column, in a chosen direction. */
  function sortBy(scope, label, wantDesc) {
    var table = document.querySelector('table[data-scope="' + scope + '"]');
    if (!table) return;
    var th = Array.prototype.slice.call(table.querySelectorAll('thead th'))
      .filter(function (h) { return h.textContent.trim() === label; })[0];
    if (!th || !th.sortToggle) return;
    th.sortToggle();
    if ((th.getAttribute('aria-sort') === 'descending') !== wantDesc) th.sortToggle();
  }

  function resetFilters() {
    if (q) q.value = '';
    if (arrSel) arrSel.value = '';
    if (minSel) minSel.value = '0';
    if (rateSel) rateSel.value = '0';
    if (qualSel) qualSel.value = '';
    if (unplayed) unplayed.checked = false;
  }

  var PRESETS = {
    biggest:  function () { setScope('items'); sortBy('items', 'Size', true); },
    bloated:  function () { setScope('items'); sortBy('items', 'Per hour', true); },
    unplayed: function () {
      setScope('items');
      if (unplayed) unplayed.checked = true;
      sortBy('items', 'Size', true);
    },
    outliers: function () { setScope('files'); sortBy('files', 'vs siblings', true); },
  };

  function apply() {
    var query = q.value.trim().toLowerCase();
    var arr = arrSel ? arrSel.value : '';
    var min = minSel ? parseInt(minSel.value, 10) || 0 : 0;
    var rate = rateSel ? parseInt(rateSel.value, 10) || 0 : 0;
    var qual = qualSel ? qualSel.value : '';
    var onlyUnplayed = unplayed && unplayed.checked;
    var scope = currentScope();
    var shown = 0, total = 0;

    tables.forEach(function (table) {
      // Only the visible scope gets filtered and counted. The summary
      // tables above carry no data-scope and no data-search rows, so
      // they fall straight through untouched.
      if (table.dataset.scope && table.dataset.scope !== scope) return;
      var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
      var scored = [];
      rows.forEach(function (row) {
        if (!row.dataset.search) return;
        total++;
        var ok = true;
        if (arr && row.dataset.arr !== arr) ok = false;
        if (ok && min && parseInt(row.dataset.size, 10) < min) ok = false;
        if (ok && qual && row.dataset.quality !== qual) ok = false;
        // File rows carry no data-rate on purpose: a file has a size but
        // no runtime of its own, so a per-hour floor means nothing there
        // and leaves those tables alone rather than emptying them.
        if (ok && rate && row.dataset.rate !== undefined
            && parseInt(row.dataset.rate, 10) < rate) ok = false;
        if (ok && onlyUnplayed && parseInt(row.dataset.plays, 10) > 0) ok = false;
        var score = 0;
        if (ok && query) {
          var r = fuzzyScore(query, row.dataset.search);
          ok = r[0]; score = r[1];
        }
        row.classList.toggle('hidden-row', !ok);
        // A row hidden by a filter must not stay silently selected, or
        // an action would run against something the user can't see.
        if (!ok) {
          row.querySelectorAll('.pick, .pickfile').forEach(function (box) {
            if (box.checked) box.checked = false;
          });
        }
        if (ok) { shown++; scored.push([score, row]); }
      });
      // Re-order by relevance while a query is active. A column the user
      // picked outranks that: having clicked "Size", they don't expect
      // typing in the search box to silently re-order the results.
      var body = table.querySelector('tbody');
      if (query && body && table.sortCol == null) {
        scored.sort(function (a, b) { return b[0] - a[0]; });
        scored.forEach(function (p) { body.appendChild(p[1]); });
      }
      applySort(table);
      var empty = table.parentNode.querySelector('.no-matches');
      if (empty) empty.hidden = scored.length > 0;
    });

    if (countEl) {
      countEl.textContent = (query || arr || min || rate || qual || onlyUnplayed)
        ? shown + ' of ' + total + ' shown' : total + ' rows';
    }
    // Light up whichever controls are actually narrowing the list.
    [arrSel, minSel, rateSel, qualSel].forEach(function (el) {
      if (el) el.classList.toggle('set', !!el.value && el.value !== '0');
    });
    syncSelection();
    syncFiles();
  }

  var bar = document.getElementById('action-bar');
  var selCount = document.getElementById('sel-count');
  var profileSel = document.getElementById('profile');
  var actionArr = document.getElementById('action-arr');
  var warn = document.getElementById('sel-warn');

  function selected() {
    return Array.prototype.slice.call(document.querySelectorAll('.pick:checked'))
      .filter(function (b) { return !b.closest('tr').classList.contains('hidden-row'); });
  }

  // ── Which way is this going? ──────────────────────────────────────
  // Profiles carry a rank: how good they're allowed to get, as an index
  // into the arr's own quality order. An item above the target has to
  // lose its file first or the search just re-grabs it; an item at or
  // below only needs the profile change. An unknown rank is -1 and never
  // reads as "above", so the fallback is always the path that deletes
  // nothing. The server decides for real — this is so the button doesn't
  // lie about what pressing it does.
  function rankOf(profileId) {
    if (!profileSel || !profileId) return -1;
    var opt = Array.prototype.slice.call(profileSel.options)
      .filter(function (o) { return o.value === String(profileId); })[0];
    var r = opt ? parseInt(opt.dataset.rank, 10) : NaN;
    return isNaN(r) ? -1 : r;
  }

  function syncDirection(keys, profileOf) {
    var btn = document.getElementById('apply-btn');
    var note = document.getElementById('direction-note');
    if (!btn || !profileSel) return;
    var chosen = profileSel.options[profileSel.selectedIndex];
    var target = chosen ? parseInt(chosen.dataset.rank, 10) : NaN;
    if (isNaN(target)) target = -1;

    var down = 0;
    keys.forEach(function (k) {
      var mine = rankOf(profileOf[k]);
      if (target >= 0 && mine >= 0 && mine > target) down++;
    });

    var n = keys.length;
    btn.classList.toggle('danger', down > 0);
    if (!n) {
      btn.textContent = 'Apply';
      if (note) note.textContent = '';
      return;
    }
    if (down === 0) {
      btn.textContent = 'Upgrade ' + n + ' item' + (n === 1 ? '' : 's');
      if (note) note.textContent = 'Nothing is deleted.';
    } else if (down === n) {
      btn.textContent = 'Shrink ' + n + ' item' + (n === 1 ? '' : 's');
      if (note) note.textContent = 'Current files are deleted first, via the Recycle Bin.';
    } else {
      btn.textContent = 'Apply to ' + n + ' items';
      if (note) note.textContent = down + ' of them shrink, the rest just upgrade.';
    }
  }

  function syncSelection() {
    if (!bar) return;
    var picks = selected();
    // Count distinct items rather than distinct checkboxes, and carry
    // each one's current profile so the button can work out which way
    // this is going.
    var seen = {}, profileOf = {};
    picks.forEach(function (b) {
      var k = b.dataset.arr + ':' + b.dataset.id;
      seen[k] = b.dataset.arr;
      profileOf[k] = b.dataset.profile;
    });
    var keys = Object.keys(seen);
    syncDirection(keys, profileOf);
    var arrs = {};
    keys.forEach(function (k) { arrs[seen[k]] = 1; });
    var arrList = Object.keys(arrs);

    bar.hidden = keys.length === 0;
    if (selCount) selCount.textContent = keys.length + ' selected';

    // An action targets one app. Spanning apps would need separate
    // profile ids and separate calls, so it's refused rather than
    // half-supported.
    var single = arrList.length === 1;
    if (warn) {
      warn.hidden = single || keys.length === 0;
      warn.textContent = single ? '' : 'Select items from one app at a time.';
    }
    if (actionArr) actionArr.value = single ? arrList[0] : '';
    if (profileSel) {
      Array.prototype.slice.call(profileSel.options).forEach(function (o) {
        o.hidden = !single || (o.dataset.arr !== arrList[0]);
      });
      var cur = profileSel.selectedOptions[0];
      if (!cur || cur.hidden) {
        var first = Array.prototype.slice.call(profileSel.options)
          .filter(function (o) { return !o.hidden; })[0];
        if (first) profileSel.value = first.value;
      }
    }
    Array.prototype.slice.call(bar.querySelectorAll('button')).forEach(function (b) {
      b.disabled = !single || keys.length === 0;
    });

    var hidden = document.getElementById('ids');
    if (hidden) hidden.value = keys.map(function (k) { return k.split(':')[1]; }).join(',');
  }

  // Files select independently of items: replacing a file and re-grading
  // an item are different actions, so they get separate bars and never
  // share a selection.
  var fileBar = document.getElementById('file-action-bar');
  var fileCount = document.getElementById('file-sel-count');
  var fileArr = document.getElementById('file-action-arr');
  var fileIds = document.getElementById('file-ids');
  var fileWarn = document.getElementById('file-sel-warn');

  function syncFiles() {
    if (!fileBar) return;
    var picks = Array.prototype.slice.call(document.querySelectorAll('.pickfile:checked'))
      .filter(function (b) { return !b.closest('tr').classList.contains('hidden-row'); });
    var seen = {};
    picks.forEach(function (b) { seen[b.dataset.arr + ':' + b.dataset.id] = b.dataset.arr; });
    var keys = Object.keys(seen);
    var arrs = {};
    keys.forEach(function (k) { arrs[seen[k]] = 1; });
    var arrList = Object.keys(arrs);
    var single = arrList.length === 1;

    fileBar.hidden = keys.length === 0;
    if (fileCount) fileCount.textContent = keys.length + (keys.length === 1 ? ' file selected' : ' files selected');
    if (fileWarn) {
      fileWarn.hidden = single || keys.length === 0;
      fileWarn.textContent = single ? '' : 'Select files from one app at a time.';
    }
    if (fileArr) fileArr.value = single ? arrList[0] : '';
    if (fileIds) fileIds.value = keys.map(function (k) { return k.split(':')[1]; }).join(',');
    Array.prototype.slice.call(fileBar.querySelectorAll('button')).forEach(function (b) {
      b.disabled = !single || keys.length === 0;
    });
  }

  q.addEventListener('input', apply);
  [arrSel, minSel, rateSel, qualSel, unplayed].forEach(function (el) {
    if (el) el.addEventListener('change', apply);
  });
  scopeRadios.forEach(function (r) {
    r.addEventListener('change', function () { syncPanels(); apply(); });
  });
  // Changing the target profile can flip the action from an upgrade to a
  // shrink without the selection changing at all.
  if (profileSel) profileSel.addEventListener('change', syncSelection);
  document.querySelectorAll('.preset').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var fn = PRESETS[btn.dataset.preset];
      if (!fn) return;
      resetFilters();
      fn();
      apply();
    });
  });
  // Panels first, then the apply() at the end of this block does the
  // initial filter pass with the right scope already in place.
  syncPanels();
  document.addEventListener('change', function (e) {
    if (!e.target) return;
    if (e.target.classList.contains('pick')) syncSelection();
    if (e.target.classList.contains('pickfile')) syncFiles();
  });

  // "/" focuses the search, the one keyboard nicety worth having on a
  // page whose whole job is finding something.
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; apply(); }
  });

  apply();
})();
"""


def _file_table_html(files, selectable=False, show_ratio=True):
    """Individual files. `ratio` is the point of this table: it says how
    far out of step a file is with its own siblings, which is what makes
    one worth replacing."""
    if not files:
        return '<p class="muted">Nothing to show yet.</p>'
    rows = []
    for f in files:
        hay = html.escape(' '.join(str(x) for x in (
            f.get('label', ''), f.get('name', ''), f.get('quality', ''),
            f.get('codec', ''), f.get('arr', '')) if x))
        sel = ''
        if selectable:
            sel = (f'<td class="sel"><input type="checkbox" class="pickfile" '
                   f'data-arr="{html.escape(str(f.get("arr", "")))}" '
                   f'data-id="{int(f["file_id"])}" '
                   f'aria-label="Select {html.escape(f.get("label") or f["name"])}"></td>')
        if f.get('ratio'):
            cls = ' class="ratio-hot"' if f.get('is_outlier') else ' class="dim"'
            ratio = f'<span{cls}>{f["ratio"]}x</span>'
        else:
            ratio = '<span class="dim">—</span>'
        rows.append(
            f'<tr data-search="{hay}" data-size="{int(f.get("size") or 0)}" '
            f'data-quality="{html.escape(f.get("quality") or "")}" '
            f'data-arr="{html.escape(str(f.get("arr", "")))}" data-plays="0">'
            + sel
            + f'<td>{html.escape(f.get("label") or f["name"])}</td>'
            f'<td class="num" data-sort-value="{int(f.get("size") or 0)}">'
            f'{html.escape(human_bytes(f["size"]))}</td>'
            f'<td class="dim">{html.escape(f.get("quality") or "—")}</td>'
            + (f'<td class="num" data-sort-value="{f.get("ratio") or 0}">{ratio}</td>'
               if show_ratio else '')
            + '</tr>')
    head_sel = '<th class="sel"></th>' if selectable else ''
    ratio_head = ('<th class="num" title="Size compared with the other files '
                  'in the same show">vs siblings</th>') if show_ratio else ''
    return (
        '<table data-scope="files"><thead><tr>' + head_sel +
        '<th>File</th><th class="num">Size</th><th>Quality</th>' + ratio_head +
        '</tr></thead><tbody>' + ''.join(rows) + '</tbody>'
        '</table><p class="no-matches" hidden>Nothing matches that search.</p>')


def _item_table_html(items, watch_source, selectable=False):
    """One item table.

    Every row carries its searchable text in data-search and its identity
    in data-arr/data-id, so the client-side filter and the selection both
    work off the DOM without a second copy of the data."""
    if not items:
        return '<p class="muted">Nothing to show yet.</p>'
    rows = []
    for it in items:
        year = f' <span class="dim">({it["year"]})</span>' if it.get('year') else ''
        rate = (human_bytes(it['per_hour']) + '/h') if it.get('per_hour') else '—'
        played = it.get('last_played') or ('never' if watch_source else '—')
        hay = html.escape(item_haystack(it))
        sel = ''
        if selectable and it.get('id') is not None:
            sel = (f'<td class="sel"><input type="checkbox" class="pick" '
                   f'data-arr="{html.escape(str(it.get("arr", "")))}" '
                   f'data-id="{int(it["id"])}" '
                   f'data-profile="{html.escape(str(it.get("profile") or ""))}" '
                   f'data-title="{html.escape(it["title"])}" '
                   f'aria-label="Select {html.escape(it["title"])}"></td>')
        elif selectable:
            sel = '<td class="sel"></td>'
        rows.append(
            f'<tr data-search="{hay}" data-size="{int(it.get("size") or 0)}" '
            f'data-rate="{int(it.get("per_hour") or 0)}" '
            f'data-plays="{int(it.get("plays") or 0)}" '
            f'data-quality="{html.escape(it.get("quality") or "")}" '
            f'data-arr="{html.escape(str(it.get("arr", "")))}">'
            + sel
            + f'<td>{html.escape(it["title"])}{year}</td>'
            f'<td class="num" data-sort-value="{int(it.get("size") or 0)}">'
            f'{html.escape(human_bytes(it["size"]))}</td>'
            f'<td class="dim">{html.escape(it["quality"] or "—")}</td>'
            f'<td class="dim">{html.escape(it["codec"] or "—")}</td>'
            f'<td class="num dim" data-sort-value="{int(it.get("per_hour") or 0)}">'
            f'{html.escape(rate)}</td>'
            f'<td class="dim">{html.escape(played)}</td>'
            '</tr>')
    head_sel = '<th class="sel"></th>' if selectable else ''
    return (
        '<table data-scope="items"><thead><tr>' + head_sel +
        '<th>Title</th><th class="num">Size</th><th>Quality</th>'
        '<th>Codec</th><th class="num">Per hour</th><th>Last played</th>'
        '</tr></thead><tbody>' + ''.join(rows) + '</tbody>'
        '</table><p class="no-matches" hidden>Nothing matches that search.</p>')


def render_html(report, env=None):
    env = env if env is not None else {}
    can_act = actions_enabled(env)
    parts = []
    add = parts.append

    add('<h1>LibrARRian</h1>')
    add(f'<p class="muted">Where the space went · scanned {html.escape(report["generated"])} '
        f'in {report["elapsed"]}s</p>')

    for w_ in report['warnings']:
        add(f'<div class="banner">{html.escape(w_)}</div>')

    # Disks
    if report['disks']:
        add('<div class="card"><div class="label">Disks</div><div class="grid">')
        for d in report['disks']:
            up = pct(d['used'], d['total'])
            add('<div>'
                f'<div class="muted">{html.escape(d["path"])}</div>'
                f'<div class="stat">{html.escape(human_bytes(d["free"]))} free</div>'
                f'<div class="muted">of {html.escape(human_bytes(d["total"]))} · {up:.0f}% used</div>'
                f'{_meter(up)}'
                '</div>')
        add('</div></div>')

    # Libraries
    add('<div class="card"><div class="label">Libraries</div><table><thead><tr>'
        '<th>Library</th><th class="num">Items</th><th class="num">Files</th>'
        '<th class="num">Size</th><th class="num">Mean</th></tr></thead><tbody>')
    for lib in report['libraries']:
        add('<tr>'
            f'<td>{html.escape(lib["label"])}</td>'
            f'<td class="num">{lib["items"]:,}</td>'
            f'<td class="num">{lib["files"]:,}</td>'
            f'<td class="num">{html.escape(human_bytes(lib["size"]))}</td>'
            f'<td class="num dim">{html.escape(human_bytes(lib["mean"]))}</td>'
            '</tr>')
    add(f'<tr><td><strong>Total</strong></td><td class="num"></td><td class="num"></td>'
        f'<td class="num"><strong>{html.escape(human_bytes(report["library_bytes"]))}</strong></td>'
        f'<td class="num"></td></tr>')
    add('</tbody></table>')
    if report['unaccounted']:
        add(f'<p class="muted" style="margin-top:0.75rem">'
            f'<strong>{html.escape(human_bytes(report["unaccounted"]))}</strong> on disk '
            'is not accounted for by any arr. That covers downloads in progress, '
            'extras, other shares on the same volume, and anything the arrs no '
            'longer track. It is a pointer, not an accusation.</p>')
    add('</div>')

    # Upgrade backlog
    if report['cutoff']:
        add('<div class="card"><div class="label">Upgrade backlog</div>'
            '<p class="muted" style="margin-top:0">Items each arr already considers '
            'below its quality cutoff. It replaces these on the next search.</p>'
            '<table><tbody>')
        for label, count in report['cutoff'].items():
            add(f'<tr><td>{html.escape(label)}</td>'
                f'<td class="num">{count:,} below cutoff</td></tr>')
        add('</tbody></table></div>')

    # Quality mix
    if report['quality_bytes']:
        total_q = sum(report['quality_bytes'].values()) or 1
        add('<div class="card"><div class="label">Space by quality</div><table><tbody>')
        for q, b in sorted(report['quality_bytes'].items(),
                           key=lambda kv: kv[1], reverse=True):
            share = pct(b, total_q)
            add('<tr>'
                f'<td style="width:22%">{html.escape(q)}</td>'
                f'<td class="num" style="width:16%">{html.escape(human_bytes(b))}</td>'
                f'<td class="num dim" style="width:10%">{share:.1f}%</td>'
                f'<td>{_meter(share)}</td>'
                '</tr>')
        add('</tbody></table></div>')

    # Recycle bins
    if report.get('recycle'):
        rec = report['recycle']
        add('<div class="card"><div class="label">Recycle bins</div>'
            '<p class="muted" style="margin-top:0">Where deleted files wait. '
            'This sits on the same filesystem as your media, so a shrink frees '
            'nothing until the bin is cleared, and everything below still '
            'counts as space in use.</p>'
            '<table><thead><tr><th>App</th><th>Path</th>'
            '<th class="num">Kept for</th><th class="num">Files</th>'
            '<th class="num">Size</th></tr></thead><tbody>')
        for r in rec:
            if not r['path']:
                kept, size, count = 'not set', '—', '—'
            else:
                kept = f'{r["cleanup_days"]} days' if r['cleanup_days'] else 'forever'
                size = human_bytes(r['bytes']) if r['readable'] else 'unreadable'
                count = f'{r["files"]:,}' if r['readable'] else '—'
            add('<tr>'
                f'<td>{html.escape(r["label"])}</td>'
                f'<td class="dim">{html.escape(r["host_path"] or "—")}</td>'
                f'<td class="num dim">{html.escape(kept)}</td>'
                f'<td class="num dim">{html.escape(str(count))}</td>'
                f'<td class="num" data-sort-value="{int(r["bytes"])}">'
                f'{html.escape(size)}</td>'
                '</tr>')
        add('<tr><td><strong>Total</strong></td><td></td><td></td>'
            f'<td class="num"><strong>{sum(r["files"] for r in rec):,}</strong></td>'
            f'<td class="num"><strong>{html.escape(human_bytes(report["recycle_bytes"]))}'
            '</strong></td></tr>')
        add('</tbody></table>')
        if any(r['cleanup_days'] == 0 and r['path'] for r in rec):
            add('<p class="muted">A bin set to keep things <strong>forever</strong> '
                'is never cleared by the arr on its own. Set Recycle Bin Cleanup '
                'in that app, or empty it here.</p>')
        if can_act and report['recycle_bytes']:
            add('<form method="POST" action="/plan">'
                '<input type="hidden" name="mode" value="empty">'
                '<div class="actions">'
                '<button type="submit" class="danger">Empty now</button>'
                f'<span class="muted">Reclaims {html.escape(human_bytes(report["recycle_bytes"]))} '
                'straight away. This is permanent, and the recycle bin is the '
                'thing that made the last delete recoverable.</span>'
                '</div></form>')
        elif report['recycle_bytes'] and not can_act:
            add('<p class="muted">Emptying needs write mode '
                '(<code>LIBRARIAN_ALLOW_ACTIONS</code>).</p>')
        add('</div>')

    # ── One results table ────────────────────────────────────────────
    #
    # This used to be five cards: biggest items, most bloated, big and
    # never played, largest files, files out of step. Every one of them
    # was the same rows in a different order, so the same title showed up
    # three times and you had to know which card answered your question.
    # Now there is one table, and the orderings are what the sort headers
    # and the quick views do. Titles and files stay separate scopes: they
    # are different rows with different actions, not one list.
    items = sorted(report['items'], key=lambda i: i.get('size') or 0, reverse=True)
    files = sorted(report.get('files') or [], key=lambda f: f['size'], reverse=True)

    arr_opts = ''.join(
        f'<option value="{html.escape(n)}">{html.escape(ARRS[n]["label"])}</option>'
        for n in (report.get('connections') or {}) if n in ARRS)
    qual_opts = ''.join(
        f'<option value="{html.escape(q)}">{html.escape(q)}</option>'
        for q, _b in sorted((report.get('quality_bytes') or {}).items(),
                            key=lambda kv: kv[1], reverse=True))

    scope_tabs = ('<label class="scope-tab"><input type="radio" name="scope" value="items" checked>'
                  f'<span>Titles <b>{len(items)}</b></span></label>')
    if files:
        scope_tabs += ('<label class="scope-tab"><input type="radio" name="scope" value="files">'
                       f'<span>Files <b>{len(files)}</b></span></label>')

    # Quick views replace what the old card headings used to advertise.
    # Without them, "most bloated" stops being something you can find by
    # reading the page and becomes something you have to already know.
    presets = ['<button type="button" class="preset" data-preset="biggest">Biggest</button>',
               '<button type="button" class="preset" data-preset="bloated">Most bloated</button>']
    if report['watch_source']:
        presets.append('<button type="button" class="preset" data-preset="unplayed">'
                       'Never played</button>')
    if any(f.get('is_outlier') for f in files):
        presets.append('<button type="button" class="preset" data-preset="outliers">'
                       'Out of step</button>')

    add('<div class="card"><div class="label">Results</div>'
        f'<div class="scope">{scope_tabs}</div>'
        '<div class="filters">'
        '<input type="search" id="q" placeholder="Search title, quality, codec. Press / to focus" '
        'autocomplete="off" spellcheck="false">'
        f'<select id="f-arr"><option value="">All apps</option>{arr_opts}</select>'
        '<select id="f-min">'
        '<option value="0">Any size</option>'
        '<option value="1073741824">Over 1 GB</option>'
        '<option value="5368709120">Over 5 GB</option>'
        '<option value="10737418240">Over 10 GB</option>'
        '<option value="21474836480">Over 20 GB</option>'
        '<option value="53687091200">Over 50 GB</option>'
        '</select>'
        '<select id="f-rate" data-items-only title="Bytes per hour of runtime">'
        '<option value="0">Any rate</option>'
        '<option value="1073741824">Over 1 GB/h</option>'
        '<option value="2147483648">Over 2 GB/h</option>'
        '<option value="4294967296">Over 4 GB/h</option>'
        '<option value="8589934592">Over 8 GB/h</option>'
        '<option value="16106127360">Over 15 GB/h</option>'
        '</select>'
        f'<select id="f-qual"><option value="">Any quality</option>{qual_opts}</select>'
        + ('<label data-items-only><input type="checkbox" id="f-unplayed"> Never played</label>'
           if report['watch_source'] else '')
        + '<span class="filter-count" id="filter-count"></span>'
        '</div>'
        + (f'<div class="presets"><span class="muted">Quick views</span>{"".join(presets)}'
           '</div>' if presets else '')
        + '<p class="muted" style="margin:0 0 0.8rem">Click any column to sort by it, '
        'again to flip. Matching is fuzzy, so <code>rmx 216</code> finds Remux-2160p, '
        'and several words all have to match. The rate filter is the one that catches '
        'a bloated 90-minute film, which no size floor ever will.</p>'
        f'<div data-scope-panel="items">{_item_table_html(items, report["watch_source"], can_act)}</div>')

    if files:
        shown_outliers = human_bytes(report.get('outlier_bytes') or 0)
        add('<div data-scope-panel="files" hidden>'
            '<p class="muted" style="margin-top:0">Every file on its own, rather than '
            'rolled up into the movie or series that owns it. <b>vs siblings</b> is how '
            'far a file is out of step with the rest of its own show, which is the '
            'signal that matters: 40 GB means nothing on its own, six times the rest of '
            'the same series means a lot. '
            f'<strong>{html.escape(shown_outliers)}</strong> sits in files well clear of '
            'their siblings.</p>'
            + _file_table_html(files, can_act) + '</div>')

    add('</div>')

    if can_act:
        prof_opts = []
        for name, conn in (report.get('connections') or {}).items():
            for prof in conn.get('profiles') or []:
                prof_opts.append(
                    f'<option value="{int(prof["id"])}" data-arr="{html.escape(name)}" '
                    f'data-rank="{int(prof.get("rank", -1))}">'
                    f'{html.escape(str(prof["name"]))}</option>')
        # One button, not two. Upgrade and shrink were never a choice the
        # user makes, they're a consequence of the profile picked versus
        # what each item already has, so the page works that out instead of
        # asking. The label and the colour say which way it went before you
        # press it; build_plan decides for real, per item.
        add('<form method="POST" action="/plan">'
            '<div class="action-bar" id="action-bar" hidden>'
            '<span class="sel-count" id="sel-count">0 selected</span>'
            '<input type="hidden" name="ids" id="ids">'
            '<input type="hidden" name="arr" id="action-arr">'
            '<input type="hidden" name="mode" value="apply">'
            '<label class="muted">Target profile '
            f'<select name="profile" id="profile">{"".join(prof_opts)}</select></label>'
            '<button type="submit" id="apply-btn">Apply</button>'
            '<span class="muted" id="direction-note"></span>'
            '<span class="muted" id="sel-warn" hidden></span>'
            '</div></form>')
        # Files get their own bar. Replacing a file is a different action
        # from re-grading an item, and mixing the two selections in one
        # control would only invite picking the wrong one.
        add('<form method="POST" action="/plan">'
            '<div class="action-bar" id="file-action-bar" hidden>'
            '<span class="sel-count" id="file-sel-count">0 files selected</span>'
            '<input type="hidden" name="ids" id="file-ids">'
            '<input type="hidden" name="arr" id="file-action-arr">'
            '<input type="hidden" name="mode" value="replace">'
            '<button type="submit" class="danger">Replace file(s)</button>'
            '<span class="muted">Deletes just these files and searches for '
            'what they covered. The quality profile is left alone.</span>'
            '<span class="muted" id="file-sel-warn" hidden></span>'
            '</div></form>')

    add('<div class="card"><form method="POST" action="/rescan">'
        '<button type="submit">Rescan now</button> '
        f'<span class="muted">Results are cached for {CACHE_TTL_SECONDS // 60} minutes.</span>'
        '</form></div>')

    if can_act:
        hint = ('Write mode is on, which is the default. Upgrades never '
                'delete anything. Shrink deletes the current files through the '
                'arr, so they land in its Recycle Bin, and refuses to run at '
                'all if no Recycle Bin is configured. Every action shows you '
                'the exact plan before it does anything. Set '
                'LIBRARIAN_ALLOW_ACTIONS=false in .env for a read-only page.')
    else:
        hint = ('This page is read-only, because LIBRARIAN_ALLOW_ACTIONS is '
                'set to false. It issues nothing but GETs, so it cannot edit a '
                'profile, trigger a search, or delete a file. Set that key back '
                'to true, or drop the line entirely, to turn re-grab actions '
                'on again.')
    add(f'<p class="hint">{hint} Same report on the command line: '
        '<code>python3 librarian.py --report</code>, or '
        '<code>--json</code> for the raw numbers. '
        '<a href="/api/report.json">JSON endpoint</a>.</p>')

    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>LibrARRian · storage report</title>'
        f'<style>{CSS}</style></head><body>' + ''.join(parts) +
        f'<script>{SCRIPT}</script></body></html>')


def _page(body, code_note=''):
    return ('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>LibrARRian</title>'
            f'<style>{CSS}</style></head><body>{body}</body></html>')


def render_plan_html(plan, token):
    """The confirmation page. Deliberately verbose about the destructive
    case: this is the last screen before files move."""
    # An empty plan lists bins. It gets its own warning because it's the
    # only action here with no undo: everything else lands in the recycle
    # bin, and this IS the recycle bin.
    if plan['mode'] == 'empty':
        rows = ''.join(
            '<tr>'
            f'<td>{html.escape(e["label"])}</td>'
            f'<td class="num">{html.escape(human_bytes(e["bytes"]))}</td>'
            f'<td class="dim">{e["files"]:,} file(s)</td>'
            f'<td class="dim">{html.escape(e["host_path"])}</td>'
            '</tr>'
            for e in plan['recycle'])
        steps = ''.join(f'<li>{html.escape(x)}</li>' for x in plan['steps'])
        return _page(
            '<h1>LibrARRian</h1>'
            f'<p class="muted">Confirm: empty {len(plan["recycle"])} recycle bin(s)</p>'
            '<div class="plan-warn"><strong>This cannot be undone.</strong> '
            f'{sum(e["files"] for e in plan["recycle"]):,} file(s), '
            f'{html.escape(human_bytes(plan["total_size"]))}, will be removed from '
            'disk for good. Every other action on this page is recoverable '
            'because it puts files here first. Nothing catches this one.<br><br>'
            'The space comes back immediately.</div>'
            '<div class="card"><div class="label">What will happen</div>'
            f'<ol class="plan-steps">{steps}</ol></div>'
            '<div class="card"><div class="label">Bins</div>'
            '<table><thead><tr><th>App</th><th class="num">Size</th>'
            '<th>Contents</th><th>Path</th></tr></thead><tbody>'
            + rows + '</tbody></table></div>'
            '<div class="card"><form method="POST" action="/apply">'
            f'<input type="hidden" name="token" value="{html.escape(token)}">'
            '<button type="submit" class="danger">'
            f'Yes, permanently delete {html.escape(human_bytes(plan["total_size"]))}</button> '
            '<a href="/" style="margin-left:0.75rem">Cancel</a>'
            '</form></div>')

    # A replace plan lists files; upgrade and shrink list items.
    if plan['mode'] == 'replace':
        entries = [{'name': f['label'], 'size': f['size'],
                    'quality': f.get('quality') or '', 'extra':
                    (f'{f["ratio"]}x its siblings' if f.get('ratio') else '')}
                   for f in plan['files']]
        noun = 'file'
    else:
        entries = [{'name': i['title'] + (f' ({i["year"]})' if i.get('year') else ''),
                    'size': i['size'], 'quality': i.get('quality') or '',
                    'extra': ('files deleted first'
                              if i.get('direction') == 'down' else 'no delete')}
                   for i in plan['items']]
        noun = 'item'

    rows = ''.join(
        '<tr>'
        f'<td>{html.escape(e["name"])}</td>'
        f'<td class="num">{html.escape(human_bytes(e["size"]))}</td>'
        f'<td class="dim">{html.escape(e["quality"] or "—")}</td>'
        f'<td class="dim">{html.escape(e["extra"])}</td>'
        '</tr>'
        for e in entries)

    steps = ''.join(f'<li>{html.escape(x)}</li>' for x in plan['steps'])
    if plan['mode'] == 'replace':
        verb = 'Replace'
    elif plan['deletes_files']:
        verb = 'Shrink'
    else:
        verb = 'Upgrade'

    warn = ''
    if plan['deletes_files']:
        # Only the items the target is actually a downgrade for lose files.
        # Warning about the whole selection would overstate it and train
        # people to skim the one screen that matters.
        down = len(plan.get('down_ids') or []) or len(entries)
        down_size = plan.get('down_size') or plan['total_size']
        rest = len(entries) - down
        also = (f' The other {rest} {noun}(s) keep their files, because that '
                'profile is not a downgrade for them.' if rest > 0 else '')
        warn = (
            '<div class="plan-warn"><strong>This deletes files.</strong> '
            f'{down} of {len(entries)} {noun}(s) sit above '
            f'"{html.escape(plan["profile_name"])}" today, so their current files '
            f'({html.escape(human_bytes(down_size))} on disk) are removed through '
            f'the arr and replaced by a fresh search.{html.escape(also)}<br><br>'
            f'They go to the Recycle Bin at <code>{html.escape(plan["recycle_bin"])}</code>, '
            'so they are recoverable until you empty it. Each one is unavailable '
            'between the delete and a new release importing, and for something '
            'obscure that could be a while.</div>')

    return _page(
        '<h1>LibrARRian</h1>'
        f'<p class="muted">Confirm: {verb.lower()} {len(entries)} {noun}(s) '
        f'in {html.escape(plan["label"])}</p>'
        + warn +
        '<div class="card"><div class="label">What will happen</div>'
        f'<ol class="plan-steps">{steps}</ol></div>'
        '<div class="card"><div class="label">Items</div>'
        '<table><thead><tr><th>Name</th><th class="num">Size</th>'
        '<th>Current quality</th><th></th></tr></thead><tbody>'
        + rows + '</tbody></table></div>'
        '<div class="card"><form method="POST" action="/apply">'
        f'<input type="hidden" name="token" value="{html.escape(token)}">'
        f'<button type="submit" class="{"danger" if plan["deletes_files"] else ""}">'
        f'Yes, {verb.lower()} {len(entries)} {noun}(s)</button> '
        '<a href="/" style="margin-left:0.75rem">Cancel</a>'
        '</form></div>')


def render_result_html(plan, results):
    ok = len(results['ok'])
    bad = results['failed']
    body = ['<h1>LibrARRian</h1>']
    if bad:
        body.append('<div class="banner err">Finished with problems.</div>')
    else:
        body.append('<div class="banner ok">Done.</div>')
    # Emptying a bin re-grades nothing, so the profile row would just read
    # blank. Report the space instead, which is the point of having run it.
    if plan['mode'] == 'empty':
        tail = (f'<div class="row"><span>Space reclaimed</span><strong>'
                f'{html.escape(human_bytes(plan["total_size"]))}</strong></div>')
    else:
        tail = (f'<div class="row"><span>New profile</span><strong>'
                f'{html.escape(plan["profile_name"])}</strong></div>')
    body.append(
        '<div class="card"><div class="label">Result</div>'
        f'<div class="row"><span>Items actioned</span><strong>{ok}</strong></div>'
        f'<div class="row"><span>Files deleted</span><strong>{results["deleted_files"]}</strong></div>'
        + tail + '</div>')
    if bad:
        body.append('<div class="card"><div class="label">Problems</div><pre>'
                    + html.escape('\n'.join(bad)) + '</pre></div>')
    if results['notes']:
        body.append('<div class="card"><div class="label">Notes</div><pre>'
                    + html.escape('\n'.join(results['notes'])) + '</pre></div>')
    body.append('<p class="hint">Searches run in the background, so give the arr '
                'a few minutes. <a href="/">Back to the report</a>.</p>')
    return _page(''.join(body))


# ── Server ───────────────────────────────────────────────────────────

_CACHE = {'report': None, 'at': 0.0}
_SCAN_LOCK = threading.Lock()


def cached_report(force=False):
    """Serve the memoised report unless it's stale or a rescan was asked
    for. The lock is single-flight, not queueing: a second request while
    a scan is running gets the previous (or an empty) report rather than
    piling more concurrent pulls onto the arrs."""
    now = time.time()
    fresh = (_CACHE['report'] is not None
             and (now - _CACHE['at']) < CACHE_TTL_SECONDS)
    if fresh and not force:
        return _CACHE['report'], False

    if not _SCAN_LOCK.acquire(blocking=False):
        return _CACHE['report'], True  # someone else is scanning

    try:
        report = build_report()
        _CACHE['report'] = report
        _CACHE['at'] = time.time()
        return report, False
    finally:
        _SCAN_LOCK.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # request-log spam makes `docker logs librarian` useless

    def log_error(self, fmt, *args):
        super().log_message(fmt, *args)

    def _send(self, body, content_type='text/html; charset=utf-8', code=200):
        encoded = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(encoded)

    def _check_csrf(self):
        """Same minimal DNS-rebinding guard recyclarr-trigger uses: an
        absent Origin (curl, a Homepage tile click) passes; a present one
        must match our own Host. POST /rescan is only a re-read, so this
        is belt not braces — but it costs nothing."""
        origin = self.headers.get('Origin', '')
        if not origin:
            return True
        try:
            return urllib.parse.urlparse(origin).netloc == self.headers.get('Host', '')
        except Exception:
            return False

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            report, busy = cached_report()
            if report is None:
                self._send(
                    '<!DOCTYPE html><html><head><meta charset="utf-8">'
                    '<meta http-equiv="refresh" content="4">'
                    f'<title>LibrARRian</title><style>{CSS}</style></head><body>'
                    '<h1>LibrARRian</h1><p class="muted">First scan running. '
                    'This page refreshes itself.</p></body></html>', code=503)
                return
            html_body = render_html(report, read_env())
            if busy:
                html_body = html_body.replace(
                    '<h1>LibrARRian</h1>',
                    '<h1>LibrARRian</h1><div class="banner warn">A scan is already '
                    'running, so this is the previous result.</div>', 1)
            self._send(html_body)
            return

        if self.path in ('/api/report.json', '/report.json'):
            report, _ = cached_report()
            self._send(json.dumps(public_report(report), indent=2, default=str),
                       'application/json; charset=utf-8',
                       200 if report else 503)
            return

        if self.path == '/healthz':
            self._send('ok', 'text/plain; charset=utf-8')
            return

        self.send_error(404)

    def _read_form(self):
        """Parse a urlencoded POST body. Capped small: every form here is
        a handful of fields, so a large body is a mistake or an abuse."""
        length = int(self.headers.get('Content-Length', '0') or '0')
        if length <= 0 or length > 64_000:
            return {}
        raw = self.rfile.read(length).decode('utf-8', errors='replace')
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw).items() if v}

    def _error_page(self, message, code=400):
        self._send(_page(
            '<h1>LibrARRian</h1>'
            f'<div class="banner err">{html.escape(message)}</div>'
            '<p class="hint"><a href="/">Back to the report</a></p>'),
            code=code)

    def _issue_token(self, plan):
        """Single-use token for one exact plan. Applying requires having
        been shown that plan, so a bare POST to /apply can't do anything.
        Expired tokens are swept on the way past."""
        token = secrets.token_urlsafe(24)
        with _ACTION_LOCK:
            now = time.time()
            for t, (_, ts) in list(ACTION_TOKENS.items()):
                if now - ts > ACTION_TOKEN_TTL:
                    ACTION_TOKENS.pop(t, None)
            ACTION_TOKENS[token] = (plan, now)
        return token

    def do_POST(self):
        if not self._check_csrf():
            self.send_error(403, 'Cross-origin POST rejected (CSRF protection)')
            return

        if self.path == '/rescan':
            cached_report(force=True)
            self.send_response(303)
            self.send_header('Location', '/')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        # ── Plan: works out what would happen, changes nothing ────────
        if self.path == '/plan':
            report, _ = cached_report()
            if report is None:
                self._error_page('No scan yet — let the first one finish.', 503)
                return
            form = self._read_form()
            env = read_env()
            # Emptying the recycle bins selects nothing and targets no arr,
            # so it short-circuits the id/profile parsing below.
            if (form.get('mode') or '').strip() == 'empty':
                try:
                    plan = build_empty_plan(report, env)
                except LibrarianSourceError as e:
                    self._error_page(str(e))
                    return
                self._send(render_plan_html(plan, self._issue_token(plan)))
                return
            try:
                ids = [int(x) for x in (form.get('ids') or '').split(',') if x.strip()]
            except ValueError:
                self._error_page('Malformed selection.')
                return
            if not ids:
                self._error_page('Nothing was selected.')
                return
            try:
                profile_id = int(form.get('profile') or 0)
            except ValueError:
                self._error_page('Malformed profile.')
                return
            try:
                mode = (form.get('mode') or '').strip()
                if mode == 'replace':
                    plan = build_file_plan(report, env,
                                           (form.get('arr') or '').strip(), ids)
                else:
                    # 'upgrade' and 'shrink' were separate buttons once. A
                    # page cached from back then still posts them, and they
                    # both mean the same thing now: apply this profile and
                    # work the direction out per item.
                    plan = build_plan(report, env,
                                      (form.get('arr') or '').strip(), profile_id, ids)
            except LibrarianSourceError as e:
                self._error_page(str(e))
                return

            self._send(render_plan_html(plan, self._issue_token(plan)))
            return

        # ── Apply: only ever runs a plan that was already shown ───────
        if self.path == '/apply':
            form = self._read_form()
            token = (form.get('token') or '').strip()
            with _ACTION_LOCK:
                entry = ACTION_TOKENS.pop(token, None)   # single use
            if not entry:
                self._error_page(
                    'That confirmation has expired or was already used. '
                    'Make the selection again.', 409)
                return
            plan, _ts = entry

            report, _ = cached_report()
            env = read_env()
            # Re-check on the way in. The flag could have been turned off,
            # or the scan replaced, between planning and confirming.
            if not actions_enabled(env):
                self._error_page('Actions are disabled.', 403)
                return
            # Emptying a recycle bin touches the filesystem, not an arr, so
            # it has no arr to be reachable. Everything else does.
            if plan['mode'] != 'empty' and (
                    report is None
                    or plan['arr'] not in (report.get('connections') or {})):
                self._error_page(f'{plan["arr"]} is not reachable right now.', 503)
                return
            if not _SCAN_LOCK.acquire(blocking=False):
                self._error_page('A scan is running — try again in a moment.', 409)
                return
            try:
                if plan['mode'] == 'empty':
                    results = execute_empty_plan(report, env, plan)
                elif plan['mode'] == 'replace':
                    results = execute_file_plan(report, env, plan)
                else:
                    results = execute_plan(report, env, plan)
            except LibrarianSourceError as e:
                self._error_page(str(e), 502)
                return
            finally:
                _SCAN_LOCK.release()
            # Sizes and profiles just changed, so the cached scan is stale.
            _CACHE['at'] = 0.0
            self._send(render_result_html(plan, results))
            return

        self.send_error(404)


def serve(port):
    addr = ('0.0.0.0', port)
    acting = 'ON' if actions_enabled(read_env()) else 'off (read-only)'
    print(f'LibrARRian listening on http://{addr[0]}:{port}/ '
          f'(GET / · GET /api/report.json · POST /rescan · POST /plan · POST /apply)\n'
          f'  re-grab actions: {acting}', flush=True)
    # Warm the cache in the background so the first visitor doesn't
    # stare at the "first scan running" holding page.
    threading.Thread(target=lambda: cached_report(force=True), daemon=True).start()
    HTTPServer(addr, Handler).serve_forever()


# ── Entry point ──────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description='Analyse what the media stack is storing and where the space went.')
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--report', action='store_true',
                      help='print a text report and exit')
    mode.add_argument('--json', action='store_true',
                      help='print the report as JSON and exit')
    mode.add_argument('--serve', action='store_true',
                      help='run the web UI (the default with no arguments)')
    ap.add_argument('--port', type=int, default=int(os.environ.get('LIBRARIAN_PORT', DEFAULT_PORT)),
                    help=f'port for --serve (default {DEFAULT_PORT})')
    ap.add_argument('--top', type=int, default=25,
                    help='rows per table in the report (default 25)')
    ap.add_argument('--fast', action='store_true',
                    help='skip the per-series quality breakdown (much faster '
                         'on a large TV library)')
    ap.add_argument('--filter', '-f', default='', metavar='QUERY',
                    help='fuzzy-match items by title, quality, codec or app. '
                         'Several words must all match, e.g. -f "sonarr remux"')
    ap.add_argument('--min-size', default='', metavar='SIZE',
                    help='only items at least this big, e.g. 20GB')
    ap.add_argument('--min-rate', default='', metavar='RATE',
                    help='only items above this many bytes per hour of '
                         'runtime, e.g. 4GB. Catches a bloated 90-minute '
                         'film, which --min-size never will')
    ap.add_argument('--quality', default='', metavar='NAME',
                    help='only items whose quality contains NAME, e.g. remux')
    ap.add_argument('--arr', default='', choices=['', 'radarr', 'sonarr', 'lidarr'],
                    help='restrict to one app')
    ap.add_argument('--unplayed', action='store_true',
                    help='only items that have never been played (needs Tautulli '
                         'or Jellyfin)')
    args = ap.parse_args()

    if args.report or args.json:
        report = build_report(top_n=args.top, quality_detail=not args.fast)

        # Any narrowing option rebuilds the item tables from the filtered
        # set, so the report answers the question you actually asked
        # rather than showing the global top-N with holes in it.
        if (args.filter or args.min_size or args.min_rate or args.quality
                or args.arr or args.unplayed):
            picked = filter_items(
                report['items'], query=args.filter,
                min_size=parse_size(args.min_size), quality=args.quality,
                unplayed=args.unplayed, arr=args.arr,
                min_rate=parse_size(args.min_rate))
            report['filtered'] = {
                'query': args.filter, 'min_size': args.min_size,
                'min_rate': args.min_rate,
                'quality': args.quality, 'arr': args.arr,
                'unplayed': args.unplayed, 'matched': len(picked),
                'of': len(report['items']),
            }
            report['top_by_size'] = picked[:args.top]
            report['top_by_rate'] = sorted(
                [i for i in picked if i.get('per_hour')],
                key=lambda i: i['per_hour'], reverse=True)[:args.top]
            report['big_unwatched'] = (
                [i for i in picked if i['kind'] == 'movie' and not i.get('plays')][:args.top]
                if report['watch_source'] else [])

            # Files narrow by the same query, so `--filter severance` shows
            # that show's files rather than the whole library's.
            fpick = [f for f in report.get('files') or []
                     if (not args.arr or f.get('arr') == args.arr)
                     and (not args.min_size or f['size'] >= parse_size(args.min_size))
                     and (not args.quality or args.quality.lower() in (f.get('quality') or '').lower())
                     and (not args.filter or fuzzy_score(args.filter, ' '.join(str(x) for x in (
                         f.get('label', ''), f.get('quality', ''), f.get('codec', ''),
                         f.get('arr', '')) if x))[0])]
            report['top_files'] = sorted(fpick, key=lambda f: f['size'], reverse=True)[:args.top]
            report['outlier_files'] = sorted(
                [f for f in fpick if f.get('is_outlier')],
                key=lambda f: (f['ratio'], f['size']), reverse=True)[:args.top]
            report['outlier_bytes'] = sum(f['size'] for f in fpick if f.get('is_outlier'))
        if args.json:
            print(json.dumps(public_report(report), indent=2, default=str))
        else:
            print(render_text(report))
        # Exit 0 even with warnings: a partial report is a successful
        # run. Only an unusable one (no library reachable at all) is a
        # failure worth a non-zero code.
        return 0 if report['libraries'] else 1

    serve(args.port)
    return 0


if __name__ == '__main__':
    sys.exit(main())
