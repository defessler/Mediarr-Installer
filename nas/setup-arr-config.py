#!/usr/bin/env python3
"""
setup-arr-config.py — Arr Stack Auto-Configuration

Configures as much of the stack as possible via API.
Safe to re-run — skips items already configured.

Usage:
    python3 /volume1/docker/media/setup-arr-config.py

What this configures automatically:
    Sonarr      — root folders, download clients, remote path mappings, hardlinks, auth
    Radarr      — same as Sonarr
    Lidarr      — same, with music paths
    Prowlarr    — connects Sonarr/Radarr/Lidarr; Flaresolverr proxy; auth
    SABnzbd     — download dirs, categories, host whitelist
    Bazarr      — Sonarr/Radarr connections, auth
    Seerr       — Sonarr/Radarr connections (after wizard — see notes below)
    qBittorrent — watched folder (/downloads/ToFetch → auto-add torrents)
    Unpackerr   — generates unpackerr.conf
    Recyclarr   — generates recyclarr.yml
    Homepage    — generates service dashboard config

Still requires manual setup after:
    Seerr       — Complete the setup wizard first, connect Plex, then re-run this script
    Tautulli    — Connect to Plex via http://plex:32400 with your Plex token
    SABnzbd     — Add your usenet provider under Config → Servers
    Recyclarr   — Customise recyclarr.yml, then: docker exec recyclarr recyclarr sync
"""

import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
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

# Container UID/GID for the docker-exec write probe. Set by main() from
# .env's PUID/PGID. Default to LinuxServer's well-known 911:911 only as
# a safety net for callers that import this module without going through
# main(); in practice main() overrides these immediately.
CONTAINER_UID = 911
CONTAINER_GID = 911

def ok(msg):   print(f"  {GREEN}✔{RESET}  {msg}")
def skip(msg): print(f"  –  {msg} (already set)")
def warn(msg): print(f"  {YELLOW}!{RESET}  {msg}")
def fail(msg):
    global errors; errors += 1
    print(f"  {RED}✘{RESET}  {msg}")
def section(title):
    print(f"\n{BOLD}━━━ {title} {'━' * max(0, 52 - len(title))}{RESET}")

# ── Read config files ─────────────────────────────────────────────────────────

def read_env(path):
    """Read key=value pairs from a file, ignoring comments and blank lines.
    Inline comments after the value (e.g. KEY=value  # comment) are stripped."""
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
    """.env holds real values (gitignored). Copy from .env.example to create it."""
    return read_env(os.path.join(script_dir, '.env'))

def read_arr_key(config_xml):
    """Read API key from a *arr config.xml file."""
    try:
        return ET.parse(config_xml).find('ApiKey').text
    except Exception:
        return None

def read_sabnzbd_key(ini_path):
    """Read api_key from SABnzbd's sabnzbd.ini."""
    try:
        with open(ini_path) as f:
            for line in f:
                m = re.match(r'^api_key\s*=\s*(\S+)', line)
                if m:
                    return m.group(1)
    except Exception:
        pass
    return None

def read_bazarr_key(config_dir):
    """Read API key from Bazarr's config file."""
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

def read_json_key(json_path, *keys):
    """Read a value from a JSON file by key path."""
    try:
        with open(json_path) as f:
            data = json.load(f)
        for k in keys:
            data = data[k]
        return data
    except Exception:
        return None


def read_plex_prefs(prefs_path):
    """Return a dict of attributes from Plex's Preferences.xml.

    The file is a single self-closing <Preferences ... /> element with
    attributes like PlexOnlineToken, MachineIdentifier, FriendlyName, etc.
    Returns {} if the file is missing or unparseable — first run won't
    have it until the server has registered with plex.tv.
    """
    try:
        tree = ET.parse(prefs_path)
        return dict(tree.getroot().attrib)
    except Exception:
        return {}

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
        e._body_text = body_text
        print(f"    HTTP {e.code}: {body_text[:200]}")
        raise
    except (URLError, OSError):
        return None

def _safe_request(url, headers, method='GET', data=None):
    """Like _request but returns (result_or_None, http_code_or_None)."""
    body = json.dumps(data).encode() if data is not None else None
    req = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=15) as resp:
            content = resp.read()
            return (json.loads(content) if content else {}), resp.status
    except HTTPError as e:
        body_text = e.read().decode(errors='replace')
        print(f"    HTTP {e.code}: {body_text[:200]}")
        return None, e.code
    except (URLError, OSError):
        return None, None

def _arr_headers(key):
    return {'X-Api-Key': key, 'Content-Type': 'application/json',
            'User-Agent': 'setup-arr-config/1.0'}

def GET(base, key, path):
    result, _ = _safe_request(f"{base}{path}", _arr_headers(key))
    return result

def POST(base, key, path, data):
    result, _ = _safe_request(f"{base}{path}", _arr_headers(key), 'POST', data)
    return result

def POST_status(base, key, path, data):
    """POST that also returns the HTTP status code."""
    return _safe_request(f"{base}{path}", _arr_headers(key), 'POST', data)

def PUT(base, key, path, data):
    result, _ = _safe_request(f"{base}{path}", _arr_headers(key), 'PUT', data)
    return result

def sab_api(base, key, params):
    """SABnzbd uses query-string API, not JSON body."""
    params.update({'apikey': key, 'output': 'json'})
    url = f"{base}/api?{urlencode(params)}"
    try:
        with urlopen(Request(url), timeout=15) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        body = e.read().decode(errors='replace')
        print(f"    SABnzbd HTTP {e.code}: {body[:150]}")
        return None
    except Exception as e:
        print(f"    SABnzbd error: {e}")
        return None

def sabnzbd_ini_set(ini_path, keyword, value):
    """Directly replace a keyword value in sabnzbd.ini as a fallback when
    the API set_config call fails. Returns True on success."""
    try:
        with open(ini_path, 'r') as f:
            content = f.read()
        new_content, n = re.subn(
            rf'^({re.escape(keyword)}\s*=\s*).*$',
            f'{keyword} = {value}',
            content, flags=re.MULTILINE
        )
        if n == 0:
            return False
        with open(ini_path, 'w') as f:
            f.write(new_content)
        return True
    except Exception:
        return False

def bazarr_get(base, key, path):
    result, _ = _safe_request(f"{base}{path}", {'X-API-KEY': key,
                                                 'Content-Type': 'application/json'})
    return result

def bazarr_post(base, key, path, data):
    result, _ = _safe_request(f"{base}{path}", {'X-API-KEY': key,
                                                 'Content-Type': 'application/json'},
                              'POST', data)
    return result

def bazarr_post_form(base, key, path, form_data):
    """POST form-encoded data to Bazarr.
    Bazarr's /api/system/settings endpoint only accepts
    application/x-www-form-urlencoded, not JSON."""
    body = urlencode(form_data, doseq=True).encode()
    headers = {'X-API-KEY': key,
               'Content-Type': 'application/x-www-form-urlencoded',
               'User-Agent': 'setup-arr-config/1.0'}
    req = Request(f"{base}{path}", data=body, headers=headers, method='POST')
    try:
        with urlopen(req, timeout=15) as resp:
            content = resp.read()
            return json.loads(content) if content else {}
    except HTTPError as e:
        print(f"    HTTP {e.code}: {e.read().decode(errors='replace')[:200]}")
        return None
    except (URLError, OSError):
        return None

# ── Wait for service ──────────────────────────────────────────────────────────

def wait_ready(name, base, key, check_path, retries=60, interval=5):
    sys.stdout.write(f"  Waiting for {name} ")
    sys.stdout.flush()
    for i in range(retries):
        if GET(base, key, check_path) is not None:
            elapsed = i * interval
            print(f"{GREEN}✔{RESET} ({elapsed}s)"); return True
        sys.stdout.write("."); sys.stdout.flush()
        if (i + 1) % 6 == 0:
            elapsed = (i + 1) * interval
            sys.stdout.write(f" {elapsed}s "); sys.stdout.flush()
        time.sleep(interval)
    print(f"{RED}✘ timed out after {retries * interval}s{RESET}")
    print(f"  {name} may still be starting — re-run this script once it's up")
    return False

