#!/usr/bin/env python3
"""Turn a downloaded .m3u into a real Plex playlist.

Plex's /playlists/upload does NOT import files — it only matches each .m3u entry
against tracks ALREADY INDEXED in the music library. The tracks were just
downloaded, so this script must first make Plex SCAN them in, WAIT until that
settles, and only then upload — otherwise the upload matches nothing and creates
an empty playlist that Plexamp won't show. Sequence:

  scan the playlist folder  ->  wait for the scan to settle  ->  upload  ->
  re-query the new playlist's track count  ->  (0 matched? full scan + retry once)
  ->  prune the OLD same-titled playlist only after a confirmed-NON-EMPTY upload.

Uploading before pruning (and refusing to prune when the new playlist is empty)
means a transient Plex/scanner hiccup can never leave the user with no playlist.

Usage: plex-upload.py <m3u-dir> <playlist-name>
  <m3u-dir>        folder under /data/Music/Playlists/ holding exactly one .m3u
  <playlist-name>  desired Plex playlist title (must match the .m3u basename,
                   since Plex titles the playlist after the .m3u filename)

Env:
  LAN_IP                     -> Plex base URL http://<LAN_IP>:32400
  X_PLEX_TOKEN               -> optional; else read PlexOnlineToken from the Plex
                                config mount (Preferences.xml)
  PLAYLIST_PLEX_SCAN_TIMEOUT -> optional; seconds to wait for a scan (default 120)

Plex sees the Music tree at /media (the downloader writes to /data/Music), so the
.m3u path handed to Plex is translated /data/Music -> /media/Music. The .m3u's own
track entries must ALSO be absolute /media/... paths so Plex matches them by their
indexed location rather than relying on relative-path resolution (normalise_m3u
in sync.sh writes them that way).
"""
import glob
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

# The Plex config dir is bind-mounted read-only here. In the linuxserver/plex
# image Preferences.xml (which holds PlexOnlineToken) lives under
# Library/Application Support/Plex Media Server/ — NOT at the dir root.
PLEX_CONFIG_DIR = "/plex-config"
PLEX_PREFS_SUBPATH = "Library/Application Support/Plex Media Server/Preferences.xml"
HOST_MUSIC_PREFIX = "/data/Music"   # where the downloader writes
PLEX_MUSIC_PREFIX = "/media/Music"  # where Plex sees the same tree
TIMEOUT = 30
# How long to wait for a library scan to settle before uploading anyway. Bounded
# so a slow/large box never hangs the nightly cron pass; a 0-match upload still
# self-heals via the full-scan retry below and the next run.
SCAN_TIMEOUT = int(os.environ.get("PLAYLIST_PLEX_SCAN_TIMEOUT", "120"))
SCAN_POLL = 3                       # seconds between scan-status polls


def err(msg):
    sys.stderr.write("plex-upload: " + msg + "\n")


def plex_token():
    tok = os.environ.get("X_PLEX_TOKEN", "").strip()
    if tok:
        return tok
    # Canonical linuxserver/plex location, with a recursive glob fallback in case
    # a future image lays Preferences.xml somewhere else under the config dir.
    prefs = os.path.join(PLEX_CONFIG_DIR, PLEX_PREFS_SUBPATH)
    if not os.path.exists(prefs):
        hits = glob.glob(os.path.join(PLEX_CONFIG_DIR, "**", "Preferences.xml"),
                         recursive=True)
        if hits:
            prefs = hits[0]
    try:
        # Preferences.xml is a single self-closing <Preferences .../> element.
        tok = (ET.parse(prefs).getroot().get("PlexOnlineToken") or "").strip()
    except Exception as e:
        raise SystemExit("no X_PLEX_TOKEN and could not read %s (%s)" % (prefs, e))
    if not tok:
        raise SystemExit("PlexOnlineToken empty in %s — has Plex finished claim/login?" % prefs)
    return tok


def plex_base():
    ip = os.environ.get("LAN_IP", "").strip()
    if not ip:
        raise SystemExit("LAN_IP env not set")
    return "http://%s:32400" % ip


