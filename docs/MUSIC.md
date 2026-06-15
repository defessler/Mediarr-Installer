# Music on your NAS

Everything music-related the installer can set up, and which guide to read for each.
Three things you might want — **get** music, **play** it, **broadcast** it:

## 🎵 Get music into your library

- **Indexers (torrent + Usenet).** Add dedicated music trackers — **Redacted (RED)**,
  **Orpheus**, **RuTracker** — and Usenet indexers (**NZBFinder**, **NZB.su**) in the
  wizard's **Configure → Find indexers** screen (filter by **Music**), or via
  `nas/scripts/.env.example`. Lidarr then searches them automatically. No separate guide —
  it's part of the normal indexer setup.
- **Soulseek** — peer-to-peer music for the rare things indexers can't find. Opt-in, runs
  through your VPN. → **[MUSIC-SETUP.md](MUSIC-SETUP.md)**

## ▶️ Play your library

- **Plexamp** — turn your own Plex music into SiriusXM-style smart stations and playlists.
  → **[MUSIC-PLAYBACK.md](MUSIC-PLAYBACK.md)**

## 📻 Broadcast your library

- **AzuraCast** — run your own 24/7 internet-radio stations from your library, with a live
  now-playing tile on your dashboard. Opt-in (heavier service). → **[MUSIC-RADIO.md](MUSIC-RADIO.md)**

---

*Internal planning/research (not shipped user features): `MUSIC-SOURCES-PLAN.md`,
`MUSIC-SOURCES-DEEZER-RESEARCH.md` — the latter covers a possible future Deezer-streaming
integration that is researched but **not** implemented.*
