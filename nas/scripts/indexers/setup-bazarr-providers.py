#!/usr/bin/env python3
"""
setup-bazarr-providers.py — Set up Bazarr subtitles end to end

Three jobs, all idempotent and safe to re-run on every install/update, run in
this deliberate order:

  1. Enable the curated FREE providers (no account needed) in one batch.

  2. Make English subtitles actually work out of the box — enable the English
     language, create an "English" language profile, set it as the default
     profile for new Sonarr series + Radarr movies (only when the user hasn't
     already chosen their own default), and backfill that profile onto any
     existing series/movies that don't have one yet.

  3. Enable the credential-based ACCOUNT providers (OpenSubtitles.com/.org,
     Addic7ed) — only those whose keys are set in .env, and each saved on its
     OWN request so one bad credential can't fail the others.

Order matters: Bazarr validates account credentials on save and can throw a
500 (and briefly drop its API) on a bad/rate-limited login. Saving accounts
LAST — after the local, dependency-free English profile — means such a wobble
can't cascade onto the setup that actually matters. And every save here is a
convenience: a rejected provider/credential save is a warn(), never a fail(),
so it can't redden the whole install step. Only an unreachable Bazarr (caught
by wait_ready) is a hard failure.

Everything is written through Bazarr's FORM-ENCODED settings API (see
POST_FORM). An earlier version POSTed JSON, which Bazarr silently ignored
(its settings endpoint reads request.form, so a JSON body saved nothing).

Safe to re-run — skips providers/profiles that are already in place.

Usage:
    python3 /volume1/docker/media/indexers/setup-bazarr-providers.py

.env keys (optional — only needed for account-based providers):
    OPENSUBTITLES_USER=your_username
    OPENSUBTITLES_PASS=your_password
    OPENSUBTITLESCOM_USER=your_username
    OPENSUBTITLESCOM_PASS=your_password
    ADDIC7ED_USER=your_username
    ADDIC7ED_PASS=your_password
"""

import json
import os
import re
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

# ── Terminal colours ──────────────────────────────────────────────────────────

GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

errors = 0
warnings = 0

def ok(msg):   print(f"  {GREEN}✔{RESET}  {msg}")
def skip(msg): print(f"  –  {msg}")
def warn(msg):
    global warnings; warnings += 1
    print(f"  {YELLOW}!{RESET}  {msg}")
def fail(msg):
    global errors; errors += 1
    print(f"  {RED}✘{RESET}  {msg}")
def section(title):
    print(f"\n{BOLD}━━━ {title} {'━' * max(0, 52 - len(title))}{RESET}")

# ── Provider definitions ──────────────────────────────────────────────────────
#
# FREE_PROVIDERS: enabled automatically, no credentials needed.
# Each entry: (display_name, provider_id)
#
# ACCOUNT_PROVIDERS: enabled only if credentials are in .env.
# Each entry: (display_name, provider_id, settings_key, {field: env_var, ...})

FREE_PROVIDERS = [
    ("YIFY Subtitles",  "yifysubtitles"),
    ("Podnapisi",       "podnapisi"),
    ("TVSubtitles",     "tvsubtitles"),
    # Subscene shut down in mid-2024. Adding it to Bazarr's enabled list
    # either errors or no-ops and breaks the all-providers POST that
    # saves the rest of the batch. Subf2m is the community successor.
    ("Subf2m",          "subf2m"),
    ("Gestdown",        "gestdown"),       # Addic7ed mirror, no account needed
    ("SuperSubtitles",  "supersubtitles"),
]

ACCOUNT_PROVIDERS = [
    # OpenSubtitles.com is the modern API (v2); .org's legacy XMLRPC is
    # being phased out by Bazarr upstream and accounts are NOT shared
    # between the two sites. Prefer .com — only register .org as a
    # fallback for users who still have legacy creds.
    (
        "OpenSubtitles.com",
        "opensubtitlescom",
        "opensubtitlescom",
        {"username": "OPENSUBTITLESCOM_USER", "password": "OPENSUBTITLESCOM_PASS"},
    ),
    (
        "OpenSubtitles.org (legacy)",
        "opensubtitles",
        "opensubtitles",
        {"username": "OPENSUBTITLES_USER", "password": "OPENSUBTITLES_PASS"},
    ),
    (
        "Addic7ed",
        "addic7ed",
        "addic7ed",
        {"username": "ADDIC7ED_USER", "password": "ADDIC7ED_PASS"},
    ),
]

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _request(url, headers, method='GET', data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=15) as resp:
            content = resp.read()
            return json.loads(content) if content else {}
    except HTTPError as e:
        body_text = e.read().decode(errors='replace')
        print(f"    HTTP {e.code}: {body_text[:200]}")
        return None
    except (URLError, OSError):
        return None

