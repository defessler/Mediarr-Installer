#!/usr/bin/env python3
"""
Fetch a SiriusXM channel's recent track rotation from xmplaylist.com and
write an `artist,title` CSV that the sldl (slsk-batchdl) downloader feeds on.

xmplaylist.com publishes, for free and with NO auth/key, what each SiriusXM
channel has been spinning. Its "most-heard" endpoint returns up to 100 tracks
ranked by play count over a trailing window — exactly the "give me this
station's rotation as a wishlist" input the playlistsync pipeline wants. This
script is the producer half: poll one channel, emit a CSV; sldl is the
consumer half that searches Soulseek for each line.

    python3 poll-xmplaylist.py <slug> <output.csv> [--min-plays N] [--days D]

  <slug>        Channel slug, e.g. "thepulse", "siriusxmhits1", "hiphopnation".
                Canonical slugs are the `deeplink` field from /api/station.
                If the slug 404s we try to resolve it case-insensitively
                against the station list by name or channel number (see
                resolve_slug) and use the canonical one.
  <output.csv>  Path to write. An `Artist,Title` header row followed by one
                row per track, CSV-quoted so titles/artists containing commas
                stay intact. The header lets sockseek map columns by name
                (--artist-col Artist --title-col Title).
  --min-plays N Only emit tracks with at least N plays (default 1, i.e. all).
  --days D      Trailing window passed to the API (default 7).

Output rows use the FIRST/primary artist from the track's `artists` array
(SiriusXM lists features as additional array entries; the primary artist is
the best Soulseek search term). Rows are de-duplicated on (artist, title).

stdlib only (urllib + json + csv) — no pip deps, so this drops into a slim
python:alpine sidecar with zero `apk add`/wheel-build overhead, same posture
as the other scripts in nas/scripts/.

── Verified API shape (live, June 2026) ────────────────────────────────────
GET https://xmplaylist.com/api/station/{slug}/most-heard?days=7  → HTTP 200,
no auth. Body is an OBJECT wrapping the ranked list:

    {
      "results": [
        {
          "track":   { "id": "...", "title": "Mr. Know It All",
                       "artists": ["Teddy Swims"] },
          "spotify": { "id": "2g5kPQh1EexoG8kGZH2nOZ", ... },
          "plays":   68,
          "links":   [ { "url": "...", "site": "..." }, ... ]
        },
        ...
      ]
    }

(The list is also accepted bare — `[ {...}, ... ]` — in case the shape ever
changes back; see _extract_results.)

GET https://xmplaylist.com/api/station  → HTTP 200, no auth. Also wrapped:

    { "count": 171, "next": null, "previous": null,
      "results": [ { "id": "...", "name": "SiriusXM Hits 1",
                     "number": "2", "deeplink": "siriusxmhits1", ... }, ... ] }

So the slug lives in `deeplink`, the display name in `name`, the dial number
in `number`. NOTE: a friendly guess like "hits1" 404s; the canonical
deeplink is "siriusxmhits1". That mismatch is exactly why resolve_slug exists.

── Etiquette ───────────────────────────────────────────────────────────────
An empty User-Agent gets a hard HTTP 403, so we always send a real one
(UA constant below). The API rate-limits ~60 requests / 60 s per IP and
advertises it via `ratelimit*` response headers; one (or two, if we have to
resolve a slug) calls per channel per run stays far under that, so we don't
need to sleep — but we DO surface the limit if we ever trip it (HTTP 429).
"""

import argparse
import csv
import json
import sys
import urllib.error
import urllib.request

API_BASE = 'https://xmplaylist.com/api'

# A non-empty User-Agent is MANDATORY: xmplaylist returns HTTP 403 for an
# empty/missing UA. This identifies the playlistsync tool politely.
USER_AGENT = 'mediarr-playlistsync/1.0'

# Network timeout per request. The API is snappy; this is just so a hung
# connection produces a clear failure instead of blocking a cron run forever.
HTTP_TIMEOUT = 30


def _http_get_json(url):
    """GET `url` with our mandatory User-Agent and return parsed JSON.

    Raises RuntimeError with a human-readable message on any network,
    HTTP-status, decoding, or JSON-parse failure so the single top-level
    handler can print it to stderr and exit non-zero. The HTTP-status path
    distinguishes 404 (caller may want to attempt slug resolution) and 429
    (rate limit — echo the advertised limit) from the generic case.
    """
    req = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            charset = resp.headers.get_content_charset() or 'utf-8'
            raw = resp.read().decode(charset, errors='replace')
    except urllib.error.HTTPError as e:
        if e.code == 429:
            # Honor / surface the advertised rate limit rather than hammering.
            limit = e.headers.get('ratelimit-limit') or e.headers.get('RateLimit-Limit')
            reset = e.headers.get('ratelimit-reset') or e.headers.get('RateLimit-Reset')
            extra = ''
            if limit or reset:
                extra = f' (ratelimit-limit={limit}, ratelimit-reset={reset}s)'
            raise RuntimeError(
                f'rate limited (HTTP 429) fetching {url}{extra} — '
                f'wait and retry; the API allows ~60 requests / 60 s per IP'
            ) from e
        # Re-raise 404 verbatim so resolve_slug can catch it specifically.
        if e.code == 404:
            raise RuntimeError(f'HTTP 404 for {url}') from e
        raise RuntimeError(f'HTTP {e.code} {e.reason} fetching {url}') from e
    except urllib.error.URLError as e:
        raise RuntimeError(f'network error fetching {url}: {e.reason}') from e
    except (TimeoutError, OSError) as e:
        raise RuntimeError(f'connection failure fetching {url}: {e}') from e

    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        snippet = raw[:200].replace('\n', ' ')
        raise RuntimeError(
            f'could not parse JSON from {url}: {e} (first 200 chars: {snippet!r})'
        ) from e


