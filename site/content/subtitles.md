---
title: "Subtitles"
description: "Bazarr: automatic subtitles in the languages you pick."
lede: "Bazarr: automatic subtitles in the languages you pick."
group: "Using your stack"
order: 7
---
Bazarr watches everything Sonarr and Radarr import and automatically downloads matching subtitles — so your movies and shows just have subtitles, without you lifting a finger.

> **In one sentence:** set your preferred languages once, and Bazarr quietly fetches subtitles for every new import and most of your existing library.

> Bazarr works alongside your media apps. For the full picture of how content gets into your library, see [Movies & TV](Movies-and-TV) and the [Media Server](Media-Server) guide.

## What the installer already did

The installer connected Bazarr to both Sonarr and Radarr and switched on a handful of free subtitle providers. You don't need to wire anything up — Bazarr is already watching both apps and will start grabbing subs as soon as you tell it which languages you want.

Open it at **`http://<NAS-IP>:49153`** or click the **Bazarr** tile on your [Dashboard](Dashboard).

## Pick your languages (do this first)

Bazarr uses "Language profiles" — a named list of languages in priority order. You create one profile and assign it to your shows and movies.

1. Open Bazarr and go to **Settings → Languages**.
2. Under **Language Profiles**, click **Add Profile**.
3. Give it a name (e.g. *English*), add your language(s), and save.
4. Still in **Settings → Languages**, set the default profile for **Series** and for **Movies** to the profile you just created.
5. Save. Bazarr will start searching for subtitles on a schedule and backfill your existing library over the next few hours.

## Add provider accounts for better coverage (optional)

The installer enables some free providers out of the box. For a much higher hit rate — especially for recent releases — add a free account at **OpenSubtitles.com**:

1. Go to **Settings → Providers**.
2. Find **OpenSubtitles.com** (not .org — they are separate) and click the pencil icon.
3. Enter your username and password and save.

You can also add **Addic7ed** and **OpenSubtitles.org** the same way. The installer's Configure screen has a **Bazarr subtitle providers** section where you can enter these credentials up front if you'd prefer to supply them during a re-run.

## Grabbing subs for existing media

Bazarr searches on a schedule and works through your library automatically. If you want subs on a specific title right now:

1. Click **Series** or **Movies** in Bazarr's sidebar.
2. Find the show or movie and open it.
3. Click **Search** next to a specific episode or the whole series/movie to trigger an immediate download.

## Tips

- **A free OpenSubtitles.com account is the single biggest improvement you can make.** The unauthenticated rate limit is very low; a free account removes it and unlocks a much larger catalogue.
- **Missing subs on a show or movie?** The most common cause is that no Language profile is assigned to it. In Bazarr, open the item and check the **Language Profile** field — set it to your profile and click Search.
- **New imports are handled automatically.** Every time Sonarr or Radarr finishes importing something, it notifies Bazarr, which searches right away.
- **Wrong language downloaded?** Open the episode in Bazarr, delete the bad subtitle, and click Search to try again. You can also blacklist a specific subtitle so Bazarr skips it next time.
- Want to know which providers Bazarr is using or how many subs it has fetched? **System → Status** shows provider health and download counts.
