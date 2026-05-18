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
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

# When stdout is piped (i.e. running from setup.sh via SSH/SFTP rather
# than a tty), Python defaults to BLOCK buffering with an 8 KB window.
# In a long-running config step that prints small status lines, output
# stays trapped in the buffer until the next big chunk arrives — so the
# wizard's UI sees long silences and shows "(still working — Xs since
# last output)" even though the script is actively reporting progress.
# Real-world log on the user's NAS had heartbeats inside the auth
# verify loop never appearing at all because they were ~80 bytes each.
# Switch stdout/stderr to line-buffered so every \n gets flushed
# immediately. Python 3.7+ provides reconfigure() for this.
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass  # Older Python builds — old behavior is fine.

# ── Terminal colours ──────────────────────────────────────────────────────────

GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
RESET  = "\033[0m"

# Tracks which post-install "manual" steps the script managed to do
# automatically. The "Still needs manual setup" summary at the end of
# main() reads this and only prints items that are TRULY pending —
# previous versions printed the full list unconditionally, including
# items the script had just automated. configure_* functions set the
# matching key to True on success; the rendering helper below skips
# any line whose flag is True.
AUTOMATED = {
    'sab_provider':    False,   # SABnzbd news-server added via API
    'tautulli_token':  False,   # Tautulli wired to Plex with token
    'seerr_wizard':    False,   # Seerr first-run wizard completed via API
    'recyclarr_synced': False,  # `docker exec recyclarr recyclarr sync` ran
    'qbit_prefs':      False,   # qBittorrent default prefs applied
}

errors = 0

# Container UID/GID for the docker-exec write probe. Set by main() from
# .env's PUID/PGID. Default to LinuxServer's well-known 911:911 only as
# a safety net for callers that import this module without going through
# main(); in practice main() overrides these immediately.
CONTAINER_UID = 911
CONTAINER_GID = 911

def ok(msg):   print(f"  {GREEN}✔{RESET}  {msg}")
def skip(msg): print(f"  –  {msg} (already set)")
def info(msg):
    # Info-level FYI. Distinct prefix character (ℹ) outside the RunScreen
    # issue parser's match set (which catches ✘ / ⚠ / !). Used for status
    # the user might find useful but doesn't need to act on — e.g., self-
    # healing transient conditions, optional manual UI tweaks. Doesn't
    # contribute to the "errors" counter.
    print(f"  {DIM}ℹ{RESET}  {msg}")
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
    # Map container's /data/* path back to the host's DATA_ROOT/* path.
    # The wizard writes DATA_ROOT into .env so we can name the actual
    # host directory in the error message (Synology /volume1/Data,
    # Unraid /mnt/user/data, QNAP /share/Data, …). Falls back to the
    # historical Synology layout for older .envs that pre-date the
    # multi-NAS refactor.
    data_root = os.environ.get('DATA_ROOT')
    if not data_root:
        # Fish it out of the local .env via a quick file read — we're
        # already inside main() so script_dir is available, but
        # acl_diagnostic is module-level so we walk up to find it.
        try:
            here = os.path.dirname(os.path.realpath(__file__))
            with open(os.path.join(here, '.env')) as f:
                for line in f:
                    if line.startswith('DATA_ROOT='):
                        data_root = line.split('=', 1)[1].strip().strip('"').strip("'")
                        break
        except Exception:
            pass
    if not data_root:
        data_root = '/volume1/Data'
    host_path = path.replace('/data/', data_root.rstrip('/') + '/', 1)
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
    print(f"      access to drop a .test file there.")
    print(f"      Host path: {host_path}")
    print(f"      Data root: {data_root}")
    print(f"")
    # Family-aware fix instructions. /etc/synoinfo.conf is the Synology
    # fingerprint we use elsewhere in the stack; check it here so the
    # diagnostic shows DSM Control Panel steps on Synology and a more
    # generic chmod/chgrp + ACL hint on other NASes.
    is_synology = os.path.exists('/etc/synoinfo.conf')
    if is_synology:
        print(f"      Synology's shared-folder ACL is denying it. Fix in DSM:")
        print(f"        1. Control Panel → Shared Folder → click the share for {data_root}")
        print(f"        2. Edit → Permissions tab")
        print(f"        3. Find user '{user_name}' in the list")
        print(f"        4. Check 'Read/Write', click Save")
        print(f"        5. Back here:  docker compose restart")
        print(f"        6. Re-run:  sudo bash {os.path.dirname(os.path.realpath(__file__))}/setup.sh")
        print(f"")
        print(f"      Or from CLI:")
        print(f"        sudo synoacltool -add {data_root} \\")
        print(f'          "user:{user_name}:allow:rwxpdDaARWcCo:fd--"')
        print(f"        sudo synoacltool -enforce-inherit {data_root}")
    else:
        # Unraid / QNAP / TrueNAS / generic Linux — POSIX is the source
        # of truth. Walk the user through chgrp + chmod + setfacl.
        print(f"      Fix from your NAS shell:")
        print(f"        sudo chgrp -R {CONTAINER_GID} {host_path}")
        print(f"        sudo chmod -R g+rwX {host_path}")
        print(f"      Or with POSIX ACL (if your filesystem supports it):")
        print(f"        sudo setfacl -R -m  u:{CONTAINER_UID}:rwx {host_path}")
        print(f"        sudo setfacl -R -d -m u:{CONTAINER_UID}:rwx {host_path}")
        print(f"      Then:")
        print(f"        docker compose restart")
        print(f"        sudo bash {os.path.dirname(os.path.realpath(__file__))}/setup.sh")


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
        if result:
            ok(f"Download client: {name} (updated)")
            return
        # PUT got no response. 10 × 3s = 30s verify window — short
        # enough not to block the install for minutes if the PUT
        # silently never applied, long enough to catch the common
        # session-cycle race. Downgrade failure to a warning so the
        # rest of Step 7 keeps going; the user can tweak the
        # download client in the arr's UI later.
        for attempt in range(10):
            time.sleep(3)
            verify_list = GET(base, key, f"/{api}/downloadclient")
            if verify_list is None:
                continue
            updated = next((c for c in verify_list if c['name'] == name), None)
            if not updated:
                continue
            verify_map = {f['name']: i for i, f in enumerate(updated.get('fields', []))}
            if all(
                fname in verify_map and
                updated['fields'][verify_map[fname]].get('value') == fval
                for fname, fval in field_overrides.items()
            ):
                ok(f"Download client: {name} (updated, verified after restart)")
                return
        warn(f"Download client: {name} — couldn't auto-update after 30s. Open the arr's Settings → Download Clients to check it manually.")
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
    """Set Forms authentication, bypassed for local addresses.

    Tricky bit: writing the auth config triggers the arr to recycle
    its API session immediately. The PUT's HTTP response sometimes
    arrives after the recycle has already closed the connection,
    which urllib reports as ConnectionResetError → our PUT helper
    returns None → the old code reported "Auth: failed to set
    credentials" even though the change actually landed. This was
    real on Radarr/Lidarr/Prowlarr while Sonarr happened to win the
    race more often (no obvious reason — order of init in the LSIO
    image, probably). Fix: on a None PUT we re-GET the config after
    a settle, and trust the read-back. If it shows our intended
    auth state, treat the operation as success.

    Verify budget: real-world Synology spinning-rust logs showed
    Sonarr can take 60-90s to come back after the auth restart on
    first run (re-init of the SignalR hub, cert regen, etc.). Give
    the verify 120s of patience so we don't false-fail there."""
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
    if result:
        ok(f"Auth: {username} (LAN bypass on)")
        return
    # PUT got no response. Verify by reading the config back. 10
    # attempts × 3s = 30s of patience. Comparison made case-
    # insensitive on the enum fields — Sonarr v4 sometimes echoes
    # 'disabledForLocalAddresses' instead of the documented
    # 'DisabledForLocalAddresses', and we don't want to false-fail
    # the verify just because of a casing difference.
    print("    Auth: PUT got no response (arr likely cycled its session) — verifying...")
    last_verify = None
    for attempt in range(10):
        time.sleep(3)
        verify = GET(base, key, f"/{api}/config/host")
        if verify is None:
            continue
        last_verify = verify
        auth_method = (verify.get('authenticationMethod', '') or '').lower()
        auth_required = (verify.get('authenticationRequired', '') or '').lower()
        if (verify.get('username') == username and
            auth_method not in ('none', '') and
            auth_required == 'disabledforlocaladdresses'):
            ok(f"Auth: {username} (LAN bypass on, verified after restart)")
            return
    # Couldn't verify after 30s. Dump the last response we did see
    # so the user (and future-us reading the install log) can tell
    # whether the PUT applied partially, applied wrong, or never
    # applied at all. Without this we can only see "30s elapsed,
    # gave up" and have no idea what the arr actually thought the
    # config was. The clue is usually in here.
    warn(f"Auth: couldn't auto-apply credentials on {api} after 30s — set manually:")
    warn(f"  {base} → Settings → General → Security → Authentication: Forms")
    warn("  → Authentication Required: Disabled for Local Addresses")
    warn(f"  → Username: {username}, Password: {password}")
    if last_verify is not None:
        am = last_verify.get('authenticationMethod', '<missing>')
        ar = last_verify.get('authenticationRequired', '<missing>')
        un = last_verify.get('username', '<missing>')
        print(f"    Diagnostic — last config read from {api}: "
              f"authenticationMethod={am!r}, authenticationRequired={ar!r}, username={un!r}")

def configure_media_management(base, key, api, recycle_label):
    """Apply the bundle of Media Management settings that turn an arr's
    file handling from "OK out of the box" into "won't bite you later."
    All TRaSH-Guides-recommended baselines:

      - copyUsingHardlinks=True  → atomic moves, no double disk usage.
        (Useless if /data/downloads and /data/media are on different
        filesystems INSIDE the container — wizard's setup-folders.sh
        does a hardlink probe so we know this can work before we set
        it here.)
      - setPermissionsLinux=True  → set perms on import, so files the
        arr writes match the rest of the library instead of inheriting
        whatever umask the qBit/SAB containers had. Fixes the common
        "Plex sees old files but not new ones" symptom on Synology.
      - chmodFolder='775'  → group-writable so the user (in 'users'
        group) can manually edit / rename files in File Station.
      - extraFileExtensions='srt,sub,nfo'  → Bazarr drops .srt files
        next to media; without this the arr ignores them and Plex
        never sees subtitles. nfo for the small fraction of users
        using Plex's local-metadata agent.
      - autoUnmonitorPreviouslyDownloaded*=True  → when a user
        deletes a file from /data/media (typo / wrong release / etc),
        the arr stops trying to re-grab it. Without this, deleted
        files come back from RSS within hours.
      - recycleBin='/data/.recycle/<arr>' + recycleBinCleanupDays=30
         → safety net for accidental deletes. Files live in the
        recycle bin for 30 days before final deletion. Saved real
        users from real "oh no" moments more than once.

    Idempotent — only PUTs when any setting differs from desired."""
    config = GET(base, key, f"/{api}/config/mediamanagement")
    if config is None:
        fail("Media management: can't get config"); return

    desired = {
        'copyUsingHardlinks': True,
        'setPermissionsLinux': True,
        'chmodFolder': '775',
        'extraFileExtensions': 'srt,sub,nfo',
        'recycleBin': f'/data/.recycle/{recycle_label}',
        'recycleBinCleanupDays': 30,
    }
    # Sonarr has 'autoUnmonitorPreviouslyDownloadedEpisodes'; Radarr
    # has 'autoUnmonitorPreviouslyDownloadedMovies'; Lidarr has none.
    # Use whichever key exists in the response.
    for k in ('autoUnmonitorPreviouslyDownloadedEpisodes',
              'autoUnmonitorPreviouslyDownloadedMovies'):
        if k in config:
            desired[k] = True

    changes = {k: v for k, v in desired.items() if config.get(k) != v}
    if not changes:
        skip(f"Media management settings (all {len(desired)} already correct)")
        return

    for k, v in changes.items():
        config[k] = v
    result = PUT(base, key, f"/{api}/config/mediamanagement", config)
    if result:
        ok(f"Media management: {', '.join(sorted(changes.keys()))}")
        return
    # Same session-cycle race as configure_auth — Lidarr in particular
    # restarts its API session on Media Management changes, and the
    # response packet sometimes loses to the cycle. urllib reports
    # ConnectionResetError; our PUT helper returns None. Verify by
    # re-GETting and comparing the fields we tried to set. 30s budget.
    print("    Media management: PUT got no response (arr likely cycled its session) — verifying...")
    for _ in range(10):
        time.sleep(3)
        verify = GET(base, key, f"/{api}/config/mediamanagement")
        if verify is None:
            continue
        if all(verify.get(k) == v for k, v in changes.items()):
            ok(f"Media management: {', '.join(sorted(changes.keys()))} (verified after restart)")
            return
    # Per-setting failures here are non-fatal — the user can fix any
    # one of them in the UI. Surface as warn so the install proceeds.
    warn(f"Media management: failed to apply {', '.join(sorted(changes.keys()))}")

