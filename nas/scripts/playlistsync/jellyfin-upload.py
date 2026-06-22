#!/usr/bin/env python3
"""Turn a downloaded .m3u into a real Jellyfin playlist.

Jellyfin has NO equivalent of Plex's /playlists/upload — there is no endpoint
that ingests an .m3u and resolves its entries server-side. So this script must
itself read the .m3u, resolve every track to a Jellyfin ItemId, then create the
playlist from that Id list. And like Plex, Jellyfin only matches tracks it has
ALREADY INDEXED, so freshly-downloaded files must be scanned in and the scan
allowed to settle BEFORE we resolve them — otherwise GET /Items omits them and
the playlist comes out empty. Sequence (mirrors plex-upload.py):

  scan the library  ->  wait for the scan to settle  ->  index audio items  ->
  resolve each .m3u entry to an ItemId  ->  create the playlist (Name+Ids+UserId)
  ->  (0 matched? full rescan + retry once)  ->  prune the OLD same-titled
  playlist(s) only after a confirmed-NON-EMPTY create.

Creating before pruning (and refusing to prune when the new playlist is empty)
means a transient Jellyfin/scanner hiccup can never leave the user with no
playlist — the exact safety invariant the Plex script keeps.

Usage: jellyfin-upload.py <m3u-dir> <playlist-name> [--art-spotify URL_OR_ID]
                          [--art-sxm-slug SLUG]
  <m3u-dir>        folder under /data/Music/Playlists/ holding exactly one .m3u
  <playlist-name>  desired Jellyfin playlist title (exact-match prune key)

Env:
  LAN_IP                   -> Jellyfin base URL http://<LAN_IP>:8096
  JELLYFIN_API_KEY         -> API key (Dashboard -> API Keys); REQUIRED. Unlike
                              Plex there is no on-disk token to scrape and no
                              claim flow, so a blank key means skip cleanly.
  JELLYFIN_USER_ID         -> optional; pin the owning user. Else auto-resolved
                              from GET /Users (first admin, then first user).
  PLAYLIST_JF_SCAN_TIMEOUT -> optional; seconds to wait for a scan (default 120)

Jellyfin sees the Music tree at /media (the downloader writes to /data/Music),
exactly like Plex. normalise_m3u (in sync.sh) already rewrote each entry to its
absolute /media/Music/... path AND dropped entries with no file on disk, so an
item's reported Path field (Fields=Path) equals the .m3u line — that is the
primary match key here, with artist+title and basename as fallbacks.
"""
import argparse
import glob
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOST_MUSIC_PREFIX = "/data/Music"   # where the downloader writes
JF_MUSIC_PREFIX = "/media/Music"    # where Jellyfin sees the same tree
TIMEOUT = 30
# How long to wait for a library scan to settle before resolving anyway. Bounded
# so a slow/large box never hangs the nightly cron pass; a 0-match create still
# self-heals via the full-scan retry below and the next run.
SCAN_TIMEOUT = int(os.environ.get("PLAYLIST_JF_SCAN_TIMEOUT", "120"))
SCAN_POLL = 3                       # seconds between scan-status polls
SCAN_SETTLE = 2                     # grace after a scan clears, for metadata to commit
ADD_CHUNK = 50                      # ItemIds per POST /Playlists/{id}/Items request
# Jellyfin's library-scan scheduled task. Identify it by Key (stable) — never by
# its per-install GUID (which differs per box).
SCAN_TASK_KEY = "RefreshLibrary"
SCAN_TASK_NAMES = ("scan media library", "scan all libraries")


def err(msg):
    sys.stderr.write("jellyfin-upload: " + msg + "\n")


def jf_base():
    ip = os.environ.get("LAN_IP", "").strip()
    if not ip:
        raise SystemExit("LAN_IP env not set")
    return "http://%s:8096" % ip


