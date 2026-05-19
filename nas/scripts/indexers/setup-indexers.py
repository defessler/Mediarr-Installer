#!/usr/bin/env python3
"""
setup-indexers.py — Add indexers to Prowlarr

Public torrent indexers are added automatically (no credentials needed).
Free usenet indexers (AnimeTosho, ABNzb, Althub) are added automatically.
Account-required usenet indexers are added if their key is set in .env.
Private torrent trackers are added if credentials are set in .env.

Safe to re-run — skips indexers that are already added.

Usage:
    python3 /volume1/docker/media/indexers/setup-indexers.py

.env keys for usenet (account-required):
    NZBGEEK_API_KEY=
    NZBFINDER_API_KEY=
    DRUNKENSLUG_API_KEY=
    NZBPLANET_API_KEY=
    NZBCAT_API_KEY=
    DOGNZB_API_KEY=
    NINJACZENTRAL_API_KEY=
    TABULARASA_API_KEY=

.env keys for anime usenet (AnimeTosho has optional account-based limits):
    ANIMETOSHO_API_KEY=     # optional — increases rate limits; get from animetosho.org/api

.env keys for private torrent trackers:
    AVISTAZ_USER=          AVISTAZ_PASS=        # Asian movies/TV (private)
    HHD_API_KEY=                                # Korean movies/dramas
    ANIMEBYTES_USER=       ANIMEBYTES_PASS=     # Anime (invite-only)
    ANIMETORRENTS_USER=    ANIMETORRENTS_PASS=  # Anime (private)
"""

import json
import os
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ── Terminal colours ──────────────────────────────────────────────────────────

GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
DIM    = "\033[2m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

errors = 0

def ok(msg):   print(f"  {GREEN}✔{RESET}  {msg}")
def skip(msg): print(f"  –  {msg}")
def info(msg):
    # Info-level FYI — non-actionable status the user might find useful
    # but doesn't need to fix. Distinct from warn() so the wizard's
    # issue parser (which flags ✘/⚠/! lines into the issues panel)
    # ignores these: an indexer added with a transient CloudFlare block
    # that Flaresolverr will heal on first search isn't something the
    # user should be alarmed about. Uses 'ℹ' marker (UTF-8 ℹ) with
    # a dim prefix character that's outside the parser's match set.
    print(f"  {DIM}ℹ{RESET}  {msg}")
def warn(msg): print(f"  {YELLOW}!{RESET}  {msg}")
def fail(msg):
    global errors; errors += 1
    print(f"  {RED}✘{RESET}  {msg}")
def section(title):
    print(f"\n{BOLD}━━━ {title} {'━' * max(0, 52 - len(title))}{RESET}")

# ── Indexer definitions ───────────────────────────────────────────────────────
#
# PUBLIC_TORRENT_INDEXERS: added automatically, no credentials needed.
# USENET_INDEXERS: (display_name, api_url, env_key_name or None)
#   env_key_name=None means free — added without a key (uses key if available)
# PRIVATE_TORRENT_INDEXERS: (display_name, implementation, {field: env_var})

PUBLIC_TORRENT_INDEXERS = [
    # ── General ───────────────────────────────────────────────────────────────
    "1337x",
    "YTS",
    "EZTV",
    "TorrentGalaxy",
    "LimeTorrents",
    "The Pirate Bay",
    "Knaben",            # Large Norwegian index, excellent general coverage
    # NB: Bitsearch and Solidtorrents were removed from Prowlarr's
    # indexer DB upstream (renamed / discontinued). Adding them here
    # just produced `not found in Prowlarr` failures during install
    # with nothing the user could do about it.
    # ── TV ────────────────────────────────────────────────────────────────────
    "ShowRSS",
    # ── Anime / Japanese ──────────────────────────────────────────────────────
    "Nyaa",              # Primary anime tracker
    "SubsPlease",        # Simulcast rips — best for current-season anime
    "Tokyo Toshokan",    # Japanese media (long-running, broad)
]