def _headers(key):
    return {'X-API-KEY': key, 'Content-Type': 'application/json',
            'User-Agent': 'setup-bazarr-providers/1.0'}

def GET(base, key, path):
    return _request(f"{base}{path}", _headers(key))

def _form_headers(key):
    return {'X-API-KEY': key,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'setup-bazarr-providers/1.0'}

def POST_FORM(base, key, path, fields):
    """POST application/x-www-form-urlencoded to Bazarr.

    `fields` is a list of (name, value) tuples. Repeat a name to send a
    multi-value field the way Bazarr's own web UI does — e.g. the
    enabled_providers "array key" arrives as several
    `settings-general-enabled_providers=<id>` pairs, and each series id in a
    backfill as a repeated `seriesid=<n>`. This is the ONLY shape Bazarr's
    settings/series/movies endpoints accept: they read request.form (and
    reqparse request.values), so a JSON body would be ignored entirely.

    Returns {} on any 2xx (Bazarr answers settings saves with an empty 204),
    or None on an HTTP/network error."""
    body = urlencode(fields).encode()
    req = Request(f"{base}{path}", data=body,
                  headers=_form_headers(key), method='POST')
    try:
        with urlopen(req, timeout=15) as resp:
            content = resp.read()
            if not content:
                return {}
            try:
                return json.loads(content)
            except ValueError:
                return {}          # 2xx with a non-JSON body still means OK
    except HTTPError as e:
        body_text = e.read().decode(errors='replace')
        print(f"    HTTP {e.code}: {body_text[:200]}")
        return None
    except (URLError, OSError):
        return None

# ── Wait for Bazarr ───────────────────────────────────────────────────────────

def wait_ready(base, key, retries=24, interval=5):
    sys.stdout.write("  Waiting for Bazarr ")
    sys.stdout.flush()
    for _ in range(retries):
        if GET(base, key, "/api/system/settings") is not None:
            print(f"{GREEN}✔{RESET}"); return True
        sys.stdout.write("."); sys.stdout.flush()
        time.sleep(interval)
    print(f"{RED}✘ timed out{RESET}"); return False

# ── Provider helpers ──────────────────────────────────────────────────────────

def enable_providers(base, key, to_add):
    """Enable a list of (display_name, provider_id, optional_settings_dict) in Bazarr.

    Read-modify-write against the FORM-ENCODED settings API. We fetch the
    current enabled_providers, add any that are missing, and POST the whole
    set back as repeated `settings-general-enabled_providers` form fields —
    the exact shape Bazarr's web UI uses (enabled_providers is one of Bazarr's
    "array keys"). Credentials for account providers go out as
    `settings-<provider>-<field>` fields.

    This replaced an older JSON POST that Bazarr silently dropped: its settings
    endpoint reads request.form, so an application/json body left the form
    empty and save_settings() wrote nothing — providers were never actually
    enabled. save_settings() only touches the keys we send, so posting just the
    provider fields is a safe partial update that won't disturb other settings.

    Returns True when the batch saved (or there was nothing to add), False when
    Bazarr rejected the save. A rejected save is a warn(), never a fail():
    subtitle providers are a convenience and must not redden the install step —
    the caller loops the credential-based account providers one at a time so a
    single bad login can't fail the rest, and re-checks readiness between them
    (a 500 on save can briefly drop Bazarr's API). Only an unreachable Bazarr
    (caught by wait_ready) is a hard failure."""
    settings = GET(base, key, "/api/system/settings")
    if settings is None:
        warn("Bazarr settings API didn't respond — skipping these providers")
        return False

    enabled  = set(settings.get('general', {}).get('enabled_providers') or [])
    pending  = []   # (display, provider_id, provider_settings) not yet enabled

    for display, provider_id, provider_settings in to_add:
        if provider_id in enabled:
            skip(f"{display} (already enabled)")
            continue
        pending.append((display, provider_id, provider_settings))

    if not pending:
        return True

    # enabled_providers is an "array key": send the full union as repeated
    # fields. Add each pending provider's credentials as settings-<id>-<field>.
    union  = sorted(enabled | {pid for _d, pid, _ps in pending})
    fields = [('settings-general-enabled_providers', pid) for pid in union]
    for _display, provider_id, provider_settings in pending:
        for field, value in (provider_settings or {}).items():
            fields.append((f'settings-{provider_id}-{field}', value))

    if POST_FORM(base, key, "/api/system/settings", fields) is not None:
        for display, _pid, _ps in pending:
            ok(f"{display}")
        if len(pending) > 1:
            ok("Settings saved")
        return True

    # A rejected save — warn (never fail). Mention credentials only when this
    # batch actually carried some, so the free-provider case stays accurate.
    has_creds = any(ps for _d, _pid, ps in pending)
    for display, _pid, _ps in pending:
        if has_creds:
            warn(f"{display}: Bazarr rejected the save — check its credentials "
                 f"in Settings → Providers")
        else:
            warn(f"{display}: Bazarr rejected the save")
    return False


