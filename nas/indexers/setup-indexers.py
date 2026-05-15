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
USENET_INDEXERS = [
    # ── Free (no account required, or optional key for higher limits) ─────────
    ("AnimeTosho",     "https://feed.animetosho.org",      None,                    "ANIMETOSHO_API_KEY"),
    # ── Optional-key (free to register but still require an API key) ─────────
    # ABNzb and Althub historically allowed RSS-only access without a
    # key, but their current backends reject add-attempts without
    # `Indexer requires an API key`. Treat them like any other Newznab
    # indexer that needs creds — skip cleanly when the key isn't set.
    ("ABNzb",          "https://abnzb.com",                "ABNZB_API_KEY",         None),
    ("Althub",         "https://www.althub.co.za",         "ALTHUB_API_KEY",        None),
    # ── Account required ──────────────────────────────────────────────────────
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
]

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _headers(key):
    return {'X-Api-Key': key, 'Content-Type': 'application/json',
            'User-Agent': 'setup-indexers/1.0'}

def _request(url, headers, method='GET', data=None):
    """Returns (result, status_code, error_body). Never prints."""
    body = json.dumps(data).encode() if data is not None else None
    req = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=15) as resp:
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

def GET(base, key, path):
    result, _, _ = _request(f"{base}{path}", _headers(key))
    return result

def POST(base, key, path, data):
    result, status, err = _request(f"{base}{path}", _headers(key), 'POST', data)
    return result, status, err

def PUT(base, key, path, data):
    result, _, _ = _request(f"{base}{path}", _headers(key), 'PUT', data)
    return result

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
        ok(f"{name}")
        return
    if status == 400 and err:
        err_lower = err.lower()
        if 'unique' in err_lower:
            skip(f"{name} (already added)")
            return
        # Real bug from the latest install log: when Prowlarr's TEST on
        # the new indexer fails (CloudFlare-blocked, redirecting domain,
        # unreachable backend), the default POST returns 400 and the
        # indexer is NOT saved. The previous code said "added but blocked
        # by CloudFlare" — that "added" was a lie. Indexer was nowhere
        # in the Prowlarr UI.
        #
        # Fix: retry the POST with ?forceSave=true. This is the exact
        # same path the Prowlarr Web UI uses when you click "Save anyway"
        # after a failed test — the indexer is stored in the DB with a
        # red test-failed badge, and Prowlarr retries the test on every
        # scheduled search. Flaresolverr / a CloudFlare cookie / a fixed
        # DNS issue resolves it in the background without any further
        # user action. Far better than silently dropping the indexer.
        test_failed_keywords = (
            'cloudflare', 'blocked by', 'redirect',
            'unable to connect', 'unable to access',
        )
        if any(k in err_lower for k in test_failed_keywords):
            force_result, force_status, force_err = POST(
                base, key, "/api/v1/indexer?forceSave=true", schema)
            if force_result is not None:
                # Saved with test-failed flag — Prowlarr will retest on
                # the next scheduled search; user sees the indexer in
                # their list with a red badge that auto-clears once the
                # test passes (typically minutes after install when the
                # arrs trigger their first indexer query).
                if 'cloudflare' in err_lower or 'blocked by' in err_lower:
                    info(f"{name}: saved with forceSave (CloudFlare test failed — Flaresolverr will retry on next search)")
                elif 'redirect' in err_lower:
                    info(f"{name}: saved with forceSave (domain redirecting — Prowlarr retests on next search)")
                else:
                    info(f"{name}: saved with forceSave (currently unreachable — {_prowlarr_error(err)})")
                return
            # forceSave also rejected — something more fundamental is
            # wrong (schema mismatch, required field missing, etc.).
            # Fall through to the generic-fail path.
            fail(f"{name}: forceSave also rejected — {_prowlarr_error(force_err or err)}")
            return
        # Unknown 400 — surface the Prowlarr error verbatim so the user
        # can act on it (or open an issue).
        fail(f"{name}: {_prowlarr_error(err)}")
    else:
        # Network error after retry — demote to info rather than fail.
        # The user can add the indexer manually in 10 seconds via the
        # Prowlarr UI; failing the entire install over one flaky
        # connection is the worse UX.
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

def add_indexer(base, key, name, schemas, existing_names):
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
    display = f"{name} → {resolved_name}" if resolved_name != name else name
    _post_indexer(base, key, display, schema)

def add_private_indexer(base, key, name, implementation, field_map, schemas, existing_names):
    if name.lower() in existing_names:
        skip(f"{name} (already added)"); return

    schema, resolved_name = _find_schema(implementation, schemas)
    if schema is None:
        fail(f"{name}: implementation '{implementation}' not found in Prowlarr")
        return

    schema['name'] = name
    schema['enable'] = True
    schema['appProfileId'] = 1

    fm = {f['name']: i for i, f in enumerate(schema.get('fields', []))}
    for fname, fval in field_map.items():
        if fname in fm:
            schema['fields'][fm[fname]]['value'] = fval

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

def add_newznab(base, key, name, api_url, api_key, schemas, existing_names):
    if name.lower() in existing_names:
        skip(f"{name} (already added)"); return

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
        with open(path) as f:
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
    candidates = [script_dir, os.path.dirname(script_dir)]
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
    # the multi-NAS refactor, but fall back to script_dir's parent (this
    # script lives at <INSTALL_DIR>/indexers/) for older .envs the user
    # may have hand-edited, and finally to the Synology-historical path
    # so really-old installs don't regress.
    install_dir  = env.get('INSTALL_DIR') or os.path.dirname(script_dir) or '/volume1/docker/media'
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

    # ── Public torrent indexers ───────────────────────────────────────────────

    section("Public Torrent Indexers")
    for name in PUBLIC_TORRENT_INDEXERS:
        add_indexer(PROWLARR, PROWLARR_KEY, name, schemas, existing_names)

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
            add_newznab(PROWLARR, PROWLARR_KEY, name, api_url, api_key, schemas, existing_names)
        else:
            api_key = env.get(required_key, '')
            if not api_key:
                skip(f"{name} (set {required_key} in .env to enable)")
            else:
                add_newznab(PROWLARR, PROWLARR_KEY, name, api_url, api_key, schemas, existing_names)

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
                            creds, schemas, existing_names)
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
