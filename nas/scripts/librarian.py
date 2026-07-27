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

Read-only by default. Left alone this script issues nothing but GETs,
so it cannot edit a profile, trigger a search, or delete a file, and you
can point it at a live library without a second thought.

Set LIBRARIAN_ALLOW_ACTIONS=true and it additionally offers re-grab:

  Upgrade  set a higher quality profile on the selected items, then
           search. Nothing is deleted. Each existing file stays until a
           better release actually imports.
  Shrink   set a LOWER profile FIRST, then delete the current files
           through the arr, then search. The order is the whole point:
           search before the profile change and you re-grab the release
           you were trying to replace.

Actions are gated separately from ENABLE_LIBRARIAN because this page has
no authentication — turning on a report must not hand everyone who can
reach the port a delete button. On top of that, a delete refuses unless
the arr has a Recycle Bin configured, every action is planned and then
confirmed against a single-use token, runs are capped, and what was done
(including deleted paths) is appended to an audit log.
"""

import argparse
import configparser
import html
import json
import os
import re
import secrets
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


def filter_items(items, query='', min_size=0, quality='', unplayed=False, arr=''):
    """Apply every filter, then sort by relevance when a query is given
    and by size when one isn't. Filters are AND, which is what people
    expect from a row of controls."""
    out = []
    for it in items:
        if min_size and (it.get('size') or 0) < min_size:
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
    items = []
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
    return items, {}, None


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

    quality_bytes = {}
    if want_quality_detail and items:
        quality_bytes = _sonarr_quality_mix(base, key, api, items, id_by_index)

    return items, {'quality_bytes': quality_bytes}, None


def _sonarr_quality_mix(base, key, api, items, series_ids):
    """Bytes-by-quality across every episode file, plus a per-series
    dominant quality + codec written back onto `items`.

    Failures here are per-series and swallowed: one series whose files
    the API won't enumerate shouldn't cost us the other 299."""
    totals = {}

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
        local, codecs = {}, {}
        for f in files or []:
            if not isinstance(f, dict):
                continue
            q = ((f.get('quality') or {}).get('quality') or {}).get('name') or 'Unknown'
            local[q] = local.get(q, 0) + (f.get('size') or 0)
            codec = ((f.get('mediaInfo') or {}).get('videoCodec') or '')
            if codec:
                codecs[codec] = codecs.get(codec, 0) + 1
        return idx, local, codecs

    with ThreadPoolExecutor(max_workers=DETAIL_WORKERS) as pool:
        for result in pool.map(one, list(enumerate(series_ids))):
            if not result:
                continue
            idx, local, codecs = result
            for q, b in local.items():
                totals[q] = totals.get(q, 0) + b
            if local:
                # "Dominant" = the tier holding the most bytes. A series
                # part-upgraded to 2160p reads as 2160p once most of it
                # is, which is the honest summary for a one-line cell.
                items[idx]['quality'] = max(local.items(), key=lambda kv: kv[1])[0]
            if codecs:
                items[idx]['codec'] = max(codecs.items(), key=lambda kv: kv[1])[0]
    return totals


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
    disks = []
    for d in data or []:
        if not isinstance(d, dict):
            continue
        total = d.get('totalSpace') or 0
        free = d.get('freeSpace') or 0
        if not total:
            continue
        disks.append({
            'path': d.get('path') or '?',
            'label': d.get('label') or '',
            'total': total,
            'free': free,
            'used': max(total - free, 0),
        })
    return disks


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
# Why actions are OFF by default, separately from ENABLE_LIBRARIAN:
# this web UI has no authentication. Anyone who can reach the port can
# use it, which is fine for a report and emphatically not fine for a
# delete button. Turning the report on must not hand the whole LAN the
# ability to remove media, so the capability has its own explicit flag.
#
# On top of that, in order:
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
    """Explicit-true only. A missing key means off, matching the opt-in
    convention the rest of the stack uses for anything consequential."""
    return (env.get('LIBRARIAN_ALLOW_ACTIONS') or '').strip().lower() in (
        '1', 'true', 'yes', 'on')


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
    return [{'id': p.get('id'), 'name': p.get('name')}
            for p in (data or []) if isinstance(p, dict) and p.get('id') is not None]


def recycle_bin_path(base, key, api):
    """The arr's configured Recycle Bin, or '' when it has none.

    This is the difference between a delete you can undo and one you
    cannot. Deleting through the arr's API moves the file here rather
    than unlinking it, but only if it's set."""
    data = http_json(f'{base}/api/{api}/config/mediamanagement',
                     arr_headers(key), timeout=30)
    if isinstance(data, dict):
        return (data.get('recycleBin') or '').strip()
    return ''


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