# ── English subtitle profile ──────────────────────────────────────────────────

ENGLISH_CODE         = "en"
ENGLISH_PROFILE_NAME = "English"


def _is_unset(v):
    """A Bazarr default-profile setting / a series-or-movie profileId counts as
    'unset' when it's blank, None, or 0 — real profile ids start at 1."""
    return v in (None, '', 0, '0')


def _resolve_profile_id(existing, fallback):
    """The user's own configured profile id if they have one, else `fallback`
    (our English profile). Used to decide what backfill assigns."""
    if _is_unset(existing):
        return fallback
    try:
        return int(existing)
    except (TypeError, ValueError):
        return fallback


def _english_profile_item(item_id=1):
    """One profile item selecting plain English. The 'True'/'False' strings
    match Bazarr's PythonBoolean convention for profile-item flags."""
    return {
        "id": item_id,
        "language": ENGLISH_CODE,
        "audio_exclude": "False",
        "audio_only_include": "False",
        "hi": "False",
        "forced": "False",
    }


def _as_list(payload):
    """Bazarr list endpoints return either a bare list or {'data': [...]}."""
    if isinstance(payload, dict):
        return payload.get('data') or []
    return payload or []


def setup_english_subtitles(base, key):
    """Enable English, ensure an 'English' language profile exists, and — only
    when the user hasn't already chosen their own default — make it the default
    profile for new Sonarr series and Radarr movies.

    Read-modify-write, because Bazarr's settings endpoint treats
    `languages-enabled` and `languages-profiles` as AUTHORITATIVE FULL LISTS:
    it resets every language-enabled flag then re-enables exactly what we send,
    and it DELETES any profile we don't resubmit. So we always fetch the current
    state and add English to it — never replace it.

    Everything non-fatal here is a warn(), not a fail(): subtitles are a
    convenience and must never mark the install step failed.

    Returns a dict (english_id, series_profile, movie_profile, use_sonarr,
    use_radarr) for the backfill step, or None if Bazarr was unreachable."""
    settings = GET(base, key, "/api/system/settings")
    if settings is None:
        warn("Skipping English profile — Bazarr settings API unreachable")
        return None
    general = settings.get('general', {})

    # 1. Enabled languages — add English to whatever's already enabled.
    #    A failed GET must NOT be read as "nothing enabled": the settings POST
    #    resets every enabled flag then re-enables only what we send, so acting
    #    on an empty-from-error list would DISABLE the user's other languages.
    langs = GET(base, key, "/api/system/languages")
    if langs is None:
        warn("Skipping English profile — couldn't read Bazarr languages")
        return None
    langs = _as_list(langs)
    enabled_codes  = {l.get('code2') for l in langs if l.get('enabled')}
    enabled_codes.discard(None)
    add_english_lang = ENGLISH_CODE not in enabled_codes

    # 2. Language profile — reuse an existing "English" profile if present.
    #    Same guard, and it matters even more here: `languages-profiles` is an
    #    authoritative full list, so submitting one built from an error-empty
    #    fetch would DELETE every existing profile.
    profiles = GET(base, key, "/api/system/languages/profiles")
    if profiles is None:
        warn("Skipping English profile — couldn't read Bazarr language profiles")
        return None
    profiles = _as_list(profiles)
    english  = next((p for p in profiles
                     if str(p.get('name', '')).strip().lower() == ENGLISH_PROFILE_NAME.lower()),
                    None)
    create_profile = english is None
    if create_profile:
        english_id = max((int(p.get('profileId', 0)) for p in profiles), default=0) + 1
        english = {
            "profileId": english_id,
            "name": ENGLISH_PROFILE_NAME,
            "cutoff": None,
            "items": [_english_profile_item()],
            "mustContain": [],
            "mustNotContain": [],
            "originalFormat": None,
            "tag": None,
        }
        profiles_full = profiles + [english]
    else:
        english_id = int(english.get('profileId', 0))

    # 3. Defaults — non-destructive: only fill a default that isn't already set.
    set_series_default = bool(general.get('use_sonarr')) and _is_unset(general.get('serie_default_profile'))
    set_movie_default  = bool(general.get('use_radarr')) and _is_unset(general.get('movie_default_profile'))

    # One combined form POST. Order inside Bazarr's handler is
    # languages-enabled → languages-profiles → save_settings(defaults), so the
    # profile exists before we point the defaults at its id.
    fields = []
    if add_english_lang:
        for code in sorted(enabled_codes | {ENGLISH_CODE}):
            fields.append(('languages-enabled', code))
    if create_profile:
        fields.append(('languages-profiles', json.dumps(profiles_full)))
    if set_series_default:
        fields.append(('settings-general-serie_default_enabled', 'True'))
        fields.append(('settings-general-serie_default_profile', str(english_id)))
    if set_movie_default:
        fields.append(('settings-general-movie_default_enabled', 'True'))
        fields.append(('settings-general-movie_default_profile', str(english_id)))

    if fields and POST_FORM(base, key, "/api/system/settings", fields) is None:
        warn("Bazarr rejected the English language/profile save")
        return None

    if create_profile:   ok(f"Created the '{ENGLISH_PROFILE_NAME}' language profile")
    else:                skip(f"'{ENGLISH_PROFILE_NAME}' language profile (already exists)")
    if add_english_lang: ok("Enabled English (en)")
    else:                skip("English (en) already enabled")
    if set_series_default:            ok("Set English as the default profile for TV series")
    elif general.get('use_sonarr'):   skip("Series default profile (already set — left as-is)")
    if set_movie_default:             ok("Set English as the default profile for movies")
    elif general.get('use_radarr'):   skip("Movie default profile (already set — left as-is)")

    return {
        "english_id":     english_id,
        "series_profile": _resolve_profile_id(general.get('serie_default_profile'), english_id),
        "movie_profile":  _resolve_profile_id(general.get('movie_default_profile'), english_id),
        "use_sonarr":     bool(general.get('use_sonarr')),
        "use_radarr":     bool(general.get('use_radarr')),
    }