# Newznab-compatible usenet indexers.
# env_key_name=None → free, added regardless; uses key if present for higher limits.
#
# Tiered roughly best-anime / best-anime-with-signup / general-paid so a
# user reading the file top-to-bottom sees the "no setup needed" entries
# first. See nas/INDEXERS.md for the full rationale + coverage matrix.
USENET_INDEXERS = [
    # ── Free, no account ─────────────────────────────────────────────────────
    # These all add anonymously — no signup, no API key needed. Prowlarr
    # treats them as generic Newznab feeds against the public URLs.
    # Coverage is broad-but-shallow vs. paid indexers; the wizard's
    # default mix relies on these for unattended installs.
    ("AnimeTosho",     "https://feed.animetosho.org",      None,                    "ANIMETOSHO_API_KEY"),
    # NZBKing — public general index. Newznab API at /nzbking.com is
    # surfaced by Prowlarr's built-in indexer entry. Best free fallback
    # for anything AnimeTosho doesn't carry.
    ("NZBKing",        "https://www.nzbking.com",          None,                    None),
    # Binsearch — public, scrapes binary articles directly. Useful for
    # older content + when a release vanished from the indexer DBs.
    ("Binsearch",      "https://binsearch.info",           None,                    None),
    # ── Free with free signup (requires API key) ─────────────────────────────
    # ABNzb and Althub historically allowed RSS-only access without a
    # key, but their current backends reject add-attempts without
    # `Indexer requires an API key`. Skip silently if the key is blank.
    ("ABNzb",          "https://abnzb.com",                "ABNZB_API_KEY",         None),
    ("Althub",         "https://www.althub.co.za",         "ALTHUB_API_KEY",        None),
    # ── Paid account required ────────────────────────────────────────────────
    ("NZBGeek",        "https://api.nzbgeek.info",         "NZBGEEK_API_KEY",       None),
    ("NZBFinder",      "https://www.nzbfinder.ws",         "NZBFINDER_API_KEY",     None),
    ("DrunkenSlug",    "https://api.drunkenslug.com",      "DRUNKENSLUG_API_KEY",   None),
    ("NZBPlanet",      "https://api.nzbplanet.net",        "NZBPLANET_API_KEY",     None),
    ("NZBcat",         "https://nzb.cat",                  "NZBCAT_API_KEY",        None),
    ("DogNZB",         "https://api.dognzb.cr",            "DOGNZB_API_KEY",        None),
    ("NinjaCentral",   "https://www.ninjacentral.co.za",   "NINJACZENTRAL_API_KEY", None),
    ("Tabula Rasa",    "https://www.tabula-rasa.pw",       "TABULARASA_API_KEY",    None),
]

# Private torrent trackers — added only if credentials are set in .env.
PRIVATE_TORRENT_INDEXERS = [
    # Asian content
    # AvistaZ requires a `pid` field (their "passkey" — find it under
    # your profile on the site). Without it Prowlarr's validator 400s
    # with "'Pid' must not be empty." Treat as required.
    ("AvistaZ",         "AvistaZ",         {"username": "AVISTAZ_USER",       "password": "AVISTAZ_PASS",
                                            "pid":      "AVISTAZ_PID"}),
    ("HHD",             "HHD",             {"apiKey":   "HHD_API_KEY"}),
    # Anime
    ("AnimeTorrents",   "AnimeTorrents",   {"username": "ANIMETORRENTS_USER", "password": "ANIMETORRENTS_PASS"}),
    ("AnimeBytes",      "AnimeBytes",      {"username": "ANIMEBYTES_USER",    "password": "ANIMEBYTES_PASS"}),
    # General-purpose. Cookie-based auth (no username/password) — user
    # logs in via browser, copies the entire session cookie, pastes it
    # into IPTORRENTS_COOKIE in .env. Prowlarr's IPTorrents indexer
    # uses a single `cookie` field; we map our env var to that name.
    ("IPTorrents",      "IPTorrents",      {"cookie":   "IPTORRENTS_COOKIE"}),
]

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _headers(key):
    return {'X-Api-Key': key, 'Content-Type': 'application/json',
            'User-Agent': 'setup-indexers/1.0'}

def _request(url, headers, method='GET', data=None, timeout=45):
    """Returns (result, status_code, error_body). Never prints.

    Timeout bumped from 15s to 45s default. POST /api/v1/indexer does
    a synchronous reachability test of the indexer URL as part of
    validation — for invite-only / IP-banned indexers (AnimeTorrents,
    some private trackers behind CloudFlare), that test can take 20+
    seconds before returning a 400 to us. The 15s default fired our
    timeout BEFORE Prowlarr replied, so we'd see status=None (network
    error) instead of the actual 400 + error message — losing the
    chance to retry with forceSave=true."""
    body = json.dumps(data).encode() if data is not None else None
    req = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            content = resp.read()
            return json.loads(content) if content else {}, resp.status, None
    except HTTPError as e:
        return None, e.code, e.read().decode(errors='replace')
    except (URLError, OSError):
        return None, None, None

def _prowlarr_error(body):
    """Extract a clean single-line error message from a Prowlarr JSON error body."""
    try:
        errs = json.loads(body)
        msgs = [e.get('errorMessage', '') for e in (errs if isinstance(errs, list) else [])]
        msgs = [m for m in msgs if m]
        return msgs[0] if msgs else body[:120]
    except Exception:
        return (body or '')[:120]

def _is_db_locked(body):
    """Detect Prowlarr's SQLite-busy error so we know to retry. Real
    install log:
      'AvistaZ: credential update failed (HTTP 400) — Unable to
       connect to indexer, check the log above the ValidationFailure
       for more details. database is locked
       database is locked'
    The phrase 'database is locked' shows up in Prowlarr's response
    body when SQLite hits write contention — usually during simultaneous
    Sync Apps + indexer-test pairs or post-deploy validator's parallel
    indexer/test calls. The right response is to wait + retry, not
    surface as a hard error. Treat ANY error body containing this
    string (anywhere) as retryable."""
    return body and 'database is locked' in body.lower()

def GET(base, key, path):
    result, _, _ = _request(f"{base}{path}", _headers(key))
    return result

def POST(base, key, path, data):
    result, status, err = _request(f"{base}{path}", _headers(key), 'POST', data)
    return result, status, err

def PUT(base, key, path, data):
    result, _, _ = _request(f"{base}{path}", _headers(key), 'PUT', data)
    return result