def jf_key():
    key = os.environ.get("JELLYFIN_API_KEY", "").strip()
    if not key:
        # No on-disk token / claim flow like Plex — the key is the only source.
        # Skip cleanly (tracks already downloaded) rather than dying with a
        # traceback, mirroring plex_token()'s clear-message posture.
        raise SystemExit(
            "JELLYFIN_API_KEY is empty — finish Jellyfin's first-run setup at "
            "http://<NAS>:8096, then Dashboard -> API Keys -> '+' to create a key "
            "and put it in .env as JELLYFIN_API_KEY; the playlist uploads next run")
    return key


def _headers(key):
    # Send BOTH the legacy X-Emby-Token header (simplest, still accepted) and the
    # modern Authorization: MediaBrowser Token= form (forward-compat: X-Emby-Token
    # is deprecated and slated to be disabled by default in a future Jellyfin
    # release). Sending both is harmless and robust across versions.
    return {
        "Accept": "application/json",
        "X-Emby-Token": key,
        "Authorization": 'MediaBrowser Token="%s"' % key,
    }


def api(base, path, key, method="GET", body=None):
    """Call the Jellyfin API; return the raw response body (may be empty).
    `body` (a dict) is sent as a JSON request body with Content-Type json."""
    url = base + path
    data = None
    headers = _headers(key)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def api_json(base, path, key, method="GET", body=None):
    """Call the Jellyfin API and parse JSON, tolerating an empty body."""
    return json.loads(api(base, path, key, method=method, body=body) or b"{}")


def _qs(params):
    """Standard urlencode (spaces -> %20 via quote). Jellyfin reads these as
    normal query values (Ids/userId/searchTerm), so unlike Plex's `path` quirk
    there is no '+'-vs-%20 gotcha — but we keep quote (not quote_plus) for
    consistency and so a searchTerm space never round-trips as a literal '+'."""
    return urllib.parse.urlencode(params, quote_via=urllib.parse.quote)


def resolve_user_id(base, key):
    """Pick the owning user for the playlist. An API key carries NO user context,
    so POST /Playlists without a UserId fails with 'Guid can't be empty'. Honor an
    explicit JELLYFIN_USER_ID; else GET /Users and take the first administrator,
    then the first user. Raises with a clear message if no users exist yet."""
    pinned = os.environ.get("JELLYFIN_USER_ID", "").strip()
    if pinned:
        return pinned
    users = api_json(base, "/Users", key)
    # /Users returns a bare JSON array of user objects.
    if isinstance(users, dict):  # some builds wrap it; tolerate {"Items":[...]}
        users = users.get("Items", [])
    if not users:
        raise SystemExit(
            "Jellyfin has no users yet — finish the first-run setup wizard at "
            "http://<NAS>:8096 (creates the admin user), then re-run")
    for u in users:
        if (u.get("Policy") or {}).get("IsAdministrator"):
            return u.get("Id")
    return users[0].get("Id")


def trigger_refresh(base, key):
    """Ask Jellyfin to scan ALL libraries. POST /Library/Refresh takes no path or
    library parameter (there is no documented per-folder scan via the public API),
    so this is the whole-library scan — the analog of plex-upload's full-section
    fallback. Best-effort: a scan request that errors must not abort the run."""
    try:
        api(base, "/Library/Refresh", key, method="POST")  # 204, empty body
    except Exception as e:
        err("warning: scan request failed (%s) — continuing" % e)


def _scan_running(base, key):
    """True while the media-library scan scheduled task is active. Identify the
    task by its stable Key ('RefreshLibrary') or Name, never by per-box GUID.
    Absent/unknown task -> treat as 'not running' so the wait never hangs."""
    tasks = api_json(base, "/ScheduledTasks", key)
    if isinstance(tasks, dict):
        tasks = tasks.get("Items", [])
    for t in tasks or []:
        k = str(t.get("Key", ""))
        nm = str(t.get("Name", "")).strip().lower()
        if k == SCAN_TASK_KEY or nm in SCAN_TASK_NAMES:
            return str(t.get("State", "")).strip().lower() == "running"
    return False