def backfill_profiles(base, key, kind, list_path, id_field, param, profile_id):
    """Assign `profile_id` to every synced series/movie that has NO profile yet.

    Non-destructive: items the user already assigned a profile are never
    touched. Best-effort — a fresh install where Bazarr hasn't synced Sonarr/
    Radarr yet simply has nothing to do, and a rejected update warns rather
    than fails. The endpoint pairs equal-length seriesid/profileid (or
    radarrid/profileid) arrays, so we emit one profileid per id and chunk to
    keep the request body small on large libraries."""
    raw = GET(base, key, list_path)
    if raw is None:
        warn(f"Skipping {kind} backfill — couldn't reach Bazarr")
        return
    items = _as_list(raw)
    if not items:
        skip(f"No {kind} synced yet — nothing to backfill")
        return
    orphans = [it[id_field] for it in items if _is_unset(it.get('profileId'))]
    if not orphans:
        skip(f"All {kind} already have a profile")
        return

    done = 0
    for i in range(0, len(orphans), 100):
        chunk  = orphans[i:i + 100]
        fields = [(param, str(x)) for x in chunk] + \
                 [('profileid', str(profile_id)) for _ in chunk]
        if POST_FORM(base, key, list_path, fields) is None:
            warn(f"Backfill of some {kind} was rejected by Bazarr")
            return
        done += len(chunk)
    ok(f"Applied a subtitle profile to {done} existing {kind} that had none")

# ── Read config ───────────────────────────────────────────────────────────────