# ── *arr helpers ──────────────────────────────────────────────────────────────

def container_can_write(container, path, as_uid=None, as_gid=None):
    """Probe whether `container` can write to `path` as the specified
    UID/GID. CRITICAL: `docker exec` defaults to root inside the
    container, which can always write — useless for testing whether
    the arr daemon (which runs as PUID:PGID) can write. Always pass
    as_uid/as_gid when you want the answer to match what the daemon
    will see.

    Returns True/False/None where None means the probe itself errored
    (docker not available, container not running, etc.).

    Catches the Synology shared-folder ACL trap: read succeeds (path
    exists from the container's POV) but write fails — Sonarr/Radarr
    conflate ENOENT and EACCES in their root-folder validator, so the
    HTTP 400 reads as "Path does not exist" when it's really a
    permission denial."""
    import subprocess
    test_file = f"{path.rstrip('/')}/.mediarr-write-test"
    cmd = ["docker", "exec"]
    if as_uid is not None:
        user = f"{as_uid}"
        if as_gid is not None:
            user = f"{as_uid}:{as_gid}"
        cmd += ["-u", user]
    cmd += [container, "sh", "-c", f"touch '{test_file}' && rm '{test_file}'"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=10, text=True)
        return r.returncode == 0
    except FileNotFoundError:
        # docker not on PATH — we're probably not on the host where
        # the stack runs. Can't probe; assume yes and let the API tell us.
        return None
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None


def acl_diagnostic(path):
    """Print the standard 'Synology shared-folder ACL' diagnostic block.
    Centralised here so root-folder, remote-path-mapping and any other
    write-bound API call surface the same guidance."""
    host_path = path.replace('/data/', '/volume1/Data/', 1)
    # Look up the username for PUID so the DSM-UI instruction can name
    # the actual account the user needs to grant write access to,
    # rather than asking them to guess "the user matching PUID=1026."
    #
    # Python's pwd module reads /etc/passwd directly — no dependency on
    # `getent` being on PATH (Synology busybox sometimes lacks it,
    # which made the previous diagnostic say "Find user 'PUID=1026'"
    # instead of the actual username).
    user_name = f"PUID={CONTAINER_UID}"
    try:
        import pwd
        user_name = pwd.getpwuid(CONTAINER_UID).pw_name
    except (KeyError, ImportError):
        # KeyError: no entry for that UID. ImportError: pwd is a unix-
        # only module — but we're always on Linux when this runs.
        pass
    print(f"      Container probe says: NOT writable from inside the arr")
    print(f"      (running as uid={CONTAINER_UID} gid={CONTAINER_GID}).")
    print(f"      Read works ({path} is visible — post-deploy-validate")
    print(f"      sees its contents) but Sonarr/Radarr/Lidarr need write")
    print(f"      access to drop a .test file there, and Synology's")
    print(f"      shared-folder ACL on /volume1/Data is denying it.")
    print(f"      Host equivalent: {host_path}")
    print(f"")
    print(f"      Fix it in DSM (easiest, no CLI required):")
    print(f"        1. Control Panel → Shared Folder → click 'Data' → Edit")
    print(f"        2. Permissions tab")
    print(f"        3. Find user '{user_name}' in the list")
    print(f"        4. Check the 'Read/Write' box, click Save")
    print(f"        5. Back here:  docker compose restart")
    print(f"        6. Re-run:  sudo bash {os.path.dirname(os.path.realpath(__file__))}/setup.sh")
    print(f"")
    print(f"      Or from CLI (if synoacltool is on the box):")
    print(f"        sudo synoacltool -add /volume1/Data \\")
    print(f'          "user:{user_name}:allow:rwxpdDaARWcCo:fd--"')
    print(f"        sudo synoacltool -enforce-inherit /volume1/Data")


def add_root_folder(base, key, api, path, extra_fields=None, container=None):
    existing = GET(base, key, f"/{api}/rootfolder")
    if existing is None:
        fail(f"Root folder: can't reach API"); return
    if any(f['path'] == path for f in existing):
        skip(f"Root folder: {path}"); return

    # Pre-flight write check: if the container can't write to the path
    # AS THE DAEMON'S UID (not root, which always wins), no amount of
    # retrying the API will help — Sonarr/Radarr fail with "Path does
    # not exist" when their writability test fails. Skip straight to
    # the ACL diagnostic in that case.
    if container:
        writable = container_can_write(container, path,
                                       as_uid=CONTAINER_UID, as_gid=CONTAINER_GID)
        if writable is False:
            fail(f"Root folder: {path}")
            acl_diagnostic(path)
            return

    name = os.path.basename(path.rstrip('/')) or path
    payload = {"path": path, "name": name}
    if extra_fields:
        payload.update(extra_fields)

    # First attempt.
    result = POST(base, key, f"/{api}/rootfolder", payload)
    if result:
        ok(f"Root folder: {path}")
        return

    # Failed despite pre-flight write probe passing (or being skipped).
    # One short retry for genuine timing races — the container reports
    # writable but the arr's internal state may still be catching up.
    # Don't retry more than twice; if writes work, two attempts are
    # plenty.
    for attempt in range(1, 3):
        time.sleep(5)
        existing = GET(base, key, f"/{api}/rootfolder")
        if existing and any(f['path'] == path for f in existing):
            ok(f"Root folder: {path} (added on retry {attempt})")
            return
        result = POST(base, key, f"/{api}/rootfolder", payload)
        if result:
            ok(f"Root folder: {path} (added on retry {attempt})")
            return

    # Still failing. If we had no container to probe, this is the first
    # time we've seen the failure clearly — show the full diagnostic.
    fail(f"Root folder: {path}")
    if container:
        # We DID probe and it said writable; something else is wrong.
        print(f"      The arr says no, but a docker-exec write probe succeeded.")
        print(f"      Re-run setup-arr-config.py after a `docker compose restart`.")
    else:
        acl_diagnostic(path)

def add_download_client(base, key, api, name, implementation, field_overrides):
    existing = GET(base, key, f"/{api}/downloadclient")
    if existing is None:
        fail(f"Download client {name}: can't reach API"); return

    existing_client = next((c for c in existing if c['name'] == name), None)
    if existing_client:
        field_map = {f['name']: i for i, f in enumerate(existing_client.get('fields', []))}
        needs_update = any(
            fname in field_map and
            existing_client['fields'][field_map[fname]].get('value') != fval
            for fname, fval in field_overrides.items()
        )
        if not needs_update:
            skip(f"Download client: {name}"); return
        for fname, fval in field_overrides.items():
            if fname in field_map:
                existing_client['fields'][field_map[fname]]['value'] = fval
        result = PUT(base, key, f"/{api}/downloadclient/{existing_client['id']}", existing_client)
        ok(f"Download client: {name} (updated)") if result else fail(f"Download client: {name} (update failed)")
        return

    schemas = GET(base, key, f"/{api}/downloadclient/schema")
    if not schemas:
        fail(f"Download client {name}: can't get schema"); return
    schema = next((s for s in schemas if s.get('implementation') == implementation), None)
    if not schema:
        fail(f"Download client {name}: '{implementation}' not found"); return
    schema['name'] = name
    schema['enable'] = True
    field_map = {f['name']: i for i, f in enumerate(schema.get('fields', []))}
    for fname, fval in field_overrides.items():
        if fname in field_map:
            schema['fields'][field_map[fname]]['value'] = fval
    result = POST(base, key, f"/{api}/downloadclient", schema)
    ok(f"Download client: {name}") if result else fail(f"Download client: {name}")