def wait_for_scan(base, key):
    """Block until the library scan settles, bounded by SCAN_TIMEOUT. Tolerates
    transient API errors (retry next tick) and the task being absent. On timeout,
    proceed best-effort — the 0-match retry and the next nightly run are the
    safety nets. Mirrors plex-upload.py's wait_for_scan."""
    deadline = time.time() + SCAN_TIMEOUT
    time.sleep(SCAN_POLL)  # let the scan register as in-flight first
    while time.time() < deadline:
        try:
            if not _scan_running(base, key):
                time.sleep(SCAN_SETTLE)  # let metadata commit before we match
                return
        except Exception:
            pass  # Jellyfin busy/restarting — try again on the next tick
        time.sleep(SCAN_POLL)
    err("WARN: library scan did not settle within %ds — proceeding best-effort"
        % SCAN_TIMEOUT)


def _clean(text):
    """Lowercase + strip non-alphanumerics for a forgiving artist/title key.
    Deliberately conservative vs the reference m3u-to-jellyfin clean_text: we do
    NOT strip 'the', bracketed text, or substring 'junk' words, because our keys
    come from the controlled '{artist} - {title}' name-format (sync.sh) — over-
    cleaning there only risks WRONG matches (a bad match adds the wrong song)."""
    return "".join(c for c in text.lower() if c.isalnum())


def index_audio(base, key, user_id):
    """One pull of every audio item -> lookup maps. GET /Items with Recursive and
    IncludeItemTypes=Audio and Fields=Path,Artists,Name. Returns three dicts keyed
    Path / basename / (artist+title), all pointing at ItemIds, for layered match.
    This whole-library pull replaces Plex's server-side path match."""
    q = _qs({
        "Recursive": "true",
        "IncludeItemTypes": "Audio",
        "Fields": "Path,Artists,Name",
        "userId": user_id,
        "EnableTotalRecordCount": "false",
    })
    data = api_json(base, "/Items?" + q, key)
    by_path, by_base, by_meta = {}, {}, {}
    for it in data.get("Items", []):
        iid = it.get("Id")
        if not iid:
            continue
        p = it.get("Path") or ""
        if p:
            by_path[p] = iid
            by_base.setdefault(os.path.basename(p), iid)
        name = it.get("Name") or ""
        artists = it.get("Artists") or []
        if name:
            for a in (artists or [""]):
                by_meta.setdefault(_clean(a) + _clean(name), iid)
            by_meta.setdefault(_clean(name), iid)  # title-only fallback
    return by_path, by_base, by_meta