def PUT_with_status(base, key, path, data):
    """Like PUT but exposes (result, status, error) — used by paths
    that surface error messages (e.g., cred-update PATCH that wants
    to tell the user WHY a credential refresh failed)."""
    return _request(f"{base}{path}", _headers(key), 'PUT', data)

# ── Wait for Prowlarr ─────────────────────────────────────────────────────────

def wait_ready(base, key, retries=24, interval=5):
    sys.stdout.write("  Waiting for Prowlarr ")
    sys.stdout.flush()
    for _ in range(retries):
        if GET(base, key, "/api/v1/system/status") is not None:
            print(f"{GREEN}✔{RESET}"); return True
        sys.stdout.write("."); sys.stdout.flush()
        time.sleep(interval)
    print(f"{RED}✘ timed out{RESET}"); return False

# ── Tag helpers ───────────────────────────────────────────────────────────────

def get_or_create_tag(base, key, label):
    """Find or create a Prowlarr tag by label, return its id (or None).

    Used to tag indexers with 'flaresolverr' so they share a tag with
    the Flaresolverr IndexerProxy — without that shared tag, Prowlarr
    NEVER routes the indexer's requests through Flaresolverr, and any
    CloudFlare-protected indexer fails the reachability test during
    add. This is the single most subtle piece of Prowlarr config our
    wizard needs to get right.

    Idempotent — re-runs reuse the existing tag instead of creating
    a duplicate. setup-arr-config.py also creates this tag (in
    add_flaresolverr_proxy) so the two scripts converge on the same
    tag id regardless of run order."""
    existing = GET(base, key, "/api/v1/tag") or []
    for t in existing:
        if t.get('label') == label:
            return t.get('id')
    new_tag, _, _ = POST(base, key, "/api/v1/tag", {'label': label})
    return (new_tag or {}).get('id')


# ── Add indexer ───────────────────────────────────────────────────────────────

def _post_indexer(base, key, name, schema):
    """POST the indexer schema; classify 400 errors into clean messages.

    Network-level transient failures (status=None) get one retry with
    a 3-second backoff before being demoted to warn(). Real-world install
    logs showed AnimeTosho occasionally failing here with HTTP None when
    Prowlarr was still building its indexer cache from a fresh container
    — a single retry catches the steady-state case, and a warn (not fail)
    means a flaky network doesn't false-fail the whole install over
    indexers that can be re-added from the Prowlarr UI in seconds."""
    result, status, err = POST(base, key, "/api/v1/indexer", schema)
    # One retry on transient network errors. status=None means the HTTP
    # call itself didn't complete (timeout, connection reset, DNS), not
    # a Prowlarr-side rejection — most often clears within a few seconds.
    if result is None and status is None:
        time.sleep(3)
        result, status, err = POST(base, key, "/api/v1/indexer", schema)
    if result is not None:
        # Verify the indexer actually persisted. Prowlarr has been
        # observed returning 200/201 + JSON for POST /indexer where
        # the indexer never shows up in the UI — most often because
        # AvistaZ-style trackers reject the cred on their side AFTER
        # Prowlarr's initial validation passed (e.g. wrong PID
        # silently rejected during the first scheduled search and
        # Prowlarr quietly removes the indexer). Re-fetch the list
        # and confirm. If missing, downgrade to warn() with the
        # schema's field names so the user can see if a required
        # field (like AvistaZ's pid/passkey) might be misnamed in
        # our env-to-schema mapping.
        verify = GET(base, key, "/api/v1/indexer") or []
        if any(i.get('name', '').lower() == name.lower() for i in verify):
            ok(f"{name}")
        else:
            schema_fields = [f.get('name', '?') for f in schema.get('fields', [])]
            populated = [f.get('name', '?') for f in schema.get('fields', [])
                         if f.get('value') not in (None, '', 0, False, [])]
            warn(f"{name}: POST returned success but indexer NOT in Prowlarr's list — "
                 f"likely a silent-reject by the indexer's auth.")
            info(f"  Schema fields: {', '.join(schema_fields)}")
            info(f"  Fields we populated: {', '.join(populated) or '(none)'}")
            info(f"  Manual add via Prowlarr UI will show the actual error.")
        return
    if status == 400 and err:
        err_lower = err.lower()
        if 'unique' in err_lower:
            skip(f"{name} (already added)")
            return
        # Prowlarr's POST /api/v1/indexer runs a synchronous test of the
        # indexer's reachability as part of validation, and returns 400
        # WITHOUT saving when the test fails. The previous "added but
        # blocked by CloudFlare" classifier was wrong — it remapped the
        # error message to friendlier wording but the indexer was never
        # actually saved to Prowlarr's DB.
        #
        # Fix: ANY non-unique 400 retries with ?forceSave=true (the
        # same endpoint Prowlarr's Web UI uses when you click "Save
        # anyway" after a failed test). The indexer enters the DB with
        # a red test-failed badge, Prowlarr retries automatically on
        # the next scheduled search, and self-healing conditions
        # (Flaresolverr CloudFlare bypass, DNS recovery, etc.) clear
        # the badge in the background.
        #
        # Previously this only retried on specific keywords (cloudflare,
        # redirect, unable-to-connect) — but Prowlarr's error wording
        # has historically varied across versions ("Test was aborted",
        # "Connection refused", "404", etc.). Casting the net wider so
        # any test-failure 400 gets the forceSave treatment. Real
        # validation errors (schema mismatch, required field missing,
        # malformed body) ALSO get a forceSave retry; if those forceSave
        # too, we fail() with the underlying error so the user knows.
        force_url = "/api/v1/indexer?forceSave=true"
        force_result, force_status, force_err = POST(base, key, force_url, schema)
        if force_result is not None:
            # Classify the original 400 so the info line is informative.
            # All three branches mean "saved, Prowlarr will retest later"
            # — we just describe WHY the initial test failed so the user
            # knows whether to expect a red badge in the UI.
            if 'cloudflare' in err_lower or 'blocked by' in err_lower:
                info(f"{name}: saved (CloudFlare test failed — Flaresolverr will retry on next search)")
            elif 'redirect' in err_lower:
                info(f"{name}: saved (domain redirecting — Prowlarr retests on next search)")
            elif 'unable to connect' in err_lower or 'unable to access' in err_lower or 'refused' in err_lower:
                info(f"{name}: saved (currently unreachable — {_prowlarr_error(err)})")
            else:
                # Generic "test failed for unknown reason" — surface the
                # message so user has at least some context. Still
                # saved successfully.
                info(f"{name}: saved with forceSave — initial test failed: {_prowlarr_error(err)}")
            return
        # forceSave ALSO rejected. Inspect the error message: if it's a
        # connectivity / domain-redirect issue (TorrentGalaxy moves its
        # canonical domain every few weeks; Prowlarr's bundled URLs go
        # stale), that's not actually the wizard's fault and not
        # something the user can fix from here — they'd need a fresher
        # Prowlarr build or to manually point the indexer at a working
        # mirror. Demote to info() so this single-indexer failure
        # doesn't pollute the Issues panel and make a successful
        # install LOOK broken.
        #
        # Real schema mismatches (indexer renamed upstream, missing
        # required field) still fail() — those need code-side fixes
        # and we want them surfaced.
        combined = (err_lower + ' ' + (_prowlarr_error(force_err) or '').lower())
        if any(k in combined for k in ('redirect', 'unable to connect', 'unable to access', 'timed out', 'refused')):
            info(f"{name}: couldn't add — {_prowlarr_error(force_err or err)}")
            info(f"  Bundled URL is likely stale; try adding from the Prowlarr UI which may have a fresher mirror.")
            return
        fail(f"{name}: forceSave also rejected — original: {_prowlarr_error(err)} / forceSave: {_prowlarr_error(force_err)}")
    else:
        # status=None means the POST didn't get a response at all
        # (network timeout, connection reset, DNS). Most often: Prowlarr
        # was synchronously testing the indexer URL and the test took
        # longer than our request timeout. Try forceSave=true as a last
        # resort — that skips the test on the Prowlarr side and saves
        # the indexer immediately, side-stepping the timeout entirely.
        force_url = "/api/v1/indexer?forceSave=true"
        force_result, force_status, force_err = POST(base, key, force_url, schema)
        if force_result is not None:
            info(f"{name}: saved via forceSave (initial POST timed out — likely a slow reachability test on Prowlarr's side)")
            return
        # forceSave also failed at the network level — genuinely
        # unreachable Prowlarr (rare) or actually-broken request body.
        # Demote to info since user can add manually in ~10s; failing
        # the entire install over one flaky connection is worse UX.
        info(f"{name}: add request failed (HTTP {status}) — add manually via Prowlarr UI if you want it")