def add_remote_path_mapping(base, key, api, host, remote, local, container=None):
    existing = GET(base, key, f"/{api}/remotePathMapping")
    if existing is None:
        fail("Remote path mapping: can't reach API"); return
    if any(m.get('remotePath', '').rstrip('/') == remote.rstrip('/') for m in existing):
        skip(f"Remote path: {remote} → {local}"); return

    # Pre-flight write check: same Synology shared-folder ACL trap as
    # root folders. The arr validates that `local` is writable from
    # inside its own container; if not, returns "Path does not exist".
    # Probe as the daemon's UID — root would always succeed.
    if container:
        writable = container_can_write(container, local,
                                       as_uid=CONTAINER_UID, as_gid=CONTAINER_GID)
        if writable is False:
            fail(f"Remote path: {host} {remote} → {local}")
            acl_diagnostic(local)
            return

    payload = {"host": host, "remotePath": remote, "localPath": local}
    result, status = POST_status(base, key, f"/{api}/remotePathMapping", payload)
    if result is not None:
        ok(f"Remote path: {host} {remote} → {local}")
        return
    if status == 500:
        skip(f"Remote path: {remote} → {local} (already configured)")
        return

    # One short retry for genuine timing race.
    for attempt in range(1, 3):
        time.sleep(5)
        existing = GET(base, key, f"/{api}/remotePathMapping")
        if existing and any(m.get('remotePath', '').rstrip('/') == remote.rstrip('/') for m in existing):
            ok(f"Remote path: {host} {remote} → {local} (added on retry {attempt})")
            return
        result, status = POST_status(base, key, f"/{api}/remotePathMapping", payload)
        if result is not None:
            ok(f"Remote path: {host} {remote} → {local} (added on retry {attempt})")
            return
        if status == 500:
            skip(f"Remote path: {remote} → {local} (already configured)")
            return
    fail(f"Remote path: {host} {remote} → {local}")
    if not container:
        acl_diagnostic(local)

def configure_auth(base, key, api, username, password):
    """Set Forms authentication, bypassed for local addresses."""
    config = GET(base, key, f"/{api}/config/host")
    if config is None:
        fail("Auth: can't get host config"); return
    already_set = (
        config.get('authenticationMethod', '').lower() not in ('none', '')
        and config.get('username') == username
        and config.get('authenticationRequired') == 'DisabledForLocalAddresses'
    )
    if already_set:
        skip(f"Auth: {username} (already set)"); return
    config['authenticationMethod'] = 'Forms'
    config['authenticationRequired'] = 'DisabledForLocalAddresses'
    config['username'] = username
    config['password'] = password
    config['passwordConfirmation'] = password
    result = PUT(base, key, f"/{api}/config/host", config)
    ok(f"Auth: {username} (LAN bypass on)") if result else fail("Auth: failed to set credentials")

def enable_hardlinks(base, key, api):
    config = GET(base, key, f"/{api}/config/mediamanagement")
    if config is None:
        fail("Hardlinks: can't get config"); return
    if config.get('copyUsingHardlinks'):
        skip("Hardlinks (already enabled)"); return
    config['copyUsingHardlinks'] = True
    result = PUT(base, key, f"/{api}/config/mediamanagement", config)
    ok("Hardlinks enabled") if result else fail("Hardlinks: failed to update")

def get_quality_profile(base, key, api, preferred='1080p'):
    """Return (id, name) of best matching quality profile."""
    profiles = GET(base, key, f"/{api}/qualityprofile") or []
    if not profiles:
        return None, None
    match = next((p for p in profiles if preferred.lower() in p['name'].lower()), None)
    chosen = match or profiles[0]
    return chosen['id'], chosen['name']

def get_language_profile(base, key):
    """Return id of first language profile (Sonarr only)."""
    profiles = GET(base, key, "/api/v3/languageprofile") or []
    return profiles[0]['id'] if profiles else 1

# ── Prowlarr ──────────────────────────────────────────────────────────────────

def add_prowlarr_app(prowlarr_base, prowlarr_key, app_name, implementation,
                     config_contract, app_internal_url, app_key, sync_categories):
    existing = GET(prowlarr_base, prowlarr_key, "/api/v1/applications")
    if existing is None:
        fail(f"Prowlarr app {app_name}: can't reach API"); return
    if any(a['name'] == app_name for a in existing):
        skip(f"Prowlarr app: {app_name}"); return
    schemas = GET(prowlarr_base, prowlarr_key, "/api/v1/applications/schema") or []
    schema  = next((s for s in schemas if s.get('implementation') == implementation), None)
    if schema:
        schema['name'] = app_name
        schema['syncLevel'] = 'fullSync'
        fm = {f['name']: i for i, f in enumerate(schema.get('fields', []))}
        for fname, fval in {
            'prowlarrUrl':    'http://prowlarr:9696',
            'baseUrl':        app_internal_url,
            'apiKey':         app_key,
            'syncCategories': sync_categories,
        }.items():
            if fname in fm:
                schema['fields'][fm[fname]]['value'] = fval
        data = schema
    else:
        data = {
            'syncLevel': 'fullSync', 'name': app_name, 'tags': [],
            'fields': [
                {'name': 'prowlarrUrl',    'value': 'http://prowlarr:9696'},
                {'name': 'baseUrl',        'value': app_internal_url},
                {'name': 'apiKey',         'value': app_key},
                {'name': 'syncCategories', 'value': sync_categories},
            ],
            'implementationName': app_name, 'implementation': implementation,
            'configContract': config_contract,
        }
    result = POST(prowlarr_base, prowlarr_key, "/api/v1/applications", data)
    ok(f"Prowlarr app: {app_name}") if result else fail(f"Prowlarr app: {app_name}")

def add_flaresolverr_proxy(prowlarr_base, prowlarr_key):
    """Wire Flaresolverr into Prowlarr so CloudFlare-protected indexers work."""
    existing = GET(prowlarr_base, prowlarr_key, "/api/v1/indexerProxy")
    if existing is None:
        fail("Flaresolverr proxy: can't reach Prowlarr API"); return
    if any(p.get('implementation') == 'FlareSolverr' for p in existing):
        skip("Flaresolverr proxy (already configured)"); return

    schemas = GET(prowlarr_base, prowlarr_key, "/api/v1/indexerProxy/schema") or []
    schema = next((s for s in schemas if s.get('implementation') == 'FlareSolverr'), None)
    if schema is None:
        # Prowlarr may not have the schema yet — try posting without schema lookup
        warn("Flaresolverr schema not found in Prowlarr — may need to restart Prowlarr")
        return

    schema = json.loads(json.dumps(schema))  # deep copy
    schema['name'] = 'FlareSolverr'
    schema['tags'] = []  # empty tags = applies to all indexers

    fm = {f['name']: i for i, f in enumerate(schema.get('fields', []))}
    for fname, fval in [('host', 'http://flaresolverr:8191'), ('requestTimeout', 60)]:
        if fname in fm:
            schema['fields'][fm[fname]]['value'] = fval

    result = POST(prowlarr_base, prowlarr_key, "/api/v1/indexerProxy", schema)
    ok("Flaresolverr proxy: configured (CloudFlare bypass active)") if result \
        else fail("Flaresolverr proxy: failed to add")

# ── SABnzbd ───────────────────────────────────────────────────────────────────