def _parse_env_value(raw):
    """Parse a .env value the way the wizard's ESCAPE writer intends.
    A double-quoted value is un-escaped in a single left-to-right pass (an
    escaped backslash/quote/dollar/backtick becomes the literal char; an
    escaped n or r becomes newline/CR), so a literal backslash can't be
    mis-paired with the next char. A single-quoted value is taken literally.
    A bare value has a whitespace-anchored ' #comment' stripped. Mirrors
    ESCAPE() in installer/src/shared/env-render.ts so a password containing a
    quote, dollar, backtick or backslash (or a '#') round-trips intact."""
    s = raw.strip()
    if s[:1] == '"':
        out = []
        i, n = 1, len(s)
        while i < n:
            c = s[i]
            if c == '\\' and i + 1 < n:
                d = s[i + 1]
                out.append('\n' if d == 'n' else '\r' if d == 'r' else d)
                i += 2
                continue
            if c == '"':
                break
            out.append(c)
            i += 1
        return ''.join(out)
    if s[:1] == "'":
        j = s.find("'", 1)
        return s[1:j] if j != -1 else s[1:]
    return re.split(r'\s#', s, 1)[0].strip()


def read_env(path):
    env = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                # Strip an inline ' #comment' (whitespace-anchored) but PRESERVE
                # a '#' embedded in the value — a subtitle-provider password
                # like p@ss#word must survive intact — then strip the surrounding
                # quotes the wizard's ESCAPE adds around special-char values.
                # Mirrors read_env() in setup-arr-config.py; the old bare
                # split('#') corrupted any credential containing '#'.
                v = _parse_env_value(v)
                if v:
                    env[k.strip()] = v
    except FileNotFoundError:
        pass
    return env

def read_env_merged(script_dir):
    # .env lives at the compose root. v0.3.22 layout has this script at
    # INSTALL_DIR/scripts/indexers/ — walk up two parents. Legacy
    # installs had it at INSTALL_DIR/indexers/ (one parent). Try both,
    # plus script_dir itself for very-old layouts.
    candidates = [
        script_dir,
        os.path.dirname(script_dir),
        os.path.dirname(os.path.dirname(script_dir)),
    ]
    env_dir = next((d for d in candidates if os.path.exists(os.path.join(d, '.env'))), script_dir)
    return read_env(os.path.join(env_dir, '.env'))