def _find_schema(name, schemas):
    """Find a schema by name with fuzzy matching for common variations."""
    name_lower = name.lower()
    # 1. Exact case-insensitive
    s = next((s for s in schemas if s.get('name', '').lower() == name_lower), None)
    if s:
        return s, name
    # 2. Schema name starts with our name (e.g. "Nyaa" → "Nyaa.si")
    candidates = [s for s in schemas
                  if s.get('name', '').lower().startswith(name_lower)
                  and len(s.get('name', '')) > len(name)]
    if len(candidates) == 1:
        return candidates[0], candidates[0]['name']
    # 3. Our name starts with schema name
    candidates = [s for s in schemas
                  if name_lower.startswith(s.get('name', '').lower())
                  and s.get('name', '')]
    if len(candidates) == 1:
        return candidates[0], candidates[0]['name']
    return None, None

def add_indexer(base, key, name, schemas, existing_names, flaresolverr_tag_id=None):
    """Add a public torrent indexer to Prowlarr.

    flaresolverr_tag_id: if provided, attached to the indexer's tags
    so Prowlarr routes the indexer's HTTP requests through the
    FlareSolverr proxy. Mandatory for CloudFlare-protected indexers
    (1337x, EZTV, TorrentGalaxy, etc.) — without it the add fails the
    reachability test and the indexer never enters the DB. Cheap and
    safe to apply to non-CloudFlare indexers too: Flaresolverr just
    passes their requests through transparently."""
    if name.lower() in existing_names:
        skip(f"{name} (already added)"); return

    schema, resolved_name = _find_schema(name, schemas)
    if schema is None:
        needle = name.lower()
        suggestions = [s['name'] for s in schemas
                       if needle in s.get('name', '').lower()
                       or s.get('name', '').lower() in needle]
        hint = f" — did you mean: {', '.join(suggestions[:5])}" if suggestions else ""
        fail(f"{name}: not found in Prowlarr{hint}")
        return

    if resolved_name != name and resolved_name.lower() in existing_names:
        skip(f"{name} → {resolved_name} (already added)"); return

    schema['name'] = resolved_name
    schema['enable'] = True
    schema['appProfileId'] = 1
    if flaresolverr_tag_id is not None:
        schema['tags'] = list(set(schema.get('tags') or []) | {flaresolverr_tag_id})
    display = f"{name} → {resolved_name}" if resolved_name != name else name
    _post_indexer(base, key, display, schema)