def configure_sabnzbd(base, key, ini_path):
    section("SABnzbd")
    if not key:
        fail("API key not found — is the container running?"); return

    resp = sab_api(base, key, {'mode': 'version'})
    if not resp:
        fail("Can't reach SABnzbd API"); return
    ok(f"Connected (SABnzbd {resp.get('version', '?')})")

    ini_modified = False

    def _sab_set(label, keyword, value, extra_params=None):
        nonlocal ini_modified
        params = {'mode': 'set_config', 'section': 'misc',
                  'keyword': keyword, 'value': value}
        if extra_params:
            params.update(extra_params)
        result = sab_api(base, key, params)
        if result is not None and result.get('status') is not False:
            ok(f"{label}: {value}")
            return True
        if sabnzbd_ini_set(ini_path, keyword, value):
            ok(f"{label}: {value}  (ini edit — SABnzbd restart needed)")
            ini_modified = True
            return True
        fail(f"{label}: failed to set {value}")
        return False

    # Host whitelist — all Docker service names must be allowed
    REQUIRED_HOSTS = {'sabnzbd', 'sonarr', 'radarr', 'lidarr',
                      'bazarr', 'prowlarr', 'localhost', '127.0.0.1'}
    cur = sab_api(base, key, {'mode': 'get_config', 'section': 'misc',
                               'keyword': 'host_whitelist'})
    existing_raw = (cur or {}).get('config', {}).get('misc', {}).get('host_whitelist', '')
    if isinstance(existing_raw, list):
        existing = {h.strip() for h in existing_raw if h.strip()}
    else:
        existing = {h.strip() for h in existing_raw.split(',') if h.strip()}
    if REQUIRED_HOSTS.issubset(existing):
        skip("Host whitelist (already contains all required hostnames)")
    else:
        merged = ','.join(sorted(existing | REQUIRED_HOSTS))
        result = sab_api(base, key, {'mode': 'set_config', 'section': 'misc',
                                      'keyword': 'host_whitelist', 'value': merged})
        if result is not None and result.get('status') is not False:
            ok("Host whitelist updated (Docker service hostnames allowed)")
        elif sabnzbd_ini_set(ini_path, 'host_whitelist', merged):
            ok("Host whitelist updated (ini edit — SABnzbd restart needed)")
            ini_modified = True
        else:
            warn("Could not update host_whitelist — Sonarr/Radarr may get 403 from SABnzbd")

    # Download directories
    for label, keyword, value in [
        ("Incomplete dir", "download_dir",  "/data/incomplete"),
        ("Complete dir",   "complete_dir",  "/data/complete"),
    ]:
        current = sab_api(base, key, {'mode': 'get_config', 'section': 'misc',
                                       'keyword': keyword})
        cur_val = (current or {}).get('config', {}).get('misc', {}).get(keyword, '')
        if cur_val == value:
            skip(f"{label}: {value}"); continue
        _sab_set(label, keyword, value)

    # Categories — tv / movies / music
    cats_resp = sab_api(base, key, {'mode': 'get_config', 'section': 'categories'})
    existing_cats = {c['name'] for c in
                     (cats_resp or {}).get('config', {}).get('categories', [])}
    for cat_name, cat_dir in [('tv', '/data/complete/tv'),
                               ('movies', '/data/complete/movies'),
                               ('music', '/data/complete/music')]:
        if cat_name in existing_cats:
            skip(f"Category: {cat_name}"); continue
        result = sab_api(base, key, {
            'mode': 'set_config', 'section': 'categories',
            'keyword': cat_name, 'pp': '3',
            'dir': cat_dir,
        })
        if result is not None and result.get('status') is not False:
            ok(f"Category: {cat_name} → {cat_dir}")
        else:
            fail(f"Category: {cat_name}")

    if ini_modified:
        warn("SABnzbd config was edited directly — restart to apply:")
        warn("  docker compose restart sabnzbd")


def configure_tautulli(stack_dir, plex_prefs_path, tautulli_ini_path):
    """Wire Tautulli to the Plex container by writing its config.ini and
    restarting the container to apply.

    No user input needed — we read PlexOnlineToken from Plex's
    Preferences.xml (populated when Plex registers with plex.tv via
    PLEX_CLAIM on first run). Falls back to a manual-config warning if
    Plex isn't claimed yet.
    """
    section("Tautulli")

    prefs = read_plex_prefs(plex_prefs_path)
    plex_token = prefs.get('PlexOnlineToken')
    if not plex_token:
        warn("Plex token not found — server not claimed yet?")
        warn(f"  Preferences.xml: {plex_prefs_path}")
        warn("  Configure Tautulli manually at http://<NAS>:8181, or run")
        warn("  this script again after Plex claims successfully.")
        return

    if not os.path.exists(tautulli_ini_path):
        warn(f"Tautulli config.ini not found at {tautulli_ini_path}")
        warn("  Is the tautulli container running?")
        return

    import configparser
    cp = configparser.ConfigParser()
    cp.optionxform = str  # preserve case — Tautulli's keys are SCREAMING_CASE
    try:
        cp.read(tautulli_ini_path)
    except Exception as e:
        fail(f"Could not parse Tautulli config.ini: {e}")
        return

    # Idempotent: if everything we'd set already matches, skip.
    pms = cp['PMS'] if cp.has_section('PMS') else {}
    if (pms.get('pms_token') == plex_token
            and pms.get('pms_ip') == 'plex'
            and pms.get('pms_port') == '32400'):
        skip("Tautulli already wired to plex:32400 with the current token")
        return

    # Write the [PMS] section. Tautulli expects lowercase keys despite
    # the screaming-case names in its docs.
    if not cp.has_section('PMS'):
        cp.add_section('PMS')
    cp.set('PMS', 'pms_ip', 'plex')
    cp.set('PMS', 'pms_port', '32400')
    cp.set('PMS', 'pms_token', plex_token)
    cp.set('PMS', 'pms_ssl', '0')
    cp.set('PMS', 'pms_is_remote', '0')
    cp.set('PMS', 'pms_use_bif', '0')

    machine_id = (prefs.get('MachineIdentifier')
                  or prefs.get('ProcessedMachineIdentifier'))
    if machine_id:
        cp.set('PMS', 'pms_identifier', machine_id)
    if prefs.get('FriendlyName'):
        cp.set('PMS', 'pms_name', prefs['FriendlyName'])

    # Skip the welcome wizard on next start.
    if not cp.has_section('General'):
        cp.add_section('General')
    cp.set('General', 'first_run_complete', '1')

    try:
        with open(tautulli_ini_path, 'w') as f:
            cp.write(f)
        ok(f"Tautulli config written (PMS_IP=plex, token from Plex)")
    except Exception as e:
        fail(f"Could not write Tautulli config: {e}")
        return

    # Restart Tautulli so it re-reads config.ini. Brief downtime (~5s)
    # but the alternative is asking the user to do it manually.
    print("    Restarting Tautulli container to apply...")
    import subprocess
    try:
        subprocess.run(
            ['docker', 'compose', 'restart', 'tautulli'],
            cwd=stack_dir, check=True, capture_output=True, timeout=60,
        )
        ok("Tautulli restarted — open http://<NAS>:8181 to verify")
    except subprocess.CalledProcessError as e:
        warn(f"docker compose restart failed: {e.stderr.decode(errors='replace')[:200]}")
        warn("  Manually:  docker compose restart tautulli")
    except subprocess.TimeoutExpired:
        warn("Restart timed out — Tautulli may need a manual kick")
    except FileNotFoundError:
        warn("'docker' not found in PATH — restart Tautulli manually:")
        warn("  docker compose restart tautulli")


def configure_sabnzbd_server(base, key, host, port, user, password,
                              name='primary', connections=8, use_ssl=True):
    """Add a usenet news server to SABnzbd.

    Idempotent — looks up existing servers by `name` and skips if present.
    Falls back gracefully if any field is missing (logs a skip and returns).
    """
    section("SABnzbd: Usenet provider")
    if not host or not user or not password:
        skip("Usenet provider (USENET_HOST/USER/PASS not set in .env)")
        return
    if not key:
        fail("SABnzbd API key not found — can't add server"); return

    # Check if a server with this name already exists.
    existing_resp = sab_api(base, key, {'mode': 'get_config',
                                         'section': 'servers'})
    existing = (existing_resp or {}).get('config', {}).get('servers', [])
    if any(s.get('name') == name for s in existing):
        skip(f"Usenet provider '{name}' already configured ({host})")
        return

    # SABnzbd's set_config for the servers section uses a flat query string.
    # Booleans become 0/1; everything else stringified.
    params = {
        'mode': 'set_config',
        'section': 'servers',
        'keyword': name,
        'host': host,
        'port': str(port),
        'username': user,
        'password': password,
        'connections': str(connections),
        'ssl': '1' if use_ssl else '0',
        'enable': '1',
        'priority': '0',
    }
    result = sab_api(base, key, params)
    if result is not None and result.get('status') is not False:
        masked = host[:max(3, len(host) - 6)] + '***'
        ok(f"Usenet provider added: {masked}:{port} (user: {user[:3]}***, {connections} conn, SSL={'on' if use_ssl else 'off'})")
    else:
        fail(f"Failed to add usenet provider {host}:{port}")

