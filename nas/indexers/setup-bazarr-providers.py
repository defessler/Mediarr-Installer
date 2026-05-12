#!/usr/bin/env python3
"""
setup-bazarr-providers.py — Add subtitle providers to Bazarr

Enables a curated set of subtitle providers. Free providers that need no
account are added automatically. Providers that need credentials are added
only if the relevant keys are set in .env.

Safe to re-run — skips providers that are already enabled.

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

# ── Terminal colours ──────────────────────────────────────────────────────────

GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

errors = 0

def ok(msg):   print(f"  {GREEN}✔{RESET}  {msg}")
def skip(msg): print(f"  –  {msg}")
def warn(msg): print(f"  {YELLOW}!{RESET}  {msg}")
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
    ("Subscene",        "subscene"),
    ("Subf2m",          "subf2m"),         # Subscene mirror/replacement
    ("Gestdown",        "gestdown"),       # Addic7ed mirror, no account needed
    ("SuperSubtitles",  "supersubtitles"),
]

ACCOUNT_PROVIDERS = [
    (
        "OpenSubtitles.org",
        "opensubtitles",
        "opensubtitles",
        {"username": "OPENSUBTITLES_USER", "password": "OPENSUBTITLES_PASS"},
    ),
    (
        "OpenSubtitles.com",
        "opensubtitlescom",
        "opensubtitlescom",
        {"username": "OPENSUBTITLESCOM_USER", "password": "OPENSUBTITLESCOM_PASS"},
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

def POST(base, key, path, data):
    return _request(f"{base}{path}", _headers(key), 'POST', data)

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
    Fetches settings once, applies all changes, then saves in a single POST."""
    settings = GET(base, key, "/api/system/settings")
    if settings is None:
        fail("Cannot reach Bazarr API"); return

    general  = settings.get('general', {})
    enabled  = set(general.get('enabled_providers') or [])
    changed  = False

    for display, provider_id, provider_settings in to_add:
        if provider_id in enabled:
            skip(f"{display} (already enabled)")
            continue

        enabled.add(provider_id)
        changed = True

        # Merge any provider-specific credentials into settings
        if provider_settings:
            section_data = settings.get(provider_id, {})
            section_data.update(provider_settings)
            settings[provider_id] = section_data

        ok(f"{display}")

    if not changed:
        return

    general['enabled_providers'] = sorted(enabled)
    settings['general'] = general

    result = POST(base, key, "/api/system/settings", settings)
    if result is not None:
        ok("Settings saved")
    else:
        fail("Failed to save settings")

# ── Read config ───────────────────────────────────────────────────────────────

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
    # .env lives in nas/ — walk up if this script is in a subdirectory
    candidates = [script_dir, os.path.dirname(script_dir)]
    env_dir = next((d for d in candidates if os.path.exists(os.path.join(d, '.env'))), script_dir)
    return read_env(os.path.join(env_dir, '.env'))

def read_bazarr_key(config_dir):
    search_dirs = [config_dir, os.path.join(config_dir, 'config')]
    for d in search_dirs:
        for filename in ('config.yaml', 'config.ini', 'config'):
            path = os.path.join(d, filename)
            try:
                with open(path) as f:
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
    # the multi-NAS refactor, but fall back to script_dir's parent (this
    # script lives at <INSTALL_DIR>/indexers/) for older .envs the user
    # may have hand-edited, and finally to the Synology-historical path
    # so really-old installs don't regress.
    install_dir = env.get('INSTALL_DIR') or os.path.dirname(script_dir) or '/volume1/docker/media'

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

    section("Free Providers (no account needed)")
    enable_providers(BAZARR, BAZARR_KEY,
                     [(name, pid, {}) for name, pid in FREE_PROVIDERS])

    # ── Account providers ─────────────────────────────────────────────────────

    section("Account Providers")
    to_add = []
    for display, provider_id, settings_key, field_map in ACCOUNT_PROVIDERS:
        creds = {field: env.get(env_var, '')
                 for field, env_var in field_map.items()}
        missing = [env_var for field, env_var in field_map.items()
                   if not env.get(env_var)]
        if missing:
            skip(f"{display} (add {', '.join(missing)} to .env to enable)")
            continue
        to_add.append((display, provider_id, {settings_key: creds}))

    if to_add:
        enable_providers(BAZARR, BAZARR_KEY, to_add)

    # ── Summary ───────────────────────────────────────────────────────────────

    print(f"\n{'═' * 52}")
    if errors == 0:
        print(f"{GREEN}{BOLD}  All done — no errors.{RESET}")
    else:
        print(f"{RED}{BOLD}  Done with {errors} error(s) — review output above.{RESET}")
    print(f"""
  Still needs manual setup in Bazarr:
  • Languages    Settings → Languages → add your preferred languages
  • Wanted       Bazarr → Wanted → trigger a search once providers are set
{'═' * 52}
""")
    sys.exit(0 if errors == 0 else 1)


if __name__ == '__main__':
    main()
