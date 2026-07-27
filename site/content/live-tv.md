---
title: "Live TV & DVR"
description: "Dispatcharr: free live channels and a DVR tuner for Plex or Jellyfin, no Plex Pass needed for recording."
lede: "Free live channels and a DVR, presented to Plex or Jellyfin as a tuner."
group: "Using your stack"
order: 9
---
Dispatcharr manages live TV channels and presents itself to Plex or Jellyfin as an HDHomeRun tuner. It also records on its own, which is the part worth understanding, because it means DVR works without a Plex Pass.

> **In one sentence:** turn on Live TV in the installer, pick some free channel packs, and you get a program guide and a DVR without buying anything.

It's opt-in and off by default. Added in v0.19.0.

## What You Get

Around 2,300 channels, if you seed all five packs, from free ad-supported services:

- **Pluto TV**
- **Samsung TV Plus**
- **Plex Live TV**
- **Roku**
- **Tubi**

These are the same free streaming channels those services offer publicly. They come with a full program guide, so the result behaves like a channel lineup rather than a list of streams.

You can also bring your own IPTV or Xtream sources instead of, or alongside, the free packs. Dispatcharr doesn't care where a channel comes from.

## Recording Without A Plex Pass

This is the bit people get wrong, so it's worth being precise.

Plex's own live TV and DVR features require a Plex Pass. Dispatcharr's DVR doesn't, because Dispatcharr does the recording itself. It writes finished recordings into `Media/Recordings` as ordinary video files, and your media server then indexes them the same way it indexes anything else in your library.

So the split is:

Recording - Dispatcharr does it, free, on Plex or Jellyfin.

Live tuning inside Plex - needs a Plex Pass, because that's Plex's own feature and Dispatcharr is just the tuner it talks to.

Live tuning inside Jellyfin - free, since Jellyfin's live TV and DVR aren't paywalled.

Watching in Dispatcharr's own web UI - free, always, regardless of media server.

IMPORTANT: recordings land in `Media/Recordings` and nothing prunes them. A season pass on a daily show will fill a disk eventually. [Librarian](storage) will show you when that's happening.

## Turning It On

In the installer's **Configure** screen, enable **Live TV & DVR**. You'll need to set an admin username and password. The installer creates that account on Dispatcharr's first boot and then uses it to seed everything, so a blank password means the feature deploys unconfigured.

Pick which channel packs to seed. All five are pre-selected, which gives you the fullest guide out of the box. Trim the list if you'd rather not have 2,300 channels.

Then finish the run. Step 10 of the install does the rest: it waits out Dispatcharr's slow first boot, creates the admin account, signs in, seeds the packs' M3U and guide sources, turns on channel auto-sync so imported streams become real tuner channels, and, on Jellyfin, registers the tuner and guide for you.

Note: Dispatcharr's first boot is genuinely slow. It runs database migrations before it serves anything, so a "not serving HTTP yet" warning at the end of an install is expected rather than a problem. Give it a few minutes and re-run the health check.

### What It Costs You

Dispatcharr is the heaviest thing in the stack by some margin, and it's worth knowing that before you turn it on. It's the only service that bundles PostgreSQL, Redis, Celery and FFmpeg into one container, which is why it's opt-in rather than always-on.

Budget roughly 2 GB of RAM for it, more if you record and stream at the same time, since FFmpeg does the work for both.

IMPORTANT: on a NAS that's already tight on memory, the usual symptom is not a helpful error. The container gets killed part-way through its first-boot migrations, Docker restarts it, and it loops forever showing "restarting" and never answering on 9191. If that happens, check `docker inspect -f '{{.State.OOMKilled}}' dispatcharr`. A `true` there means memory, not configuration, and no amount of re-running the installer will fix it.

## Finding It

The web UI is on port 9191, and there's a tile for it on your [dashboard](dashboard). Everything about the channel lineup, the guide, and recording schedules lives in that UI.

On Jellyfin the tuner is registered automatically, so live TV shows up in Jellyfin without you configuring anything.

On Plex you'll need to add the tuner yourself, under **Settings → Live TV & DVR → Set up Plex DVR**. Plex should discover it on the network as an HDHomeRun. Remember this part is the Plex Pass gate, and Dispatcharr's own recording works regardless.

## Notes

- **It's LAN-only and not behind the VPN.** Plex and Jellyfin have to reach it on your network as a tuner, so it publishes directly. Putting it behind the VPN would make it invisible to your own media server.
- **Free channels come and go.** These lineups are maintained by the streaming services, not by Mediarr. Channels appearing and disappearing over time is normal, and re-syncing the source picks up the current lineup.
- **Guide data is included.** You don't need a separate XMLTV subscription for the free packs.
