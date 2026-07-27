---
title: "Movies & TV"
description: "Sonarr and Radarr: add titles directly and track what they are doing."
lede: "Sonarr and Radarr: add titles directly and track what they are doing."
group: "Using your stack"
order: 4
---
Sonarr and Radarr are the engines behind your movie and TV library — they watch for wanted content, search your indexers, hand the best release to your download client, and import it into your media server automatically.

> **In one sentence:** add a show or movie, and Sonarr/Radarr take it from there — searching, downloading, and dropping it into your library with no further effort from you.

> The **easiest way** to request movies and TV is through the Seerr portal — search, click Request, done. See [Requesting Movies and TV](Requesting-Movies-and-TV). This page is for adding things directly when you want finer control.

## What they do

**Sonarr** manages TV shows; **Radarr** manages movies. They work identically:

1. You add a title and tell them to monitor it.
2. They search your [Indexers](Indexers) for a release that matches your [Quality Profile](Quality-Profiles).
3. The best match goes to [qBittorrent or SABnzbd](Downloads-and-VPN) for downloading.
4. Once the download finishes, they **import and rename** the file into your media library using a hardlink — no extra disk space used.

After that first add, everything is hands-off. The installer already wired up the download clients, root folders, quality profiles, and indexer connections for you.

## Adding a movie or TV show directly

**Radarr (movies)** — open `http://<NAS-IP>:49151` or click its tile on your [Dashboard](Dashboard).

1. Click **Movies → Add New Movie**.
2. Search for the title and select it.
3. The **root folder** (`/data/Media/Movies`) and **quality profile** are already set by the installer — leave them as-is unless you have a reason to change.
4. Click **Add Movie**. Radarr searches immediately; if a release exists it starts downloading.

**Sonarr (TV)** — open `http://<NAS-IP>:49152` or click its tile on your [Dashboard](Dashboard).

1. Click **Series → Add New Series**.
2. Search for the show and select it.
3. The **root folder** (`/data/Media/TV Shows`) and **quality profile** are already set.
4. Choose **which seasons** to monitor (all, future only, or specific seasons).
5. Click **Add Series**. Sonarr searches for any monitored episodes that are already released.

## Checking progress

- **Activity → Queue** — shows everything currently downloading or being imported.
- **Wanted → Missing** — titles it's monitoring but hasn't found a release for yet.
- **History** — a log of every grab, download, and import.

## Quality and sources

Your quality profile controls which releases are acceptable (resolution, codec, source). The installer sets a sensible default — **web-1080p** for Sonarr and **hd-bluray-web** for Radarr via Recyclarr. To change it, see [Quality Profiles](Quality-Profiles).

Releases are found through [Indexers](Indexers) — Prowlarr syncs them into both Sonarr and Radarr. If you need more sources, add them in Prowlarr.

Downloads run through [Downloads & VPN](Downloads-and-VPN) — qBittorrent sits entirely inside the VPN container, so your IP is never exposed.

## Where files land

Your media server (Plex at `:32400` or Jellyfin at `:8096`) reads from:

| Library | Path |
|---|---|
| Movies | `/media/Movies` |
| TV Shows | `/media/TV Shows` |
| Anime Movies | `/media/Anime/Movies` |
| Anime TV | `/media/Anime/TV Shows` |

See [Media Server](Media-Server) for library setup and playback.

## Tips

- **Nothing is downloading?** The most common cause is no release matched — either too few indexers (add more in Prowlarr) or a quality profile that's too strict (loosen it in [Quality Profiles](Quality-Profiles)). Check **Wanted → Missing** and look at the search results icon next to the title for clues.
- **You don't need to touch settings.** The installer already enabled hardlinks, connected the download client, and set root folders. Sonarr and Radarr should work out of the box.
- **For music**, the equivalent is Lidarr — see [Music Setup](Music-Setup) for how to get it running with Soulseek.
- **Prefer requesting?** Go to [Requesting Movies and TV](Requesting-Movies-and-TV) — it's faster for day-to-day use and works for your whole household without anyone touching Sonarr or Radarr directly.
