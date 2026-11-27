---
title: "Game ROMs"
description: "ROMarr: add a game to a Wanted list and it finds, downloads, and files the ROM by platform."
lede: "The Sonarr pattern, pointed at game ROMs."
group: "Using your stack"
order: 12
---
This page is meant to talk about ROMarr and how to set it up.

ROMarr is an *arr for game ROMs. You add a game to its Wanted list. It searches your indexers through Prowlarr, sends the best release to qBittorrent or SABnzbd, and files the finished ROM under `Media/Games/<platform>`.

> **In one sentence:** turn on ROMarr, open it, and add a game to Wanted.

It's opt-in and off by default, like everything on the reading page. It's also marked beta. We've tested the wiring against ROMarr's own source. It hasn't run on a live NAS yet. Expect a rough edge or two.

## Turning It On

Tick "ROMarr" under "Games" on the Configure screen. You can also set `ENABLE_ROMARR=true` in the NAS's `.env` and re-run. It answers on `http://<NAS-IP>:49162`.

The first thing to do after install is open it, because of how its login works:

- If you set `ARR_PASSWORD`, ROMarr uses it. Log in with that.
- If you left `ARR_PASSWORD` blank, the first person to open ROMarr's web UI sets its password. Open it straight after install so that person is you.

Note: `ARR_PASSWORD` only seeds the login once. Change it later and ROMarr keeps the old one until you change it in ROMarr's own settings too.

## What the Installer Sets Up

The installer sets up more for ROMarr than it does for Mylar3 or LazyLibrarian. There's very little to finish by hand.

- Prowlarr - Added as ROMarr's indexer, with Prowlarr's real API key. Every tracker you've added to Prowlarr is searchable from ROMarr.
- qBittorrent - Added as a download client when you have qBittorrent on, with the `romarr` category. It goes through the VPN like the rest of your torrents.
- SABnzbd - Added as a download client when you have SABnzbd on. The installer also creates its `romarr` category.
- Path mappings - Two mappings so ROMarr can find what the download clients finished: `/downloads = /data/Downloads/Torrents` for qBittorrent and `/data/complete = /data/Downloads/Usenet/complete` for SABnzbd.
- Library - A plain folder library at `Media/Games`. ROMarr makes the per-platform folders under it as it files things.

A re-run rewrites those entries, which is how a changed Prowlarr key or `QBITTORRENT_PASS` gets fixed. It only touches the entries it made. If you've added your own Prowlarr or your own qBittorrent on another host, the installer leaves yours alone and doesn't add a second one.

### Why It's Wired Differently

Mylar3 and LazyLibrarian are Prowlarr Applications. Prowlarr pushes your indexers into them. ROMarr can't work that way. Prowlarr supports exactly seven application types and none of them is a game app. So the link runs the other way. ROMarr holds a Prowlarr entry with Prowlarr's address and key.

ROMarr can also read those settings from environment variables. It only reads them on its very first boot, though. On a fresh install Prowlarr's key doesn't exist yet at that point. That route would store an empty key for good. The installer sets them through ROMarr's API after Prowlarr is up instead.

## Being Straight About Coverage

General-purpose indexers carry very little in the way of ROMs. Most of what ROMarr finds comes from trackers you add to Prowlarr yourself. Which ones you add is your call. Expect a much lower hit rate than Sonarr gives you for TV, at least until you've added a source that carries games.

Whether a given ROM is yours to download is also your call, not ours. The installer adds no game-specific sources for you.

## Or Just Drop Files In

`Media/Games` works as a plain folder whether or not ROMarr is doing the finding:

```
<your data root>/Media/Games/
```

Check out ROMarr's own Settings → Libraries if you'd rather it filed into RomM, Gaseous, or Retrom. It supports all three. We don't install any of them. You'd point ROMarr at one you already run.

## If Something Looks Wrong

- ROMarr finds nothing at all - The Prowlarr link didn't land. The install log says so with a warning. Re-run the configure step. You can also add it by hand under ROMarr → Settings → Indexers with `http://prowlarr:9696` and the key from Prowlarr → Settings → General.
- Downloads finish but never import - Look at the path mappings under ROMarr → Settings → General. They should match the two in the list above.
- The tile is grey on the Done screen - ROMarr loads its platform catalog on first boot. Give it a minute and re-check.