def configure_bind_address(base, key, api):
    """Set BindAddress to '*' so sibling Docker containers (Prowlarr,
    Bazarr, Seerr, Homepage widgets) can reach this arr by its compose
    service name. Default in some arr versions is '127.0.0.1' which
    only allows host-network connections — but the arrs run inside the
    'media' bridge network, so 127.0.0.1 is the arr's own loopback,
    not the host's. Symptom: 'Test' on Bazarr's Sonarr connection
    fails; Prowlarr Sync silently doesn't push indexers. Fix is one
    line in /api/v3/config/host.

    The TRaSH guide flags this as a default-trap on a few image
    variants; it's a no-op (already '*') on LinuxServer's stock arr
    images but worth setting explicitly so we don't depend on the
    image author's default holding."""
    config = GET(base, key, f"/{api}/config/host")
    if config is None:
        fail("Bind address: can't get config"); return
    if config.get('bindAddress') == '*':
        skip("Bind address (already '*')"); return
    config['bindAddress'] = '*'
    # Same race as configure_auth — changing host config triggers a
    # session cycle on some arr versions. Fire-and-don't-fret; verify
    # by re-reading. Reuse the same 30s patience budget.
    result = PUT(base, key, f"/{api}/config/host", config)
    if result:
        ok("Bind address: '*' (sibling containers can reach)")
        return
    for _ in range(10):
        time.sleep(3)
        verify = GET(base, key, f"/{api}/config/host")
        if verify and verify.get('bindAddress') == '*':
            ok("Bind address: '*' (verified after restart)")
            return
    warn("Bind address: couldn't auto-apply — set manually in Settings → General → Host → Bind Address = *")
def enable_hardlinks(base, key, api):
    """Compatibility shim — calls into the broader media-management
    configurator. Kept so any external callers (or older entry points)
    still resolve. Real work happens in configure_media_management."""
    configure_media_management(base, key, api, recycle_label=api.replace('/', '_'))

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

def configure_plex_notification(base, key, api, plex_token, on_episode_file=False):
    """Wire Sonarr/Radarr's Connect → Plex notification so library scans
    fire the moment a file is imported. Without this, Plex relies on
    its own scheduled-scan timer (which configure_plex_remote_access
    disables for I/O reasons), OR on inotify against the bind-mounted
    /media tree. Inotify across Docker bind mounts on Synology btrfs
    is documented unreliable (events from another container's writes
    sometimes don't propagate to Plex's watcher), so the safest
    pattern is BOTH: keep inotify enabled in Plex AND register the
    Connect notification here.

    Plex's API endpoint for the partial-scan webhook is built into the
    arr's PlexServer notification implementation — we just need to
    provide host=plex, port=32400, authToken=<plex token from
    Preferences.xml>, and toggle the onImport / onUpgrade event flags.
    Idempotent: skips when a PlexServer notification with our name
    already exists.

    on_episode_file=True is Sonarr's event flag name; Radarr uses
    onMovieFileImport. The caller picks the right one — we pass it
    through verbatim.
    """
    if not plex_token:
        skip(f"{api} → Plex notification (Plex token not available yet — re-run after Plex claim)")
        return
    name = "Plex Media Server"
    existing = GET(base, key, f"/{api}/notification")
    if existing is None:
        fail(f"{api} → Plex notification: can't reach API"); return
    if any(n.get('name') == name for n in existing):
        skip(f"{api} → Plex notification (already configured)"); return

    schemas = GET(base, key, f"/{api}/notification/schema") or []
    schema = next((s for s in schemas if s.get('implementation') == 'PlexServer'), None)
    if schema is None:
        warn(f"{api} → Plex notification: PlexServer schema not found in this arr version"); return

    schema = json.loads(json.dumps(schema))  # deep copy
    schema['name'] = name
    schema['onGrab'] = False
    schema['onDownload'] = True            # Radarr's "on import"
    schema['onUpgrade'] = True
    schema['onRename'] = True
    schema['onMovieAdded'] = False         # only Radarr — ignored on Sonarr
    if on_episode_file:
        schema['onEpisodeFileDelete'] = False
        schema['onSeriesDelete'] = False
    schema['supportsOnGrab'] = schema.get('supportsOnGrab', False)
    fm = {f['name']: i for i, f in enumerate(schema.get('fields', []))}
    for fname, fval in {
        'host':         'plex',
        'port':         32400,
        'useSsl':       False,
        'authToken':    plex_token,
        'updateLibrary': True,
    }.items():
        if fname in fm:
            schema['fields'][fm[fname]]['value'] = fval

    result = POST(base, key, f"/{api}/notification", schema)
    if result:
        ok(f"{api} → Plex notification: configured (partial-scan on import/upgrade)")
    else:
        # Don't fail the install — the user can wire this up by hand in
        # Settings → Connect → Add → Plex Media Server. Warn so they
        # know it didn't auto-apply.
        warn(f"{api} → Plex notification: POST rejected — add manually at "
             f"Settings → Connect → Add → Plex Media Server (host=plex port=32400)")

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

def _get_or_create_tag(prowlarr_base, prowlarr_key, label):
    """Get or create a Prowlarr tag by label. Returns the tag id or None.

    Prowlarr's indexer-proxy + indexer tagging model is the entire reason
    Flaresolverr works: a proxy only applies to indexers that share at
    least one tag with it. We need a stable named tag both the proxy
    creation step (here) and the indexer adds (in setup-indexers.py)
    can converge on. Idempotent — re-runs find the existing tag."""
    existing = GET(prowlarr_base, prowlarr_key, "/api/v1/tag") or []
    for t in existing:
        if t.get('label') == label:
            return t.get('id')
    # Doesn't exist yet — create it.
    new_tag = POST(prowlarr_base, prowlarr_key, "/api/v1/tag", {'label': label})
    return (new_tag or {}).get('id')


def add_flaresolverr_proxy(prowlarr_base, prowlarr_key):
    """Wire Flaresolverr into Prowlarr so CloudFlare-protected indexers work.

    Critical detail learned the hard way: Prowlarr's IndexerProxy only
    applies to indexers that share at least one tag with the proxy. A
    Flaresolverr proxy created with `tags: []` is functionally dead —
    Prowlarr never routes through it, and every CloudFlare-protected
    indexer (1337x, EZTV, TorrentGalaxy, etc.) silently fails the
    reachability test during add.

    Correct flow (matches the canonical TRaSH guide):
      1. Create a tag named 'flaresolverr'
      2. Attach the tag to this proxy
      3. setup-indexers.py attaches the same tag to every public torrent
         indexer when adding them — Prowlarr then routes their requests
         through Flaresolverr automatically.

    Returns the tag id so the caller can stash it in env / pass it
    downstream — but setup-indexers.py also looks it up itself via
    _get_or_create_tag(), so this is informational."""
    existing = GET(prowlarr_base, prowlarr_key, "/api/v1/indexerProxy")
    if existing is None:
        fail("Flaresolverr proxy: can't reach Prowlarr API"); return None

    # Create / find the flaresolverr tag FIRST — even when the proxy
    # already exists, we may need to attach the tag to it (older
    # installs created the proxy with `tags: []` per the now-fixed bug).
    tag_id = _get_or_create_tag(prowlarr_base, prowlarr_key, 'flaresolverr')
    if tag_id is None:
        warn("Flaresolverr tag: couldn't create — indexer tagging will fall back to add-without-proxy")
        return None

    flaresolverr_proxy = next((p for p in existing if p.get('implementation') == 'FlareSolverr'), None)
    if flaresolverr_proxy is not None:
        # Already exists. Verify the tag is attached; if not, attach it
        # (covers users upgrading from the buggy `tags: []` version).
        if tag_id not in (flaresolverr_proxy.get('tags') or []):
            flaresolverr_proxy['tags'] = list(set(flaresolverr_proxy.get('tags') or []) | {tag_id})
            updated = PUT(prowlarr_base, prowlarr_key,
                          f"/api/v1/indexerProxy/{flaresolverr_proxy['id']}", flaresolverr_proxy)
            if updated:
                ok("Flaresolverr proxy: tag attached (was missing — CloudFlare-protected indexers will now route through Flaresolverr)")
            else:
                warn("Flaresolverr proxy: tag attach failed — set 'flaresolverr' tag on it manually in Prowlarr UI")
        else:
            skip("Flaresolverr proxy (already configured, tag present)")
        return tag_id

    schemas = GET(prowlarr_base, prowlarr_key, "/api/v1/indexerProxy/schema") or []
    schema = next((s for s in schemas if s.get('implementation') == 'FlareSolverr'), None)
    if schema is None:
        warn("Flaresolverr schema not found in Prowlarr — may need to restart Prowlarr")
        return tag_id

    schema = json.loads(json.dumps(schema))  # deep copy
    schema['name'] = 'FlareSolverr'
    schema['tags'] = [tag_id]    # critical — see docstring

    fm = {f['name']: i for i, f in enumerate(schema.get('fields', []))}
    for fname, fval in [('host', 'http://flaresolverr:8191'), ('requestTimeout', 60)]:
        if fname in fm:
            schema['fields'][fm[fname]]['value'] = fval

    result = POST(prowlarr_base, prowlarr_key, "/api/v1/indexerProxy", schema)
    if result:
        ok("Flaresolverr proxy: configured (tag='flaresolverr', CloudFlare bypass active)")
    else:
        fail("Flaresolverr proxy: failed to add")
    return tag_id

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

    # Host whitelist — all Docker service names must be allowed.
    # 'gluetun' is in here even though SAB isn't behind the VPN —
    # qBittorrent is, and qBit's "Run external program on torrent
    # completion" callbacks come from gluetun's network namespace.
    # If we don't whitelist it SAB returns 403 Forbidden silently and
    # Sonarr/Radarr never see SAB completions. The wizard's previous
    # symptom: "completed in SAB, never imported" was sometimes this.
    REQUIRED_HOSTS = {'sabnzbd', 'sonarr', 'radarr', 'lidarr',
                      'bazarr', 'prowlarr', 'gluetun',
                      'localhost', '127.0.0.1'}
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


