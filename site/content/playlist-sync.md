---
title: "Playlist Sync"
description: "Mirror SiriusXM channels into your library as Plex or Jellyfin playlists, refreshed on a schedule."
lede: "Mirror SiriusXM channels into your library as Plex or Jellyfin playlists."
group: "Music"
order: 3
---
Playlist Sync is a hands-off worker that keeps SiriusXM channels mirrored into your music library as playlists, refreshed automatically on a schedule.

> **In one sentence:** pick some SiriusXM channels in the installer, and Mediarr downloads each track (Soulseek first, with a yt-dlp fallback) and turns each channel into a playlist you can play in Plexamp or Jellyfin, re-syncing on its own every day.

> Want Soulseek wired into **Lidarr** for your wanted albums instead? See [Music downloads with Soulseek](music-setup). Want to **play** your library as smart stations? See [Plexamp](music-playback).

## What You Need

- **Plex or Jellyfin.** Either works. Playlist Sync uploads through whichever one you installed.
- **A second free Soulseek account.** Your stack's main Soulseek session belongs to `slskd`, and Soulseek only allows one session per account, so Playlist Sync needs its own login. Creating one is free and takes a minute in the [Soulseek desktop client](https://www.slsknet.org) or the slskd web UI.

That's the whole list. SiriusXM channel rotations come from [xmplaylist.com](https://xmplaylist.com), which needs no account, no key, and no subscription. You don't need to be a SiriusXM subscriber to use this.

Note: Playlist Sync used to offer Spotify playlists as a second source. That was removed in v0.17.0, so this feature is SiriusXM-only now. Nothing else about it changed.

## Turning It On

In the installer's **Configure** screen, open the **Music** group and enable **Playlist Sync**. It's off by default. Then fill in:

Soulseek username and password - your *second* free Soulseek login, not the one slskd uses.

SiriusXM channels - search and tick channels in the dropdown, which lists every SiriusXM channel by name. Anything not listed can be added as a custom slug.

Schedule and format - optional. A cron schedule (default daily at 4 AM) and preferred audio format (default FLAC).

You need at least one SiriusXM channel.

### Picking Channels

Start typing in the **SiriusXM channels** box. It searches the full SiriusXM directory by name, so try "octane", "80s", or "hip hop", and tick the ones you want. If a channel isn't listed, add it by its [xmplaylist.com](https://xmplaylist.com) slug using the custom slug box.

Playlists are named after the channel the friendly way, so you get `Turbo - SiriusXM` rather than a URL slug.

## How It Works

Each scheduled run, for every channel:

1. The channel's recent rotation is fetched from xmplaylist.com as a track list.
2. Each track is downloaded Soulseek first. Anything Soulseek can't supply falls back to yt-dlp.
3. Downloads and a per-playlist `.m3u` land under `Media/Music/Playlists/<playlist>/`, the same library your media server scans.
4. The media server is told to scan the new files, and only then is the playlist uploaded, replacing the previous copy so re-runs don't pile up duplicates.

That ordering in steps 3 and 4 matters more than it looks. Uploading a playlist before the tracks have been scanned in produces an empty playlist, which was a real bug worth fixing properly.

It runs once when first enabled so you see results immediately, then on the schedule. Everything routes through your VPN, like Soulseek does.

### Monthly Archives

Alongside the rotating per-channel playlist, Playlist Sync keeps a permanent monthly archive: a Top 50 for each channel named `<station> (YYYY-MM)`. Those are never overwritten, so over time you build a listenable record of what a station was playing in any given month. Turn it off with `PLAYLIST_MONTHLY_ARCHIVE=false` if you'd rather not.

### Cover Art

Playlists get real cover art where it can be found, on a best-effort basis. A playlist with no art isn't a failure, it just means no artwork was available for that channel.

## Notes And Troubleshooting

- **Nothing appears yet.** Give the first run time. Downloading a whole channel's rotation off Soulseek isn't instant. Check the container logs with `docker logs playlistsync`.
- **A track is missing from a playlist.** It wasn't found on Soulseek *or* via yt-dlp. Each track is independent, so this only affects that one entry.
- **Re-runs only fetch new tracks.** A per-playlist index means a daily sync just adds what's new rather than re-downloading everything.
- **Playlists appear empty in Plexamp.** Plexamp caches aggressively. Pull to refresh, or check the playlist in Plex's own web UI first to confirm whether it's actually empty.
- **It's opt-in and hands-off.** Once configured it survives reboots and VPN changes on its own. You shouldn't need to touch it again.