# ── qBittorrent ───────────────────────────────────────────────────────────────

def configure_qbittorrent(base, username, password):
    """Set qBittorrent preferences via the Web API (cookie auth)."""
    section("qBittorrent")

    import http.cookiejar
    from urllib.request import build_opener, HTTPCookieProcessor

    cj = http.cookiejar.CookieJar()
    opener = build_opener(HTTPCookieProcessor(cj))

    # Login
    try:
        login_data = urlencode({'username': username, 'password': password}).encode()
        resp = opener.open(f"{base}/api/v2/auth/login", login_data, timeout=10)
        result = resp.read().decode()
        if result.strip() != 'Ok.':
            warn(f"qBittorrent login failed: {result.strip()[:80]}")
            warn("Watched folder not configured — set manually in Settings → Downloads")
            return
        ok("qBittorrent authenticated")
    except Exception as e:
        warn(f"qBittorrent not reachable ({e}) — skipping watch folder setup")
        return

    # Get current scan_dirs
    try:
        resp = opener.open(f"{base}/api/v2/app/preferences", timeout=10)
        prefs = json.loads(resp.read())
    except Exception as e:
        warn(f"qBittorrent: can't read preferences ({e})")
        return

    scan_dirs = prefs.get('scan_dirs', {})
    if '/downloads/ToFetch' in scan_dirs:
        skip("Watched folder: /downloads/ToFetch (already configured)")
    else:
        try:
            prefs_json = json.dumps({'scan_dirs': {'/downloads/ToFetch': 1}})
            set_data = urlencode({'json': prefs_json}).encode()
            opener.open(f"{base}/api/v2/app/setPreferences", set_data, timeout=10)
            ok("Watched folder: /downloads/ToFetch → auto-add torrents")
        except Exception as e:
            fail(f"qBittorrent: failed to set watched folder ({e})")

# ── Bazarr ────────────────────────────────────────────────────────────────────

def configure_bazarr(base, key, sonarr_key, radarr_key, config_path,
                     username=None, password=None):
    section("Bazarr")
    if not key:
        sys.stdout.write("  Waiting for Bazarr config ")
        sys.stdout.flush()
        for _ in range(24):
            time.sleep(5)
            key = read_bazarr_key(config_path)
            if key:
                print(f"{GREEN}✔{RESET}")
                break
            sys.stdout.write(".")
            sys.stdout.flush()
        else:
            print(f"{RED}✘ timed out{RESET}")
            fail("Bazarr config not found — visit the Bazarr UI once, then re-run")
            return

    settings = bazarr_get(base, key, "/api/system/settings")
    if settings is None:
        fail("Can't reach Bazarr API"); return

    sonarr_cfg = settings.get('sonarr', {})
    radarr_cfg = settings.get('radarr', {})
    general    = settings.get('general', {})
    auth       = settings.get('auth', {})

    # Bazarr's /api/system/settings POST requires form-encoded data, not JSON.
    # Keys use the format: settings-{section}-{field}.
    # Boolean fields must use lowercase 'true'/'false' — dynaconf rejects
    # capital-case strings ('True'/'False') for bool-typed validators.
    form_data = {}
    changed = False

    # Sonarr connection
    if sonarr_key and sonarr_cfg.get('apikey') != sonarr_key:
        form_data['settings-sonarr-ip']          = 'sonarr'
        form_data['settings-sonarr-port']        = '8989'
        form_data['settings-sonarr-base_url']    = '/'
        form_data['settings-sonarr-ssl']         = 'false'
        form_data['settings-sonarr-apikey']      = sonarr_key
        form_data['settings-general-use_sonarr'] = 'true'
        changed = True
        ok("Bazarr → Sonarr connection set")
    else:
        skip("Bazarr → Sonarr (already set)" if sonarr_key else "Bazarr → Sonarr (no Sonarr key)")

    if radarr_key and radarr_cfg.get('apikey') != radarr_key:
        form_data['settings-radarr-ip']          = 'radarr'
        form_data['settings-radarr-port']        = '7878'
        form_data['settings-radarr-base_url']    = '/'
        form_data['settings-radarr-ssl']         = 'false'
        form_data['settings-radarr-apikey']      = radarr_key
        form_data['settings-general-use_radarr'] = 'true'
        changed = True
        ok("Bazarr → Radarr connection set")
    else:
        skip("Bazarr → Radarr (already set)" if radarr_key else "Bazarr → Radarr (no Radarr key)")

    # Web UI credentials
    if username and password and auth.get('username') != username:
        form_data['settings-auth-type']          = 'basic'
        form_data['settings-auth-username']      = username
        form_data['settings-auth-password']      = password
        form_data['settings-general-use_auth']   = 'true'
        changed = True
        ok(f"Bazarr auth: {username}")
    elif username:
        skip(f"Bazarr auth: {username} (already set)")

    if changed:
        result = bazarr_post_form(base, key, "/api/system/settings", form_data)
        ok("Bazarr settings saved") if result is not None else fail("Bazarr settings: save failed")

# ── Seerr ─────────────────────────────────────────────────────────────────────

def configure_seerr(base, key, sonarr_base, sonarr_key, radarr_base, radarr_key):
    section("Seerr")
    if not key:
        warn("Seerr settings.json not found — complete the setup wizard first.")
        warn("Then re-run:  python3 /volume1/docker/media/setup-arr-config.py")
        return

    main_settings = GET(base, key, "/api/v1/settings/main")
    if main_settings is None:
        warn("Seerr setup wizard not yet complete — skipping Sonarr/Radarr wiring.")
        warn("Visit http://<NAS>:5056, finish the wizard, then re-run this script.")
        return

    if main_settings.get('localLogin') is False:
        main_settings['localLogin'] = True
        result = POST(base, key, "/api/v1/settings/main", main_settings)
        ok("Local login enabled") if result is not None else fail("Local login: failed to enable")
    else:
        skip("Local login (already enabled)")

    if sonarr_key:
        existing = GET(base, key, "/api/v1/settings/sonarr") or []
        if any(s.get('hostname') == 'sonarr' for s in existing):
            skip("Seerr → Sonarr (already set)")
        else:
            profile_id, profile_name = get_quality_profile(sonarr_base, sonarr_key, "api/v3", "1080p")
            lang_id = get_language_profile(sonarr_base, sonarr_key)
            result = POST(base, key, "/api/v1/settings/sonarr", {
                "name": "Sonarr", "hostname": "sonarr", "port": 8989,
                "apiKey": sonarr_key, "useSsl": False, "baseUrl": "",
                "activeProfileId": profile_id or 1,
                "activeProfileName": profile_name or "HD-1080p",
                "activeDirectory": "/data/Media/TV Shows",
                "is4k": False, "isDefault": True, "syncEnabled": False,
                "preventSearch": False, "seasons": True,
                "enableSeasonFolders": True, "tags": [],
                "animeDirectory": "/data/Media/Anime/TV Shows",
                "languageProfileId": lang_id,
            })
            ok("Seerr → Sonarr connection set") if result else fail("Seerr → Sonarr: failed")

    if radarr_key:
        existing = GET(base, key, "/api/v1/settings/radarr") or []
        if any(r.get('hostname') == 'radarr' for r in existing):
            skip("Seerr → Radarr (already set)")
        else:
            profile_id, profile_name = get_quality_profile(radarr_base, radarr_key, "api/v3", "1080p")
            result = POST(base, key, "/api/v1/settings/radarr", {
                "name": "Radarr", "hostname": "radarr", "port": 7878,
                "apiKey": radarr_key, "useSsl": False, "baseUrl": "",
                "activeProfileId": profile_id or 1,
                "activeProfileName": profile_name or "HD-1080p",
                "activeDirectory": "/data/Media/Movies",
                "is4k": False, "isDefault": True, "syncEnabled": False,
                "preventSearch": False, "minimumAvailability": "released",
                "tags": [], "animeDirectory": "/data/Media/Anime/Movies",
            })
            ok("Seerr → Radarr connection set") if result else fail("Seerr → Radarr: failed")

    warn("Seerr Plex connection still needs manual setup in the UI")

