---
title: "Indexers"
description: "Where your downloads actually come from, and how to add your own."
lede: "Where your downloads actually come from, and how to add your own."
group: "Using your stack"
order: 5
---
Indexers are the search sources that tell Sonarr, Radarr, and Lidarr *where* to find a
given movie, show, or album. Without them, the stack has nothing to search.

> **In one sentence:** an indexer is a directory of what's available to download. Add
> your indexers once in Prowlarr and it pushes them to every *arr app automatically.

> New to the stack? The [Downloads & VPN](Downloads-and-VPN) guide covers qBittorrent
> and SABnzbd (the clients that do the actual downloading once an indexer finds a release).
> To see how requests flow end-to-end, start at [Requesting Movies & TV](Requesting-Movies-and-TV).

## What an indexer actually is

Think of an indexer as a catalog. When Radarr wants a movie, it asks the indexer
"do you have this?" and gets back a list of releases with their sizes, qualities, and
download links. There are two kinds:

- **Torrent indexers** - free to use, public or private, and every torrent goes through
  your VPN (qBittorrent runs inside the Gluetun container, so if the VPN drops, downloads
  stop rather than exposing your IP).
- **Usenet indexers** - very fast, typically require a paid usenet provider *and* a
  (sometimes paid) indexer membership. See [Downloads & VPN](Downloads-and-VPN) for
  provider setup.

## Prowlarr: one place to manage them all

**Prowlarr** (`:49150`) is the indexer manager for your whole stack. You add an indexer
once in Prowlarr and it syncs automatically to Sonarr, Radarr, and Lidarr, with no
per-app setup needed.

Open it from the [Dashboard](Dashboard) tile, or directly at `http://<NAS-IP>:49150`.

## What the installer already did

The wizard added a set of free public torrent indexers for you during install. Most
people can request content straight away without touching Prowlarr at all.

## Adding more indexers

**Option 1, re-run the installer** (recommended for first-time additions):

1. Open the installer and go to **Configure → Advanced**.
2. The indexer browser lists the curated catalog. Filter by content type, cost, or
   signup requirement to find what you need.
3. For free public trackers, just check the box. No account needed.
4. For private trackers or usenet indexers, paste your API key (or username/password)
   into the field next to the indexer name.
5. Finish the wizard. Prowlarr picks up the new indexers and pushes them to your *arr apps.

**Option 2, add directly in Prowlarr:**

1. Open Prowlarr from the [Dashboard](Dashboard).
2. Go to **Indexers → Add Indexer**.
3. Search for your indexer, fill in your credentials, and click **Test** to confirm it
   works, then **Save**.
4. Prowlarr syncs it to Sonarr, Radarr, and Lidarr within a minute.

## Tips

- **More good indexers = more releases found.** If a request sits in Sonarr/Radarr for
  hours without downloading, the most common cause is too few indexers (or indexers that
  don't carry that content category). Add a couple more and re-search.
- **Test before you trust.** Hit the **Test** button next to any indexer in Prowlarr
  before counting on it. It confirms the connection is live and your credentials work.
- **Filter by category.** If you only care about music, add indexers marked for Music.
  Adding unrelated ones just adds noise to searches.
- **Private trackers** usually give better quality and availability than public ones, but
  require an invite or registration. Usenet is the fastest option when availability is
  good, see [Downloads & VPN](Downloads-and-VPN).
- **Quality profile affects what gets grabbed.** If an indexer returns results but nothing
  downloads, check your [Quality Profiles](Quality-Profiles), since the release may not meet
  the minimum score. Loosening the profile or adding more indexers usually fixes it.

## Where this fits

```
Prowlarr (indexers)  →  Sonarr / Radarr / Lidarr  →  qBittorrent / SABnzbd  →  Plex / Jellyfin
  search sources          find + manage releases        download (via VPN)         watch / listen
```

Each step has its own short guide: [Requesting Movies & TV](Requesting-Movies-and-TV) ·
[Movies & TV](Movies-and-TV) · [Downloads & VPN](Downloads-and-VPN) ·
[Quality Profiles](Quality-Profiles) · [Media Server](Media-Server).