def read_m3u_entries(m3u_path):
    """Parse the .m3u into ordered (path, artist, title) tuples. normalise_m3u has
    already rewritten each track line to its absolute /media/Music/... path and
    dropped missing files. We read the path line and the PRECEDING #EXTINF (if
    any) for artist/title (#EXTINF:secs,Artist - Title). Comment/blank lines that
    aren't #EXTINF are skipped."""
    out = []
    pending_artist = pending_title = ""
    try:
        with open(m3u_path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError as e:
        raise SystemExit("cannot read %s: %s" % (m3u_path, e))
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        if s.startswith("#EXTINF"):
            # #EXTINF:<secs>,<Artist> - <Title>
            meta = s.split(",", 1)[1] if "," in s else ""
            if " - " in meta:
                pending_artist, pending_title = (x.strip() for x in meta.split(" - ", 1))
            else:
                pending_artist, pending_title = "", meta.strip()
            continue
        if s.startswith("#"):
            continue
        out.append((s, pending_artist, pending_title))
        pending_artist = pending_title = ""
    return out


def _meta_from_basename(path):
    """Derive (artist, title) from an 'Artist - Title.ext' basename — sockseek's
    --name-format is exactly '{artist} - {title}', so our own filenames carry it
    even when an #EXTINF line is absent."""
    stem = os.path.splitext(os.path.basename(path))[0]
    if " - " in stem:
        a, t = stem.split(" - ", 1)
        return a.strip(), t.strip()
    return "", stem.strip()


def resolve_ids(entries, by_path, by_base, by_meta):
    """Map each .m3u entry to a Jellyfin ItemId, preserving order and de-duping.
    Match order (most to least precise): exact Path -> basename -> artist+title ->
    title-only. Path is the strongest key (it equals the item's indexed file).
    Returns (ids_in_order, unmatched_paths)."""
    ids, seen, unmatched = [], set(), []
    for path, artist, title in entries:
        iid = by_path.get(path)
        if not iid:
            iid = by_base.get(os.path.basename(path))
        if not iid:
            if not (artist or title):
                artist, title = _meta_from_basename(path)
            if artist and title:
                iid = by_meta.get(_clean(artist) + _clean(title))
            if not iid and title:
                iid = by_meta.get(_clean(title))
        if iid:
            if iid not in seen:
                seen.add(iid)
                ids.append(iid)
        else:
            unmatched.append(path)
    return ids, unmatched


def playlists_by_title(base, key, user_id, name):
    """ItemIds of every playlist currently titled exactly `name`. searchTerm is a
    fuzzy/substring match, so we re-filter to an EXACT Name== to avoid catching
    'SiriusXM - Hits 1' when looking for 'SiriusXM - Hits 10' (the same exact-
    title semantics plex-upload uses)."""
    q = _qs({
        "Recursive": "true",
        "IncludeItemTypes": "Playlist",
        "searchTerm": name,
        "userId": user_id,
        "EnableTotalRecordCount": "false",
    })
    try:
        data = api_json(base, "/Items?" + q, key)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    return [it["Id"] for it in data.get("Items", [])
            if it.get("Name") == name and it.get("Id")]


def playlist_item_count(base, key, user_id, pid):
    """Track count of a playlist (confirm a create is non-empty before pruning)."""
    q = _qs({"userId": user_id, "EnableTotalRecordCount": "true"})
    try:
        data = api_json(base, "/Playlists/%s/Items?%s" % (pid, q), key)
    except Exception:
        return 0
    items = data.get("Items")
    if items is not None:
        return len(items)
    return int(data.get("TotalRecordCount", 0) or 0)


def create_playlist(base, key, user_id, name, ids):
    """Create a populated audio playlist in ONE shot. POST /Playlists with a JSON
    body {Name, Ids, UserId, MediaType:'Audio', IsPublic:false} returns the new
    playlist's Id directly (no set-difference dance like Plex). MediaType=Audio
    makes Jellyfin treat it as a music playlist so it surfaces in music contexts.
    We create fully-populated (rather than create-empty-then-append) to sidestep
    the API-key-broken Update/Move endpoints. Returns the new playlist Id."""
    first = ids[:ADD_CHUNK]
    body = {
        "Name": name,
        "Ids": first,
        "UserId": user_id,
        "MediaType": "Audio",
        "IsPublic": False,
    }
    try:
        resp = api_json(base, "/Playlists", key, method="POST", body=body)
    except urllib.error.HTTPError as e:
        detail = (e.read() or b"")[:200]
        # Fresh Jellyfin: the <config>/data/Playlists dir is created lazily the
        # first time a playlist is made in the UI; until then POST /Playlists
        # throws ArgumentException about the parent folder. Surface it clearly
        # instead of crash-looping (setup pre-creates the dir; this is the belt).
        if b"Playlists" in detail or b"parentFolder" in detail or b"CreatePlaylist" in detail:
            raise SystemExit(
                "Jellyfin can't create playlists yet (the Playlists folder doesn't "
                "exist) — create ANY playlist once in the Jellyfin UI, or re-run "
                "setup to pre-create <jellyfin-config>/data/Playlists; then the "
                "sync works hands-off. (HTTP %s: %s)" % (e.code, detail))
        raise SystemExit("Jellyfin POST /Playlists failed: HTTP %s — %s"
                         % (e.code, detail))
    pid = resp.get("Id")
    if not pid:
        raise SystemExit("Jellyfin POST /Playlists returned no Id (%r)" % resp)
    # Append the remainder in <=50-Id chunks.
    for i in range(ADD_CHUNK, len(ids), ADD_CHUNK):
        seg = ids[i:i + ADD_CHUNK]
        q = _qs({"Ids": ",".join(seg), "userId": user_id})
        try:
            api(base, "/Playlists/%s/Items?%s" % (pid, q), key, method="POST")
        except Exception as e:
            err("warning: could not add %d track(s) to playlist (%s)" % (len(seg), e))
    return pid


def delete_playlist(base, key, pid):
    """Delete a playlist. A Jellyfin playlist IS a library Item, so deletion is
    DELETE /Items/{id} (DELETE /Playlists/{id}/Items with an API key is reported
    broken upstream — delete the whole stale playlist item instead). Best-effort."""
    if not pid:
        return
    try:
        api(base, "/Items/" + pid, key, method="DELETE")
    except Exception as e:
        err("warning: could not delete playlist %s (%s)" % (pid, e))


def _get_json(url):
    """Plain GET + JSON from an EXTERNAL host (xmplaylist / Spotify oEmbed) — no
    Jellyfin auth. Used only for best-effort poster-art lookup."""
    req = urllib.request.Request(
        url, headers={"Accept": "application/json", "User-Agent": "mediarr-playlistsync"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read() or b"{}")


def resolve_art_url(spotify_ref=None, sxm_slug=None):
    """Best-effort cover-image URL for the playlist poster — IDENTICAL logic to
    plex-upload.py. SiriusXM: the channel's official LOGO, hosted by xmplaylist at
    /img/station/<slug>-lg.png (far better than Spotify's auto-mosaic, and Jellyfin
    fetches it server-side so it's not subject to the VPN exit-IP block). Spotify:
    oEmbed the playlist URL -> its real cover. Returns None on ANY failure."""
    try:
        if sxm_slug and not spotify_ref:
            return ("https://xmplaylist.com/img/station/%s-lg.png"
                    % urllib.parse.quote(sxm_slug))
        if not spotify_ref:
            return None
        ref = (spotify_ref if str(spotify_ref).startswith("http")
               else "https://open.spotify.com/playlist/%s" % spotify_ref)
        o = _get_json("https://open.spotify.com/oembed?url=%s"
                      % urllib.parse.quote(ref, safe=":/"))
        return o.get("thumbnail_url") or None
    except Exception as e:
        err("note: couldn't resolve poster art (%s) — keeping Jellyfin's default" % e)
        return None


def set_poster(base, key, pid, art_url):
    """Set the playlist's Primary image from a URL. Jellyfin fetches it server-side
    via POST /Items/{id}/RemoteImages/Download?Type=Primary&ImageUrl=<url>. Fully
    best-effort: a miss just leaves Jellyfin's default. (A raw-bytes upload to
    /Items/{id}/Images/Primary is the alternative but needs a second fetch; the
    server-side download mirrors Plex's set_poster posture most closely.)"""
    if not (pid and art_url):
        return
    q = _qs({"Type": "Primary", "ImageUrl": art_url})
    try:
        api(base, "/Items/%s/RemoteImages/Download?%s" % (pid, q), key, method="POST")
        err("set playlist poster from %s" % art_url)
    except Exception as e:
        err("note: couldn't set playlist poster (%s) — keeping Jellyfin's default" % e)


def main():
    ap = argparse.ArgumentParser(
        description="Turn a downloaded .m3u into a Jellyfin playlist (+ optional poster).")
    ap.add_argument("m3u_dir", help="folder under /data/Music/Playlists/ holding one .m3u")
    ap.add_argument("name", help="Jellyfin playlist title (exact-match prune key)")
    ap.add_argument("--art-spotify", default=None, metavar="URL_OR_ID",
                    help="Spotify playlist URL/ID; its cover (oEmbed) becomes the poster")
    ap.add_argument("--art-sxm-slug", default=None, metavar="SLUG",
                    help="SiriusXM xmplaylist slug; the channel's Spotify-playlist cover becomes the poster")
    args = ap.parse_args()
    m3u_dir, name = args.m3u_dir, args.name

    matches = sorted(glob.glob(os.path.join(m3u_dir, "*.m3u8"))
                     + glob.glob(os.path.join(m3u_dir, "*.m3u")))
    if not matches:
        raise SystemExit("no .m3u in %s (nothing downloaded?)" % m3u_dir)
    entries = read_m3u_entries(matches[0])
    if not entries:
        raise SystemExit("no track entries in %s (nothing to upload)" % matches[0])

    base, key = jf_base(), jf_key()
    try:
        user_id = resolve_user_id(base, key)

        # The OLD same-titled playlist(s) we'll REPLACE — captured before we touch
        # anything, pruned only AFTER a confirmed-non-empty create so a transient
        # miss never destroys a good one.
        stale = playlists_by_title(base, key, user_id, name)

        # 1) Scan the just-downloaded tracks into Jellyfin and WAIT until it
        #    settles — GET /Items only returns indexed items.
        err("scanning the Jellyfin music library ...")
        trigger_refresh(base, key)
        wait_for_scan(base, key)

        # 2) Index audio, resolve each .m3u entry to an ItemId (Path -> basename
        #    -> artist+title -> title).
        by_path, by_base, by_meta = index_audio(base, key, user_id)
        ids, unmatched = resolve_ids(entries, by_path, by_base, by_meta)

        # 3) Nothing matched? The scan may not have landed yet. Escalate to a full
        #    rescan and retry the resolve ONCE (mirrors plex-upload's retry).
        if not ids:
            err("0 tracks matched — running a full library scan and retrying once ...")
            trigger_refresh(base, key)
            wait_for_scan(base, key)
            by_path, by_base, by_meta = index_audio(base, key, user_id)
            ids, unmatched = resolve_ids(entries, by_path, by_base, by_meta)

        if not ids:
            # Still empty: keep the user's PRIOR playlist (do NOT prune it) and
            # do NOT create an empty one. Fail loudly so sync.sh surfaces it.
            raise SystemExit(
                "Jellyfin matched 0 tracks for '%s' even after a full scan — the "
                "files aren't in the Music library yet; it should populate on the "
                "next run" % name)

        if unmatched:
            err("note: %d entry(ies) had no Jellyfin match (skipped): %s"
                % (len(unmatched), ", ".join(os.path.basename(p) for p in unmatched[:5])
                   + (" ..." if len(unmatched) > 5 else "")))

        # 4) Create the populated playlist in one shot (returns its Id directly).
        new_id = create_playlist(base, key, user_id, name, ids)

        # 5) Confirm non-empty before we prune anything.
        count = playlist_item_count(base, key, user_id, new_id)
        if count == 0:
            # Defensive: create reported success but the playlist reads empty.
            # Drop our empty creation, keep the user's prior playlist, fail loudly.
            delete_playlist(base, key, new_id)
            raise SystemExit(
                "Jellyfin created an empty playlist for '%s' — keeping the prior "
                "one; it should populate on the next run" % name)

        err("uploaded playlist '%s' (%d track%s)"
            % (name, count, "" if count == 1 else "s"))
        err("note: an already-open Jellyfin/Finamp client may need a refresh "
            "before a brand-new playlist appears.")

        # 6) Safe now: delete the prior same-titled playlist(s) we're replacing.
        #    Never touch the one we just created.
        for pid in stale:
            if pid != new_id:
                delete_playlist(base, key, pid)

        # 7) Cosmetic: best-effort poster. Swallows every failure.
        set_poster(base, key, new_id,
                   resolve_art_url(spotify_ref=args.art_spotify, sxm_slug=args.art_sxm_slug))
    except (urllib.error.URLError, OSError) as e:
        # Jellyfin momentarily unreachable (connection refused / DNS / timeout).
        # Exit cleanly — sync.sh keeps the downloaded tracks and retries next run.
        raise SystemExit("Jellyfin API unreachable (%s) — tracks are downloaded; "
                         "will retry next run" % e)


if __name__ == "__main__":
    main()