def configure_plex_remote_access(lan_ip, plex_token, public_port=32400):
    """Force Plex to advertise its public direct-connection URL so
    Plex.tv stops routing clients through the Plex Relay.

    Symptom this fixes: post-deploy log says
        ✔ Plex is reachable externally on port 32400
    but Plex clients (mobile, web, etc.) still show "Indirect connection"
    or "Relayed". Root cause: Plex's "Manual Port Mapping" is OFF by
    default. Plex relies on NAT-PMP / UPnP to discover its public port,
    and many home routers either don't support those protocols or have
    them disabled. When discovery fails, Plex.tv has no public address
    to publish — even though port 32400 IS forwarded — so it falls
    back to Relay.

    Fix: PUT /:/prefs?ManualPortMappingMode=1&ManualPortMappingPort=32400
    via Plex's HTTP API. This tells Plex "stop trying to discover, the
    port is just X on my router." Plex then publishes
    [public-ip]:32400 to Plex.tv, and clients connect directly.

    Idempotent — re-running with the same values is a no-op on Plex's
    side. We don't probe current values first; the PUT is cheap.

    Limitations:
      - Requires the user to actually have port 32400 forwarded on
        their router (the wizard's post-deploy validator confirms
        this; if it isn't, the manual mapping just tells Plex to
        publish an unreachable URL).
      - If the user wants a NON-standard external port (e.g. ISP
        blocks 32400 inbound, so they forward 32401 → 32400), they
        need to edit Plex Settings → Remote Access → Custom Public
        Port manually. We default to 32400 which matches the wizard's
        firewall rules + post-deploy check."""
    section("Plex Remote Access")
    if not plex_token:
        warn("Plex token not found — server not claimed yet?")
        warn("  Run the install again after the Plex container has claimed itself")
        warn("  (PLEX_CLAIM in .env triggers claim on first boot).")
        return
    if not lan_ip:
        warn("LAN_IP not set in .env — can't reach Plex API")
        return
    # Plex's REST endpoint for preferences. PUT keys as query string,
    # auth via X-Plex-Token header.
    plex_base = f"http://{lan_ip}:32400"

    def _plex_prefs_put(name, params_dict, retries=6):
        """One PUT to /:/prefs with the supplied params. Returns True
        on 2xx, False after exhausting retries. Plex's prefs endpoint
        accepts batches via repeated query-string keys, but in practice
        setting one preference per call is what its web UI does — and
        we follow suit so per-pref failures are attributable.

        503 retry: Plex returns 503 Service Unavailable while it's
        still loading its library DB on first boot. That's "wait a
        minute" not "permanent failure." Retry up to `retries` times
        with 10s spacing between attempts (default 6 = 60s budget per
        pref). Real install log: every Plex prefs PUT returned 503
        for the entire Step 7 window because Plex hadn't finished
        loading its DB yet; without 503 retry, EVERY pref applied
        zero settings.

        401 (bad token) and 5xx-other / 4xx don't retry — those are
        terminal."""
        for attempt in range(retries):
            try:
                req = Request(
                    f"{plex_base}/:/prefs?{urlencode(params_dict)}",
                    method='PUT',
                    headers={
                        'X-Plex-Token': plex_token,
                        'Accept':       'application/json',
                        'User-Agent':   'setup-arr-config/1.0',
                    },
                )
                with urlopen(req, timeout=10) as resp:
                    resp.read()
                return True
            except HTTPError as e:
                if e.code == 401:
                    warn(f"Plex API rejected our token on {name} — server may not be fully claimed yet")
                    return False
                if e.code == 503 and attempt < retries - 1:
                    # Plex still warming up. Heartbeat once per ~20s.
                    if attempt == 0 or attempt % 2 == 1:
                        print(f"    Plex returned 503 on {name} — still loading library DB; waiting...")
                    time.sleep(10)
                    continue
                warn(f"Plex prefs PUT ({name}) returned HTTP {e.code} after {attempt + 1} attempt(s)")
                return False
            except Exception as e:
                if attempt < retries - 1:
                    time.sleep(10)
                    continue
                warn(f"Couldn't reach Plex API at {plex_base} ({e}) — skipping {name}")
                return False
        return False

    # 1. Manual Port Mapping — fixes the "Indirect connection" relay
    # symptom (see top of function for full why). FIRST pref call
    # eats the brunt of Plex's first-boot DB load latency — bump
    # retries here from 6 → 18 (180s budget). Subsequent pref calls
    # benefit from the warmed-up state and use the default budget.
    if _plex_prefs_put("Manual port mapping", {
        'ManualPortMappingMode': '1',
        'ManualPortMappingPort': str(public_port),
    }, retries=18):
        ok(f"Manual port mapping enabled ([public-ip]:{public_port})")
    info("If clients still report 'indirect' after a minute:")
    info("  1. Settings → Remote Access in Plex web UI → 'Retry'")
    info("  2. Verify port 32400 is forwarded on your router to this NAS")
    info("  3. Some ISPs (CGNAT) block inbound — only Plex Relay works in that case")

    # 2. Quality-of-life preferences that TRaSH Guides + the Plex
    # community consistently recommend for a NAS-hosted, arr-managed
    # library. Default Plex behavior burns a LOT of NAS I/O on tasks
    # that aren't useful in this stack:
    #
    #   GenerateBIFBehavior=never
    #     Plex's video preview thumbnails (the strip you see when
    #     scrubbing in playback). Generating them re-encodes every
    #     video in the library — hours/days of 100% CPU + sustained
    #     disk read on a NAS. Most users don't notice them missing.
    #     Turn off; users who DO want them can flip it back per-library.
    #
    #   ScheduledLibraryUpdatesEnabled=0
    #     Periodic library scans pound the NAS for no benefit when
    #     Sonarr/Radarr Connect → Plex notifications already trigger
    #     partial scans the moment a file lands. Disable scheduled
    #     scan; rely on the notification.
    #
    # NOTE: removed three pref names that Plex's API rejects with
    # HTTP 400 ("not a valid setting name"):
    #   - EmptyTrashAfterScan
    #   - ScanIdleScanTasksEnabled
    #   - LowPriorityScanner
    # These appear in some community guides but aren't actually valid
    # Plex preference keys (Plex's settings names have evolved and
    # some doc sources are stale). Each was reliably 400'ing real
    # installs. Equivalent behavior for "don't trash files on
    # missing-file scan" / "scan at low priority" is now achieved
    # via Plex Web UI → Settings → Library → Empty trash automatically
    # after every scan (toggle OFF) and the implicit low-priority
    # behavior of disabling scheduled scans entirely. Users who want
    # these manually flipped are pointed at the UI in the Help modal.
    qol = [
        ('GenerateBIFBehavior',           'never',  'Video preview thumbnails (BIF)'),
        ('ScheduledLibraryUpdatesEnabled','0',      'Scheduled library scans'),
    ]
    applied = 0
    for setting, value, label in qol:
        if _plex_prefs_put(label, {setting: value}):
            applied += 1
    if applied:
        ok(f"Plex quality-of-life prefs applied ({applied}/{len(qol)} settings — see comments in setup-arr-config.py for why each)")
    else:
        info("(Plex QoL prefs skipped — none applied; check the warnings above)")


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

    # Tautulli writes config.ini on first boot — but on a fresh install
    # it might not exist YET by the time setup-arr-config.py runs (the
    # 45s post-step-6 settle wait isn't always enough for Tautulli to
    # finish initial setup on slow disks). Poll up to 60s before bailing
    # so we don't false-warn that the container's "not running" when
    # it's just slow to write its first config.
    if not os.path.exists(tautulli_ini_path):
        sys.stdout.write("    Waiting for Tautulli to write its initial config.ini ")
        sys.stdout.flush()
        deadline = time.time() + 60
        while time.time() < deadline:
            time.sleep(3)
            sys.stdout.write('.')
            sys.stdout.flush()
            if os.path.exists(tautulli_ini_path):
                print(' ✔')
                break
        else:
            print(f' {RED}✘ timed out{RESET}')
            warn(f"Tautulli config.ini still not found at {tautulli_ini_path}")
            warn("  Container may have crashed — check 'docker logs tautulli'.")
            return

    import configparser
    # interpolation=None: Tautulli's config.ini has '%' characters
    # everywhere (HTTP fields, encryption keys, formatted strings) and
    # ConfigParser's default BasicInterpolation treats '%' as the start
    # of a variable substitution. The read silently mangles values
    # containing literal '%' (they get interpreted as broken
    # interpolations or raise), and even values that round-trip end up
    # written back with extra escaping. Result: Tautulli boots into a
    # restart loop with "Unable to initialize Tautulli due to a
    # corrupted config file. Exiting..." every few seconds. Real-world
    # symptom seen on user NAS — 40+ restart cycles before the user
    # spotted it.
    cp = configparser.ConfigParser(interpolation=None)
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
        AUTOMATED['tautulli_token'] = True
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
        AUTOMATED['tautulli_token'] = True
    except Exception as e:
        fail(f"Could not write Tautulli config: {e}")
        return

    # Restart Tautulli so it re-reads config.ini. Use `docker compose
    # restart` rather than stop+up — stop+up creates a fresh container
    # instance which retriggers LSIO's first-boot path (where Tautulli's
    # known boot-races live), and `compose stop` marks the container as
    # user-stopped which interferes with `restart: unless-stopped` after
    # the container exits during init on slow hardware. Real-world
    # symptom seen on user NAS: container ended up in `exited` state
    # post-install and needed a manual `docker start` to recover.
    # `compose restart` sends SIGTERM to the running container (Tautulli
    # shuts down cleanly), then starts it back up — same container ID,
    # restart policy intact, no first-boot path re-run.
    print("    Restarting Tautulli container to apply...")
    import subprocess
    # Use `docker restart` (Docker CLI, not compose) — this is namespace-
    # neutral and doesn't need the compose project's `-f` flag set. The
    # alternative `docker compose restart` would resolve which compose
    # files belong to the project from the cwd, and on a `VPN_ENABLED=
    # false` install with the no-vpn override active, plain `compose
    # restart` from the canonical dir works fine (Tautulli isn't part
    # of the override). Keep `docker restart` so we never depend on
    # which override files are active.
    try:
        subprocess.run(
            ['docker', 'restart', '-t', '15', 'tautulli'],
            check=True, capture_output=True, timeout=90, text=True,
        )
    except subprocess.CalledProcessError as e:
        warn(f"docker compose restart failed: {(e.stderr or '')[:200]}")
        warn("  Manually:  docker compose restart tautulli")
        return
    except subprocess.TimeoutExpired:
        warn("Restart timed out — Tautulli may need a manual kick:")
        warn("  docker compose restart tautulli")
        return
    except FileNotFoundError:
        warn("'docker' not found in PATH — restart Tautulli manually:")
        warn("  docker compose restart tautulli")
        return

    # Verify Tautulli actually came back up. The `restart` command
    # returns once the container is started, not once Tautulli is ready
    # to serve HTTP — that takes 10-60s depending on disk speed. Poll
    # docker for container state up to 30s so we catch a fast crash-loop
    # before the user moves on. We don't wait for HTTP-200 here because
    # the wizard isn't blocked on it — post-deploy-validate.sh has the
    # richer HTTP check.
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(2)
        try:
            r = subprocess.run(
                ['docker', 'inspect', '-f', '{{.State.Status}}', 'tautulli'],
                capture_output=True, timeout=5, text=True,
            )
            state = (r.stdout or '').strip()
            if state == 'running':
                ok("Tautulli restarted — open http://<NAS>:8181 to verify (may take 30-60s)")
                return
            if state == 'exited':
                warn("Tautulli exited after restart — check 'docker logs tautulli'")
                warn("  Quick fix:  docker start tautulli")
                return
        except (subprocess.SubprocessError, FileNotFoundError):
            break
    warn("Tautulli didn't reach 'running' state within 30s — check 'docker ps'")


def _probe_usenet_ssl(host, port, timeout=5):
    """Probe whether host:port speaks SSL/TLS. Returns:
        True  — SSL handshake succeeded (port speaks TLS)
        False — TCP connect worked but SSL handshake failed (port is
                plain — common cause is using a non-SSL port like 9000
                with SSL=on, which surfaces as the [SSL: WRONG_VERSION_
                NUMBER] error inside SABnzbd's connection attempt)
        None  — TCP connect itself failed (DNS / port closed / network).
                Caller should fall back to whatever the user picked.

    We use socket + ssl.wrap_socket directly instead of trying via
    SABnzbd's test_server because the SAB API hides the SSL-failure
    detail behind a generic 'connect failed' string. Pre-probing gives
    us a clean signal we can act on."""
    import socket
    import ssl
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except OSError:
        return None
    try:
        ctx = ssl.create_default_context()
        # We're probing, not securely communicating — disable hostname
        # check + cert verify so a misconfigured provider cert doesn't
        # produce false negatives. The PROVIDER's identity is verified
        # by SABnzbd's actual login over TLS; we just want "does the
        # port speak TLS at all?"
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        wrapped = ctx.wrap_socket(sock, server_hostname=host)
        wrapped.close()
        return True
    except (ssl.SSLError, OSError):
        try:
            sock.close()
        except Exception:
            pass
        return False


