---
title: "Requesting Movies & TV"
description: "The everyday flow. Search, click Request, and wait for it to show up."
lede: "The everyday flow. Search, click Request, and wait for it to show up."
group: "Using your stack"
order: 2
aliases: "Requesting-Movies-and-TV"
---
This guide covers the **everyday way you actually use the stack**: a Netflix-style
request page where you (and anyone you invite) search for a movie or show, click
**Request**, and the stack quietly finds it, downloads it, and adds it to Plex.

> **In one sentence:** open the request portal, search a title, click Request —
> a while later it's in Plex/Jellyfin, ready to play. You never touch Sonarr or
> Radarr directly.

> Using Jellyfin instead of Plex? Everything below is identical — your portal is
> **Jellyseerr** (it works with both). Want to drive Sonarr/Radarr by hand for
> finer control? See [Movies & TV](Movies-and-TV).

## What it is

**Seerr** (Plex) / **Jellyseerr** (Jellyfin) is the friendly front door to the
stack. It shows a browsable, searchable catalogue of movies and shows; when
someone requests one, it hands the job to **Radarr** (movies) or **Sonarr** (TV),
which do the actual finding and downloading. The installer wires those connections
for you — including the quality profile — so there's nothing to configure beyond
signing in.

Open it at **`http://<your-NAS-IP>:5056`** (find the exact link on your
[Homepage dashboard](Dashboard)).

## First-time setup (once)

1. Open `http://<your-NAS-IP>:5056`.
2. **Sign in with Plex** (or your Jellyfin account). This is the same login you
   use to watch — Seerr uses it to know who you are and what's already in your library.
3. That's it. The installer already connected Seerr to Radarr and Sonarr, so you
   land straight on the Discover page. (If you ever need to check, it's under
   **Settings → Services**.)

## Requesting something

1. Search for a movie or show (or browse **Discover** / **Trending**).
2. Open it and click **Request**.
   - **Movies** download as a single request.
   - **TV** lets you pick **which seasons** (or all) before requesting.
3. As the owner, your own requests are **auto-approved** and sent straight to
   Radarr/Sonarr. You'll see the status move from **Requested → Processing →
   Available** as it downloads and imports.
4. When it flips to **Available**, it's in Plex/Jellyfin — just play it.

## Letting other people request

This is the point of Seerr — friends and family request without touching anything technical:

1. **Settings → Users → Import Plex Users** (or invite by email for Jellyfin).
2. They sign in with their own Plex/Jellyfin account and request what they want.
3. Their requests land in your **Requests** list as **Pending** — approve or deny
   with one click. (You can also turn on auto-approval per user under their permissions.)

## Tips

- **Notifications:** Settings → Notifications wires up Discord, Telegram, email,
  etc. — get pinged when a request becomes available.
- **Already in your library?** Seerr greys out the Request button and shows
  **Available** for anything Plex/Jellyfin already has, so you don't double-request.
- **Nothing downloads after requesting?** The request reached Radarr/Sonarr but
  they found no release — usually an [indexer](Indexers) gap (too few sources, or
  a strict [quality profile](Quality-Profiles)). Check the item in Radarr/Sonarr's
  Activity → Queue, or loosen the profile.
- **Migrating from Overseerr?** Seerr is a fork and can import your old request
  history: **Settings → Import**.

## Where this fits

```
You (Seerr)  →  Radarr / Sonarr  →  Indexers  →  qBittorrent / SABnzbd  →  Plex
  request          find + manage      search        download (via VPN)      watch
```

Each step has its own short guide: [Movies & TV](Movies-and-TV) ·
[Indexers](Indexers) · [Downloads & VPN](Downloads-and-VPN) ·
[Media Server](Media-Server).