def _is_404(err):
    """True when a RuntimeError from _http_get_json represents an HTTP 404."""
    return isinstance(err, RuntimeError) and 'HTTP 404' in str(err)


def _extract_results(payload):
    """Return the list of result items from an API payload.

    Live endpoints wrap their lists in `{"results": [...]}`; we also accept a
    bare top-level list. An empty `results` list is valid (low-traffic channels
    legitimately report nothing). But an UNRECOGNISED shape — a dict with no
    `results` key, a `results` that isn't a list, or a non-dict/non-list payload
    — means xmplaylist changed its format under us; raise loudly so the caller
    exits non-zero instead of silently treating it as "no data" (which would
    masquerade as an empty channel and yield an empty CSV → no playlist)."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        if 'results' in payload:
            results = payload.get('results')
            if isinstance(results, list):
                return results
            raise RuntimeError(
                "unexpected API response: 'results' is %s, not a list"
                % type(results).__name__)
        raise RuntimeError(
            "unexpected API response shape (keys: %s) — xmplaylist's format "
            "may have changed"
            % (', '.join(sorted(map(str, payload.keys()))) or '<none>'))
    raise RuntimeError(
        "unexpected API response type %s (expected an object or a list)"
        % type(payload).__name__)


def resolve_slug(slug, days):
    """Return a canonical station `deeplink` for the user-supplied `slug`.

    Fast path: if `{slug}/most-heard` already exists we return `slug`
    unchanged without ever hitting the station list (one call, no waste). The
    existence probe uses the SAME `days` window as the real fetch, so a valid
    channel isn't misjudged "not found" by a narrower probe window.

    Fallback (the given slug 404s): fetch /api/station and match
    case-insensitively against each station's canonical `deeplink`, its
    `name` (whole string and with spaces/punctuation stripped, so
    "Hits 1" / "hits1" both land), and its dial `number`. The first match's
    `deeplink` wins. This is what lets a user type a memorable-but-wrong
    handle (e.g. "hits1") and still reach "siriusxmhits1".

    Raises RuntimeError if the slug 404s AND nothing in the station list
    matches — with a short list of close suggestions to nudge the user.
    """
    # Fast path: does the channel endpoint resolve as-is?
    try:
        _http_get_json(f'{API_BASE}/station/{slug}/most-heard?days={days}')
        return slug
    except RuntimeError as e:
        if not _is_404(e):
            raise  # genuine network/parse error — don't mask it as "bad slug"

    # Slow path: pull the directory and try to match what the user meant.
    stations = _extract_results(_http_get_json(f'{API_BASE}/station'))
    if not stations:
        raise RuntimeError(
            f'slug "{slug}" not found and the station directory came back '
            f'empty — cannot resolve. Check https://xmplaylist.com for the '
            f'correct channel handle.'
        )

    def norm(s):
        # Lowercase + drop everything but letters/digits, so "Hits 1",
        # "hits-1", and "hits1" all normalise to the same key.
        return ''.join(ch for ch in str(s).lower() if ch.isalnum())

    want = norm(slug)
    for st in stations:
        if not isinstance(st, dict):
            continue
        deeplink = st.get('deeplink')
        if not deeplink:
            continue
        candidates = {
            norm(deeplink),
            norm(st.get('name', '')),
            norm(st.get('number', '')),
        }
        if want in candidates and want:
            if deeplink != slug:
                print(
                    f'note: resolved "{slug}" -> "{deeplink}" '
                    f'({st.get("name", "?")}, ch {st.get("number", "?")})',
                    file=sys.stderr,
                )
            return deeplink

    # No exact normalised hit — offer the nearest-looking handles to help.
    suggestions = []
    for st in stations:
        if not isinstance(st, dict):
            continue
        name = st.get('name', '')
        deeplink = st.get('deeplink', '')
        if want and (want in norm(name) or want in norm(deeplink)):
            suggestions.append(f'{deeplink} ({name})')
    hint = ''
    if suggestions:
        hint = ' Did you mean: ' + ', '.join(suggestions[:8]) + '?'
    raise RuntimeError(
        f'could not resolve channel slug "{slug}" against /api/station.{hint}'
    )


def fetch_tracks(slug, days):
    """Return the list of result items for `slug`'s most-heard rotation.

    `slug` must already be canonical (run it through resolve_slug first).
    An empty rotation returns [] (valid: some low-traffic channels report
    nothing for short windows) rather than raising."""
    url = f'{API_BASE}/station/{slug}/most-heard?days={days}'
    return _extract_results(_http_get_json(url))


def parse_rows(items, min_plays):
    """Turn raw API items into a de-duplicated list of (artist, title) rows.

    Tolerant by design: a malformed item (missing `track`, empty `artists`,
    blank title, non-integer `plays`) is skipped with a stderr note instead
    of aborting the whole run — one bad record shouldn't cost us the other 99.
    Uses the FIRST entry of `artists` as the primary artist. Threshold and
    dedupe (case-sensitive on the cleaned strings, preserving first-seen
    order) happen here.
    """
    rows = []
    seen = set()
    skipped = 0
    for item in items:
        if not isinstance(item, dict):
            skipped += 1
            continue

        track = item.get('track')
        if not isinstance(track, dict):
            skipped += 1
            continue

        title = track.get('title')
        artists = track.get('artists')
        if not isinstance(title, str) or not isinstance(artists, list) or not artists:
            skipped += 1
            continue

        primary = artists[0]
        if not isinstance(primary, str):
            skipped += 1
            continue

        title = title.strip()
        primary = primary.strip()
        if not title or not primary:
            skipped += 1
            continue

        # plays is optional for thresholding; treat a missing/garbage value
        # as 0 so a non-int never crashes us and only clears a min-plays of 0.
        plays_raw = item.get('plays', 0)
        try:
            plays = int(plays_raw)
        except (TypeError, ValueError):
            plays = 0
        if plays < min_plays:
            continue

        key = (primary, title)
        if key in seen:
            continue
        seen.add(key)
        rows.append((primary, title))

    if skipped:
        print(f'note: skipped {skipped} malformed/incomplete track record(s)',
              file=sys.stderr)
    return rows


def write_csv(path, rows):
    """Write rows as an `Artist,Title` CSV with a header row.

    The header is what lets sockseek map columns by name
    (--artist-col Artist --title-col Title) instead of guessing positions.
    Uses the csv module so any artist/title containing a comma (or quote, or
    newline) is correctly quoted — sockseek reads this straight back as CSV.
    newline='' is required on all platforms for csv to emit clean line
    endings. `-` writes to stdout (handy for piping / debugging)."""
    if path == '-':
        writer = csv.writer(sys.stdout)
        writer.writerow(['Artist', 'Title'])
        for artist, title in rows:
            writer.writerow([artist, title])
        return
    with open(path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Artist', 'Title'])
        for artist, title in rows:
            writer.writerow([artist, title])


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Fetch a SiriusXM channel rotation from xmplaylist.com '
                    'and write an artist,title CSV for the sldl downloader.',
    )
    parser.add_argument('slug', help='Channel slug / deeplink, e.g. "thepulse" '
                                     '(resolved case-insensitively if it 404s)')
    parser.add_argument('output', help='Output CSV path ("-" for stdout)')
    parser.add_argument('--min-plays', type=int, default=1, metavar='N',
                        help='Only include tracks with at least N plays '
                             '(default: 1 = all tracks)')
    parser.add_argument('--days', type=int, default=7, metavar='D',
                        help='Trailing window in days for the API query '
                             '(default: 7)')
    parser.add_argument('--limit', type=int, default=0, metavar='N',
                        help='Keep only the TOP N tracks by play count. The API '
                             'returns most-heard first and parse_rows preserves '
                             'that order, so this is a true top-N (0 = all, '
                             'default). Used by the monthly Top-50 archive.')
    args = parser.parse_args(argv)

    if args.days < 1:
        print('error: --days must be >= 1', file=sys.stderr)
        return 2
    if args.min_plays < 0:
        print('error: --min-plays must be >= 0', file=sys.stderr)
        return 2
    if args.limit < 0:
        print('error: --limit must be >= 0', file=sys.stderr)
        return 2

    try:
        slug = resolve_slug(args.slug, args.days)
        items = fetch_tracks(slug, args.days)
    except RuntimeError as e:
        print(f'error: {e}', file=sys.stderr)
        return 1

    rows = parse_rows(items, args.min_plays)

    # Top-N: the API returns most-heard first and parse_rows preserves that
    # order, so the first N rows are the N most-played. The monthly archive uses
    # --limit 50 over a month-to-date window to get "this month's top 50".
    if args.limit > 0:
        rows = rows[:args.limit]

    if not rows:
        # Not a hard failure on its own — but warn loudly, because an empty
        # CSV usually means the threshold is too high or the window too short,
        # and a silent empty file would just make sldl a no-op.
        print(
            f'warning: no tracks matched for "{slug}" '
            f'(days={args.days}, min-plays={args.min_plays}); '
            f'writing empty CSV to {args.output}',
            file=sys.stderr,
        )

    try:
        write_csv(args.output, rows)
    except OSError as e:
        print(f'error: could not write {args.output}: {e}', file=sys.stderr)
        return 1

    if args.output != '-':
        print(f'wrote {len(rows)} track(s) to {args.output}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
