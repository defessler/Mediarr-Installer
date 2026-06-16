#!/usr/bin/env python3
"""
Tiny webhook server backing the Recyclarr tile on the Homepage dashboard.

This file runs in its own little Python:alpine container next to Recyclarr
and exposes a single one-page web UI:

  GET  /          → Recyclarr status page (last sync time, current
                    profiles, profile pickers, Sync Now button, recent
                    output if any). Recyclarr itself is a CLI tool with
                    no web UI, hence this sidecar.
  POST /sync      → runs `docker exec recyclarr recyclarr sync` (via the
                    mounted docker socket), captures output, re-renders.
  POST /profile   → updates TRASH_SONARR_PROFILE / TRASH_RADARR_PROFILE
                    in .env, regenerates recyclarr.yml by exec'ing
                    `python3 setup-arr-config.py --recyclarr-only`, then
                    falls through to a sync. Single call from the form.

The container is named `recyclarr-trigger` (was once "stack-ops trigger"
back when it also hosted /pull image-updater endpoints — those were
removed because the post-pull `compose up -d` cascaded gluetun recreates
into qBittorrent network-namespace breakage and there was no clean
rollback for `:latest`-tag breakage either). Rename would orphan
existing containers on `docker compose up -d`, hence the legacy name.

Volumes mounted by docker-compose.yml:
  /var/run/docker.sock                  (rw)  — docker exec recyclarr sync
  ${INSTALL_DIR}/recyclarr/config       (ro)  — read .last-sync stamp
  ${INSTALL_DIR}/recyclarr-trigger.py   (ro)  — this file
  ${INSTALL_DIR}                        (rw)  — write .env + regenerate
                                                recyclarr.yml in place

Security note: anyone on the LAN can hit POST /sync or /profile. The
"attack" surface for /sync is they trigger a no-op idempotent sync.
For /profile it's they swap your TRaSH profile to a different valid
pick — annoying but trivially reversible from the same page. Coarse
in-process locks prevent parallel-request trampling. CSRF protection
(Origin / Host match) closes the cross-origin browser vector. This is
a home-LAN tool, not exposed to the internet.
"""

from http.server import BaseHTTPRequestHandler, HTTPServer
import html
import http.client
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse

# Where the .last-sync stamp file lives, AS SEEN INSIDE THIS CONTAINER.
# docker-compose mounts the recyclarr container's /config dir read-only
# at /recyclarr-config here, so the stamp configure_recyclarr() writes
# (and recyclarr-sync.sh refreshes) is visible.
STAMP_FILE = '/recyclarr-config/.last-sync'

# Install dir mounted writable at /install-dir so we can update .env
# and re-run setup-arr-config.py --recyclarr-only when the user picks
# a different profile.
#
# v0.3.22 moved setup-arr-config.py under scripts/; v0.3.23 also moved
# .env into scripts/. Resolve both paths at runtime so we keep working
# under all three historical layouts:
#   - v0.3.23+: /install-dir/scripts/.env + /install-dir/scripts/setup-arr-config.py
#   - v0.3.22:  /install-dir/.env + /install-dir/scripts/setup-arr-config.py
#   - legacy:   /install-dir/.env + /install-dir/setup-arr-config.py
INSTALL_DIR = '/install-dir'


def _resolve_path(*candidates):
    """Return the first existing path from `candidates`, falling back to
    the last entry so callers get a stable string even when nothing
    exists yet (they handle the missing-file case themselves)."""
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[-1] if candidates else ''


def _env_file():
    return _resolve_path(
        f'{INSTALL_DIR}/scripts/.env',           # v0.3.23+
        f'{INSTALL_DIR}/.env',                   # legacy / v0.3.22
    )


def _setup_script():
    return _resolve_path(
        f'{INSTALL_DIR}/scripts/setup-arr-config.py',   # v0.3.22+
        f'{INSTALL_DIR}/setup-arr-config.py',           # legacy
    )


# Resolved once at module import. Each handler re-reads via the helpers
# if a path could change between requests (so far they're install-time
# stable).
ENV_FILE = _env_file()
SETUP_SCRIPT = _setup_script()