def _set_field_case_insensitive(schema, field_name, value):
    """Find a field in schema['fields'] by case-insensitive name match
    and set its value. Returns the actual schema field name we matched
    on (for logging) or None if no match found.

    Why: Prowlarr's indexer schemas have inconsistent field-name casing
    across implementations — AvistaZ uses `pid` (lowercase), AnimeBytes
    uses `passkey`, some old indexers use `PassKey` (Pascal). Our
    PRIVATE_TORRENT_INDEXERS map declares fields as lowercase. Without
    case-insensitive matching, a `pid` env var would fail to populate
    a schema field literally named `Pid` — the POST goes through with
    an empty PID, Prowlarr accepts the indexer schema-validation-wise
    but the tracker auth fails on first scheduled search, indexer
    quietly disappears from Prowlarr's UI."""
    field_name_lower = field_name.lower()
    for f in schema.get('fields', []):
        if f.get('name', '').lower() == field_name_lower:
            f['value'] = value
            return f.get('name')
    return None


def add_private_indexer(base, key, name, implementation, field_map, schemas, existing_names,
                        flaresolverr_tag_id=None, existing_indexers=None):
    """Add OR re-sync a private torrent tracker.

    Two modes:
      1. New: indexer not in Prowlarr → fetch schema, fill creds, POST.
      2. Re-sync: indexer already added → compare its stored creds to
         what's in .env (passed via field_map). If different, PATCH
         the indexer with the new values. This is the path that lets
         users update credentials (rotate AvistaZ PID, refresh
         IPTorrents cookie, etc.) by editing the Configure form and
         re-running step 8 — no need to delete + re-add in Prowlarr.

    field_map values here are already resolved STRINGS from .env (not
    env-var names). Caller does the env lookup so we can compare
    apples-to-apples to Prowlarr's stored field values."""

    # Re-sync path: indexer already exists, compare/update creds.
    if name.lower() in existing_names:
        if existing_indexers is None:
            # No indexer list passed — fall back to legacy "skip" behaviour.
            skip(f"{name} (already added)")
            return
        current = next((i for i in existing_indexers if i.get('name', '').lower() == name.lower()), None)
        if current is None:
            skip(f"{name} (already added)")
            return
        # Build a {field_name: stored_value} dict for the indexer as it
        # exists in Prowlarr right now. Compare against the requested
        # field_map. If they all match, skip; otherwise PATCH.
        # Case-insensitive field map so AvistaZ-style schemas with
        # `Pid` (Pascal-case) match our lowercase `pid`. Build a lower-
        # case key index of stored values to compare against.
        current_fields_ci = {f.get('name', '').lower(): f.get('value')
                             for f in current.get('fields', [])}
        changed = []
        for fname, requested_value in field_map.items():
            if requested_value == '':
                continue    # empty .env value = "don't touch"
            stored = current_fields_ci.get(fname.lower())
            # Prowlarr returns password-type fields as empty string when
            # GETing the indexer back (security feature — they don't echo
            # creds). So we can't reliably diff passwords. Apply unless
            # we KNOW the stored value matches.
            if stored != requested_value:
                changed.append(fname)
        if not changed:
            skip(f"{name} (already added, creds match)")
            return
        # Apply the new field values to the existing indexer and PUT,
        # using case-insensitive name matching.
        for fname, fval in field_map.items():
            if fval == '':
                continue
            _set_field_case_insensitive(current, fname, fval)
        # Ensure the flaresolverr tag stays attached on resync (covers
        # users on the upgrade path who never had the tag).
        if flaresolverr_tag_id is not None:
            current['tags'] = list(set(current.get('tags') or []) | {flaresolverr_tag_id})
        result, status, err = PUT_with_status(base, key, f"/api/v1/indexer/{current['id']}", current)
        # Retry on SQLite-busy: Prowlarr serializes writes through a
        # single SQLite handle, so concurrent Sync Apps + indexer test
        # calls + our PUT compete and one loses with "database is
        # locked". Up to 8 retries × 5s = 40s of patience. Each retry
        # re-PUTs the same body; idempotent.
        retries = 0
        while result is None and _is_db_locked(err) and retries < 8:
            retries += 1
            time.sleep(5)
            result, status, err = PUT_with_status(base, key, f"/api/v1/indexer/{current['id']}", current)
        if result is not None:
            suffix = f" (after {retries} retry/retries on DB lock)" if retries else ""
            ok(f"{name}: credentials updated ({', '.join(changed)}){suffix}")
        else:
            warn(f"{name}: credential update failed (HTTP {status}) — {_prowlarr_error(err or '')}")
        return

    # New-indexer path: fetch schema, fill creds, POST.
    schema, resolved_name = _find_schema(implementation, schemas)
    if schema is None:
        fail(f"{name}: implementation '{implementation}' not found in Prowlarr")
        return

    schema['name'] = name
    schema['enable'] = True
    schema['appProfileId'] = 1
    if flaresolverr_tag_id is not None:
        schema['tags'] = list(set(schema.get('tags') or []) | {flaresolverr_tag_id})

    # Set each field with case-insensitive name matching. Warn if any
    # field we tried to set wasn't found in the schema — that's the
    # subtle "AvistaZ silently rejected because pid wasn't populated"
    # failure mode. Better to surface it loudly here than wait for
    # the indexer to vanish from Prowlarr after first scheduled search.
    missed = []
    for fname, fval in field_map.items():
        if _set_field_case_insensitive(schema, fname, fval) is None:
            missed.append(fname)
    if missed:
        schema_field_names = [f.get('name', '?') for f in schema.get('fields', [])]
        warn(f"{name}: schema doesn't have field(s) {', '.join(missed)} — indexer may fail silently")
        info(f"  Schema fields: {', '.join(schema_field_names)}")
        info(f"  This is usually a Prowlarr-side schema change; the env-to-schema mapping needs an update.")

    _post_indexer(base, key, name, schema)