def build_plan(report, env, mode, arr_name, profile_id, item_ids):
    """Work out exactly what an action would do, without doing any of it.

    Returns a plan dict. Raises LibrarianSourceError with a plain-English
    reason when the action isn't allowed, which the UI shows verbatim.
    """
    if mode not in ('upgrade', 'shrink'):
        raise LibrarianSourceError(f'unknown action "{mode}"')
    if not actions_enabled(env):
        raise LibrarianSourceError(
            'Actions are disabled. Set LIBRARIAN_ALLOW_ACTIONS=true in .env '
            'and re-run the installer to enable them.')

    spec = ACTION_SPEC.get(arr_name)
    conn = (report.get('connections') or {}).get(arr_name)
    if not spec or not conn:
        raise LibrarianSourceError(f'{arr_name} is not reachable right now')
    if mode == 'shrink' and not spec['can_shrink']:
        raise LibrarianSourceError(
            f'Shrinking is not offered for {arr_name}: it would mean deleting '
            'every file the item owns, which is too blunt to put behind one '
            'button. Change the profile in the app if you really want it.')

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

    plan = {
        'mode': mode,
        'arr': arr_name,
        'label': ARRS[arr_name]['label'],
        'profile_id': profile_id,
        'profile_name': target['name'],
        'items': [{'id': i['id'], 'title': i['title'], 'year': i.get('year'),
                   'size': i.get('size') or 0, 'quality': i.get('quality') or '',
                   'path': i.get('path') or ''} for i in items],
        'total_size': sum(i.get('size') or 0 for i in items),
        'deletes_files': mode == 'shrink',
        'recycle_bin': '',
        'steps': [],
    }

    if mode == 'upgrade':
        plan['steps'] = [
            f'Set the quality profile of {len(items)} item(s) to "{target["name"]}".',
            'Trigger a search for each one.',
            'Nothing is deleted. Each existing file stays until a better '
            'release actually imports, so nothing goes missing in the meantime.',
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
            f'Set the quality profile of {len(items)} item(s) to "{target["name"]}" FIRST.',
            f'Delete their current files, which the Recycle Bin at {bin_path} will catch.',
            'Trigger a search under the new profile.',
            'Order matters: profile first, or the search re-grabs the same '
            'release you are replacing. Each item is unavailable between the '
            'delete and the new release importing.',
        ]
    return plan


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

    # 2. Delete, on a shrink only, and only through the arr so the
    #    Recycle Bin applies.
    if plan['deletes_files']:
        for item in plan['items']:
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
                f'{spec["label"]}: no {spec["env_key"]} in .env — skipped.')
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
    for d in report['disks']:
        d['is_media'] = any(
            (r or '').startswith(d['path']) for r in report['root_paths'])
    media_used = sum(d['used'] for d in report['disks'] if d.get('is_media'))
    report['media_used'] = media_used
    report['unaccounted'] = max(media_used - library_bytes, 0) if media_used else 0

    for it in report['items']:
        it['per_hour'] = bytes_per_hour(it['size'], it['minutes'])

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
    add('  Mediarr Librarian — storage report')
    add(f'  generated {report["generated"]}  ({report["elapsed"]}s)')
    f = report.get('filtered')
    if f:
        bits = []
        if f['query']:    bits.append(f'match "{f["query"]}"')
        if f['min_size']: bits.append(f'≥ {f["min_size"]}')
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
* { box-sizing: border-box; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: #0f172a; color: #e2e8f0;
  padding: 2rem 1rem; max-width: 1100px; margin: 0 auto;
}
h1 { font-weight: 600; color: #34d399; margin: 0 0 0.25rem 0; }
h2 { font-size: 1rem; font-weight: 600; margin: 0 0 0.75rem 0; }
.muted { color: #94a3b8; font-size: 0.875rem; }
.card {
  background: #1e293b; border: 1px solid #334155;
  border-radius: 0.5rem; padding: 1rem; margin: 1rem 0;
}
.label {
  color: #64748b; font-size: 0.7rem; text-transform: uppercase;
  letter-spacing: 0.05em; margin-bottom: 0.75rem;
}
table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
th {
  text-align: left; color: #64748b; font-weight: 500;
  font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 0 0.5rem 0.5rem 0; border-bottom: 1px solid #334155;
}
td { padding: 0.45rem 0.5rem 0.45rem 0; border-bottom: 1px solid #263449; }
tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; }
.dim { color: #94a3b8; }
.meter {
  height: 0.4rem; background: #0b1220; border-radius: 999px;
  overflow: hidden; margin-top: 0.35rem;
}
.meter > span { display: block; height: 100%; background: #10b981; }
.meter.warn > span { background: #f59e0b; }
.meter.hot  > span { background: #ef4444; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 1rem; }
.stat { font-size: 1.5rem; font-weight: 600; }
.banner {
  border-radius: 0.375rem; padding: 0.75rem 1rem;
  margin: 1rem 0; font-size: 0.9rem;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3); color: #fcd34d;
}
button {
  background: #10b981; color: white; border: none;
  padding: 0.7rem 1.4rem; font-size: 0.95rem; font-weight: 600;
  border-radius: 0.375rem; cursor: pointer;
}
button:hover { background: #059669; }
code {
  background: #0b1220; padding: 0.125rem 0.375rem;
  border-radius: 0.25rem; font-size: 0.875em;
}
.hint { font-size: 0.8rem; color: #64748b; margin-top: 1.5rem; line-height: 1.6; }

/* ── Search / filter ─────────────────────────────────────────────── */
.filters {
  display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center;
  margin-bottom: 0.9rem;
}
.filters input[type="search"], .filters select {
  background: #0b1220; color: #e2e8f0;
  border: 1px solid #334155; border-radius: 0.375rem;
  padding: 0.5rem 0.65rem; font: inherit; font-size: 0.875rem;
}
.filters input[type="search"] { flex: 1; min-width: 200px; }
.filters input[type="search"]:focus, .filters select:focus {
  outline: 2px solid #34d399; outline-offset: 1px;
}
.filters label { font-size: 0.8rem; color: #94a3b8; display: flex;
                 align-items: center; gap: 0.35rem; }
.filter-count { font-size: 0.8rem; color: #64748b; }
tr.hidden-row { display: none; }
.no-matches { color: #94a3b8; font-size: 0.875rem; padding: 0.75rem 0; }

/* ── Selection + actions ─────────────────────────────────────────── */
td.sel, th.sel { width: 1.75rem; padding-right: 0.35rem; }
.action-bar {
  position: sticky; bottom: 0; z-index: 5;
  background: #1e293b; border: 1px solid #334155;
  border-radius: 0.5rem; padding: 0.75rem 1rem; margin-top: 1rem;
  display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap;
  box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
}
.action-bar[hidden] { display: none; }
.action-bar .sel-count { font-weight: 600; color: #e2e8f0; font-size: 0.875rem; }
.action-bar select { background: #0b1220; color: #e2e8f0;
  border: 1px solid #334155; border-radius: 0.375rem;
  padding: 0.45rem 0.6rem; font: inherit; font-size: 0.85rem; }
button.danger { background: #b91c1c; }
button.danger:hover { background: #dc2626; }
button.secondary { background: #334155; }
button.secondary:hover { background: #475569; }

/* ── Plan / confirm page ─────────────────────────────────────────── */
.plan-steps { margin: 0.5rem 0 1rem 1.1rem; }
.plan-steps li { font-size: 0.875rem; line-height: 1.6; margin-bottom: 0.4rem; }
.plan-warn {
  background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239,68,68,0.35);
  color: #fca5a5; border-radius: 0.375rem; padding: 0.85rem 1rem;
  margin: 1rem 0; font-size: 0.9rem; line-height: 1.6;
}
.tabs { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
.tabs a {
  color: #94a3b8; text-decoration: none; font-size: 0.8rem;
  padding: 0.3rem 0.7rem; border-radius: 999px; border: 1px solid #334155;
}
.tabs a:hover { color: #e2e8f0; border-color: #475569; }
@media (max-width: 640px) { body { padding: 1rem 0.5rem; } }
"""


def _meter(used_pct):
    cls = 'meter hot' if used_pct >= 90 else 'meter warn' if used_pct >= 75 else 'meter'
    return (f'<div class="{cls}"><span style="width:{min(used_pct, 100):.1f}%"></span></div>')


# Client-side filtering and selection. Deliberately plain: the page has
# to work from a NAS with no internet, so there is no framework and no
# CDN. fuzzyScore mirrors fuzzy_score() in this same file — keep the two
# in step or the CLI and the browser rank the same search differently.
SCRIPT = r"""
function fuzzyTerm(term, text) {
  if (!term) return [true, 0];
  var idx = text.indexOf(term);
  if (idx !== -1) {
    var s = 1000 - Math.min(idx, 100) * 2;
    if (idx === 0 || !/[a-z0-9]/.test(text[idx - 1])) s += 60;
    return [true, s];
  }
  var pos = 0, score = 0, prev = -2;
  for (var i = 0; i < term.length; i++) {
    var found = text.indexOf(term[i], pos);
    if (found === -1) return [false, 0];
    if (found === prev + 1) score += 10;
    if (found === 0 || !/[a-z0-9]/.test(text[found - 1])) score += 8;
    score += Math.max(0, 12 - (found - pos));
    prev = found; pos = found + 1;
  }
  return [true, score];
}

function fuzzyScore(query, text) {
  if (!query) return [true, 0];
  var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  var total = 0;
  for (var i = 0; i < terms.length; i++) {
    var r = fuzzyTerm(terms[i], text);
    if (!r[0]) return [false, 0];
    total += r[1];
  }
  return [true, total];
}

(function () {
  var q = document.getElementById('q');
  var arrSel = document.getElementById('f-arr');
  var minSel = document.getElementById('f-min');
  var unplayed = document.getElementById('f-unplayed');
  var countEl = document.getElementById('filter-count');
  if (!q) return;

  var tables = Array.prototype.slice.call(document.querySelectorAll('table'));

  function apply() {
    var query = q.value.trim().toLowerCase();
    var arr = arrSel ? arrSel.value : '';
    var min = minSel ? parseInt(minSel.value, 10) || 0 : 0;
    var onlyUnplayed = unplayed && unplayed.checked;
    var shown = 0, total = 0;

    tables.forEach(function (table) {
      var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
      var scored = [];
      rows.forEach(function (row) {
        if (!row.dataset.search) return;
        total++;
        var ok = true;
        if (arr && row.dataset.arr !== arr) ok = false;
        if (ok && min && parseInt(row.dataset.size, 10) < min) ok = false;
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
          var box = row.querySelector('.pick');
          if (box && box.checked) { box.checked = false; }
        }
        if (ok) { shown++; scored.push([score, row]); }
      });
      // Re-order by relevance while a query is active, then restore
      // the original size ordering when it's cleared.
      var body = table.querySelector('tbody');
      if (query && body) {
        scored.sort(function (a, b) { return b[0] - a[0]; });
        scored.forEach(function (p) { body.appendChild(p[1]); });
      }
      var empty = table.parentNode.querySelector('.no-matches');
      if (empty) empty.hidden = scored.length > 0;
    });

    if (countEl) {
      countEl.textContent = (query || arr || min || onlyUnplayed)
        ? shown + ' of ' + total + ' shown' : '';
    }
    syncSelection();
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

  function syncSelection() {
    if (!bar) return;
    var picks = selected();
    // The same item appears in more than one table (biggest, most
    // bloated, never played), so count distinct items rather than
    // distinct checkboxes.
    var seen = {};
    picks.forEach(function (b) { seen[b.dataset.arr + ':' + b.dataset.id] = b.dataset.arr; });
    var keys = Object.keys(seen);
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

  q.addEventListener('input', apply);
  [arrSel, minSel, unplayed].forEach(function (el) {
    if (el) el.addEventListener('change', apply);
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.classList.contains('pick')) syncSelection();
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
                   f'data-title="{html.escape(it["title"])}" '
                   f'aria-label="Select {html.escape(it["title"])}"></td>')
        elif selectable:
            sel = '<td class="sel"></td>'
        rows.append(
            f'<tr data-search="{hay}" data-size="{int(it.get("size") or 0)}" '
            f'data-plays="{int(it.get("plays") or 0)}" '
            f'data-arr="{html.escape(str(it.get("arr", "")))}">'
            + sel
            + f'<td>{html.escape(it["title"])}{year}</td>'
            f'<td class="num">{html.escape(human_bytes(it["size"]))}</td>'
            f'<td class="dim">{html.escape(it["quality"] or "—")}</td>'
            f'<td class="dim">{html.escape(it["codec"] or "—")}</td>'
            f'<td class="num dim">{html.escape(rate)}</td>'
            f'<td class="dim">{html.escape(played)}</td>'
            '</tr>')
    head_sel = '<th class="sel"></th>' if selectable else ''
    return (
        '<table><thead><tr>' + head_sel +
        '<th>Title</th><th class="num">Size</th><th>Quality</th>'
        '<th>Codec</th><th class="num">Per hour</th><th>Last played</th>'
        '</tr></thead><tbody>' + ''.join(rows) + '</tbody>'
        '</table><p class="no-matches" hidden>Nothing matches that search.</p>')


def render_html(report, env=None):
    env = env if env is not None else {}
    can_act = actions_enabled(env)
    parts = []
    add = parts.append

    add('<h1>Librarian</h1>')
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
            'is not accounted for by any arr — downloads in progress, extras, other '
            'shares on the same volume, or files the arrs no longer track.</p>')
    add('</div>')

    # Upgrade backlog
    if report['cutoff']:
        add('<div class="card"><div class="label">Upgrade backlog</div>'
            '<p class="muted" style="margin-top:0">Items each arr already considers '
            'below its quality cutoff — it will replace these on the next search.</p>'
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

    # Search / filter. One control set drives every table below it.
    arr_opts = ''.join(
        f'<option value="{html.escape(n)}">{html.escape(ARRS[n]["label"])}</option>'
        for n in (report.get('connections') or {}) if n in ARRS)
    add('<div class="card"><div class="label">Find something</div>'
        '<div class="filters">'
        '<input type="search" id="q" placeholder="Fuzzy search title, quality, codec… (press / to focus)" '
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
        '<label><input type="checkbox" id="f-unplayed"> Never played</label>'
        '<span class="filter-count" id="filter-count"></span>'
        '</div>'
        '<p class="muted" style="margin:0">Matching is fuzzy, so <code>rmx 216</code> '
        'finds Remux-2160p. Several words all have to match.</p>'
        '</div>')

    # Item tables
    add('<div class="card"><div class="label">Biggest items</div>'
        + _item_table_html(report['top_by_size'], report['watch_source'], can_act) + '</div>')

    add('<div class="card"><div class="label">Most bloated — bytes per hour</div>'
        '<p class="muted" style="margin-top:0">A high rate on a short runtime is '
        'usually a remux. Sorting by raw size only ever finds long shows.</p>'
        + _item_table_html(report['top_by_rate'], report['watch_source'], can_act) + '</div>')

    if report['big_unwatched']:
        add('<div class="card">'
            f'<div class="label">Big and never played · via {html.escape(report["watch_source"])}</div>'
            + _item_table_html(report['big_unwatched'], report['watch_source'], can_act) + '</div>')

    if can_act:
        prof_opts = []
        for name, conn in (report.get('connections') or {}).items():
            for prof in conn.get('profiles') or []:
                prof_opts.append(
                    f'<option value="{int(prof["id"])}" data-arr="{html.escape(name)}">'
                    f'{html.escape(str(prof["name"]))}</option>')
        add('<form method="POST" action="/plan">'
            '<div class="action-bar" id="action-bar" hidden>'
            '<span class="sel-count" id="sel-count">0 selected</span>'
            '<input type="hidden" name="ids" id="ids">'
            '<input type="hidden" name="arr" id="action-arr">'
            '<label class="muted">Target profile '
            f'<select name="profile" id="profile">{"".join(prof_opts)}</select></label>'
            '<button type="submit" name="mode" value="upgrade">Upgrade</button>'
            '<button type="submit" name="mode" value="shrink" class="danger">Shrink</button>'
            '<span class="muted" id="sel-warn" hidden></span>'
            '</div></form>')

    add('<div class="card"><form method="POST" action="/rescan">'
        '<button type="submit">Rescan now</button> '
        f'<span class="muted">Results are cached for {CACHE_TTL_SECONDS // 60} minutes.</span>'
        '</form></div>')

    if can_act:
        hint = ('Actions are enabled (LIBRARIAN_ALLOW_ACTIONS). Upgrades never '
                'delete anything. Shrink deletes the current files through the '
                'arr, so they land in its Recycle Bin, and refuses to run at '
                'all if no Recycle Bin is configured. Every action shows you '
                'the exact plan before it does anything.')
    else:
        hint = ('This page is read-only. It issues nothing but GETs, so it '
                'cannot edit a profile, trigger a search, or delete a file. '
                'Set LIBRARIAN_ALLOW_ACTIONS=true in .env to turn on re-grab '
                'actions.')
    add(f'<p class="hint">{hint} Same report on the command line: '
        '<code>python3 librarian.py --report</code>, or '
        '<code>--json</code> for the raw numbers. '
        '<a href="/api/report.json" style="color:#34d399">JSON endpoint</a>.</p>')

    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>Librarian — storage report</title>'
        f'<style>{CSS}</style></head><body>' + ''.join(parts) +
        f'<script>{SCRIPT}</script></body></html>')


def _page(body, code_note=''):
    return ('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>Librarian</title>'
            f'<style>{CSS}</style></head><body>{body}</body></html>')


def render_plan_html(plan, token):
    """The confirmation page. Deliberately verbose about the destructive
    case: this is the last screen before files move."""
    rows = ''.join(
        '<tr>'
        f'<td>{html.escape(i["title"])}'
        + (f' <span class="dim">({i["year"]})</span>' if i.get('year') else '')
        + '</td>'
        f'<td class="num">{html.escape(human_bytes(i["size"]))}</td>'
        f'<td class="dim">{html.escape(i["quality"] or "—")}</td>'
        '</tr>'
        for i in plan['items'])

    steps = ''.join(f'<li>{html.escape(x)}</li>' for x in plan['steps'])
    verb = 'Shrink' if plan['deletes_files'] else 'Upgrade'

    warn = ''
    if plan['deletes_files']:
        warn = (
            '<div class="plan-warn"><strong>This deletes files.</strong> '
            f'{len(plan["items"])} item(s), '
            f'{html.escape(human_bytes(plan["total_size"]))} on disk, will have '
            'their current files removed through the arr and replaced by a fresh '
            f'search at "{html.escape(plan["profile_name"])}".<br><br>'
            f'They go to the Recycle Bin at <code>{html.escape(plan["recycle_bin"])}</code>, '
            'so they are recoverable until you empty it. Each item is unavailable '
            'between the delete and a new release importing, and for something '
            'obscure that could be a while.</div>')

    return _page(
        '<h1>Librarian</h1>'
        f'<p class="muted">Confirm: {verb.lower()} {len(plan["items"])} item(s) '
        f'in {html.escape(plan["label"])}</p>'
        + warn +
        '<div class="card"><div class="label">What will happen</div>'
        f'<ol class="plan-steps">{steps}</ol></div>'
        '<div class="card"><div class="label">Items</div>'
        '<table><thead><tr><th>Title</th><th class="num">Size</th>'
        '<th>Current quality</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        '<div class="card"><form method="POST" action="/apply">'
        f'<input type="hidden" name="token" value="{html.escape(token)}">'
        f'<button type="submit" class="{"danger" if plan["deletes_files"] else ""}">'
        f'Yes, {verb.lower()} {len(plan["items"])} item(s)</button> '
        '<a href="/" style="margin-left:0.75rem;color:#94a3b8">Cancel</a>'
        '</form></div>')


def render_result_html(plan, results):
    ok = len(results['ok'])
    bad = results['failed']
    body = ['<h1>Librarian</h1>']
    if bad:
        body.append('<div class="banner err">Finished with problems.</div>')
    else:
        body.append('<div class="banner ok">Done.</div>')
    body.append(
        '<div class="card"><div class="label">Result</div>'
        f'<div class="row"><span>Items actioned</span><strong>{ok}</strong></div>'
        f'<div class="row"><span>Files deleted</span><strong>{results["deleted_files"]}</strong></div>'
        f'<div class="row"><span>New profile</span><strong>{html.escape(plan["profile_name"])}</strong></div>'
        '</div>')
    if bad:
        body.append('<div class="card"><div class="label">Problems</div><pre>'
                    + html.escape('\n'.join(bad)) + '</pre></div>')
    if results['notes']:
        body.append('<div class="card"><div class="label">Notes</div><pre>'
                    + html.escape('\n'.join(results['notes'])) + '</pre></div>')
    body.append('<p class="hint">Searches run in the background, so give the arr '
                'a few minutes. <a href="/" style="color:#34d399">Back to the report</a>.</p>')
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
                    f'<title>Librarian</title><style>{CSS}</style></head><body>'
                    '<h1>Librarian</h1><p class="muted">First scan running — '
                    'this page refreshes itself.</p></body></html>', code=503)
                return
            html_body = render_html(report, read_env())
            if busy:
                html_body = html_body.replace(
                    '<h1>Librarian</h1>',
                    '<h1>Librarian</h1><div class="banner">A scan is already '
                    'running — showing the previous result.</div>', 1)
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
            '<h1>Librarian</h1>'
            f'<div class="banner err">{html.escape(message)}</div>'
            '<p class="hint"><a href="/" style="color:#34d399">Back to the report</a></p>'),
            code=code)

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
                plan = build_plan(report, env, (form.get('mode') or '').strip(),
                                  (form.get('arr') or '').strip(), profile_id, ids)
            except LibrarianSourceError as e:
                self._error_page(str(e))
                return

            # Single-use token. Applying requires having been shown this
            # exact plan, so a bare POST to /apply can't do anything.
            token = secrets.token_urlsafe(24)
            with _ACTION_LOCK:
                now = time.time()
                for t, (_, ts) in list(ACTION_TOKENS.items()):
                    if now - ts > ACTION_TOKEN_TTL:
                        ACTION_TOKENS.pop(t, None)
                ACTION_TOKENS[token] = (plan, now)
            self._send(render_plan_html(plan, token))
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
            if report is None or plan['arr'] not in (report.get('connections') or {}):
                self._error_page(f'{plan["arr"]} is not reachable right now.', 503)
                return
            if not _SCAN_LOCK.acquire(blocking=False):
                self._error_page('A scan is running — try again in a moment.', 409)
                return
            try:
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
    print(f'Librarian listening on http://{addr[0]}:{port}/ '
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
        if args.filter or args.min_size or args.quality or args.arr or args.unplayed:
            picked = filter_items(
                report['items'], query=args.filter,
                min_size=parse_size(args.min_size), quality=args.quality,
                unplayed=args.unplayed, arr=args.arr)
            report['filtered'] = {
                'query': args.filter, 'min_size': args.min_size,
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