# ── Config file generators ────────────────────────────────────────────────────

UNPACKERR_CONF = """\
# Unpackerr Configuration — generated by setup-arr-config.py
# https://github.com/Unpackerr/unpackerr/wiki/Configuration

debug        = false
quiet        = false
interval     = "2m"
start_delay  = "1m"
retry_delay  = "5m"
max_retries  = 3
parallel     = 1
file_mode    = "0644"
dir_mode     = "0755"
delete_delay = "5m"
delete_orig  = false

[[sonarr]]
  url       = "http://sonarr:8989"
  api_key   = "{sonarr_key}"
  paths     = ["/data/Downloads/Torrents/Completed", "/data/Downloads/Usenet/complete"]
  protocols = "torrent,usenet"
  timeout   = "10s"

[[radarr]]
  url       = "http://radarr:7878"
  api_key   = "{radarr_key}"
  paths     = ["/data/Downloads/Torrents/Completed", "/data/Downloads/Usenet/complete"]
  protocols = "torrent,usenet"
  timeout   = "10s"

[[lidarr]]
  url       = "http://lidarr:8686"
  api_key   = "{lidarr_key}"
  paths     = ["/data/Downloads/Torrents/Completed", "/data/Downloads/Usenet/complete"]
  protocols = "torrent,usenet"
  timeout   = "10s"
"""

RECYCLARR_CONF = """\
# Recyclarr Configuration — generated by setup-arr-config.py
# https://recyclarr.dev/wiki/
#
# Recyclarr syncs TRaSH Guide quality profiles and custom formats into
# Sonarr and Radarr. This is a starter config — customise it and run:
#
#   docker exec recyclarr recyclarr sync
#
# Browse available TRaSH Guide presets:
#   https://recyclarr.dev/wiki/guide-configs/
#
# Example: add quality profile presets by enabling the include block below.

sonarr:
  main:
    base_url: http://sonarr:8989
    api_key: {sonarr_key}
    # Uncomment to sync TRaSH Guide quality profiles:
    # include:
    #   - template: sonarr-quality-definition-series
    #   - template: sonarr-v4-quality-profile-web-1080p
    #   - template: sonarr-v4-custom-formats-web-1080p

radarr:
  main:
    base_url: http://radarr:7878
    api_key: {radarr_key}
    # Uncomment to sync TRaSH Guide quality profiles:
    # include:
    #   - template: radarr-quality-definition-movie
    #   - template: radarr-quality-profile-hd-bluray-web
    #   - template: radarr-custom-formats-hd-bluray-web
"""

HOMEPAGE_SERVICES = """\
# Homepage service config — generated by setup-arr-config.py
# Edit this file to customise your dashboard.
# Docs: https://gethomepage.dev/configs/services/

- Media:
    - Plex:
        href: http://{ip}:32400/web
        description: Media server
        icon: plex.png
        siteMonitor: http://{ip}:32400
    - Tautulli:
        href: http://{ip}:8181
        description: Plex analytics
        icon: tautulli.png
        siteMonitor: http://{ip}:8181
    - Seerr:
        href: http://{ip}:5056
        description: Request movies & TV
        icon: overseerr.png
        siteMonitor: http://{ip}:5056

- Automation:
    - Sonarr:
        href: http://{ip}:49152
        description: TV show automation
        icon: sonarr.png
        siteMonitor: http://{ip}:49152
    - Radarr:
        href: http://{ip}:49151
        description: Movie automation
        icon: radarr.png
        siteMonitor: http://{ip}:49151
    - Lidarr:
        href: http://{ip}:49154
        description: Music automation
        icon: lidarr.png
        siteMonitor: http://{ip}:49154
    - Bazarr:
        href: http://{ip}:49153
        description: Subtitle automation
        icon: bazarr.png
        siteMonitor: http://{ip}:49153
    - Prowlarr:
        href: http://{ip}:49150
        description: Indexer manager
        icon: prowlarr.png
        siteMonitor: http://{ip}:49150

- Downloads:
    - SABnzbd:
        href: http://{ip}:49155
        description: Usenet client
        icon: sabnzbd.png
        siteMonitor: http://{ip}:49155
    - qBittorrent:
        href: http://{ip}:49156
        description: Torrent client (VPN)
        icon: qbittorrent.png
        siteMonitor: http://{ip}:49156
"""

HOMEPAGE_SETTINGS = """\
# Homepage settings — generated by setup-arr-config.py
# Docs: https://gethomepage.dev/configs/settings/

title: Media Stack
startUrl: /
theme: dark
color: slate

layout:
  Media:
    style: row
    columns: 3
  Automation:
    style: row
    columns: 3
  Downloads:
    style: row
    columns: 2
"""

HOMEPAGE_WIDGETS = """\
# Homepage widgets — generated by setup-arr-config.py
# Docs: https://gethomepage.dev/widgets/

- datetime:
    text_size: xl
    format:
      dateStyle: long
      timeStyle: short
      hour12: true

- search:
    provider: google
    target: _blank
"""

def write_config_file(label, path, content):
    if os.path.exists(path):
        skip(f"{label} config (already exists)"); return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(content)
        ok(f"{label} config written → {path}")
    except Exception as e:
        fail(f"{label} config: {e}")

