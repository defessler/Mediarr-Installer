#!/usr/bin/env python3
"""
Tiny webhook server backing the Recyclarr tile on the Homepage dashboard.

The Recyclarr container itself has no web UI — it's a CLI tool. This file
runs in its own little Python:alpine container next to Recyclarr and
exposes a one-page web UI with a "Sync Now" button.

  GET  /       → status page (last sync time, currently-applied profile,
                 big green Sync Now button, recent output if any)
  POST /sync   → runs `docker exec recyclarr recyclarr sync` (via the
                 mounted docker socket), captures output, re-renders the
                 page with the result

Why a separate container instead of bolting onto Recyclarr's:
- Recyclarr's official image is locked to its own entrypoint; bolting
  a Python server on top means a custom Dockerfile we'd have to keep
  rebased against upstream. Not worth the maintenance burden for ~50
  lines of code that don't need to share Recyclarr's filesystem.

- The webhook container can stay tiny (python:3-alpine + apk add
  docker-cli) and gets reusable: any future "tiny dashboard widget that
  needs to docker-exec into another container" can use the same pattern.

Volumes mounted by docker-compose.yml:
  /var/run/docker.sock          (rw)  — to run `docker exec recyclarr ...`
  ${INSTALL_DIR}/recyclarr/config  (ro) — to read .last-sync timestamp
  ${INSTALL_DIR}/recyclarr-trigger.py (ro) — this file

Security note: anyone on the LAN can hit POST /sync. The "attack" is
they trigger a recyclarr sync, which is idempotent and harmless. We
take a coarse in-process lock to avoid trampling parallel triggers but
otherwise don't authenticate — this is a home-LAN tool, not exposed
to the internet.
"""

from http.server import BaseHTTPRequestHandler, HTTPServer
import html
import os
import subprocess
import threading

# Where the .last-sync stamp file lives, AS SEEN INSIDE THIS CONTAINER.
# docker-compose mounts the recyclarr container's /config dir read-only
# at /recyclarr-config here, so the stamp configure_recyclarr() writes
# (and recyclarr-sync.sh refreshes) is visible.
STAMP_FILE = '/recyclarr-config/.last-sync'

# Single-flight lock: while a sync is in flight, any second sync request
# bounces with a "wait a sec" message rather than queuing. Recyclarr's
# sync is idempotent so even a queue would be safe, but it'd just chew
# Sonarr/Radarr's API budget for no reason. Non-blocking acquire so the
# user sees an immediate "in progress" response instead of waiting.
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
        padding: 0.25rem 0; }}
.row strong {{ font-weight: 500; }}
button {{
  background: #10b981; color: white; border: none;
  padding: 0.875rem 1.75rem; font-size: 1rem; font-weight: 600;
  border-radius: 0.375rem; cursor: pointer;
  transition: background 0.15s ease;
}}
button:hover  {{ background: #059669; }}
button:active {{ background: #047857; }}
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

<form method="POST" action="/sync">
  <button type="submit">Sync Now</button>
</form>

{output_section}

<p class="hint">
  Change profiles: edit <code>TRASH_SONARR_PROFILE</code> /
  <code>TRASH_RADARR_PROFILE</code> in <code>.env</code> and re-run the wizard
  — recyclarr.yml gets regenerated to match.<br>
  Equivalent CLI: <code>docker exec recyclarr recyclarr sync</code> or
  <code>bash recyclarr-sync.sh</code>.<br>
  Schedule weekly via Synology Task Scheduler — see the in-app Help → Recyclarr.
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
        with open(STAMP_FILE) as f:
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


def render(banner_kind=None, banner_text=None, output=None):
    """Render the status page. `banner_*` shows a top-of-page status flash
    after a sync; `output` is the captured sync output (shown in a <pre>)."""
    ts, sp, rp = read_stamp()
    banner_html = ''
    if banner_kind and banner_text:
        banner_html = f'<div class="banner {html.escape(banner_kind)}">{html.escape(banner_text)}</div>'
    output_html = ''
    if output:
        output_html = (
            '<div class="card">'
            '<div class="label">Sync output</div>'
            f'<pre>{html.escape(output)}</pre>'
            '</div>'
        )
    return PAGE.format(
        banner=banner_html,
        last_sync=html.escape(ts),
        sonarr_profile=html.escape(sp),
        radarr_profile=html.escape(rp),
        output_section=output_html,
    )


def run_sync():
    """Single-flight `docker exec recyclarr recyclarr sync`.
    Returns (status_kind, message, output) where status_kind is one of
    'ok' / 'warn' / 'err' for the banner styling. Non-blocking lock
    acquire so a second concurrent click gets immediate feedback."""
    if not SYNC_LOCK.acquire(blocking=False):
        return ('warn', 'Another sync is already in progress — try again in a moment.', '')
    try:
        try:
            r = subprocess.run(
                ['docker', 'exec', 'recyclarr', 'recyclarr', 'sync'],
                capture_output=True, text=True, timeout=180,
            )
        except FileNotFoundError:
            # docker CLI not available — image initialisation didn't apk-add it
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
    finally:
        SYNC_LOCK.release()


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
        if self.path != '/':
            self.send_error(404)
            return
        self._send_html(render())

    def do_POST(self):
        if self.path != '/sync':
            self.send_error(404)
            return
        kind, msg, out = run_sync()
        # HTTP status mirrors the sync outcome — useful if anyone scripts
        # against this endpoint (curl -X POST returns rc=22 on 5xx).
        code = 200 if kind == 'ok' else (409 if kind == 'warn' else 500)
        self._send_html(render(banner_kind=kind, banner_text=msg, output=out), code=code)


def main():
    addr = ('0.0.0.0', 8888)
    print(f'Recyclarr trigger webhook listening on http://{addr[0]}:{addr[1]}/', flush=True)
    HTTPServer(addr, Handler).serve_forever()


if __name__ == '__main__':
    main()
