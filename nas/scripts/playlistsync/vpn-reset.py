#!/usr/bin/env python3
"""Ask gluetun to reconnect the VPN tunnel so we get a FRESH exit IP.

Why this exists: playlistsync runs inside gluetun's network namespace
(docker-compose `network_mode: container:gluetun`), so ALL of its traffic —
including the xmplaylist poll — leaves through the VPN. xmplaylist sits behind
Cloudflare, which periodically 403/429-blocks VPN/datacenter exit IPs. When that
happens, sync.sh calls this script to stop+start the tunnel; gluetun reconnects
to a different server in SERVER_COUNTRIES and the exit IP changes, clearing the
block. Because we share gluetun's namespace, its control server is reachable at
127.0.0.1:8000 (no port needs publishing).

Best-effort by design: a missing/locked-down control server is NOT fatal — we
print a clear reason and exit non-zero, and sync.sh simply skips the retry (the
next scheduled pass tries again). Exit 0 means "reconnect issued" (caller may
retry the poll); non-zero means "couldn't reset" (caller should not bother
retrying with the same IP).

Env:
  GLUETUN_CONTROL_URL      base URL of gluetun's control server
                           (default http://127.0.0.1:8000 — correct when we share
                           gluetun's namespace).
  GLUETUN_CONTROL_APIKEY   optional API key. gluetun v3.40+ can require auth on
                           the control server; set this (and the matching role on
                           the gluetun side) if your control server is locked down.
  PLAYLIST_VPN_RESET_WAIT  seconds to wait for the tunnel to come back (default 60).

stdlib only (urllib + json) — same posture as the other playlistsync scripts.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

CTRL = os.environ.get("GLUETUN_CONTROL_URL", "http://127.0.0.1:8000").rstrip("/")
API_KEY = os.environ.get("GLUETUN_CONTROL_APIKEY", "").strip()
WAIT_SECS = int(os.environ.get("PLAYLIST_VPN_RESET_WAIT", "60") or "60")
REQ_TIMEOUT = 10


def err(msg):
    sys.stderr.write("vpn-reset: " + msg + "\n")


def _req(method, path, body=None):
    """Call the gluetun control server; return parsed JSON (or {})."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if API_KEY:
        # gluetun's auth middleware accepts the API key via X-API-Key.
        headers["X-API-Key"] = API_KEY
    req = urllib.request.Request(CTRL + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=REQ_TIMEOUT) as r:
        return json.loads(r.read() or b"{}")


def public_ip():
    """Current VPN exit IP per gluetun, or '' if unknown/unreachable."""
    try:
        d = _req("GET", "/v1/publicip/ip")
    except Exception:
        return ""
    return (d or {}).get("public_ip") or ""


def _set_status(status):
    """PUT the unified VPN status (works for WireGuard + OpenVPN on modern
    gluetun). Raises on transport/HTTP error so main() can classify it."""
    _req("PUT", "/v1/vpn/status", {"status": status})


def main():
    old = public_ip()
    try:
        # Stop then start the tunnel. gluetun re-selects a server from
        # SERVER_COUNTRIES on reconnect, so the exit IP typically changes.
        _set_status("stopped")
        time.sleep(2)
        _set_status("running")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            err("gluetun control server requires auth (HTTP %s) — set "
                "GLUETUN_CONTROL_APIKEY (and a matching gluetun role) to enable "
                "automatic IP reset. Skipping." % e.code)
        elif e.code == 404:
            err("gluetun control server doesn't have /v1/vpn/status (older "
                "gluetun?) — skipping automatic IP reset.")
        else:
            err("gluetun control server returned HTTP %s — skipping IP reset." % e.code)
        return 1
    except (urllib.error.URLError, OSError) as e:
        err("gluetun control server unreachable at %s (%s) — is the control "
            "server enabled and are we in gluetun's namespace? Skipping IP reset."
            % (CTRL, e))
        return 1

    # Wait for the tunnel to come back up. While reconnecting, public_ip() may
    # return '' (no connectivity) — keep polling until it reports an IP or we
    # time out. A changed IP is the happy path; an unchanged one still gets a
    # retry (the ~reconnect downtime can itself clear a transient rate-limit).
    deadline = time.time() + WAIT_SECS
    while time.time() < deadline:
        time.sleep(3)
        new = public_ip()
        if new:
            if new != old:
                err("reconnected — exit IP %s -> %s" % (old or "?", new))
            else:
                err("reconnected but the exit IP is unchanged (%s); the server "
                    "pool may be small or pinned. Retrying anyway." % new)
            time.sleep(3)  # let DNS/routes settle before the caller retries
            return 0
    err("reconnect issued but the tunnel didn't report a public IP within %ds — "
        "retrying the poll anyway." % WAIT_SECS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