def apply_public_settings(base, key, public_names, priority=50, seed_time_mins=1):
    """Set priority and seed time on all public (no-login) indexers."""
    indexers = GET(base, key, "/api/v1/indexer") or []
    public_lower = {n.lower() for n in public_names}

    for indexer in indexers:
        if indexer.get('name', '').lower() not in public_lower:
            continue
        changed = False
        if indexer.get('priority') != priority:
            indexer['priority'] = priority
            changed = True
        for field in indexer.get('fields', []):
            if field.get('name') == 'seedCriteria.seedTime':
                if field.get('value') != seed_time_mins:
                    field['value'] = seed_time_mins
                    changed = True
        if not changed:
            skip(f"{indexer['name']} (priority={priority}, seedTime={seed_time_mins}m)")
            continue
        # Retry the PUT once on transient failure (same reasoning as
        # _post_indexer's retry): Prowlarr can briefly 503 while loading
        # an indexer's schema in the background, and we don't want a
        # single setting update to fail-the-whole-step over a flake.
        result = PUT(base, key, f"/api/v1/indexer/{indexer['id']}", indexer)
        if result is None:
            time.sleep(2)
            result = PUT(base, key, f"/api/v1/indexer/{indexer['id']}", indexer)
        if result:
            ok(f"{indexer['name']}: priority={priority}, seedTime={seed_time_mins}m")
        else:
            # Demoted to info: priority/seed-time tweaks are cosmetic
            # per-indexer settings; the indexer is added and functional
            # without them. User can adjust in 2 clicks in the Prowlarr
            # UI. Previous version called warn() / fail() which flagged
            # this in the wizard's issues panel — disproportionate.
            info(f"{indexer['name']}: settings update flaked — tweak priority/seedTime in Prowlarr UI if you care")

def add_newznab(base, key, name, api_url, api_key, schemas, existing_names, existing_indexers=None):
    """Add or re-sync a Newznab usenet indexer.

    Re-sync semantics match add_private_indexer: if the indexer's
    already in Prowlarr, compare its stored apiKey + baseUrl to what
    we'd write. If they differ, PATCH. This lets users rotate API
    keys (NZBGeek + other paid usenet providers often require periodic
    refresh) by editing .env and re-running step 8."""

    if name.lower() in existing_names:
        if existing_indexers is None:
            skip(f"{name} (already added)")
            return
        current = next((i for i in existing_indexers if i.get('name', '').lower() == name.lower()), None)
        if current is None:
            skip(f"{name} (already added)")
            return
        current_fields = {f.get('name'): f.get('value') for f in current.get('fields', [])}
        desired = {'baseUrl': api_url, 'apiKey': api_key or ''}
        changed = []
        for fname, requested in desired.items():
            if requested == '' and fname == 'apiKey':
                # Empty .env api_key = "don't touch". The user likely
                # disabled the indexer by clearing the .env value;
                # leaving the stored key in place gives them an easy
                # rollback if they re-fill the .env later.
                continue
            stored = current_fields.get(fname)
            if stored != requested:
                changed.append(fname)
        if not changed:
            skip(f"{name} (already added, creds match)")
            return
        fm = {f['name']: i for i, f in enumerate(current.get('fields', []))}
        for fname, fval in desired.items():
            if fval == '' and fname == 'apiKey':
                continue
            if fname in fm:
                current['fields'][fm[fname]]['value'] = fval
        result, status, err = PUT_with_status(base, key, f"/api/v1/indexer/{current['id']}", current)
        # Retry on SQLite-busy: Prowlarr serializes writes through a
        # single SQLite handle, so concurrent Sync Apps + indexer test
        # calls + our PUT compete and one loses with "database is
        # locked". Up to 8 retries × 5s = 40s of patience. Each retry
        # re-PUTs the same body; idempotent.
        retries = 0
        while result is None and _is_db_locked(err) and retries < 8:
            retries += 1
            time.sleep(5)
            result, status, err = PUT_with_status(base, key, f"/api/v1/indexer/{current['id']}", current)
        if result is not None:
            suffix = f" (after {retries} retry/retries on DB lock)" if retries else ""
            ok(f"{name}: credentials updated ({', '.join(changed)}){suffix}")
        else:
            warn(f"{name}: credential update failed (HTTP {status}) — {_prowlarr_error(err or '')}")
        return

    schema = next((s for s in schemas
                   if s.get('implementation', '').lower() == 'newznab'), None)
    if schema is None:
        fail(f"{name}: Newznab implementation not found"); return

    schema = json.loads(json.dumps(schema))  # deep copy — reused across calls
    schema['name'] = name
    schema['enable'] = True
    schema['appProfileId'] = 1

    fm = {f['name']: i for i, f in enumerate(schema.get('fields', []))}
    for fname, fval in [('baseUrl', api_url), ('apiKey', api_key or '')]:
        if fname in fm:
            schema['fields'][fm[fname]]['value'] = fval

    _post_indexer(base, key, name, schema)