def read_bazarr_key(config_dir):
    search_dirs = [config_dir, os.path.join(config_dir, 'config')]
    for d in search_dirs:
        for filename in ('config.yaml', 'config.ini', 'config'):
            path = os.path.join(d, filename)
            try:
                with open(path, encoding='utf-8') as f:
                    content = f.read()
                m = re.search(r'^\s*apikey\s*[=:]\s*[\'"]?([^\s\'"]+)',
                              content, re.MULTILINE)
                if m:
                    return m.group(1)
            except Exception:
                continue
    return None

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    script_dir = os.path.dirname(os.path.realpath(__file__))
    env        = read_env_merged(script_dir)

    LAN_IP     = env.get('LAN_IP', '')
    # Resolve INSTALL_DIR portably: .env writes it on every install since
    # the multi-NAS refactor. Fallbacks: walk up from script_dir (v0.3.22
    # layout has it at INSTALL_DIR/scripts/indexers/, so two parents up;
    # legacy installs had it at INSTALL_DIR/indexers/, one parent up).
    # Final fallback is the Synology-historical path.
    if env.get('INSTALL_DIR'):
        install_dir = env.get('INSTALL_DIR')
    elif os.path.basename(os.path.dirname(script_dir)) == 'scripts':
        install_dir = os.path.dirname(os.path.dirname(script_dir))
    else:
        install_dir = os.path.dirname(script_dir) or '/volume1/docker/media'

    # Respect the user's service selection — if they opted Bazarr out, the
    # container doesn't exist and there's no key to read. Exit cleanly
    # with rc=0 so setup.sh doesn't flag step 9 as a failure. Default-on
    # semantics match isEnabled() in env-render.ts and is_enabled() in
    # setup.sh — only an explicit ENABLE_BAZARR=false/0/no/off opts out.
    enable_bazarr = (env.get('ENABLE_BAZARR', 'true') or 'true').strip().lower()
    if enable_bazarr in ('false', '0', 'no', 'off'):
        print("ENABLE_BAZARR=false in .env — skipping Bazarr provider setup.")
        sys.exit(0)

    BAZARR_KEY  = env.get('BAZARR_API_KEY') or read_bazarr_key(f'{install_dir}/bazarr/config')

    if not LAN_IP:
        print("Error: LAN_IP not set in .env"); sys.exit(1)
    if not BAZARR_KEY:
        print("Error: Bazarr API key not found — is the container running?")
        sys.exit(1)

    BAZARR = f"http://{LAN_IP}:49153"

    print(f"\n{BOLD}╔══════════════════════════════════════════╗")
    print("║       Bazarr Provider Setup              ║")
    print(f"╚══════════════════════════════════════════╝{RESET}")

    if not wait_ready(BAZARR, BAZARR_KEY):
        sys.exit(1)

    # ── Free providers ────────────────────────────────────────────────────────
    # No credentials, no external login on save — the safe, always-works batch.

    section("Free Providers (no account needed)")
    enable_providers(BAZARR, BAZARR_KEY,
                     [(name, pid, {}) for name, pid in FREE_PROVIDERS])

    # ── English subtitle profile ────────────────────────────────────────────────
    # Runs BEFORE the account providers: it's the piece that actually makes
    # subtitles work, it's local (no external dependency), and doing it here
    # means a flaky account-credential save (which can 500 and briefly drop
    # Bazarr's API) can't cascade onto it.

    section("English Subtitle Profile")
    resolved = setup_english_subtitles(BAZARR, BAZARR_KEY)
    if resolved:
        # Backfill existing series/movies that have no profile yet. On a fresh
        # install Bazarr usually hasn't synced Sonarr/Radarr, so these no-op
        # cleanly; on an update they catch up the existing library.
        if resolved['use_sonarr']:
            backfill_profiles(BAZARR, BAZARR_KEY, "TV series",
                              "/api/series", "sonarrSeriesId", "seriesid",
                              resolved['series_profile'])
        if resolved['use_radarr']:
            backfill_profiles(BAZARR, BAZARR_KEY, "movies",
                              "/api/movies", "radarrId", "radarrid",
                              resolved['movie_profile'])

    # ── Account providers ─────────────────────────────────────────────────────
    # Saved LAST and ONE AT A TIME. Bazarr validates these credentials on save
    # (a real login to OpenSubtitles/Addic7ed), so a wrong/rate-limited one can
    # 500 the request and briefly knock the API offline. Isolating each save
    # keeps one bad credential from failing the others, and a readiness
    # re-check between them stops a transient wobble from skipping a good one.

    section("Account Providers")
    account_to_add = []
    for display, provider_id, settings_key, field_map in ACCOUNT_PROVIDERS:
        creds = {field: env.get(env_var, '')
                 for field, env_var in field_map.items()}
        missing = [env_var for field, env_var in field_map.items()
                   if not env.get(env_var)]
        if missing:
            skip(f"{display} (add {', '.join(missing)} to .env to enable)")
            continue
        # IMPORTANT: pass `creds` directly (the flat {field: value} dict),
        # NOT `{settings_key: creds}`. enable_providers() turns each entry
        # into a `settings-<provider_id>-<field>` form field, so creds must be
        # the field map itself — wrapping it a level deeper would emit a bogus
        # `settings-<provider_id>-<settings_key>` field whose value is the
        # stringified creds dict, which Bazarr can't store as a credential.
        #
        # In our current data model settings_key always equals provider_id, so
        # the parameter is redundant — keep it for future-flexibility but ignore
        # it here.
        account_to_add.append((display, provider_id, creds))

    for i, (display, provider_id, creds) in enumerate(account_to_add):
        saved = enable_providers(BAZARR, BAZARR_KEY, [(display, provider_id, creds)])
        # A rejected save can leave Bazarr's API briefly unreachable; make sure
        # it's back before the next provider so a good credential isn't skipped.
        if not saved and i + 1 < len(account_to_add):
            wait_ready(BAZARR, BAZARR_KEY, retries=6)

    # ── Summary ───────────────────────────────────────────────────────────────

    print(f"\n{'═' * 52}")
    if errors:
        print(f"{RED}{BOLD}  Done with {errors} error(s) — review output above.{RESET}")
    elif warnings:
        print(f"{YELLOW}{BOLD}  Done with {warnings} warning(s) — review above. "
              f"Subtitle setup is best-effort and never fails the install.{RESET}")
    else:
        print(f"{GREEN}{BOLD}  All done — no errors.{RESET}")
    print(f"""
  Subtitle setup:
  • English is enabled + set as the default language profile automatically.
  • More languages   Settings → Languages → Profiles  (optional)
  • Wanted           Bazarr → Wanted → trigger a search to fetch subs now
{'═' * 52}
""")
    sys.exit(0 if errors == 0 else 1)


if __name__ == '__main__':
    main()