def overwrite_config_file(label, path, content):
    """Write config, overwriting existing — used for generated files that should stay fresh."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(content)
        ok(f"{label} config written → {path}")
    except Exception as e:
        fail(f"{label} config: {e}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    script_dir = os.path.dirname(os.path.realpath(__file__))
    env        = read_env_merged(script_dir)

    LAN_IP   = env.get('LAN_IP', '')
    QB_USER  = env.get('QBITTORRENT_USER', 'admin')
    QB_PASS  = env.get('QBITTORRENT_PASS', '')
    ARR_USER = env.get('ARR_USERNAME', '')
    ARR_PASS = env.get('ARR_PASSWORD', '')
    # PUID/PGID drive the container write-probe — without them we'd be
    # checking as root inside the container (which can always write,
    # and would silently mask the Synology ACL trap that the daemon
    # actually trips on). Stash in module globals so helpers see them
    # without per-call plumbing.
    global CONTAINER_UID, CONTAINER_GID
    try:    CONTAINER_UID = int(env.get('PUID') or 1026)
    except: CONTAINER_UID = 1026
    try:    CONTAINER_GID = int(env.get('PGID') or 100)
    except: CONTAINER_GID = 100

    if not LAN_IP:  print("Error: LAN_IP not set in .env");           sys.exit(1)
    if not QB_PASS: print("Error: QBITTORRENT_PASS not set in .env"); sys.exit(1)

    # ── Service URLs (host-mapped, used by this script) ───────────────────────
    SONARR   = f"http://{LAN_IP}:49152"
    RADARR   = f"http://{LAN_IP}:49151"
    LIDARR   = f"http://{LAN_IP}:49154"
    PROWLARR = f"http://{LAN_IP}:49150"
    SABNZBD  = f"http://{LAN_IP}:49155"
    BAZARR   = f"http://{LAN_IP}:49153"
    SEERR    = f"http://{LAN_IP}:5056"
    QBIT     = f"http://{LAN_IP}:49156"

    # ── Docker-internal URLs (written into service configs) ───────────────────
    SONARR_INT = "http://sonarr:8989"
    RADARR_INT = "http://radarr:7878"
    LIDARR_INT = "http://lidarr:8686"

    # ── API keys — .env takes priority, config files are the fallback ─────────
    B = "/volume1/docker/media"

    # Poll all config files together until available (up to 120s)
    arr_configs = {
        'sonarr':   (env.get('SONARR_API_KEY'),   f"{B}/sonarr/config/config.xml"),
        'radarr':   (env.get('RADARR_API_KEY'),   f"{B}/radarr/config/config.xml"),
        'lidarr':   (env.get('LIDARR_API_KEY'),   f"{B}/lidarr/config/config.xml"),
        'prowlarr': (env.get('PROWLARR_API_KEY'), f"{B}/prowlarr/config/config.xml"),
    }
    resolved_keys = {}
    pending = {}
    for svc, (env_val, config_xml) in arr_configs.items():
        key = env_val or read_arr_key(config_xml)
        if key:
            resolved_keys[svc] = key
        else:
            pending[svc] = config_xml

    if pending:
        names = ', '.join(s.title() for s in pending)
        sys.stdout.write(f"  Waiting for config files ({names}) ")
        sys.stdout.flush()
        deadline = time.time() + 120
        while pending and time.time() < deadline:
            time.sleep(3)
            sys.stdout.write('.'); sys.stdout.flush()
            for svc in list(pending.keys()):
                key = read_arr_key(pending[svc])
                if key:
                    resolved_keys[svc] = key
                    del pending[svc]
        print(f" {GREEN}✔{RESET}" if not pending else f" {RED}✘ missing: {', '.join(pending)}{RESET}")

    SONARR_KEY   = resolved_keys.get('sonarr')
    RADARR_KEY   = resolved_keys.get('radarr')
    LIDARR_KEY   = resolved_keys.get('lidarr')
    PROWLARR_KEY = resolved_keys.get('prowlarr')
    SABNZBD_KEY  = env.get('SABNZBD_API_KEY')  or read_sabnzbd_key(f"{B}/sabnzbd/config/sabnzbd.ini")
    BAZARR_KEY   = env.get('BAZARR_API_KEY')   or read_bazarr_key(f"{B}/bazarr/config")
    SEERR_KEY    = env.get('SEERR_API_KEY')    or read_json_key(f"{B}/seerr/config/settings.json", "main", "apiKey")

    # qBittorrent shares Gluetun's network namespace — use gluetun as host
    QB_HOST = "gluetun"
    QB_PORT = 49156

    print(f"\n{BOLD}╔══════════════════════════════════════════╗")
    print("║     Arr Stack Auto-Configuration         ║")
    print(f"╚══════════════════════════════════════════╝{RESET}")
    print("\nAPI keys found:")
    for name, key in [('Sonarr', SONARR_KEY), ('Radarr', RADARR_KEY),
                      ('Lidarr', LIDARR_KEY), ('Prowlarr', PROWLARR_KEY),
                      ('SABnzbd', SABNZBD_KEY), ('Bazarr', BAZARR_KEY),
                      ('Seerr', SEERR_KEY)]:
        s = f"{GREEN}✔{RESET} {key[:8]}..." if key else f"{RED}✘{RESET} not found"
        print(f"  {name:<12} {s}")

    # ── SABnzbd (configure first so Sonarr/Radarr/Lidarr can connect to it) ──

    configure_sabnzbd(SABNZBD, SABNZBD_KEY, f"{B}/sabnzbd/config/sabnzbd.ini")

    # Optional usenet provider — if USENET_HOST is set in .env we add it
    # to SABnzbd's news servers via the API. Otherwise the user wires it
    # up manually at http://<NAS>:49155 → Config → Servers.
    USENET_HOST = env.get('USENET_HOST', '')
    USENET_PORT = int(env.get('USENET_PORT') or 563)
    USENET_USER = env.get('USENET_USER', '')
    USENET_PASS = env.get('USENET_PASS', '')
    USENET_CONNECTIONS = int(env.get('USENET_CONNECTIONS') or 8)
    USENET_SSL = (env.get('USENET_SSL', '1').strip() not in ('0', 'false', 'False', ''))
    USENET_NAME = env.get('USENET_NAME', 'primary')

    configure_sabnzbd_server(SABNZBD, SABNZBD_KEY,
                              USENET_HOST, USENET_PORT, USENET_USER, USENET_PASS,
                              name=USENET_NAME, connections=USENET_CONNECTIONS,
                              use_ssl=USENET_SSL)

    # ── Tautulli (auto-wires to Plex via PlexOnlineToken from Preferences.xml) ─

    PLEX_PREFS = f"{B}/plex/config/Library/Application Support/Plex Media Server/Preferences.xml"
    TAUTULLI_INI = f"{B}/tautulli/config/config.ini"
    configure_tautulli(B, PLEX_PREFS, TAUTULLI_INI)

    # ── Sonarr ────────────────────────────────────────────────────────────────

    section("Sonarr")
    if not SONARR_KEY:
        fail("API key not found — is the container running?")
    elif wait_ready("Sonarr", SONARR, SONARR_KEY, "/api/v3/system/status"):
        add_root_folder(SONARR, SONARR_KEY, "api/v3", "/data/Media/TV Shows", container="sonarr")
        add_root_folder(SONARR, SONARR_KEY, "api/v3", "/data/Media/Anime/TV Shows", container="sonarr")
        add_download_client(SONARR, SONARR_KEY, "api/v3", "qBittorrent", "QBittorrent", {
            "host": QB_HOST, "port": QB_PORT, "useSsl": False,
            "username": QB_USER, "password": QB_PASS, "category": "tv-sonarr",
        })
        if SABNZBD_KEY:
            add_download_client(SONARR, SONARR_KEY, "api/v3", "SABnzbd", "Sabnzbd", {
                "host": "sabnzbd", "port": 8080, "useSsl": False,
                "apiKey": SABNZBD_KEY, "category": "tv",
            })
        else:
            warn("SABnzbd key not found — skipping")
        add_remote_path_mapping(SONARR, SONARR_KEY, "api/v3",
                                QB_HOST, "/downloads", "/data/Downloads/Torrents",
                                container="sonarr")
        add_remote_path_mapping(SONARR, SONARR_KEY, "api/v3",
                                "sabnzbd", "/data/complete", "/data/Downloads/Usenet/complete",
                                container="sonarr")
        enable_hardlinks(SONARR, SONARR_KEY, "api/v3")
        if ARR_USER and ARR_PASS:
            configure_auth(SONARR, SONARR_KEY, "api/v3", ARR_USER, ARR_PASS)

    # ── Radarr ────────────────────────────────────────────────────────────────

    section("Radarr")
    if not RADARR_KEY:
        fail("API key not found — is the container running?")
    elif wait_ready("Radarr", RADARR, RADARR_KEY, "/api/v3/system/status"):
        add_root_folder(RADARR, RADARR_KEY, "api/v3", "/data/Media/Movies", container="radarr")
        add_root_folder(RADARR, RADARR_KEY, "api/v3", "/data/Media/Anime/Movies", container="radarr")
        add_download_client(RADARR, RADARR_KEY, "api/v3", "qBittorrent", "QBittorrent", {
            "host": QB_HOST, "port": QB_PORT, "useSsl": False,
            "username": QB_USER, "password": QB_PASS, "category": "radarr",
        })
        if SABNZBD_KEY:
            add_download_client(RADARR, RADARR_KEY, "api/v3", "SABnzbd", "Sabnzbd", {
                "host": "sabnzbd", "port": 8080, "useSsl": False,
                "apiKey": SABNZBD_KEY, "category": "movies",
            })
        else:
            warn("SABnzbd key not found — skipping")
        add_remote_path_mapping(RADARR, RADARR_KEY, "api/v3",
                                QB_HOST, "/downloads", "/data/Downloads/Torrents",
                                container="radarr")
        add_remote_path_mapping(RADARR, RADARR_KEY, "api/v3",
                                "sabnzbd", "/data/complete", "/data/Downloads/Usenet/complete",
                                container="radarr")
        enable_hardlinks(RADARR, RADARR_KEY, "api/v3")
        if ARR_USER and ARR_PASS:
            configure_auth(RADARR, RADARR_KEY, "api/v3", ARR_USER, ARR_PASS)

    # ── Lidarr ────────────────────────────────────────────────────────────────

    section("Lidarr")
    if not LIDARR_KEY:
        fail("API key not found — is the container running?")
    elif wait_ready("Lidarr", LIDARR, LIDARR_KEY, "/api/v1/system/status"):
        # Lidarr's API can answer /system/status before its default
        # quality/metadata profiles are inserted (especially on a fresh
        # first-run DB). Poll the profile endpoints with a short backoff
        # so we don't try to attach the root folder to a non-existent
        # defaultQualityProfileId=1 (the previous fallback — Lidarr
        # then 400s with "Quality Profile does not exist").
        lidarr_quality_id = None
        lidarr_meta_id    = None
        for attempt in range(6):  # up to ~30s
            qprofiles = GET(LIDARR, LIDARR_KEY, "/api/v1/qualityprofile") or []
            mprofiles = GET(LIDARR, LIDARR_KEY, "/api/v1/metadataprofile") or []
            if qprofiles and mprofiles:
                # Prefer something with "Lossless" or "Standard" in its
                # name if available, else first one. Same for metadata.
                qmatch = next((p for p in qprofiles
                               if 'lossless' in p['name'].lower()
                               or 'standard' in p['name'].lower()), None)
                lidarr_quality_id = (qmatch or qprofiles[0])['id']
                lidarr_meta_id    = mprofiles[0]['id']
                break
            time.sleep(5)
        if lidarr_quality_id is None or lidarr_meta_id is None:
            fail("Lidarr: quality/metadata profiles not available after 30s — "
                 "open http://<NAS>:49154 once to let Lidarr finish first-run "
                 "setup, then re-run this script.")
        else:
            add_root_folder(LIDARR, LIDARR_KEY, "api/v1", "/data/Media/Music", {
                "defaultQualityProfileId":  lidarr_quality_id,
                "defaultMetadataProfileId": lidarr_meta_id,
            }, container="lidarr")
        add_download_client(LIDARR, LIDARR_KEY, "api/v1", "qBittorrent", "QBittorrent", {
            "host": QB_HOST, "port": QB_PORT, "useSsl": False,
            "username": QB_USER, "password": QB_PASS, "category": "lidarr",
        })
        if SABNZBD_KEY:
            add_download_client(LIDARR, LIDARR_KEY, "api/v1", "SABnzbd", "Sabnzbd", {
                "host": "sabnzbd", "port": 8080, "useSsl": False,
                "apiKey": SABNZBD_KEY, "category": "music",
            })
        else:
            warn("SABnzbd key not found — skipping")
        add_remote_path_mapping(LIDARR, LIDARR_KEY, "api/v1",
                                QB_HOST, "/downloads", "/data/Downloads/Torrents",
                                container="lidarr")
        add_remote_path_mapping(LIDARR, LIDARR_KEY, "api/v1",
                                "sabnzbd", "/data/complete", "/data/Downloads/Usenet/complete",
                                container="lidarr")
        enable_hardlinks(LIDARR, LIDARR_KEY, "api/v1")
        if ARR_USER and ARR_PASS:
            configure_auth(LIDARR, LIDARR_KEY, "api/v1", ARR_USER, ARR_PASS)

    # ── Prowlarr ──────────────────────────────────────────────────────────────

    section("Prowlarr")
    if not PROWLARR_KEY:
        fail("API key not found — is the container running?")
    elif wait_ready("Prowlarr", PROWLARR, PROWLARR_KEY, "/api/v1/system/status"):
        add_flaresolverr_proxy(PROWLARR, PROWLARR_KEY)
        if SONARR_KEY:
            add_prowlarr_app(PROWLARR, PROWLARR_KEY, "Sonarr", "Sonarr",
                             "SonarrSettings", SONARR_INT, SONARR_KEY,
                             [5000, 5010, 5020, 5030, 5040, 5045, 5050, 5070])
        if RADARR_KEY:
            add_prowlarr_app(PROWLARR, PROWLARR_KEY, "Radarr", "Radarr",
                             "RadarrSettings", RADARR_INT, RADARR_KEY,
                             [2000, 2010, 2020, 2030, 2040, 2045, 2050, 2060])
        if LIDARR_KEY:
            add_prowlarr_app(PROWLARR, PROWLARR_KEY, "Lidarr", "Lidarr",
                             "LidarrSettings", LIDARR_INT, LIDARR_KEY,
                             [3000, 3010, 3030, 3040, 3050])
        if ARR_USER and ARR_PASS:
            configure_auth(PROWLARR, PROWLARR_KEY, "api/v1", ARR_USER, ARR_PASS)

    # ── qBittorrent ───────────────────────────────────────────────────────────

    configure_qbittorrent(QBIT, QB_USER, QB_PASS)

    # ── Bazarr ────────────────────────────────────────────────────────────────

    configure_bazarr(BAZARR, BAZARR_KEY, SONARR_KEY, RADARR_KEY,
                     f"{B}/bazarr/config",
                     username=ARR_USER or None, password=ARR_PASS or None)

    # ── Seerr ─────────────────────────────────────────────────────────────────

    configure_seerr(SEERR, SEERR_KEY, SONARR, SONARR_KEY, RADARR, RADARR_KEY)

    # ── Config files ──────────────────────────────────────────────────────────

    section("Unpackerr")
    write_config_file("Unpackerr",
        f"{B}/unpackerr/config/unpackerr.conf",
        UNPACKERR_CONF.format(
            sonarr_key=SONARR_KEY or 'REPLACE_WITH_SONARR_KEY',
            radarr_key=RADARR_KEY or 'REPLACE_WITH_RADARR_KEY',
            lidarr_key=LIDARR_KEY or 'REPLACE_WITH_LIDARR_KEY',
        ))
    if SONARR_KEY or RADARR_KEY:
        warn("Restart unpackerr:  docker compose restart unpackerr")

    section("Recyclarr")
    write_config_file("Recyclarr",
        f"{B}/recyclarr/config/recyclarr.yml",
        RECYCLARR_CONF.format(
            sonarr_key=SONARR_KEY or 'REPLACE_WITH_SONARR_KEY',
            radarr_key=RADARR_KEY or 'REPLACE_WITH_RADARR_KEY',
        ))
    if SONARR_KEY or RADARR_KEY:
        warn("Customise recyclarr.yml then run:  docker exec recyclarr recyclarr sync")

    section("Homepage Dashboard")
    homepage_cfg = f"{B}/homepage/config"
    write_config_file("Homepage services",
        f"{homepage_cfg}/services.yaml",
        HOMEPAGE_SERVICES.format(ip=LAN_IP))
    write_config_file("Homepage settings",
        f"{homepage_cfg}/settings.yaml",
        HOMEPAGE_SETTINGS)
    write_config_file("Homepage widgets",
        f"{homepage_cfg}/widgets.yaml",
        HOMEPAGE_WIDGETS)
    # bookmarks.yaml — create empty so Homepage doesn't complain
    bookmarks_path = f"{homepage_cfg}/bookmarks.yaml"
    if not os.path.exists(bookmarks_path):
        try:
            os.makedirs(homepage_cfg, exist_ok=True)
            open(bookmarks_path, 'w').close()
            ok(f"Homepage bookmarks.yaml created")
        except Exception as e:
            fail(f"Homepage bookmarks.yaml: {e}")
    else:
        skip("Homepage bookmarks.yaml")

    # ── Summary ───────────────────────────────────────────────────────────────

    print(f"\n{'═' * 52}")
    if errors == 0:
        print(f"{GREEN}{BOLD}  All done — no errors.{RESET}")
    else:
        print(f"{RED}{BOLD}  Done with {errors} error(s) — review output above.{RESET}")

    print(f"""
  Still needs manual setup:
  • SABnzbd     http://{LAN_IP}:49155  → Config → Servers → add usenet provider
  • Seerr       http://{LAN_IP}:5056   → complete setup wizard, then re-run script
  • Tautulli    http://{LAN_IP}:8181   → connect Plex (needs your Plex token)
  • Recyclarr   customise recyclarr.yml then: docker exec recyclarr recyclarr sync
  • qBittorrent http://{LAN_IP}:49156  → Settings → BitTorrent → set seeding limits
""")
    print('═' * 52)
    sys.exit(0 if errors == 0 else 1)


if __name__ == '__main__':
    main()