def api(base, path, token, method="GET"):
    """Call the Plex API; return the raw response body (may be empty)."""
    url = base + path
    url += ("&" if "?" in url else "?") + "X-Plex-Token=" + urllib.parse.quote(token)
    req = urllib.request.Request(url, method=method, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def api_json(base, path, token):
    """Call the Plex API and parse JSON, tolerating an empty body."""
    return json.loads(api(base, path, token) or b"{}")


def music_section_id(base, token):
    data = api_json(base, "/library/sections", token)
    for d in data.get("MediaContainer", {}).get("Directory", []):
        if d.get("type") == "artist":
            return d.get("key")
    raise SystemExit("no music (type=artist) library section found in Plex")


def section_refreshing(base, token, section):
    """True while Plex is actively scanning this section. The `refreshing`
    attribute is absent on some builds / for very fast scans — treat absent as
    'not refreshing' so the wait never hangs on it."""
    data = api_json(base, "/library/sections/%s" % section, token)
    dirs = data.get("MediaContainer", {}).get("Directory", [])
    return bool(dirs) and str(dirs[0].get("refreshing", "")) == "1"


def trigger_refresh(base, token, section, path):
    """Ask Plex to scan the section. With `path`, scan only that folder (fast);
    without it, a whole-section scan (the reliable discover-everything fallback,
    the same call the installer uses at library creation). Best-effort: a scan
    request that errors must not abort the run."""
    p = "/library/sections/%s/refresh" % section
    if path:
        p += "?" + urllib.parse.urlencode({"path": path})
    try:
        api(base, p, token)  # GET, empty body
    except Exception as e:
        err("warning: scan request failed (%s) — continuing" % e)


def wait_for_scan(base, token, section):
    """Block until the section's scan settles, bounded by SCAN_TIMEOUT. Tolerates
    transient API errors while Plex is mid-restart (retry next tick, don't crash)
    and the `refreshing` flag being absent. On timeout, proceed best-effort — the
    0-match retry and the next nightly run are the safety nets."""
    deadline = time.time() + SCAN_TIMEOUT
    time.sleep(SCAN_POLL)  # let the scan register as in-flight first
    while time.time() < deadline:
        try:
            if not section_refreshing(base, token, section):
                return
        except Exception:
            pass  # Plex busy/restarting — try again on the next tick
        time.sleep(SCAN_POLL)
    err("WARN: library scan did not settle within %ds — proceeding best-effort"
        % SCAN_TIMEOUT)


def playlists_by_title(base, token, name):
    """(ratingKey, leafCount) for every AUDIO playlist currently titled `name`.
    Returns [] if Plex has no /playlists yet."""
    try:
        data = api_json(base, "/playlists?playlistType=audio", token)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    out = []
    for pl in data.get("MediaContainer", {}).get("Metadata", []):
        if pl.get("title") == name and pl.get("ratingKey"):
            leaf = int(pl.get("leafCount", pl.get("size", 0)) or 0)
            out.append((str(pl["ratingKey"]), leaf))
    return out


def delete_playlist(base, token, key):
    if not key:
        return
    try:
        api(base, "/playlists/" + key, token, method="DELETE")
    except Exception as e:
        err("warning: could not delete playlist %s (%s)" % (key, e))


def upload_and_measure(base, token, section, plex_path, name, stale_keys):
    """POST the .m3u as a playlist, then RE-QUERY to learn the new playlist's key
    and how many tracks actually matched — /playlists/upload returns an empty body,
    so the count can only be read back afterwards. Returns (ratingKey|None, leaf)."""
    q = urllib.parse.urlencode({"sectionID": section, "path": plex_path})
    try:
        api(base, "/playlists/upload?" + q, token, method="POST")
    except urllib.error.HTTPError as e:
        raise SystemExit("Plex /playlists/upload failed: HTTP %s — %s"
                         % (e.code, (e.read() or b"")[:200]))
    # The newly-created playlist is the same-titled one that wasn't there before.
    fresh = [(k, lf) for k, lf in playlists_by_title(base, token, name)
             if k not in stale_keys]
    if not fresh:
        return None, 0
    key, leaf = max(fresh, key=lambda t: t[1])  # the populated one, if any
    return key, leaf


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: plex-upload.py <m3u-dir> <playlist-name>")
    m3u_dir, name = sys.argv[1], sys.argv[2]
    matches = sorted(glob.glob(os.path.join(m3u_dir, "*.m3u8"))
                     + glob.glob(os.path.join(m3u_dir, "*.m3u")))
    if not matches:
        raise SystemExit("no .m3u in %s (nothing downloaded?)" % m3u_dir)
    host_path = matches[0]
    plex_path = (PLEX_MUSIC_PREFIX + host_path[len(HOST_MUSIC_PREFIX):]
                 if host_path.startswith(HOST_MUSIC_PREFIX) else host_path)
    folder = os.path.dirname(plex_path)  # /media/Music/Playlists/<label>

    base, token = plex_base(), plex_token()
    section = music_section_id(base, token)

    # Capture the OLD same-titled playlist(s) now; prune them only AFTER a
    # confirmed-non-empty upload, so a transient miss never destroys a good one.
    stale_keys = [k for k, _ in playlists_by_title(base, token, name)]

    # 1) Scan the just-downloaded folder into Plex and WAIT until it settles.
    #    Without this the brand-new tracks aren't in the library yet, so the
    #    upload below matches nothing.
    err("scanning %s into the Plex music library ..." % folder)
    trigger_refresh(base, token, section, folder)
    wait_for_scan(base, token, section)

    # 2) Upload and verify how many tracks actually matched (re-query, since the
    #    upload returns no body).
    new_key, leaf = upload_and_measure(base, token, section, plex_path, name, stale_keys)

    # 3) Nothing matched? The targeted scan may not have landed. Escalate to a
    #    whole-library scan, drop the empty upload so we don't pile duplicates,
    #    wait, and retry ONCE.
    if leaf == 0:
        err("0 tracks matched — running a full library scan and retrying once ...")
        delete_playlist(base, token, new_key)
        trigger_refresh(base, token, section, None)
        wait_for_scan(base, token, section)
        new_key, leaf = upload_and_measure(base, token, section, plex_path, name, stale_keys)

    if leaf == 0:
        # Still empty: keep the user's PRIOR good playlist (do NOT prune), drop
        # the empty new one, and fail loudly so sync.sh surfaces it.
        delete_playlist(base, token, new_key)
        raise SystemExit(
            "Plex matched 0 tracks for '%s' even after a full scan — the files "
            "aren't in the Music library yet; it should populate on the next run"
            % name)

    err("uploaded playlist '%s' from %s (%d track%s)"
        % (name, plex_path, leaf, "" if leaf == 1 else "s"))
    # Safe now: prune the pre-existing same-titled playlist(s) so re-runs don't
    # pile up duplicates. Deleting by the captured ratingKeys can't touch the new
    # one.
    for key in stale_keys:
        delete_playlist(base, token, key)
        err("replaced previous playlist '%s'" % name)


if __name__ == "__main__":
    main()
