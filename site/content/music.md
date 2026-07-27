---
title: "Music"
description: "The map of every music feature and which guide covers it."
lede: "The map of every music feature and which guide covers it."
group: "Music"
order: 1
---
Everything music-related the installer can set up, and which guide to read for each.
Three things you might want — **get** music, **play** it, **broadcast** it:

## 🎵 Get music into your library

- **Indexers (torrent + Usenet).** Add dedicated music trackers — **Redacted (RED)**,
  **Orpheus**, **RuTracker** — and Usenet indexers (**NZBFinder**, **NZB.su**) in the
  wizard's **Configure → Find indexers** screen (filter by **Music**), or via
  `nas/scripts/.env.example`. Lidarr then searches them automatically. No separate guide —
  it's part of the normal indexer setup.
- **Soulseek** — peer-to-peer music for the rare things indexers can't find. Opt-in, runs
  through your VPN. → **[MUSIC-SETUP.md](Music-Setup)**
- **Playlist Sync** — auto-mirror SiriusXM channels + public Spotify playlists into Plex playlists, downloaded for you on a schedule. Opt-in, runs through your VPN. Needs Plex. → **[Playlist Sync](Playlist-Sync)**

## ▶️ Play your library

- **Plexamp** — turn your own Plex music into SiriusXM-style smart stations and playlists.
  → **[MUSIC-PLAYBACK.md](Music-Playback)**

---

*Internal planning/research (not shipped user features): `MUSIC-SOURCES-PLAN.md`,
`MUSIC-SOURCES-DEEZER-RESEARCH.md` — the latter covers a possible future Deezer-streaming
integration that is researched but **not** implemented.*