# Profile picks shown in the dropdowns. MUST match the recipes table in
# setup-arr-config.py (which is the source of truth) — when a new TRaSH
# profile is added there it needs to be added here too. If the user
# somehow submits an unknown value we reject it server-side rather than
# write garbage to .env.
SONARR_PROFILES = [
    ('web-1080p',    'WEB-1080p (most users)'),
    ('web-2160p',    'WEB-2160p (4K web)'),
    ('bluray-1080p', 'Bluray-1080p (better than WEB)'),
    ('bluray-2160p', 'Bluray-2160p (4K Bluray + REMUX)'),
    ('anime',        'Anime (anime-specific scoring)'),
]
RADARR_PROFILES = [
    ('hd-bluray-web',   'HD Bluray + WEB (default — most users)'),
    ('uhd-bluray-web',  'UHD Bluray + WEB (4K Bluray + web)'),
    ('remux-web-2160p', 'Remux + WEB 2160p (largest files)'),
    ('anime',           'Anime (anime-specific scoring)'),
]
SONARR_KEYS = {k for k, _ in SONARR_PROFILES}
RADARR_KEYS = {k for k, _ in RADARR_PROFILES}

# Single-flight lock: while a sync OR profile-change is in flight, any
# second request bounces with "wait a sec" rather than queuing.
# Recyclarr's sync is idempotent so even a queue would be safe, but
# changing .env mid-sync invites the kind of half-written file races
# we don't want to debug. Non-blocking acquire so the user sees an
# immediate "in progress" response instead of waiting.
SYNC_LOCK = threading.Lock()


PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recyclarr — TRaSH Sync</title>
<style>
* {{ box-sizing: border-box; }}
body {{
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: #0f172a; color: #e2e8f0;
  padding: 2rem 1rem; max-width: 800px; margin: 0 auto;
}}
h1 {{ font-weight: 600; color: #34d399; margin: 0 0 0.5rem 0; }}
.muted {{ color: #94a3b8; font-size: 0.875rem; }}
.card {{
  background: #1e293b; border: 1px solid #334155;
  border-radius: 0.5rem; padding: 1rem; margin: 1rem 0;
}}
.label {{
  color: #64748b; font-size: 0.7rem; text-transform: uppercase;
  letter-spacing: 0.05em; margin-bottom: 0.5rem;
}}
.row {{ display: flex; justify-content: space-between; gap: 1rem;
        padding: 0.25rem 0; align-items: center; }}
.row strong {{ font-weight: 500; }}
.field {{ display: flex; flex-direction: column; gap: 0.35rem;
          margin: 0.75rem 0; }}
.field label {{ font-size: 0.8rem; color: #94a3b8; }}
select {{
  background: #0b1220; color: #e2e8f0;
  border: 1px solid #334155; border-radius: 0.375rem;
  padding: 0.5rem 0.6rem; font: inherit; font-size: 0.9rem;
}}
select:focus {{ outline: 2px solid #34d399; outline-offset: 1px; }}
.actions {{ display: flex; gap: 0.75rem; flex-wrap: wrap;
            align-items: center; margin-top: 0.5rem; }}
button {{
  background: #10b981; color: white; border: none;
  padding: 0.875rem 1.75rem; font-size: 1rem; font-weight: 600;
  border-radius: 0.375rem; cursor: pointer;
  transition: background 0.15s ease;
}}
button.secondary {{ background: #334155; }}
button:hover  {{ background: #059669; }}
button.secondary:hover {{ background: #475569; }}
button:active {{ background: #047857; }}
button.secondary:active {{ background: #1e293b; }}
button:disabled {{ opacity: 0.5; cursor: not-allowed; }}
pre {{
  background: #0b1220; padding: 1rem; border-radius: 0.375rem;
  overflow: auto; font-size: 0.8125rem; line-height: 1.45;
  white-space: pre-wrap; word-wrap: break-word; max-height: 60vh;
}}
code {{
  background: #0b1220; padding: 0.125rem 0.375rem;
  border-radius: 0.25rem; font-size: 0.875em;
}}
.banner {{
  border-radius: 0.375rem; padding: 0.75rem 1rem;
  margin: 1rem 0; font-size: 0.9rem;
}}
.banner.ok {{ background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); color: #6ee7b7; }}
.banner.warn {{ background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); color: #fcd34d; }}
.banner.err {{ background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; }}
.hint {{ font-size: 0.8rem; color: #64748b; margin-top: 1.5rem;
         line-height: 1.6; }}
.grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }}
@media (max-width: 600px) {{ .grid {{ grid-template-columns: 1fr; }} }}
</style>
</head>
<body>
<h1>Recyclarr</h1>
<p class="muted">
  Syncs TRaSH Guide quality profiles + custom-format scoring into Sonarr + Radarr.
</p>

{banner}

<div class="card">
  <div class="label">Current state</div>
  <div class="row"><span>Last sync</span><strong>{last_sync}</strong></div>
  <div class="row"><span>Sonarr profile</span><strong><code>{sonarr_profile}</code></strong></div>
  <div class="row"><span>Radarr profile</span><strong><code>{radarr_profile}</code></strong></div>
</div>

<div class="card">
  <div class="label">Sync now (apply the current profile)</div>
  <form method="POST" action="/sync">
    <div class="actions">
      <button type="submit">Sync Now</button>
      <span class="muted">Runs <code>recyclarr sync</code> against Sonarr + Radarr.</span>
    </div>
  </form>
</div>

<div class="card">
  <div class="label">Change profile</div>
  <p class="muted" style="margin: 0 0 0.75rem 0">
    Picks the TRaSH Guide quality bundle Recyclarr applies. Saving rewrites
    <code>recyclarr.yml</code> and runs a sync in one go — no need to edit
    <code>.env</code> or re-run the installer.
  </p>
  <form method="POST" action="/profile">
    <div class="grid">
      <div class="field">
        <label for="sonarr">Sonarr profile</label>
        <select name="sonarr" id="sonarr">
{sonarr_options}
        </select>
      </div>
      <div class="field">
        <label for="radarr">Radarr profile</label>
        <select name="radarr" id="radarr">
{radarr_options}
        </select>
      </div>
    </div>
    <div class="actions">
      <button type="submit">Save profile &amp; sync</button>
      <span class="muted">Regenerates <code>recyclarr.yml</code>, then syncs.</span>
    </div>
  </form>
</div>

{output_section}

<p class="hint">
  Equivalent CLI: <code>docker exec recyclarr recyclarr sync</code> or
  <code>bash recyclarr-sync.sh</code> for sync; for profile changes the
  Configure screen in the installer also writes <code>.env</code> and
  runs <code>python3 setup-arr-config.py --recyclarr-only</code> on
  save. Schedule weekly sync via Synology Task Scheduler — see the
  in-app Help → Recyclarr.
</p>

</body>
</html>"""


def read_stamp():
    """Return (timestamp, sonarr_profile, radarr_profile) from .last-sync.
    Falls back gracefully when the stamp file doesn't exist (fresh install
    that hasn't synced yet) or has unexpected content."""
    if not os.path.exists(STAMP_FILE):
        return ('never (sync has not run yet)', 'unknown', 'unknown')
    try:
        with open(STAMP_FILE, encoding='utf-8') as f:
            lines = [ln.strip() for ln in f.read().splitlines() if ln.strip()]
        ts = lines[0] if lines else 'unknown'
        sp = 'unknown'
        rp = 'unknown'
        for ln in lines[1:]:
            if ln.startswith('sonarr_profile='):
                sp = ln.split('=', 1)[1]
            elif ln.startswith('radarr_profile='):
                rp = ln.split('=', 1)[1]
        return (ts, sp, rp)
    except Exception as e:
        return (f'(read error: {e})', '?', '?')


def read_env_profile_values():
    """Return (sonarr_profile, radarr_profile) by reading the live .env.
    Falls back to defaults (web-1080p / hd-bluray-web) when the keys
    aren't present — same defaults setup-arr-config.py uses. Returns
    sensible values even when .env can't be read (mount missing) so the
    page still renders rather than 500ing."""
    sp = ''
    rp = ''
    try:
        with open(ENV_FILE, encoding='utf-8') as f:
            for line in f:
                if line.startswith('TRASH_SONARR_PROFILE='):
                    sp = line.split('=', 1)[1].strip().strip('"').strip("'")
                elif line.startswith('TRASH_RADARR_PROFILE='):
                    rp = line.split('=', 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return (sp or 'web-1080p', rp or 'hd-bluray-web')


def render_options(profiles, current):
    """Build a string of <option> tags for a dropdown, marking the
    current pick as selected. Caller escapes via html.escape elsewhere;
    the values + labels here are constants from our own tables so
    they're safe."""
    out = []
    for value, label in profiles:
        sel = ' selected' if value == current else ''
        out.append(
            f'          <option value="{html.escape(value)}"{sel}>'
            f'{html.escape(label)}</option>'
        )
    return '\n'.join(out)


def render(banner_kind=None, banner_text=None, output=None):
    """Render the status page. `banner_*` shows a top-of-page status flash
    after a sync; `output` is the captured sync output (shown in a <pre>).

    Pulls the currently-applied profile from the .last-sync stamp (what
    Recyclarr last ran with), but pre-selects the dropdowns from .env
    (what the user has SET, which might differ between sync runs)."""
    ts, last_sp, last_rp = read_stamp()
    env_sp, env_rp = read_env_profile_values()
    banner_html = ''
    if banner_kind and banner_text:
        banner_html = f'<div class="banner {html.escape(banner_kind)}">{html.escape(banner_text)}</div>'
    output_html = ''
    if output:
        output_html = (
            '<div class="card">'
            '<div class="label">Output</div>'
            f'<pre>{html.escape(output)}</pre>'
            '</div>'
        )
    return PAGE.format(
        banner=banner_html,
        last_sync=html.escape(ts),
        # Show the LAST APPLIED profile in the "Current state" panel —
        # answers "what is actually live in Sonarr/Radarr right now."
        sonarr_profile=html.escape(last_sp),
        radarr_profile=html.escape(last_rp),
        # Pre-select the .env value in the dropdowns — answers "what
        # WILL apply on the next sync." They might differ if the user
        # has changed .env outside of a sync run.
        sonarr_options=render_options(SONARR_PROFILES, env_sp),
        radarr_options=render_options(RADARR_PROFILES, env_rp),
        output_section=output_html,
    )


def update_env_profiles(sonarr, radarr):
    """Rewrite TRASH_SONARR_PROFILE + TRASH_RADARR_PROFILE in .env in
    place. Appends a new line if the key is missing. Returns (ok, msg)
    where ok is True on success, msg is human-readable for the banner.

    Atomic write: render the full new body, then write+rename so a
    crash mid-write doesn't leave .env truncated."""
    if not os.path.exists(ENV_FILE):
        return (False, f'.env not found at {ENV_FILE} — is the install dir mounted?')
    try:
        with open(ENV_FILE, encoding='utf-8') as f:
            lines = f.readlines()
        updates = {
            'TRASH_SONARR_PROFILE': sonarr,
            'TRASH_RADARR_PROFILE': radarr,
        }
        seen = set()
        new_lines = []
        for ln in lines:
            stripped = ln.lstrip()
            replaced = False
            for key, val in updates.items():
                if stripped.startswith(f'{key}='):
                    new_lines.append(f'{key}={val}\n')
                    seen.add(key)
                    replaced = True
                    break
            if not replaced:
                new_lines.append(ln)
        # Append any keys that didn't exist yet.
        for key, val in updates.items():
            if key not in seen:
                if new_lines and not new_lines[-1].endswith('\n'):
                    new_lines.append('\n')
                new_lines.append(f'{key}={val}\n')
        # Atomic + secure write. .env holds every secret (VPN keys, qbit/slskd
        # passwords, all *arr/usenet API keys) and is deliberately 0600. A bare
        # open()+replace runs under this trigger container's root umask (022),
        # creating the temp 0644 and — because os.replace (rename(2)) repoints the
        # .env name to that new inode — silently downgrading the live secrets file
        # to world-readable. mkstemp creates the temp 0600, matching .env's intended
        # mode (and healing a prior 0644 downgrade); fsync + os.replace keep the
        # swap atomic. Mirrors setup-arr-config.py's set_env_value().
        d = os.path.dirname(ENV_FILE) or '.'
        fd, tmp = tempfile.mkstemp(dir=d, prefix='.env-', suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.writelines(new_lines)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, ENV_FILE)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return (True, '')
    except PermissionError as e:
        return (False, f'permission denied writing .env ({e}) — the trigger '
                       'container needs a writable mount on $INSTALL_DIR.')
    except Exception as e:
        return (False, f'failed to update .env: {e}')


def regenerate_recyclarr_yml():
    """Run `python3 setup-arr-config.py --recyclarr-only` inside this
    container. The script is mounted from the install dir + uses only
    stdlib so it runs fine on python:3-alpine. Returns (ok, output)."""
    if not os.path.exists(SETUP_SCRIPT):
        return (False, f'setup-arr-config.py not found at {SETUP_SCRIPT}')
    try:
        r = subprocess.run(
            ['python3', SETUP_SCRIPT, '--recyclarr-only'],
            capture_output=True, text=True, timeout=60,
            cwd=INSTALL_DIR,
        )
        out = (r.stdout or '') + (r.stderr or '')
        return (r.returncode == 0, out)
    except subprocess.TimeoutExpired:
        return (False, 'setup-arr-config.py --recyclarr-only timed out after 60s')
    except Exception as e:
        return (False, f'failed to run setup-arr-config.py: {e}')


# ── Docker API helper (UNIX socket → /var/run/docker.sock) ──────────
# Used by detect_daemon_api_version() to probe the daemon's max API
# version at startup so docker-cli pins to something the daemon speaks.
# Talking the engine API directly avoids the `docker` Python SDK (~5MB
# wheel + apk build delays on python:3-alpine) for a single GET /version.
class UnixHTTPConn(http.client.HTTPConnection):
    """Tiny adapter making http.client speak Docker's UNIX socket. The
    Docker engine API IS HTTP — just delivered over /var/run/docker.sock
    instead of a TCP port. Reusing http.client lets us avoid both the
    `requests` and `docker` packages (each ~5MB + wheel-build delays
    on python:3-alpine apk add). Caller manages the connection lifecycle
    and parses the response."""
    def __init__(self, timeout=10):
        super().__init__('localhost', timeout=timeout)
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def _ensure_recyclarr_settings_yml():
    """Make sure ${INSTALL_DIR}/recyclarr/config/settings.yml exists with
    the config-templates provider pinned to master.

    Background: Recyclarr v8.x defaults to checking out the `v8` branch
    of github.com/recyclarr/config-templates, which was reshaped in
    mid-May 2026 into a FULL-templates-only schema. The wizard's
    generated recyclarr.yml still uses granular includes
    (radarr-quality-definition-movie, etc.) that live only on the
    `master` branch now. Without a settings.yml that pins to master,
    every recyclarr sync exits with:
      [ERR] Unable to find include template with name
            'radarr-quality-definition-movie'

    setup-arr-config.py writes this same settings.yml at install time,
    but the user might hit Sync from the trigger's web UI BEFORE
    they've re-run a full install on the new wizard build — so we
    re-assert it from here as a belt-and-suspenders. Idempotent:
    skips when the file is already current. Returns True if the file
    is in the expected wizard-written state at exit, False on a
    write failure (sync will likely still fail with the template
    error in that case, but we don't make it worse)."""
    settings_path = '/install-dir/recyclarr/config/settings.yml'
    body = (
        '# Generated by Mediarr Installer (recyclarr-trigger)\n'
        '# Pins config-templates to master so the wizard\'s granular\n'
        '# include references (radarr-quality-definition-movie, etc.)\n'
        '# keep resolving under Recyclarr v8.x which prefers the v8\n'
        '# branch by default. Safe to delete if you migrate recyclarr.yml\n'
        '# to v8 full templates by hand.\n'
        'resource_providers:\n'
        '  - name: config-templates-master\n'
        '    type: config-templates\n'
        '    clone_url: https://github.com/recyclarr/config-templates.git\n'
        '    reference: master\n'
        '    replace_default: true\n'
    )
    try:
        existing = None
        if os.path.exists(settings_path):
            try:
                with open(settings_path, encoding='utf-8') as f:
                    existing = f.read()
            except Exception:
                pass
        # Skip writes if a HAND-CUSTOMISED settings.yml is in place
        # (anything without our marker header). The user clearly
        # knows what they're doing; we don't overwrite their config.
        if existing and 'Generated by Mediarr Installer' not in existing:
            return True
        if existing == body:
            return True
        os.makedirs(os.path.dirname(settings_path), exist_ok=True)
        with open(settings_path, 'w', encoding='utf-8') as f:
            f.write(body)
        return True
    except Exception as e:
        print(f'[sync] settings.yml write failed: {e}', flush=True)
        return False


def run_sync():
    """`docker exec recyclarr recyclarr sync`. Returns
    (status_kind, message, output) — status_kind one of ok/warn/err for
    the banner styling. Caller holds SYNC_LOCK; this function doesn't."""
    # Belt-and-suspenders settings.yml write so users who clicked Sync
    # before running the latest setup-arr-config.py still get a
    # working sync. Non-fatal on failure — recyclarr-trigger doesn't
    # control whether the user's stack has the new layout, just makes
    # sure that when it CAN write the file it does.
    _ensure_recyclarr_settings_yml()
    try:
        r = subprocess.run(
            ['docker', 'exec', 'recyclarr', 'recyclarr', 'sync'],
            capture_output=True, text=True, timeout=180,
        )
    except FileNotFoundError:
        return ('err',
                'docker CLI missing in trigger container — check the image '
                'entrypoint installed docker-cli.', '')
    except subprocess.TimeoutExpired:
        return ('err',
                'Sync timed out after 180s. Check `docker logs recyclarr` '
                'and Sonarr/Radarr API reachability.', '')
    out = (r.stdout or '') + (r.stderr or '')
    if r.returncode == 0:
        return ('ok', 'Sync completed — refresh Sonarr/Radarr Settings → Profiles to see updates.', out)
    return ('err', f'Sync failed (exit {r.returncode}). See output below.', out)


def run_profile_change(sonarr, radarr):
    """Validate, write .env, regenerate recyclarr.yml, then sync.
    Returns (status_kind, message, output) for the page render."""
    if sonarr not in SONARR_KEYS:
        return ('err', f'Unknown Sonarr profile "{sonarr}" — rejected.', '')
    if radarr not in RADARR_KEYS:
        return ('err', f'Unknown Radarr profile "{radarr}" — rejected.', '')

    ok_env, msg_env = update_env_profiles(sonarr, radarr)
    if not ok_env:
        return ('err', f'Could not save profile picks: {msg_env}', '')

    ok_regen, regen_out = regenerate_recyclarr_yml()
    if not ok_regen:
        return ('err',
                'Profile picks saved to .env but regenerating recyclarr.yml failed.',
                regen_out)

    sync_kind, sync_msg, sync_out = run_sync()
    combined = ''
    if regen_out:
        combined += '── recyclarr.yml regeneration ──\n' + regen_out + '\n\n'
    if sync_out:
        combined += '── recyclarr sync ──\n' + sync_out

    if sync_kind == 'ok':
        return ('ok',
                f'Saved profiles (Sonarr={sonarr}, Radarr={radarr}) and synced. '
                'Refresh Sonarr/Radarr Settings → Profiles to see updates.',
                combined)
    return (sync_kind,
            f'Saved profiles but sync reported a problem: {sync_msg}',
            combined)


class Handler(BaseHTTPRequestHandler):
    # Quieter — only emit failures to stderr; the default request-log spam
    # makes `docker logs recyclarr-trigger` hard to read for actual errors.
    def log_message(self, fmt, *args):
        pass

    def log_error(self, fmt, *args):
        super().log_message(fmt, *args)

    def _send_html(self, body, code=200):
        encoded = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path == '/':
            self._send_html(render())
            return
        self.send_error(404)

    def _check_csrf(self):
        """Minimal DNS-rebinding protection. The browser sends `Host:` and
        `Origin:` headers; we accept the request only when either is
        absent (curl / Homepage's tile click) or matches the same Host
        we see ourselves. Defeats malicious-tab-on-public-internet
        attacks that try to POST /sync via a victim's LAN browser. Not
        a hard auth boundary (anyone on LAN can still curl us) but
        closes the cross-origin browser vector at zero UX cost."""
        origin = self.headers.get('Origin', '')
        host = self.headers.get('Host', '')
        if not origin:
            return True
        try:
            from urllib.parse import urlparse
            origin_host = urlparse(origin).netloc
        except Exception:
            return False
        return origin_host == host

    def _read_form(self):
        """Parse application/x-www-form-urlencoded POST body. Returns
        a dict of first-value-per-key (form selects can't multi-select
        in this UI so single-value is right)."""
        length = int(self.headers.get('Content-Length', '0') or '0')
        if length <= 0 or length > 4096:  # tiny cap — our form is two keys
            return {}
        raw = self.rfile.read(length).decode('utf-8', errors='replace')
        parsed = urllib.parse.parse_qs(raw)
        return {k: v[0] for k, v in parsed.items() if v}

    def do_POST(self):
        if not self._check_csrf():
            self.send_error(403, "Cross-origin POST rejected (CSRF protection)")
            return

        if self.path == '/sync':
            if not SYNC_LOCK.acquire(blocking=False):
                self._send_html(render(
                    banner_kind='warn',
                    banner_text='Another sync is already in progress — try again in a moment.',
                ), code=409)
                return
            try:
                kind, msg, out = run_sync()
            finally:
                SYNC_LOCK.release()
            code = 200 if kind == 'ok' else (409 if kind == 'warn' else 500)
            self._send_html(render(banner_kind=kind, banner_text=msg, output=out), code=code)
            return

        if self.path == '/profile':
            if not SYNC_LOCK.acquire(blocking=False):
                self._send_html(render(
                    banner_kind='warn',
                    banner_text='Another sync is in progress — wait for it before changing the profile.',
                ), code=409)
                return
            try:
                form = self._read_form()
                sonarr = form.get('sonarr', '').strip()
                radarr = form.get('radarr', '').strip()
                if not sonarr or not radarr:
                    kind, msg, out = ('err',
                                      'Missing sonarr/radarr profile in form submission.', '')
                else:
                    kind, msg, out = run_profile_change(sonarr, radarr)
            finally:
                SYNC_LOCK.release()
            code = 200 if kind == 'ok' else (409 if kind == 'warn' else 500)
            self._send_html(render(banner_kind=kind, banner_text=msg, output=out), code=code)
            return

        self.send_error(404)


def detect_daemon_api_version():
    """Query the docker daemon's /version endpoint over its UNIX socket
    and return the highest API version IT supports. Used at startup to
    pin docker-cli to a version the daemon speaks.

    Why this is necessary: `apk add docker-cli` pulls the latest CLI
    (currently API 1.50+) which by default tries to negotiate using
    its own version. Synology's bundled Docker daemon on DSM 7 caps
    at API 1.43 — without pinning, every `docker exec` call inside
    this container fails with:

      "client version 1.52 is too new. Maximum supported API version
       is 1.43"

    By probing the daemon FIRST + setting DOCKER_API_VERSION in the
    environment we inherit through subprocess, every subsequent CLI
    call automatically uses a version the daemon accepts. Works on
    DSM 6 (API ~1.39), DSM 7 (1.43), and anything more recent.

    Falls back to whatever DOCKER_API_VERSION is already set in env
    (compose passes 1.43 as the safe static default) if the probe
    fails — that way a broken docker.sock mount still gives a usable
    starting point rather than crashing the trigger at boot.
    """
    try:
        conn = UnixHTTPConn(timeout=5)
        conn.request('GET', '/version')
        resp = conn.getresponse()
        if resp.status != 200:
            return None
        data = json.loads(resp.read().decode('utf-8'))
        return data.get('ApiVersion')
    except Exception as e:
        print(f'[trigger] Could not probe daemon API version ({e}); '
              f'falling back to DOCKER_API_VERSION env or CLI default',
              flush=True)
        return None


def main():
    # Pin docker-cli to a daemon-accepted API version BEFORE we bind
    # the HTTP server (so the first sync click never errors). The
    # docker-compose env block sets a static fallback of 1.43; if the
    # runtime probe succeeds it overrides with the actual daemon-
    # reported max.
    detected = detect_daemon_api_version()
    if detected:
        old = os.environ.get('DOCKER_API_VERSION', '<unset>')
        os.environ['DOCKER_API_VERSION'] = detected
        print(f'[trigger] Pinned DOCKER_API_VERSION={detected} '
              f'(was {old}) from daemon /version probe', flush=True)
    else:
        existing = os.environ.get('DOCKER_API_VERSION', '<unset>')
        print(f'[trigger] Daemon probe failed; sticking with '
              f'DOCKER_API_VERSION={existing}', flush=True)

    addr = ('0.0.0.0', 8888)
    print(
        f'Recyclarr trigger webhook listening on http://{addr[0]}:{addr[1]}/'
        f' (endpoints: GET / + POST /sync + POST /profile)',
        flush=True,
    )
    HTTPServer(addr, Handler).serve_forever()


if __name__ == '__main__':
    main()