def configure_sabnzbd_server(base, key, host, port, user, password,
                              name='primary', connections=8, use_ssl=True):
    """Add a usenet news server to SABnzbd.

    Idempotent — looks up existing servers by `name` and skips if present.
    Falls back gracefully if any field is missing (logs a skip and returns).

    Auto-detects SSL mismatch: if the user asked for SSL=on but a TCP-
    level probe shows the port doesn't speak TLS, we flip to SSL=off
    and warn. This catches the FrugalUsenet / Eweka / Newsgroup.Ninja
    style where ports 9000-9999 are plain and 563/443/9443 are TLS —
    users often misconfigure by leaving SSL=on after copying their
    provider's non-SSL port from a quickstart guide. Pre-this-fix
    behaviour: SABnzbd silently logs SSL: WRONG_VERSION_NUMBER on
    every connection, downloads never start.
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
        AUTOMATED['sab_provider'] = True
        return

    # SSL pre-probe: only when the user asked for SSL. If they explicitly
    # picked plain, respect that — they presumably know their provider
    # better than us. (Some hosts SUPPORT both SSL and plain on the
    # same port via STARTTLS; not worth second-guessing the user there.)
    effective_ssl = use_ssl
    if use_ssl:
        probe = _probe_usenet_ssl(host, port)
        if probe is False:
            # TCP worked, SSL handshake failed → port is plain.
            warn(f"USENET_SSL=on but {host}:{port} doesn't speak TLS — falling back to plain.")
            warn(f"  (Provider's SSL port is usually 563/443/9443; plain is 119/23/9xxx.)")
            warn(f"  Update USENET_SSL=0 in .env to silence this warning on re-runs.")
            effective_ssl = False
        elif probe is None:
            # TCP connect failed altogether. Don't muddy the .env's
            # SSL flag — let SABnzbd surface the real reachability
            # error in its UI (host unreachable, port closed, …).
            warn(f"Couldn't TCP-connect to {host}:{port} — server may be unreachable from this NAS.")
            warn(f"  Pushing config anyway with USENET_SSL={'on' if use_ssl else 'off'}; check SABnzbd → Status when install finishes.")

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
        'ssl': '1' if effective_ssl else '0',
        'enable': '1',
        'priority': '0',
    }
    result = sab_api(base, key, params)
    if result is not None and result.get('status') is not False:
        masked = host[:max(3, len(host) - 6)] + '***'
        ssl_label = ('on' if effective_ssl else 'off') + (' (auto-flipped from on)' if (use_ssl and not effective_ssl) else '')
        ok(f"Usenet provider added: {masked}:{port} (user: {user[:3]}***, {connections} conn, SSL={ssl_label})")
        AUTOMATED['sab_provider'] = True
    else:
        fail(f"Failed to add usenet provider {host}:{port}")

# ── qBittorrent ───────────────────────────────────────────────────────────────

def configure_qbittorrent(base, username, password, env=None):
    """Set qBittorrent preferences via the Web API (cookie auth).

    setup-folders.sh pre-writes /volume1/docker/media/qbittorrent/config/
    qBittorrent/qBittorrent.conf with a PBKDF2 hash derived from
    QBITTORRENT_PASS, so the daemon boots with the user's credentials
    on first launch. If login still fails here it's either:
      (a) the daemon's still finishing startup (transient — retry once)
      (b) a stale .credentials-set file from an old wizard version (the
          legacy in-container init script which we now clean up in
          setup-folders.sh, but a re-run might come AFTER that script
          already ran with the bug)
      (c) the password truly doesn't match (user manually changed it
          in the qBittorrent UI after a previous install)

    Distinguish (a) from (c): qBittorrent's auth API returns 'Ok.' on
    success, 'Fails.' on wrong creds, and empty body when the daemon is
    busy/restarting. Only retry on the empty/network case — retrying a
    'Fails.' just burns through qBittorrent's IP-ban budget (default 5
    failed logins / 5 minutes → 1 hour ban) and makes diagnostics
    harder."""
    section("qBittorrent")

    import http.cookiejar
    from urllib.request import build_opener, HTTPCookieProcessor

    cj = http.cookiejar.CookieJar()
    opener = build_opener(HTTPCookieProcessor(cj))

    def attempt_login():
        """Returns (response-body: str, error: Exception or None).
        Empty body + None error = 200 OK with no content (qBittorrent
        under stress). Non-None error = network / HTTP failure.

        Note: deliberately untyped — Synology DSM7 ships python 3.9 in
        Container Manager, which doesn't yet have PEP 604 (X | None
        union syntax). An earlier annotated version crashed setup.sh
        with TypeError before the function ever ran."""
        try:
            data = urlencode({'username': username, 'password': password}).encode()
            resp = opener.open(f"{base}/api/v2/auth/login", data, timeout=10)
            return resp.read().decode().strip(), None
        except Exception as e:
            return '', e

    last_result, last_error = attempt_login()
    # 'Fails.' is qBittorrent's "wrong credentials" — no point retrying,
    # would just burn through the ban budget. Anything else (empty body,
    # network error, connection reset) is almost always a transient
    # first-boot issue.
    #
    # qBit's log on first run reveals the actual gating message:
    #   "WebUI will be started shortly after internal preparations.
    #    Please wait..."
    # On Synology spinning rust with a non-trivial resume-data set in
    # BT_backup/, those "internal preparations" (state load + torrent
    # integrity verification + BT session init) can run for several
    # minutes BEFORE the WebUI binds. The old 8 × 10s = 80s budget
    # false-failed every install in that case. Bumped to 30 × 10s =
    # 300s (5 minutes), which matches the worst real-world wait we've
    # measured. 'Fails.' still short-circuits immediately so the IP-
    # ban budget isn't touched on wrong-password attempts.
    MAX_RETRIES = 30
    retries = 0
    while last_result != 'Ok.' and last_result != 'Fails.' and retries < MAX_RETRIES:
        time.sleep(10)
        retries += 1
        print(f"    qBittorrent not ready yet — retry {retries}/{MAX_RETRIES}")
        last_result, last_error = attempt_login()

    # Last-resort: 80s of retries and still empty body. Most likely
    # the qBit container is stuck in a half-started state (LinuxServer's
    # init scripts occasionally race the WebUI bind on Synology) OR
    # it's running with a stale qBittorrent.conf that doesn't match
    # the password we just wrote (setup-folders.sh rewrites the conf
    # but if the daemon never re-read it, the new PBKDF2 hash never
    # takes effect). `docker restart qbittorrent` cures both — the
    # container fully reinitializes + re-reads the conf on boot.
    # We used to attempt a `docker restart qbittorrent` fallback here,
    # then later upgraded that to a compose-aware
    # `docker compose rm + up -d gluetun qbittorrent` recovery. Both
    # turned out to be traps on VPN_ENABLED installs:
    #
    #   - qBittorrent shares gluetun's network namespace
    #     (`network_mode: service:gluetun`). The stop side of any
    #     container cycle blocks on namespace teardown while gluetun
    #     is busy.
    #   - Real-world logs showed 30-180s of blocked install time
    #     followed by a timeout, with qBit left in a wedged state
    #     that subsequent API calls couldn't recover from. The
    #     cascading "Connection reset by peer" errors then masked
    #     the actual cause from the user.
    #
    # Better policy: surface a clear, actionable warning + the
    # restart-qbit.sh helper (which does an orderly gluetun-then-qbit
    # recreate from outside this script) and skip the rest of qBit's
    # config. The install moves on. The user runs the helper once
    # post-install; the next setup.sh re-run finds qBit responsive
    # and finishes its config.
    if env is None:
        env = read_env_merged(os.path.dirname(os.path.realpath(__file__)))
    install_dir = env.get('INSTALL_DIR') or os.path.dirname(os.path.realpath(__file__))
    restarted = False  # kept for the success branch below to compile cleanly

    if last_result == 'Ok.':
        ok("qBittorrent authenticated" + (" (after forced restart)" if restarted else ""))
    elif last_result == 'Fails.':
        # `base` is the host:port URL the wizard derived from .env;
        # `install_dir` comes from .env via the caller. Surface them
        # verbatim so the user gets paths that match their actual NAS
        # layout (Synology /volume1/docker/media vs Unraid /mnt/user/
        # appdata/mediarr vs whatever).
        install_dir = os.environ.get('INSTALL_DIR') or os.path.dirname(os.path.realpath(__file__))
        warn(f"qBittorrent login rejected: username='{username}' did not match qBittorrent.conf.")
        warn("This usually means qBittorrent's WebUI password was changed manually after a")
        warn("previous install. Fix:")
        warn("  1. docker logs qbittorrent | grep -i 'temporary password'  — if recent, use that")
        warn("  2. Either log in via the qBittorrent UI and set the password to match")
        warn("     QBITTORRENT_PASS in .env, OR delete the qBittorrent config and re-run:")
        warn(f"       rm {install_dir}/qbittorrent/config/qBittorrent/qBittorrent.conf")
        warn("       docker compose restart qbittorrent")
        warn(f"       sudo bash {install_dir}/setup.sh")
        warn("Watched folder not configured — set manually in Settings → Downloads → Watched folders")
        return
    else:
        # qBittorrent's WebUI didn't bind in 5 minutes. Real symptom:
        # qBit's own startup log says "WebUI will be started shortly
        # after internal preparations. Please wait..." — those
        # preparations (BT_backup load + torrent integrity check + BT
        # session init) take 3-10+ minutes on Synology spinning rust
        # with non-trivial resume data, or after a container reset
        # that wiped the BT_backup dir.
        #
        # This is NOT a fatal install error — qBit is healthy, just
        # slow. The wizard's correct response: skip qBit-specific
        # config (watch folder, seed-limit hints), surface a clear
        # next-step recipe, and let the install proceed to Step 8+.
        # The user runs restart-qbit.sh once after install completes
        # AND/OR re-runs setup.sh once qBit has fully booted.
        install_dir = os.environ.get('INSTALL_DIR') or os.path.dirname(os.path.realpath(__file__))
        warn("qBittorrent's WebUI hasn't bound to port 49156 after 5 minutes of retries.")
        warn("This is usually SLOW not BROKEN — qBit's first-boot 'internal preparations'")
        warn("(loading BT_backup + verifying torrent integrity + initializing the BT session)")
        warn("can run 3-10+ minutes on Synology spinning rust. Recovery, in order:")
        warn("")
        warn(f"  1. Wait 5 more minutes, then check:")
        warn(f"       curl -sf http://$LAN_IP:49156 || echo 'still not bound'")
        warn(f"")
        warn(f"  2. If still not bound, force a clean restart:")
        warn(f"       bash {install_dir}/restart-qbit.sh")
        warn(f"")
        warn(f"  3. Once qBit's WebUI responds, re-run setup.sh — Step 7 will")
        warn(f"     finish qBit's watch-folder + Lidarr's download-client config")
        warn(f"     (idempotent — Sonarr/Radarr already configured will be skipped).")
        if last_error is not None:
            warn(f"")
            warn(f"  (Last error from qBit: {last_error})")
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

    # Apply sensible seeding defaults so users don't have to dig through
    # Settings → BitTorrent on first boot. Conservative numbers — torrents
    # stop after either 2× upload ratio OR 10 days seeded (qBit takes
    # whichever fires first). Idempotent: skips when the values already
    # match what we'd set, so a power-user who tuned them stays untouched.
    desired = {
        'max_ratio_enabled':         True,
        'max_ratio':                 2.0,
        'max_ratio_act':             1,        # 1 = pause (vs 0 = nothing)
        'max_seeding_time_enabled':  True,
        'max_seeding_time':          14400,    # minutes = 10 days
    }
    matches = all(prefs.get(k) == v for k, v in desired.items())
    if matches:
        skip("Seeding limits (already at 2.0 ratio / 10 days)")
        AUTOMATED['qbit_prefs'] = True
    else:
        try:
            prefs_json = json.dumps(desired)
            set_data = urlencode({'json': prefs_json}).encode()
            opener.open(f"{base}/api/v2/app/setPreferences", set_data, timeout=10)
            ok("Seeding limits: ratio 2.0 OR 10 days → pause torrent")
            AUTOMATED['qbit_prefs'] = True
        except Exception as e:
            warn(f"qBittorrent: couldn't set seeding defaults ({e}) — set manually in Settings → BitTorrent")

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

    # Web UI credentials. Use `form` (cookie session) instead of `basic`
    # (HTTP Basic) so logout works and browsers don't cache credentials
    # in-band on every request — matches the auth pattern Sonarr/Radarr
    # use (Forms with DisabledForLocalAddresses).
    if username and password and auth.get('username') != username:
        form_data['settings-auth-type']          = 'form'
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

def complete_seerr_first_run(base, plex_token):
    """Best-effort: complete Seerr's first-run wizard via API using the
    Plex token Tautulli also reads (PlexOnlineToken in Preferences.xml).

    Seerr/Overseerr deliberately blocks every settings endpoint with HTTP
    403 until the in-browser wizard authorises the first admin account.
    Pre-flexibility-pass behaviour was to warn the user and bail — they'd
    visit http://<NAS>:5056, click 'Sign in with Plex', wire up Sonarr/
    Radarr manually, then re-run setup.sh. That's 5+ minutes of clicking
    they shouldn't need to do; we already have a valid Plex token and
    everything else the wizard would ask for.

    Flow:
      1. POST /api/v1/auth/plex { authToken } — creates the first admin
         user and a session cookie. This is the same call the in-browser
         wizard's 'Sign in with Plex' button makes.
      2. POST /api/v1/settings/plex with the in-stack server config
         (host=plex, port=32400) so library scans target the right host.

    Returns True if step 1 succeeded (admin user now exists; the existing
    configure_seerr() function's X-Api-Key auth will work from here on).
    Returns False on any failure — caller falls back to the manual-hint
    path. Defensive: every call is wrapped in try/except so a Seerr API
    quirk can't crash the whole install."""
    import http.cookiejar
    from urllib.request import build_opener, HTTPCookieProcessor

    if not plex_token:
        return False

    cj = http.cookiejar.CookieJar()
    opener = build_opener(HTTPCookieProcessor(cj))

    # Sign in with Plex token — creates the first admin user. Seerr's
    # POST /api/v1/auth/plex accepts { authToken: <plex token> } and
    # returns 200 with the user object on success. 403/422 typically
    # means the wizard's already done (and the in-stack Plex token was
    # rotated since), so we treat those as "skip but don't fail".
    try:
        body = json.dumps({"authToken": plex_token}).encode()
        req = Request(f"{base}/api/v1/auth/plex", data=body,
                      headers={'Content-Type': 'application/json',
                               'User-Agent': 'setup-arr-config/1.0'},
                      method='POST')
        with opener.open(req, timeout=20) as resp:
            resp.read()  # discard body; we just need the cookie
        print(f"  {GREEN}✔{RESET} Seerr: signed in with Plex token (first admin created)")
    except HTTPError as e:
        # HTTPError only fires for non-2xx codes; checking `in (200..)`
        # here is unreachable (audit caught this). What we actually want:
        #   - 200/201/204 from urlopen never reach this handler (success
        #     above didn't raise).
        #   - 403 = the wizard has already been initialised by a prior
        #     install / manual sign-in; the existing admin token now
        #     accepts X-Api-Key for /settings endpoints. Return True so
        #     the caller proceeds to its retry probe of /settings/main
        #     with the existing api key.
        #   - 422 = malformed body / token expired. Real failure.
        #   - Anything else = real failure; fall back to manual hint.
        if e.code == 403:
            print(f"  {DIM}ℹ{RESET} Seerr wizard appears already initialised — using existing api key")
            return True
        warn(f"Seerr auth/plex returned HTTP {e.code} — falling back to manual wizard")
        return False
    except Exception as e:
        warn(f"Seerr auth/plex failed ({e}) — falling back to manual wizard")
        return False

    # Configure the Plex server so Seerr knows where to scan libraries
    # from. This is the second step of the in-browser wizard. Best-effort:
    # if this fails the admin user still exists, so the existing
    # configure_seerr() path will still take over and the user has a
    # working Seerr — just without Plex auto-configured.
    try:
        body = json.dumps({
            "name": "Plex",
            "hostname": "plex",
            "port": 32400,
            "useSsl": False,
            "libraries": [],
        }).encode()
        req = Request(f"{base}/api/v1/settings/plex", data=body,
                      headers={'Content-Type': 'application/json',
                               'User-Agent': 'setup-arr-config/1.0'},
                      method='POST')
        opener.open(req, timeout=15)
        print(f"  {GREEN}✔{RESET} Seerr: Plex server registered (plex:32400)")
    except Exception:
        # Non-fatal — admin user still exists, Plex can be wired manually.
        pass

    # Trigger a library sync so Movies / TV libraries appear in Seerr's
    # settings → libraries page. Optional and slow on big libraries, so
    # we just fire-and-forget without waiting for completion.
    try:
        req = Request(f"{base}/api/v1/settings/plex/library?sync=true",
                      method='GET',
                      headers={'User-Agent': 'setup-arr-config/1.0'})
        opener.open(req, timeout=10)
    except Exception:
        pass

    return True


def configure_seerr(base, key, sonarr_base, sonarr_key, radarr_base, radarr_key,
                    plex_token=None):
    section("Seerr")
    if not key:
        install_dir = os.environ.get('INSTALL_DIR') or os.path.dirname(os.path.realpath(__file__))
        warn("Seerr settings.json not found — complete the setup wizard first.")
        warn(f"Then re-run:  python3 {install_dir}/setup-arr-config.py")
        return

    # Probe with a direct urlopen so we can recognise the "wizard not
    # finished" 403 without _safe_request first printing "HTTP 403: …"
    # raw. Seerr returns 403 on every settings endpoint until the user
    # completes the in-browser first-run wizard (which is the only
    # path that issues a real session and finalises the API key) —
    # there's nothing useful to scrape from the response body.
    try:
        req = Request(f"{base}/api/v1/settings/main",
                      headers={'X-Api-Key': key,
                               'Content-Type': 'application/json',
                               'User-Agent': 'setup-arr-config/1.0'})
        with urlopen(req, timeout=15) as resp:
            main_settings = json.loads(resp.read())
    except HTTPError as e:
        if e.code in (401, 403):
            # Wizard not done. Try to complete it via API using the
            # Plex token we already have (read from Preferences.xml).
            # On success, retry the settings/main GET; on failure, fall
            # back to the manual-instructions hint.
            if plex_token and complete_seerr_first_run(base, plex_token):
                try:
                    req = Request(f"{base}/api/v1/settings/main",
                                  headers={'X-Api-Key': key,
                                           'Content-Type': 'application/json',
                                           'User-Agent': 'setup-arr-config/1.0'})
                    with urlopen(req, timeout=15) as resp:
                        main_settings = json.loads(resp.read())
                    AUTOMATED['seerr_wizard'] = True
                    ok("Seerr first-run wizard auto-completed via Plex token")
                except Exception as ee:
                    warn(f"Seerr auto-complete partial — settings/main re-probe failed ({ee})")
                    warn("  Visit http://<NAS>:5056 once to verify the wizard finished, then re-run setup.sh.")
                    return
            else:
                warn("Seerr first-run wizard not finished — API key isn't usable yet.")
                warn("  1. Visit http://<NAS>:5056 in your browser")
                warn("  2. Click 'Sign in with Plex' and complete the wizard (it'll")
                warn("     auto-detect the Sonarr/Radarr we set up here).")
                warn("  3. Or back here: sudo bash setup.sh   (this step is idempotent)")
                return
        else:
            warn(f"Seerr API error HTTP {e.code} — skipping Sonarr/Radarr wiring")
            return
    except URLError as e:
        warn(f"Seerr not reachable: {e.reason}")
        return
    except Exception as e:
        warn(f"Seerr probe errored: {e}")
        return

    # If we reach this point the settings/main probe succeeded → the
    # wizard's been initialized (either previously via browser, or just
    # now via complete_seerr_first_run). Mark the flag so the final
    # summary doesn't print the stale "complete the Seerr wizard" hint.
    AUTOMATED['seerr_wizard'] = True

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

    # Plex library-selection in Seerr is genuinely a UI step — pick
    # which Plex libraries to expose to requesters. Demoted from warn
    # to info because (a) the rest of Seerr is now fully wired up by
    # the auto-wizard above and (b) the user has no choice but to do
    # this in the Seerr UI; flagging it as a warning in the issues
    # panel implies something is broken when it isn't.
    info("Seerr → pick which Plex libraries to expose at http://<NAS>:5056 → Settings → Plex → Libraries")

# ── Config file generators ────────────────────────────────────────────────────

UNPACKERR_CONF = """\
# Unpackerr Configuration — generated by setup-arr-config.py
# https://github.com/Unpackerr/unpackerr/wiki/Configuration
#
# Timing notes:
# - interval=5m: arr download-client poll is every 60s by default, so a
#   5-minute scan window gives the arr two polls to claim a completed
#   archive before unpackerr tries to extract it.
# - delete_delay=10m: post-extract, the arr needs time to discover the
#   extracted file, import it (which may hardlink, copy, or symlink),
#   and release the source handle. 10m is the safe lower bound on
#   spinning rust — earlier values cause unpackerr to delete the
#   archive while the arr's still copying, leaving orphaned partials.

debug        = false
quiet        = false
interval     = "5m"
start_delay  = "1m"
retry_delay  = "5m"
max_retries  = 3
parallel     = 1
file_mode    = "0644"
dir_mode     = "0755"
delete_delay = "10m"
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

{lidarr_block}
"""

# Lidarr-specific unpackerr block — rendered only when a real Lidarr
# API key is available. Without this gate, unpackerr.conf included a
# stub [[lidarr]] block with `REPLACE_WITH_LIDARR_KEY` and the
# container 401-spammed every interval cycle.
UNPACKERR_LIDARR_BLOCK = """\
[[lidarr]]
  url       = "http://lidarr:8686"
  api_key   = "{lidarr_key}"
  paths     = ["/data/Downloads/Torrents/Completed", "/data/Downloads/Usenet/complete"]
  protocols = "torrent,usenet"
  timeout   = "10s"\
"""

# Recyclarr include-template recipes, keyed by the wizard's profile-pick
# values (TRASH_SONARR_PROFILE / TRASH_RADARR_PROFILE in .env). Each
# value is the list of TRaSH Guide templates to enable in recyclarr.yml's
# `include:` block. The names come from recyclarr's published template
# index — https://recyclarr.dev/wiki/yaml/config-reference/include/ — and
# are stable across recyclarr versions because they're the same names
# the TRaSH Guides website uses internally.
#
# All recipes include the quality-definition template (size limits per
# quality) AND a profile template AND a matching custom-formats template
# — that's the three-step pattern TRaSH himself recommends for "I just
# want it to work." See https://trash-guides.info/Sonarr/Sonarr-Recyclarr-Configurations/.
SONARR_PROFILE_RECIPES = {
    'web-1080p': [
        'sonarr-quality-definition-series',
        'sonarr-v4-quality-profile-web-1080p',
        'sonarr-v4-custom-formats-web-1080p',
    ],
    'web-2160p': [
        'sonarr-quality-definition-series',
        'sonarr-v4-quality-profile-web-2160p',
        'sonarr-v4-custom-formats-web-2160p',
    ],
    'bluray-1080p': [
        'sonarr-quality-definition-series',
        'sonarr-v4-quality-profile-bluray-1080p',
        'sonarr-v4-custom-formats-bluray-1080p',
    ],
    'bluray-2160p': [
        'sonarr-quality-definition-series',
        'sonarr-v4-quality-profile-bluray-2160p',
        'sonarr-v4-custom-formats-bluray-2160p',
    ],
    'anime': [
        'sonarr-quality-definition-anime',
        'sonarr-v4-quality-profile-anime',
        'sonarr-v4-custom-formats-anime',
    ],
}
SONARR_PROFILE_NAMES = {
    'web-1080p':    'WEB-1080p',
    'web-2160p':    'WEB-2160p',
    'bluray-1080p': 'Bluray-1080p',
    'bluray-2160p': 'Bluray-2160p',
    'anime':        'Anime',
}

RADARR_PROFILE_RECIPES = {
    'hd-bluray-web': [
        'radarr-quality-definition-movie',
        'radarr-quality-profile-hd-bluray-web',
        'radarr-custom-formats-hd-bluray-web',
    ],
    'uhd-bluray-web': [
        'radarr-quality-definition-movie',
        'radarr-quality-profile-uhd-bluray-web',
        'radarr-custom-formats-uhd-bluray-web',
    ],
    'remux-web-2160p': [
        'radarr-quality-definition-movie',
        'radarr-quality-profile-remux-web-2160p',
        'radarr-custom-formats-remux-web-2160p',
    ],
    'anime': [
        'radarr-quality-definition-anime',
        'radarr-quality-profile-anime',
        'radarr-custom-formats-anime',
    ],
}
RADARR_PROFILE_NAMES = {
    'hd-bluray-web':    'HD Bluray + WEB',
    'uhd-bluray-web':   'UHD Bluray + WEB',
    'remux-web-2160p':  'Remux + WEB 2160p',
    'anime':            'Remux + WEB 1080p - Anime',
}


def render_recyclarr_config(sonarr_key, radarr_key, sonarr_profile, radarr_profile):
    """Build recyclarr.yml dynamically based on the user's TRaSH profile
    picks. Returns the full file body as a single string.

    Why this is a function (not a `.format()`-able template like every
    other config in this file): recyclarr.yml's `include:` block expands
    or contracts depending on which profile is selected, AND we want to
    omit the sonarr / radarr sections entirely when their API key is
    blank (which happens when the user disabled that arr). A static
    template can't express either of those.

    sonarr_key / radarr_key may be empty strings — caller handles the
    "no key yet" case by passing 'REPLACE_WITH_SONARR_KEY' as a sentinel
    so re-runs of the wizard fix it up. We just pass through.

    sonarr_profile / radarr_profile fall back to the wizard's defaults
    if the env var is missing or set to an unrecognised value (so a
    typo in .env doesn't break the install — we just use the default
    and leave a comment in the YAML pointing at it).
    """
    out = [
        "# Recyclarr Configuration — generated by setup-arr-config.py",
        "# https://recyclarr.dev/wiki/",
        "#",
        "# Recyclarr syncs TRaSH Guide quality profiles and custom formats into",
        "# Sonarr and Radarr. The wizard auto-runs `recyclarr sync` after writing",
        "# this file, but you can re-apply changes any time:",
        "#",
        "#   docker exec recyclarr recyclarr sync       (one-off)",
        "#   bash recyclarr-sync.sh                     (with logging)",
        "#",
        "# To change which TRaSH profile is applied, edit TRASH_SONARR_PROFILE or",
        "# TRASH_RADARR_PROFILE in .env and re-run the wizard — re-running",
        "# regenerates this file to match.",
        "#",
        "# Power-user note: the wizard refuses to clobber a recyclarr.yml whose",
        "# `base_url` and `api_key` lines already look correct, so hand-edits to",
        "# the `include:` block survive a wizard re-run. If you'd rather the",
        "# wizard owns the file: delete recyclarr.yml before re-running.",
        "",
    ]

    # Sonarr section — skipped entirely when the user has no key (which
    # means either Sonarr is disabled or its API hasn't responded yet).
    # Without a key, recyclarr sync would fail with "API key required";
    # better to omit the block so the rest of the file still validates.
    if sonarr_key and sonarr_key != 'REPLACE_WITH_SONARR_KEY':
        recipe = SONARR_PROFILE_RECIPES.get(sonarr_profile) \
                 or SONARR_PROFILE_RECIPES['web-1080p']
        pname  = SONARR_PROFILE_NAMES.get(sonarr_profile) \
                 or SONARR_PROFILE_NAMES['web-1080p']
        out += [
            f"# Sonarr — TRaSH profile: {sonarr_profile or 'web-1080p (default)'}",
            "sonarr:",
            "  main:",
            "    base_url: http://sonarr:8989",
            f"    api_key: {sonarr_key}",
            "    # Drop entries from existing profiles that aren't in the TRaSH",
            "    # template list. Without this, recyclarr only adds + leaves old",
            "    # custom-formats in place forever — which produces weird scores",
            "    # when you switch profile recipes between wizard runs.",
            "    delete_old_custom_formats: true",
            "    replace_existing_custom_formats: true",
            "    include:",
        ]
        for tpl in recipe:
            out.append(f"      - template: {tpl}")
        out += [
            "    quality_profiles:",
            f"      - name: {pname}",
            "",
        ]
    elif sonarr_key:
        # We have the placeholder sentinel — write the section but with
        # an obvious "fix me" so the user knows what to do on re-run.
        out += [
            "# Sonarr — API key not discovered yet; re-run the wizard.",
            "# sonarr:",
            "#   main:",
            "#     base_url: http://sonarr:8989",
            f"#     api_key: {sonarr_key}",
            "",
        ]

    # Radarr section — same pattern.
    if radarr_key and radarr_key != 'REPLACE_WITH_RADARR_KEY':
        recipe = RADARR_PROFILE_RECIPES.get(radarr_profile) \
                 or RADARR_PROFILE_RECIPES['hd-bluray-web']
        pname  = RADARR_PROFILE_NAMES.get(radarr_profile) \
                 or RADARR_PROFILE_NAMES['hd-bluray-web']
        out += [
            f"# Radarr — TRaSH profile: {radarr_profile or 'hd-bluray-web (default)'}",
            "radarr:",
            "  main:",
            "    base_url: http://radarr:7878",
            f"    api_key: {radarr_key}",
            "    delete_old_custom_formats: true",
            "    replace_existing_custom_formats: true",
            "    include:",
        ]
        for tpl in recipe:
            out.append(f"      - template: {tpl}")
        out += [
            "    quality_profiles:",
            f"      - name: {pname}",
            "",
        ]
    elif radarr_key:
        out += [
            "# Radarr — API key not discovered yet; re-run the wizard.",
            "# radarr:",
            "#   main:",
            "#     base_url: http://radarr:7878",
            f"#     api_key: {radarr_key}",
            "",
        ]

    return "\n".join(out)

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


def render_homepage_services(env, ip):
    """Build services.yaml dynamically based on the user's ENABLE_*
    selection. Static HOMEPAGE_SERVICES was a hardcoded full-bundle
    template that produced red 'unreachable' badges on the dashboard
    for every disabled service — Homepage's siteMonitor checks would
    hammer non-existent containers and the user would think their
    install was broken.

    Prowlarr stays always-on (not profile-gated in compose), so it's
    unconditional. Everything else gets its section only when its
    ENABLE_* flag is on. Empty sections (e.g. no Media items when
    ENABLE_PLEX=false) are omitted entirely so Homepage's layout config
    doesn't reference a section that has no rows."""
    out = ["# Homepage service config — generated by setup-arr-config.py",
           "# Edit this file to customise your dashboard.",
           "# Docs: https://gethomepage.dev/configs/services/",
           ""]

    def block(name, href, description, icon, monitor=None):
        return (f"    - {name}:\n"
                f"        href: {href}\n"
                f"        description: {description}\n"
                f"        icon: {icon}\n"
                f"        siteMonitor: {monitor or href}")

    # Media section — Plex stack (Plex / Tautulli / Seerr move together).
    media = []
    if is_enabled(env, 'ENABLE_PLEX'):
        media.append(block("Plex",     f"http://{ip}:32400/web", "Media server",   "plex.png",      f"http://{ip}:32400"))
        media.append(block("Tautulli", f"http://{ip}:8181",      "Plex analytics", "tautulli.png"))
        media.append(block("Seerr",    f"http://{ip}:5056",      "Request movies & TV", "overseerr.png"))
    if media:
        out.append("- Media:")
        out.extend(media)
        out.append("")

    # Automation section — arrs + Prowlarr (always-on). Bazarr only if
    # Bazarr is enabled.
    automation = []
    if is_enabled(env, 'ENABLE_SONARR'):
        automation.append(block("Sonarr",   f"http://{ip}:49152", "TV show automation", "sonarr.png"))
    if is_enabled(env, 'ENABLE_RADARR'):
        automation.append(block("Radarr",   f"http://{ip}:49151", "Movie automation",   "radarr.png"))
    if is_enabled(env, 'ENABLE_LIDARR'):
        automation.append(block("Lidarr",   f"http://{ip}:49154", "Music automation",   "lidarr.png"))
    if is_enabled(env, 'ENABLE_BAZARR'):
        automation.append(block("Bazarr",   f"http://{ip}:49153", "Subtitle automation","bazarr.png"))
    automation.append(    block("Prowlarr", f"http://{ip}:49150", "Indexer manager",    "prowlarr.png"))
    if automation:
        out.append("- Automation:")
        out.extend(automation)
        out.append("")

    # Downloads section — SAB (usenet) + qBit (torrenting).
    downloads = []
    if is_enabled(env, 'ENABLE_SABNZBD'):
        downloads.append(block("SABnzbd",     f"http://{ip}:49155", "Usenet client",         "sabnzbd.png"))
    if is_enabled(env, 'ENABLE_QBITTORRENT'):
        downloads.append(block("qBittorrent", f"http://{ip}:49156", "Torrent client (VPN)",  "qbittorrent.png"))
    if downloads:
        out.append("- Downloads:")
        out.extend(downloads)
        out.append("")

    # Maintenance section — services with no web UI (Recyclarr is a
    # CLI tool, so its tile points at the docs + the in-config last-
    # sync stamp, not at any port on the NAS). This is the section the
    # user expected to see Recyclarr appear in but it was missing from
    # the generator because Recyclarr doesn't fit the "thing with a
    # web UI" mold. Two approaches that don't work and one that does:
    #
    #   (a) Skip it entirely — what the old code did. User has no idea
    #       Recyclarr exists; can't find docs or recent-sync info from
    #       the dashboard.
    #   (b) Add it under Automation pointing at the docs — confusing
    #       because clicking goes to recyclarr.dev not to the NAS.
    #   (c) New Maintenance section with a docs link + a customapi
    #       widget reading the .last-sync stamp configure_recyclarr
    #       writes. The tile's `href` is the TRaSH Guides homepage
    #       (most users want to read the guides, not the recyclarr
    #       wiki); the tooltip / widget gives the freshness signal.
    #
    # siteMonitor is skipped here — there's no HTTP endpoint to ping.
    # Homepage handles a missing siteMonitor by not showing a status
    # dot, which is exactly what we want.
    maintenance = []
    if is_enabled(env, 'ENABLE_RECYCLARR'):
        # The TRaSH profile pick is surfaced in the tile description so
        # the user can see at a glance which profile is currently
        # applied — that's the bit they're most likely to want to
        # change once the dashboard's up.
        sp = env.get('TRASH_SONARR_PROFILE', 'web-1080p').strip() or 'web-1080p'
        rp = env.get('TRASH_RADARR_PROFILE', 'hd-bluray-web').strip() or 'hd-bluray-web'
        sp_name = SONARR_PROFILE_NAMES.get(sp, sp)
        rp_name = RADARR_PROFILE_NAMES.get(rp, rp)
        # Recyclarr itself is a CLI tool with no web UI, but the
        # recyclarr-trigger sidecar (defined in docker-compose.yml)
        # exposes a single-page web UI with a "Sync Now" button on
        # port 8889. Tile href points there — clicking the tile opens
        # the trigger UI in the user's browser. siteMonitor uses the
        # same URL so the dashboard's status dot reflects whether the
        # trigger container is up + serving (not whether the LAST sync
        # succeeded — that's surfaced inside the trigger UI itself).
        maintenance.append(
            f"    - Recyclarr:\n"
            f"        href: http://{ip}:8889/\n"
            f"        description: 'TRaSH sync · Sonarr={sp_name}, Radarr={rp_name}'\n"
            f"        icon: recyclarr.svg\n"
            f"        siteMonitor: http://{ip}:8889/"
        )
    if maintenance:
        out.append("- Maintenance:")
        out.extend(maintenance)
        out.append("")

    return "\n".join(out)


def render_homepage_settings(env):
    """Build settings.yaml's `layout:` block based on which sections
    will exist in services.yaml — otherwise Homepage logs a warning
    for layout keys that have no matching section."""
    out = ["# Homepage settings — generated by setup-arr-config.py",
           "# Docs: https://gethomepage.dev/configs/settings/",
           "",
           "title: Media Stack",
           "startUrl: /",
           "theme: dark",
           "color: slate",
           "",
           "layout:"]
    # Media — gated on Plex
    if is_enabled(env, 'ENABLE_PLEX'):
        out.append("  Media:")
        out.append("    style: row")
        out.append("    columns: 3")
    # Automation — always has at least Prowlarr
    out.append("  Automation:")
    out.append("    style: row")
    out.append("    columns: 3")
    # Downloads — only when at least one downloader is on
    if is_enabled(env, 'ENABLE_SABNZBD') or is_enabled(env, 'ENABLE_QBITTORRENT'):
        out.append("  Downloads:")
        out.append("    style: row")
        out.append("    columns: 2")
    # Maintenance — currently just Recyclarr (could grow with future
    # CLI-only services). columns: 1 so the single tile renders full-
    # width rather than getting orphaned in a 3-col grid.
    if is_enabled(env, 'ENABLE_RECYCLARR'):
        out.append("  Maintenance:")
        out.append("    style: row")
        out.append("    columns: 1")
    return "\n".join(out) + "\n"

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

def is_enabled(env, key):
    """Default-on opt-out semantics. Missing or empty → enabled; only
    explicit 'false'/'0'/'no'/'off' (any case) counts as disabled.
    Mirrors env-render.ts's isEnabled() and setup.sh's is_enabled() so
    the renderer, the bash launcher, and this configurator all agree
    on what's enabled for any given .env. Profiles created before
    service selection existed have no ENABLE_* keys, so every service
    is treated as enabled (back-compat)."""
    return (env.get(key, 'true') or 'true').strip().lower() not in ('false', '0', 'no', 'off')


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
    # Catch ValueError/TypeError specifically — bare `except:` would
    # swallow KeyboardInterrupt and SystemExit, so a Ctrl-C here would
    # silently install with default UIDs instead of stopping.
    try:    CONTAINER_UID = int(env.get('PUID') or 1026)
    except (ValueError, TypeError): CONTAINER_UID = 1026
    try:    CONTAINER_GID = int(env.get('PGID') or 100)
    except (ValueError, TypeError): CONTAINER_GID = 100

    if not LAN_IP:  print("Error: LAN_IP not set in .env");           sys.exit(1)
    # QBITTORRENT_PASS is only required when qBittorrent is in the stack.
    # The configure_qbittorrent() block at the bottom of main() is gated
    # on ENABLE_QBITTORRENT, but this top-level check fires before that
    # gate — so it would refuse to run setup-arr-config.py at all on an
    # install where the user opted out of qBittorrent.
    if is_enabled(env, 'ENABLE_QBITTORRENT') and not QB_PASS:
        print("Error: QBITTORRENT_PASS not set in .env"); sys.exit(1)

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
    # B = the wizard's install dir on this host. NAS-family-portable:
    # comes from .env (INSTALL_DIR) on every install since the multi-NAS
    # refactor; falls back to Synology's historical path for older .envs
    # the user might have hand-edited, and finally to script_dir which
    # is where setup.sh always runs from anyway.
    B = env.get('INSTALL_DIR') or script_dir or '/volume1/docker/media'
    # Expose INSTALL_DIR + DATA_ROOT to module-level helpers (like
    # acl_diagnostic / configure_qbittorrent) that need them but don't
    # take env as a parameter. Cheaper than threading them through every
    # function signature.
    os.environ['INSTALL_DIR'] = B
    if env.get('DATA_ROOT'):
        os.environ['DATA_ROOT'] = env['DATA_ROOT']

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

    # qBittorrent's reachable host inside the media network depends on
    # whether VPN is wrapping it:
    #   - VPN_ENABLED=true: qBittorrent shares gluetun's net namespace
    #     (network_mode: service:gluetun in compose), so the only DNS
    #     name that resolves is "gluetun".
    #   - VPN_ENABLED=false: docker-compose.no-vpn.yml override drops
    #     the gluetun sidecar and switches qBittorrent to bridge on
    #     the media network, so it's reachable as "qbittorrent".
    # Pre-multi-NAS this defaulted to "gluetun" unconditionally and
    # silently broke the no-VPN install (Sonarr would log connect-
    # refused at qBittorrent every 15s because there's no "gluetun"
    # host to resolve). Pick the right one based on VPN_ENABLED so
    # both code paths work.
    vpn_on = (env.get('VPN_ENABLED', 'false') or 'false').strip().lower() in ('true', '1', 'yes', 'on')
    QB_HOST = "gluetun" if vpn_on else "qbittorrent"
    QB_PORT = 49156

    print(f"\n{BOLD}╔══════════════════════════════════════════╗")
    print("║     Arr Stack Auto-Configuration         ║")
    print(f"╚══════════════════════════════════════════╝{RESET}")
    print("\nAPI keys found:")
    # Map each service to its ENABLE_* gate. When a service is opted
    # out, the "✘ not found" line is misleading — the user knows they
    # turned it off; we shouldn't flag missing keys for a container
    # that was never going to start. Show "⏭ disabled" for those
    # instead so the status block tracks reality.
    #
    # Prowlarr is always-on (not profile-gated), so no flag check.
    # Tautulli + Seerr ride on ENABLE_PLEX (Plex stack moves together).
    name_key_flag = [
        ('Sonarr',   SONARR_KEY,   'ENABLE_SONARR'),
        ('Radarr',   RADARR_KEY,   'ENABLE_RADARR'),
        ('Lidarr',   LIDARR_KEY,   'ENABLE_LIDARR'),
        ('Prowlarr', PROWLARR_KEY, None),
        ('SABnzbd',  SABNZBD_KEY,  'ENABLE_SABNZBD'),
        ('Bazarr',   BAZARR_KEY,   'ENABLE_BAZARR'),
        ('Seerr',    SEERR_KEY,    'ENABLE_PLEX'),
    ]
    for name, key, flag in name_key_flag:
        if flag is not None and not is_enabled(env, flag):
            s = f"{DIM}⏭{RESET} disabled"
        elif key:
            s = f"{GREEN}✔{RESET} {key[:8]}..."
        else:
            s = f"{RED}✘{RESET} not found"
        print(f"  {name:<12} {s}")

    # ── SABnzbd (configure first so Sonarr/Radarr/Lidarr can connect to it) ──

    if is_enabled(env, 'ENABLE_SABNZBD'):
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
    else:
        section("SABnzbd")
        print(f"  {DIM}⏭  ENABLE_SABNZBD=false — skipping.{RESET}")
        # Force-blank the key so downstream arrs don't try to register
        # a SAB download client against a container that doesn't exist.
        SABNZBD_KEY = None

    # ── Tautulli (auto-wires to Plex via PlexOnlineToken from Preferences.xml) ─
    #
    # Read the Plex token up front — same value Tautulli wants for its
    # PMS config and Seerr wants for its first-run auth. One filesystem
    # read shared between the two.

    plex_token = None
    if is_enabled(env, 'ENABLE_PLEX'):
        PLEX_PREFS = f"{B}/plex/config/Library/Application Support/Plex Media Server/Preferences.xml"
        TAUTULLI_INI = f"{B}/tautulli/config/config.ini"
        try:
            plex_token = read_plex_prefs(PLEX_PREFS).get('PlexOnlineToken')
        except Exception:
            plex_token = None
        # Set Manual Port Mapping in Plex so Plex.tv stops routing
        # clients through the Relay. Runs BEFORE Tautulli's config
        # write so that if Plex is still warming up, we get a clean
        # error here rather than a corrupted Tautulli config.
        configure_plex_remote_access(LAN_IP, plex_token)
        configure_tautulli(B, PLEX_PREFS, TAUTULLI_INI)
    else:
        section("Tautulli")
        print(f"  {DIM}⏭  ENABLE_PLEX=false — Tautulli not deployed.{RESET}")

    # ── Sonarr ────────────────────────────────────────────────────────────────

    section("Sonarr")
    if not is_enabled(env, 'ENABLE_SONARR'):
        print(f"  {DIM}⏭  ENABLE_SONARR=false — skipping.{RESET}")
        SONARR_KEY = None  # so Prowlarr / Bazarr below know not to wire it
    elif not SONARR_KEY:
        fail("API key not found — is the container running?")
    elif wait_ready("Sonarr", SONARR, SONARR_KEY, "/api/v3/system/status"):
        add_root_folder(SONARR, SONARR_KEY, "api/v3", "/data/Media/TV Shows", container="sonarr")
        add_root_folder(SONARR, SONARR_KEY, "api/v3", "/data/Media/Anime/TV Shows", container="sonarr")
        # Download clients + remote-path-mappings are only useful when
        # their target service is in the stack. Adding a qBittorrent
        # download client when ENABLE_QBITTORRENT=false would leave
        # Sonarr with a phantom downloader pointing at gluetun:49156
        # (nonexistent host) — the UI badge would go red and Sonarr
        # would log connection errors every 15s. Same trap for
        # SABnzbd when ENABLE_SABNZBD=false (caught indirectly by
        # SABNZBD_KEY being blanked, but make the gate explicit).
        if is_enabled(env, 'ENABLE_QBITTORRENT'):
            add_download_client(SONARR, SONARR_KEY, "api/v3", "qBittorrent", "QBittorrent", {
                "host": QB_HOST, "port": QB_PORT, "useSsl": False,
                "username": QB_USER, "password": QB_PASS, "category": "tv-sonarr",
            })
            add_remote_path_mapping(SONARR, SONARR_KEY, "api/v3",
                                    QB_HOST, "/downloads", "/data/Downloads/Torrents",
                                    container="sonarr")
        if is_enabled(env, 'ENABLE_SABNZBD') and SABNZBD_KEY:
            add_download_client(SONARR, SONARR_KEY, "api/v3", "SABnzbd", "Sabnzbd", {
                "host": "sabnzbd", "port": 8080, "useSsl": False,
                "apiKey": SABNZBD_KEY, "category": "tv",
            })
            add_remote_path_mapping(SONARR, SONARR_KEY, "api/v3",
                                    "sabnzbd", "/data/complete", "/data/Downloads/Usenet/complete",
                                    container="sonarr")
        elif is_enabled(env, 'ENABLE_SABNZBD') and not SABNZBD_KEY:
            warn("SABnzbd key not found — skipping")
        configure_media_management(SONARR, SONARR_KEY, "api/v3", recycle_label="sonarr")
        configure_bind_address(SONARR, SONARR_KEY, "api/v3")
        # Plex Connect notification — fires partial-scans the moment a
        # file is imported. Combined with configure_plex_remote_access's
        # ScheduledLibraryUpdatesEnabled=0 this means Plex sees new
        # content fast without scheduled-scan I/O.
        if is_enabled(env, 'ENABLE_PLEX'):
            configure_plex_notification(SONARR, SONARR_KEY, "api/v3", plex_token, on_episode_file=True)
        if ARR_USER and ARR_PASS:
            configure_auth(SONARR, SONARR_KEY, "api/v3", ARR_USER, ARR_PASS)

    # ── Radarr ────────────────────────────────────────────────────────────────

    section("Radarr")
    if not is_enabled(env, 'ENABLE_RADARR'):
        print(f"  {DIM}⏭  ENABLE_RADARR=false — skipping.{RESET}")
        RADARR_KEY = None  # so Prowlarr / Bazarr below know not to wire it
    elif not RADARR_KEY:
        fail("API key not found — is the container running?")
    elif wait_ready("Radarr", RADARR, RADARR_KEY, "/api/v3/system/status"):
        add_root_folder(RADARR, RADARR_KEY, "api/v3", "/data/Media/Movies", container="radarr")
        add_root_folder(RADARR, RADARR_KEY, "api/v3", "/data/Media/Anime/Movies", container="radarr")
        # See Sonarr block for why these are gated on ENABLE_*.
        if is_enabled(env, 'ENABLE_QBITTORRENT'):
            add_download_client(RADARR, RADARR_KEY, "api/v3", "qBittorrent", "QBittorrent", {
                "host": QB_HOST, "port": QB_PORT, "useSsl": False,
                "username": QB_USER, "password": QB_PASS, "category": "radarr",
            })
            add_remote_path_mapping(RADARR, RADARR_KEY, "api/v3",
                                    QB_HOST, "/downloads", "/data/Downloads/Torrents",
                                    container="radarr")
        if is_enabled(env, 'ENABLE_SABNZBD') and SABNZBD_KEY:
            add_download_client(RADARR, RADARR_KEY, "api/v3", "SABnzbd", "Sabnzbd", {
                "host": "sabnzbd", "port": 8080, "useSsl": False,
                "apiKey": SABNZBD_KEY, "category": "movies",
            })
            add_remote_path_mapping(RADARR, RADARR_KEY, "api/v3",
                                    "sabnzbd", "/data/complete", "/data/Downloads/Usenet/complete",
                                    container="radarr")
        elif is_enabled(env, 'ENABLE_SABNZBD') and not SABNZBD_KEY:
            warn("SABnzbd key not found — skipping")
        configure_media_management(RADARR, RADARR_KEY, "api/v3", recycle_label="radarr")
        configure_bind_address(RADARR, RADARR_KEY, "api/v3")
        # Plex Connect notification — same rationale as Sonarr block above.
        if is_enabled(env, 'ENABLE_PLEX'):
            configure_plex_notification(RADARR, RADARR_KEY, "api/v3", plex_token, on_episode_file=False)
        if ARR_USER and ARR_PASS:
            configure_auth(RADARR, RADARR_KEY, "api/v3", ARR_USER, ARR_PASS)

    # ── Lidarr ────────────────────────────────────────────────────────────────

    section("Lidarr")
    if not is_enabled(env, 'ENABLE_LIDARR'):
        print(f"  {DIM}⏭  ENABLE_LIDARR=false — skipping.{RESET}")
        LIDARR_KEY = None  # so Prowlarr below knows not to wire it
    elif not LIDARR_KEY:
        fail("API key not found — is the container running?")
    elif wait_ready("Lidarr", LIDARR, LIDARR_KEY, "/api/v1/system/status"):
        # Lidarr's API answers /system/status well before its DB has
        # inserted the default quality + metadata profiles (Sonarr and
        # Radarr also lazy-init these, but Lidarr is noticeably slower
        # on first run — 30s was previously not enough on Synology
        # spinning rust). Two-pronged approach:
        #   1. Hit several Lidarr endpoints first so any lazy-init they
        #      trigger (e.g. metadata profiles get created on first
        #      access in some Lidarr versions) is kicked off.
        #   2. Poll for up to 2 minutes (24×5s) instead of 30s.
        # If profiles STILL haven't appeared after 2 minutes the user
        # almost certainly needs to visit the UI once — surface the
        # actionable hint then.
        for warmup in ("/api/v1/qualityprofile", "/api/v1/metadataprofile",
                       "/api/v1/customformat", "/api/v1/indexer"):
            GET(LIDARR, LIDARR_KEY, warmup)  # ignore results, just touch them
        lidarr_quality_id = None
        lidarr_meta_id    = None
        for attempt in range(24):  # up to ~120s
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
                if attempt > 0:
                    print(f"    Lidarr profiles appeared after {attempt * 5}s.")
                break
            time.sleep(5)
        if lidarr_quality_id is None or lidarr_meta_id is None:
            fail("Lidarr: quality/metadata profiles not available after 2 min — "
                 "open http://<NAS>:49154 once to let Lidarr finish first-run "
                 "setup, then re-run setup.sh. (Lidarr sometimes needs a UI "
                 "visit to seed its defaults on Synology.)")
        else:
            add_root_folder(LIDARR, LIDARR_KEY, "api/v1", "/data/Media/Music", {
                "defaultQualityProfileId":  lidarr_quality_id,
                "defaultMetadataProfileId": lidarr_meta_id,
            }, container="lidarr")
        # See Sonarr block for why these are gated on ENABLE_*.
        if is_enabled(env, 'ENABLE_QBITTORRENT'):
            add_download_client(LIDARR, LIDARR_KEY, "api/v1", "qBittorrent", "QBittorrent", {
                "host": QB_HOST, "port": QB_PORT, "useSsl": False,
                "username": QB_USER, "password": QB_PASS, "category": "lidarr",
            })
            add_remote_path_mapping(LIDARR, LIDARR_KEY, "api/v1",
                                    QB_HOST, "/downloads", "/data/Downloads/Torrents",
                                    container="lidarr")
        if is_enabled(env, 'ENABLE_SABNZBD') and SABNZBD_KEY:
            add_download_client(LIDARR, LIDARR_KEY, "api/v1", "SABnzbd", "Sabnzbd", {
                "host": "sabnzbd", "port": 8080, "useSsl": False,
                "apiKey": SABNZBD_KEY, "category": "music",
            })
            add_remote_path_mapping(LIDARR, LIDARR_KEY, "api/v1",
                                    "sabnzbd", "/data/complete", "/data/Downloads/Usenet/complete",
                                    container="lidarr")
        elif is_enabled(env, 'ENABLE_SABNZBD') and not SABNZBD_KEY:
            warn("SABnzbd key not found — skipping")
        configure_media_management(LIDARR, LIDARR_KEY, "api/v1", recycle_label="lidarr")
        configure_bind_address(LIDARR, LIDARR_KEY, "api/v1")
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
        # Prowlarr doesn't have a /config/mediamanagement endpoint
        # (no media files of its own), but it DOES have the same Bind
        # Address pitfall as the arrs — Sync Apps tests fail if
        # bindAddress is 127.0.0.1 because the wizard's verify call
        # hits the container's loopback, not the host's.
        configure_bind_address(PROWLARR, PROWLARR_KEY, "api/v1")
        if ARR_USER and ARR_PASS:
            configure_auth(PROWLARR, PROWLARR_KEY, "api/v1", ARR_USER, ARR_PASS)

    # ── qBittorrent ───────────────────────────────────────────────────────────

    if is_enabled(env, 'ENABLE_QBITTORRENT'):
        # Pass env in so the gluetun-aware restart path can see
        # VPN_ENABLED + INSTALL_DIR (read from .env, not the process
        # environment — setup.sh doesn't export them).
        configure_qbittorrent(QBIT, QB_USER, QB_PASS, env=env)
    else:
        section("qBittorrent")
        print(f"  {DIM}⏭  ENABLE_QBITTORRENT=false — skipping.{RESET}")

    # ── Bazarr ────────────────────────────────────────────────────────────────

    if is_enabled(env, 'ENABLE_BAZARR'):
        configure_bazarr(BAZARR, BAZARR_KEY, SONARR_KEY, RADARR_KEY,
                         f"{B}/bazarr/config",
                         username=ARR_USER or None, password=ARR_PASS or None)
    else:
        section("Bazarr")
        print(f"  {DIM}⏭  ENABLE_BAZARR=false — skipping.{RESET}")

    # ── Seerr ─────────────────────────────────────────────────────────────────

    if is_enabled(env, 'ENABLE_PLEX'):
        # Seerr ships as part of the Plex stack — pointless without Plex
        # (it's a Plex request system). Gated on ENABLE_PLEX rather than
        # a separate flag.
        #
        # Pass the Plex token so configure_seerr can auto-complete the
        # first-run wizard if it hasn't been done in-browser yet. Without
        # the token Seerr's API returns 403 on every settings endpoint
        # and the user has to click through the wizard manually.
        configure_seerr(SEERR, SEERR_KEY, SONARR, SONARR_KEY, RADARR, RADARR_KEY,
                        plex_token=plex_token)
    else:
        section("Seerr")
        print(f"  {DIM}⏭  ENABLE_PLEX=false — Seerr not deployed.{RESET}")

    # ── Config files ──────────────────────────────────────────────────────────

    section("Unpackerr")
    if is_enabled(env, 'ENABLE_UNPACKERR'):
        # write_config_file is idempotent — it skips if the file already
        # exists and returns no signal. Track whether we actually wrote
        # the conf in this run by checking file mtime before vs after,
        # so we only need to restart the container when fresh config
        # actually lands.
        conf_path = f"{B}/unpackerr/config/unpackerr.conf"
        before_mtime = os.path.getmtime(conf_path) if os.path.exists(conf_path) else 0
        # Lidarr block included only when we actually have a real key
        # AND Lidarr is enabled — avoids the 401-spam from a stub.
        lidarr_block = ''
        if LIDARR_KEY and is_enabled(env, 'ENABLE_LIDARR'):
            lidarr_block = UNPACKERR_LIDARR_BLOCK.format(lidarr_key=LIDARR_KEY)
        write_config_file("Unpackerr",
            conf_path,
            UNPACKERR_CONF.format(
                sonarr_key=SONARR_KEY or 'REPLACE_WITH_SONARR_KEY',
                radarr_key=RADARR_KEY or 'REPLACE_WITH_RADARR_KEY',
                lidarr_block=lidarr_block,
            ))
        after_mtime = os.path.getmtime(conf_path) if os.path.exists(conf_path) else 0
        if (SONARR_KEY or RADARR_KEY) and after_mtime > before_mtime:
            # Auto-restart unpackerr so it picks up the new conf + API
            # keys without the user manually running docker compose
            # restart. unpackerr re-reads its conf on boot only, so a
            # config file written after the container is up has no
            # effect until restart. Previously this was a warn telling
            # the user to do the restart themselves — now it just happens.
            try:
                subprocess.run(['docker', 'restart', 'unpackerr'],
                               capture_output=True, timeout=30, text=True)
                ok("Unpackerr restarted to pick up the new keys")
            except Exception as e:
                info(f"Couldn't auto-restart unpackerr ({e}) — manually: docker compose restart unpackerr")
    else:
        print(f"  {DIM}⏭  ENABLE_UNPACKERR=false — skipping.{RESET}")

    section("Recyclarr")
    if is_enabled(env, 'ENABLE_RECYCLARR'):
        recyclarr_yml = f"{B}/recyclarr/config/recyclarr.yml"
        # write_config_file is idempotent — skips when the file exists.
        # That's right for user customisations, but it ALSO means an
        # older wizard's recyclarr.yml with stale base_url / api_key
        # values persists forever. Common case: a previous install
        # wrote http://localhost:8989 (which doesn't resolve from
        # inside the recyclarr container), and the user's been
        # seeing "Connection failed - check your base_url" ever since.
        # Detect that specifically + force-rewrite when we find a
        # broken-by-design URL we know we'd never produce.
        wants_force = False
        if os.path.exists(recyclarr_yml):
            try:
                with open(recyclarr_yml, 'r') as f:
                    body = f.read()
                bad_url_signs = (
                    'localhost:', '127.0.0.1:',
                    '://0.0.0.0', 'REPLACE_WITH_',
                )
                if any(s in body for s in bad_url_signs):
                    wants_force = True
                    info("Existing recyclarr.yml has non-container URLs (likely from an older "
                         "wizard or hand-edit) — refreshing it to use http://sonarr:8989 / "
                         "http://radarr:7878 inside the container's docker network.")
                # Also rewrite if the keys are still REPLACE_WITH placeholders
                # (means the previous run had no api keys at write-time).
                if SONARR_KEY and 'REPLACE_WITH_SONARR_KEY' in body:
                    wants_force = True
                if RADARR_KEY and 'REPLACE_WITH_RADARR_KEY' in body:
                    wants_force = True
            except Exception:
                pass
        # Read the user's TRaSH profile picks from .env (set by the
        # wizard's Configure screen). Default to the most common TRaSH
        # picks if missing — pre-flag profiles get sensible behaviour
        # without forcing the user to re-run the wizard.
        sonarr_profile = env.get('TRASH_SONARR_PROFILE', '').strip() or 'web-1080p'
        radarr_profile = env.get('TRASH_RADARR_PROFILE', '').strip() or 'hd-bluray-web'
        # render_recyclarr_config decides per-arr whether to write a
        # real `include:` block (when we have an API key) or just a
        # commented-out placeholder. Either way it returns a complete
        # file body.
        rendered = render_recyclarr_config(
            SONARR_KEY or 'REPLACE_WITH_SONARR_KEY',
            RADARR_KEY or 'REPLACE_WITH_RADARR_KEY',
            sonarr_profile, radarr_profile,
        )
        # Also force-rewrite when the rendered TRaSH profile recipe
        # doesn't match what's currently on disk. Users changing their
        # picks via the wizard would otherwise see "skipped — already
        # exists" and wonder why nothing changed.
        if os.path.exists(recyclarr_yml) and not wants_force:
            try:
                with open(recyclarr_yml, 'r') as f:
                    current = f.read()
                # Cheap heuristic: if the recipe templates we'd write
                # are NOT all already present in the file, we need to
                # rewrite. Avoids unnecessary churn on already-correct
                # files (which would clobber any user hand-edits to the
                # `include:` block).
                expected_tpls = (
                    SONARR_PROFILE_RECIPES.get(sonarr_profile, [])
                    + RADARR_PROFILE_RECIPES.get(radarr_profile, [])
                )
                if any(tpl not in current for tpl in expected_tpls):
                    wants_force = True
                    info(f"TRaSH profile picks changed — refreshing recyclarr.yml "
                         f"(sonarr={sonarr_profile}, radarr={radarr_profile}).")
            except Exception:
                pass
        if wants_force:
            # Use overwrite_config_file (the existing helper that DOES
            # overwrite). Backup the user's file first in case they
            # customised it.
            try:
                ts = time.strftime('%Y%m%d-%H%M%S')
                bak = f"{recyclarr_yml}.before-mediarr-{ts}.bak"
                import shutil as _shutil
                _shutil.copy(recyclarr_yml, bak)
                info(f"  Backed up your previous recyclarr.yml → {bak}")
            except Exception:
                pass
            overwrite_config_file("Recyclarr", recyclarr_yml, rendered)
        else:
            write_config_file("Recyclarr", recyclarr_yml, rendered)
        # Auto-run an initial sync if we have real keys to talk to the
        # arrs. The shipped recyclarr.yml has the TRaSH Guide defaults
        # (HD-1080p quality profile + standard custom formats), so a
        # zero-customisation sync still produces useful results. Power
        # users editing recyclarr.yml afterwards can re-run sync any
        # time. Skipped when SONARR_KEY + RADARR_KEY are both missing
        # (likely a disabled-arrs install) — nothing to sync into.
        if SONARR_KEY or RADARR_KEY:
            import subprocess
            def run_recyclarr_sync():
                # `docker exec recyclarr recyclarr sync` runs inside the
                # container we just started. Container's --network points
                # at the same media network the arrs live on, so the
                # http://sonarr:8989 / http://radarr:7878 URLs in
                # recyclarr.yml resolve. Capture output and return the
                # CompletedProcess for caller to handle.
                return subprocess.run(
                    ['docker', 'exec', 'recyclarr', 'recyclarr', 'sync'],
                    capture_output=True, timeout=120, text=True,
                )
            try:
                r = run_recyclarr_sync()
                # First-sync flakes are common — recyclarr starts before
                # sonarr/radarr have finished their first-run init, and
                # gets a TCP connect or HTTP 503 from the API. Retry
                # once after a 20s settle in that case. Real-world log:
                #   "[series] Connection failed - check your base_url"
                # which is recyclarr's wording for "couldn't talk to the
                # arr at all", almost always a timing race.
                if r.returncode != 0:
                    err_lower = ((r.stderr or '') + (r.stdout or '')).lower()
                    if 'connection failed' in err_lower or 'connection refused' in err_lower:
                        print("    Recyclarr sync hit a connection failure — retrying once after 20s...")
                        time.sleep(20)
                        r = run_recyclarr_sync()
                if r.returncode == 0:
                    ok("Recyclarr initial sync ran — TRaSH Guide profiles applied")
                    AUTOMATED['recyclarr_synced'] = True
                    # Write a last-sync timestamp file so dashboards
                    # (Homepage's customapi widget) and the recyclarr-
                    # sync.sh helper can surface "last synced N hours
                    # ago" — useful for trusting the weekly cron is
                    # actually running. We don't depend on a status
                    # endpoint because recyclarr doesn't expose one;
                    # plain text file in /config does the job.
                    try:
                        ts_path = f"{B}/recyclarr/config/.last-sync"
                        with open(ts_path, 'w') as tsf:
                            tsf.write(time.strftime('%Y-%m-%dT%H:%M:%S%z') + '\n')
                            tsf.write(f"sonarr_profile={sonarr_profile}\n")
                            tsf.write(f"radarr_profile={radarr_profile}\n")
                    except Exception:
                        # Best-effort — don't fail the install if we
                        # can't write the timestamp.
                        pass
                else:
                    # Demoted from warn to info: a failed first-sync isn't
                    # an install-blocking error. The conf is on disk, the
                    # container is running, and `docker exec recyclarr
                    # recyclarr sync` works any time the user wants to
                    # retry (e.g. after editing the YAML to enable the
                    # TRaSH includes). Surfacing it as a warn put it in
                    # the wizard's issues panel and made the install
                    # feel broken when it wasn't.
                    info(f"Recyclarr sync returned rc={r.returncode} — config is on disk; re-run any time:")
                    info(f"  docker exec recyclarr recyclarr sync")
                    # Surface a useful diagnostic. recyclarr's output is
                    # heavily decorated with Unicode box-drawing chars
                    # (╭ ─ ╮ │ ╰ ╯) that aren't actionable on their own —
                    # the FIRST run was emitting "Last line: ╰─────╯"
                    # which gave the user zero signal. Filter to the
                    # last ~5 lines that contain real text + an error
                    # marker if any, and print up to 3 of them.
                    raw = (r.stderr or r.stdout or '').splitlines()
                    meaningful = []
                    for line in raw:
                        # Strip box-drawing chars + whitespace; skip if
                        # nothing alphanumeric is left.
                        stripped = ''.join(c for c in line if c.isascii() or c.isalnum())
                        clean = stripped.strip(' │─╭╮╰╯|')
                        if not clean:
                            continue
                        # Prefer lines with error-y keywords
                        meaningful.append(line.rstrip())
                    # Show last 3 meaningful lines so user sees real
                    # context, not just the closing border.
                    for line in meaningful[-3:]:
                        info(f"  {line[:160]}")
            except subprocess.TimeoutExpired:
                warn("Recyclarr sync timed out (>120s) — check the container manually")
                warn("  docker logs recyclarr  /  docker exec recyclarr recyclarr sync")
            except FileNotFoundError:
                warn("docker not in PATH — run manually: docker exec recyclarr recyclarr sync")
            except Exception as e:
                warn(f"Recyclarr sync errored ({e}) — run manually:")
                warn("  docker exec recyclarr recyclarr sync")
    else:
        print(f"  {DIM}⏭  ENABLE_RECYCLARR=false — skipping.{RESET}")

    section("Homepage Dashboard")
    if not is_enabled(env, 'ENABLE_HOMEPAGE'):
        print(f"  {DIM}⏭  ENABLE_HOMEPAGE=false — skipping.{RESET}")
    else:
        homepage_cfg = f"{B}/homepage/config"
        # Render services + settings dynamically against the ENABLE_*
        # flags. The previous template was a static full-bundle YAML
        # that listed every service unconditionally — disabled-service
        # rows then showed red siteMonitor badges on the dashboard
        # because Homepage couldn't reach the containers (they weren't
        # in the active compose profile set). Now: only enabled
        # services appear; only the matching layout sections exist.
        # services.yaml + settings.yaml are FULLY generated from the
        # user's ENABLE_* picks every run. Use overwrite_config_file —
        # the older code used write_config_file (skip-if-exists), which
        # meant any change to ENABLE_* / TRASH_* flags after the first
        # install never reflected on the dashboard. Real-world symptom:
        # users enabling Recyclarr after a prior install never saw the
        # Maintenance tile because the older services.yaml didn't have
        # the Maintenance section to begin with, and the write got
        # silently skipped on the re-run.
        #
        # widgets.yaml is static (just a datetime + search widget) so
        # write_config_file (skip-if-exists) is still correct there —
        # the user may have customised it and we don't want to clobber.
        overwrite_config_file("Homepage services",
            f"{homepage_cfg}/services.yaml",
            render_homepage_services(env, LAN_IP))
        overwrite_config_file("Homepage settings",
            f"{homepage_cfg}/settings.yaml",
            render_homepage_settings(env))
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

    # Build the "still needs manual setup" list dynamically — only show
    # items that DIDN'T get automated during this run. Pre-flexibility-
    # pass we printed the full 5-item list every time, including for
    # services we'd just auto-configured in the same install (the user's
    # log showed "✔ Usenet provider added" followed by "• SABnzbd → add
    # usenet provider" in the manual list, which is contradictory and
    # erodes trust). Each line below pairs with one AUTOMATED flag;
    # filtered out when the matching flag is True. Plex-stack lines also
    # filter when ENABLE_PLEX is false.
    plex_on    = is_enabled(env, 'ENABLE_PLEX')
    sab_on     = is_enabled(env, 'ENABLE_SABNZBD')
    qbit_on    = is_enabled(env, 'ENABLE_QBITTORRENT')
    recy_on    = is_enabled(env, 'ENABLE_RECYCLARR')

    pending = []
    if sab_on and not AUTOMATED['sab_provider']:
        pending.append(f"  • SABnzbd     http://{LAN_IP}:49155  → Config → Servers → add usenet provider")
    if plex_on and not AUTOMATED['seerr_wizard']:
        pending.append(f"  • Seerr       http://{LAN_IP}:5056   → complete setup wizard, then re-run script")
    if plex_on and not AUTOMATED['tautulli_token']:
        pending.append(f"  • Tautulli    http://{LAN_IP}:8181   → connect Plex (needs your Plex token)")
    if recy_on and not AUTOMATED['recyclarr_synced']:
        pending.append(f"  • Recyclarr   customise recyclarr.yml then: docker exec recyclarr recyclarr sync")
    if qbit_on and not AUTOMATED['qbit_prefs']:
        pending.append(f"  • qBittorrent http://{LAN_IP}:49156  → Settings → BitTorrent → set seeding limits")

    if pending:
        print("\n  Still needs manual setup:")
        for line in pending:
            print(line)
        print()
    else:
        print(f"\n  {GREEN}Everything's wired up — no manual steps required.{RESET}\n")
    print('═' * 52)
    sys.exit(0 if errors == 0 else 1)


def homepage_only_main():
    """Regenerate Homepage's services.yaml + settings.yaml from .env
    without re-running every arr's API configuration. Used by the
    installer's Update screen "Refresh dashboard" action — fast
    (<1s vs 60-120s for full main()) and side-effect-free against
    the running arrs.

    Uses overwrite_config_file (open(w) truncates + writes in one
    syscall) so the file is never observably-absent — earlier versions
    did an rm + overwrite, which opened a window where Homepage's file
    watcher could see services.yaml gone and trigger its own "no
    services configured → write a default sample" fallback BEFORE
    Python finished rewriting. Result was the user staring at a
    Homepage default template that had clobbered our content.

    After writing, restart the Homepage container so it definitely
    picks up the new layout — its hot-reload watcher is flaky on
    Synology bind mounts. The restart is best-effort; if docker isn't
    available we just emit a hint and exit cleanly.

    widgets.yaml stays whatever the user set it to — that file is for
    the datetime + search widgets and isn't generated from .env.
    """
    script_dir = os.path.dirname(os.path.realpath(__file__))
    env        = read_env_merged(script_dir)
    LAN_IP     = env.get('LAN_IP', '')
    if not LAN_IP:
        print("Error: LAN_IP not set in .env")
        sys.exit(1)
    if not is_enabled(env, 'ENABLE_HOMEPAGE'):
        print("ENABLE_HOMEPAGE=false in .env — nothing to regenerate.")
        sys.exit(0)

    section("Homepage refresh")
    homepage_cfg = f"{script_dir}/homepage/config"
    services_yml = f"{homepage_cfg}/services.yaml"
    settings_yml = f"{homepage_cfg}/settings.yaml"

    # Render first, then write — fails loud if rendering itself errors.
    # No rm step (see docstring): overwrite_config_file's open(w) +
    # write is atomic enough that Homepage's watcher doesn't see an
    # absent file in between.
    services_body = render_homepage_services(env, LAN_IP)
    settings_body = render_homepage_settings(env)
    print(f"    services.yaml: {len(services_body)} bytes, "
          f"{services_body.count(chr(10)) + 1} lines")
    print(f"    settings.yaml: {len(settings_body)} bytes")
    overwrite_config_file("Homepage services", services_yml, services_body)
    overwrite_config_file("Homepage settings", settings_yml, settings_body)

    # Restart Homepage so it definitely picks up the new layout —
    # its hot-reload watcher is unreliable on Synology bind mounts.
    # Best-effort: if docker isn't on PATH or the container isn't
    # named 'homepage', we skip with a hint rather than failing.
    print("    Restarting homepage container to pick up new layout...")
    import subprocess
    try:
        r = subprocess.run(
            ['docker', 'restart', 'homepage'],
            capture_output=True, timeout=30, text=True,
        )
        if r.returncode == 0:
            ok("Homepage restarted — refresh http://<NAS>:3000 to see the new tiles.")
        else:
            warn(f"docker restart homepage failed: {(r.stderr or '').strip()[:200]}")
            warn("  Refresh manually:  docker restart homepage")
    except FileNotFoundError:
        warn("docker not in PATH — restart Homepage manually:")
        warn("  docker restart homepage")
    except subprocess.TimeoutExpired:
        warn("Homepage restart timed out after 30s — try manually:")
        warn("  docker restart homepage")


if __name__ == '__main__':
    # Tiny CLI dispatch — no argparse needed for one flag. Anything
    # else falls through to the full main().
    if '--homepage-only' in sys.argv:
        homepage_only_main()
    else:
        main()