# ── Read .env ─────────────────────────────────────────────────────────────────

def read_env(path):
    env = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                v = v.split('#')[0].strip()
                if v:
                    env[k.strip()] = v
    except FileNotFoundError:
        pass
    return env

def read_env_merged(script_dir):
    # .env lives at the compose root (INSTALL_DIR). With the v0.3.22 layout
    # this script lives at INSTALL_DIR/scripts/indexers/ — two levels deep
    # — so we walk up two parents. Legacy installs had it at
    # INSTALL_DIR/indexers/ (one level), so the shorter walk is also
    # checked. Falls back to script_dir for very-old layouts.
    candidates = [
        script_dir,
        os.path.dirname(script_dir),
        os.path.dirname(os.path.dirname(script_dir)),
    ]
    env_dir = next((d for d in candidates if os.path.exists(os.path.join(d, '.env'))), script_dir)
    return read_env(os.path.join(env_dir, '.env'))

def read_arr_key(config_xml):
    import xml.etree.ElementTree as ET
    try:
        return ET.parse(config_xml).find('ApiKey').text
    except Exception:
        return None

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    script_dir = os.path.dirname(os.path.realpath(__file__))
    env        = read_env_merged(script_dir)

    LAN_IP       = env.get('LAN_IP', '')
    # Resolve INSTALL_DIR portably: .env writes it on every install since
    # the multi-NAS refactor. Fallbacks: walk up from script_dir (which
    # under the v0.3.22 layout is INSTALL_DIR/scripts/indexers/, so two
    # parents up = compose root; legacy installs had this script at
    # INSTALL_DIR/indexers/, one parent up). Final fallback is the
    # Synology-historical path so really-old hand-edited installs don't
    # regress to "" and produce empty bind mounts.
    if env.get('INSTALL_DIR'):
        install_dir = env.get('INSTALL_DIR')
    elif os.path.basename(os.path.dirname(script_dir)) == 'scripts':
        install_dir = os.path.dirname(os.path.dirname(script_dir))
    else:
        install_dir = os.path.dirname(script_dir) or '/volume1/docker/media'
    PROWLARR_KEY = env.get('PROWLARR_API_KEY') or read_arr_key(f'{install_dir}/prowlarr/config/config.xml')

    if not LAN_IP:
        print("Error: LAN_IP not set in .env"); sys.exit(1)
    if not PROWLARR_KEY:
        print("Error: Prowlarr API key not found — is the container running?")
        sys.exit(1)

    PROWLARR = f"http://{LAN_IP}:49150"

    print(f"\n{BOLD}╔══════════════════════════════════════════╗")
    print("║        Prowlarr Indexer Setup            ║")
    print(f"╚══════════════════════════════════════════╝{RESET}")

    if not wait_ready(PROWLARR, PROWLARR_KEY):
        sys.exit(1)

    # Fetch schemas once — passed to all add_* calls to avoid repeated requests
    schemas = GET(PROWLARR, PROWLARR_KEY, "/api/v1/indexer/schema") or []
    if not schemas:
        print(f"{RED}Error: could not fetch indexer schemas from Prowlarr{RESET}")
        sys.exit(1)

    existing = GET(PROWLARR, PROWLARR_KEY, "/api/v1/indexer") or []
    existing_names = {i['name'].lower() for i in existing}

    # Locate or create the 'flaresolverr' tag. setup-arr-config.py
    # creates this tag in add_flaresolverr_proxy and attaches it to
    # the Flaresolverr IndexerProxy — Prowlarr only routes through
    # the proxy for indexers that SHARE a tag with it. Without this
    # tag on the indexer, CloudFlare-protected adds (1337x, EZTV,
    # TorrentGalaxy, AnimeTorrents, etc.) fail the reachability test
    # during add and never enter the DB. Passing the tag to every
    # public + private indexer add is safe (Flaresolverr proxies
    # non-CloudFlare requests transparently with negligible overhead).
    flaresolverr_tag_id = get_or_create_tag(PROWLARR, PROWLARR_KEY, 'flaresolverr')
    if flaresolverr_tag_id is not None:
        info(f"Flaresolverr tag id = {flaresolverr_tag_id} — applying to public + private torrent indexers")
        # Patch the FlareSolverr IndexerProxy itself to include the
        # tag, in case it was created by an OLDER wizard version with
        # empty tags (the historical bug). Without the proxy ALSO
        # having the tag, indexer-tagging is meaningless — Prowlarr
        # only routes when both sides share a tag. Idempotent: if the
        # proxy already has the tag, we don't re-PUT.
        proxies = GET(PROWLARR, PROWLARR_KEY, "/api/v1/indexerProxy") or []
        flaresolverr_proxy = next(
            (p for p in proxies if p.get('implementation') == 'FlareSolverr'),
            None,
        )
        if flaresolverr_proxy is None:
            warn("FlareSolverr IndexerProxy not configured — run setup-arr-config.py first (step 7)")
        elif flaresolverr_tag_id not in (flaresolverr_proxy.get('tags') or []):
            flaresolverr_proxy['tags'] = list(
                set(flaresolverr_proxy.get('tags') or []) | {flaresolverr_tag_id}
            )
            updated, _, _ = POST(
                PROWLARR, PROWLARR_KEY,
                f"/api/v1/indexerProxy/{flaresolverr_proxy['id']}?_method=PUT",
                flaresolverr_proxy,
            )
            # Some Prowlarr versions don't accept _method override on
            # POST; try a real PUT helper too. Either succeeding is
            # enough.
            if not updated:
                updated_alt = PUT(
                    PROWLARR, PROWLARR_KEY,
                    f"/api/v1/indexerProxy/{flaresolverr_proxy['id']}",
                    flaresolverr_proxy,
                )
                updated = updated_alt
            if updated:
                info("Attached 'flaresolverr' tag to existing FlareSolverr proxy (was missing — fixes routing)")
            else:
                warn("FlareSolverr proxy missing 'flaresolverr' tag — manually add it in Prowlarr UI to enable CloudFlare bypass")
    else:
        warn("Couldn't find/create 'flaresolverr' tag — CloudFlare-protected indexers may fail to add")

    # ── Public torrent indexers ───────────────────────────────────────────────

    section("Public Torrent Indexers")
    for name in PUBLIC_TORRENT_INDEXERS:
        add_indexer(PROWLARR, PROWLARR_KEY, name, schemas, existing_names,
                    flaresolverr_tag_id=flaresolverr_tag_id)

    # ── Usenet indexers ───────────────────────────────────────────────────────

    section("Usenet Indexers")
    for entry in USENET_INDEXERS:
        name, api_url, required_key, optional_key = entry

        if required_key is None:
            # Free indexer — always add; use optional key for higher limits if available
            api_key = env.get(optional_key, '') if optional_key else ''
            if api_key:
                ok_note = f"{name} (with API key — higher limits)"
            else:
                ok_note = name
            add_newznab(PROWLARR, PROWLARR_KEY, name, api_url, api_key, schemas, existing_names, existing_indexers=existing)
        else:
            api_key = env.get(required_key, '')
            if not api_key:
                skip(f"{name} (set {required_key} in .env to enable)")
            else:
                add_newznab(PROWLARR, PROWLARR_KEY, name, api_url, api_key, schemas, existing_names, existing_indexers=existing)

    # ── Private torrent trackers ──────────────────────────────────────────────

    section("Private Torrent Trackers")
    private_added = 0
    for name, implementation, field_env_map in PRIVATE_TORRENT_INDEXERS:
        creds = {field: env.get(env_var, '')
                 for field, env_var in field_env_map.items()}
        missing = [env_var for field, env_var in field_env_map.items()
                   if not env.get(env_var)]
        if missing:
            skip(f"{name} (add {', '.join(missing)} to .env to enable)")
            continue
        add_private_indexer(PROWLARR, PROWLARR_KEY, name, implementation,
                            creds, schemas, existing_names,
                            flaresolverr_tag_id=flaresolverr_tag_id,
                            existing_indexers=existing)
        private_added += 1

    if private_added == 0:
        warn("No private tracker credentials in .env — see header comments to enable")

    # ── Public indexer settings ───────────────────────────────────────────────

    section("Public Indexer Settings")
    apply_public_settings(PROWLARR, PROWLARR_KEY, PUBLIC_TORRENT_INDEXERS)

    # ── Summary ───────────────────────────────────────────────────────────────

    print(f"\n{'═' * 52}")
    if errors == 0:
        print(f"{GREEN}{BOLD}  All done — no errors.{RESET}")
    else:
        print(f"{YELLOW}{BOLD}  Done with {errors} per-indexer issue(s) — review output above.{RESET}")
        print(f"  These are best-effort additions; each failed indexer can be")
        print(f"  added/tweaked manually via the Prowlarr UI in seconds. None")
        print(f"  of them block the rest of the install.")
    print(f"{'═' * 52}\n")
    # Always exit 0 once we've reached this point. Real "step 8 broken"
    # scenarios (Prowlarr unreachable, API key wrong, etc.) sys.exit(1)
    # earlier from the wait_ready / arg-validation phase. Per-indexer
    # add/settings failures are surfaced as warnings/errors in the log
    # but don't fail-the-step — that was producing too many false-
    # failed installs over transient single-indexer connectivity issues
    # (real-world logs: Tokyo Toshokan settings update, AnimeTosho add
    # racing Prowlarr's schema cache, etc.). User gets the diagnostic
    # in the log; the stack as a whole keeps running.
    sys.exit(0)


if __name__ == '__main__':
    main()
