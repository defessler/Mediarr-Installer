#!/usr/bin/env python3
"""Turn a downloaded .m3u into a real Plex playlist.

Plex does NOT watch folders for .m3u, so after playlistsync downloads a
playlist's tracks and writes its .m3u, this uploads it via Plex's
/playlists/upload endpoint. Idempotent: an existing playlist of the same
title is deleted first so re-runs don't pile up duplicates.

Usage: plex-upload.py <m3u-dir> <playlist-name>
  <m3u-dir>        folder under /data/Music/Playlists/ holding exactly one .m3u
  <playlist-name>  desired Plex playlist title (must match the .m3u basename,
                   since Plex titles the playlist after the .m3u filename)

Env:
  LAN_IP        -> Plex base URL http://<LAN_IP>:32400
  X_PLEX_TOKEN  -> optional; else read PlexOnlineToken from the Plex config mount
                   (/plex-config/Library/Application Support/Plex Media Server/Preferences.xml)

Plex sees the Music tree at /media (the downloader writes to /data/Music), so the
.m3u path handed to Plex is translated /data/Music -> /media/Music. The .m3u's own
track entries must likewise be /media/... paths (that is the downloader's job).
"""
import glob
import json
import os
import sys
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
    url = base + path
    url += ("&" if "?" in url else "?") + "X-Plex-Token=" + urllib.parse.quote(token)
    req = urllib.request.Request(url, method=method, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def music_section_id(base, token):
    data = json.loads(api(base, "/library/sections", token))
    for d in data.get("MediaContainer", {}).get("Directory", []):
        if d.get("type") == "artist":
            return d.get("key")
    raise SystemExit("no music (type=artist) library section found in Plex")


def delete_existing(base, token, name):
    try:
        data = json.loads(api(base, "/playlists", token))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return
        raise
    for pl in data.get("MediaContainer", {}).get("Metadata", []):
        if pl.get("title") == name and pl.get("ratingKey"):
            try:
                api(base, "/playlists/" + str(pl["ratingKey"]), token, method="DELETE")
                err("replaced existing playlist '%s'" % name)
            except Exception as e:
                err("warning: could not delete existing '%s' (%s)" % (name, e))


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

    base, token = plex_base(), plex_token()
    section = music_section_id(base, token)
    delete_existing(base, token, name)
    q = urllib.parse.urlencode({"sectionID": section, "path": plex_path})
    try:
        api(base, "/playlists/upload?" + q, token, method="POST")
    except urllib.error.HTTPError as e:
        raise SystemExit("Plex /playlists/upload failed: HTTP %s — %s"
                         % (e.code, (e.read() or b"")[:200]))
    err("uploaded playlist '%s' from %s" % (name, plex_path))


if __name__ == "__main__":
    main()
