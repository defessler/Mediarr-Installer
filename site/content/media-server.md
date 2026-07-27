---
title: "Media Server"
description: "Plex or Jellyfin: sign in once, find your libraries, play anywhere."
lede: "Plex or Jellyfin: sign in once, find your libraries, play anywhere."
group: "Using your stack"
order: 3
---
This guide covers the app that actually **streams your library** to TVs, phones, and browsers. That's Plex or Jellyfin, whichever you chose when you ran the installer.

> **In one sentence:** open your media server, sign in once, and everything Sonarr/Radarr/Lidarr has imported is already there waiting to play.

> The easiest way to add new movies or shows is the request portal. See
> [Requesting Movies & TV](Requesting-Movies-and-TV). To drive Sonarr or Radarr
> by hand, see [Movies & TV](Movies-and-TV).

## What it is

Your installer asked you to pick one:

- **Plex** (default) - streams to every platform via the Plex app, and needs a free Plex account. Open it at **`http://<NAS-IP>:32400/web`**.
- **Jellyfin** - fully open-source, no account required. Open it at **`http://<NAS-IP>:8096`**.

Either way, find the tile on your [Homepage dashboard](Dashboard) for the quickest link.

## First-time setup (once)

### Plex

1. Open **`http://<NAS-IP>:32400/web`** directly in your browser, at the IP address rather than the cloud URL. If the server shows up with a hashed or random name and won't let you in, it hasn't been claimed yet. Opening it via the direct IP link fixes that.
2. Sign in with your Plex account. Plex will claim this server to your account automatically.
3. Your libraries are already created and pointed at the right folders, so click through the setup wizard and accept the defaults.

### Jellyfin

1. Open **`http://<NAS-IP>:8096`**.
2. Create your **admin account** on first run (you choose the username and password).
3. The installer needs a Jellyfin API key so the arrs can trigger library scans. Go to **Dashboard → API Keys**, generate one, and paste it into the installer's **Run screen** (re-run the installer, go past Configure to the Run screen, and paste the key into the Jellyfin API key field). Then run Install.
4. Your libraries are already set up, so click through the wizard and accept the defaults.

## Your libraries

The installer pre-creates these libraries pointing at the right paths on your NAS:

| Library | Path |
|---|---|
| Movies | `/media/Movies` |
| TV Shows | `/media/TV Shows` |
| Music | `/media/Music` |
| Anime Movies | `/media/Anime/Movies` |
| Anime TV Shows | `/media/Anime/TV Shows` |

You don't need to add or change anything. When Sonarr or Radarr imports a new file, it notifies the media server and the item appears automatically, usually within a minute or two.

## Playing your library

Install the **Plex** or **Jellyfin** app on your TV, phone, or tablet, sign in with the same account you set up above, and browse your library.

For music, Plex users can also use **Plexamp**, a dedicated music player with radio-style playback. See [Music Playback](Music-Playback).

## Tips

- **Media imported but not showing up?** The import notification from Sonarr/Radarr may have failed. In Plex, go to your library, click the **...** menu, and choose **Scan Library Files** to force a refresh. For Jellyfin, go to **Dashboard → Libraries** and run a scan. Alternatively, re-run the installer (Update mode → Refresh dashboard) to re-sync everything.
- **Plex shows a "secure connection" warning or can't find your server through the app?** Access it directly via `http://<NAS-IP>:32400/web` instead of going through app.plex.tv. Local direct access bypasses the relay and is always faster.
- **Plex "Update Library Automatically" is off?** Check **Settings → Libraries** in the Plex web UI and make sure automatic library updates are enabled, so new imports appear without manual scans.
- **Want to add content?** Use [Requesting Movies & TV](Requesting-Movies-and-TV), which is the easiest path. For direct queue management, use [Movies & TV](Movies-and-TV).
