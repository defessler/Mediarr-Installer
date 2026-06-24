# Future Media Expansion (parked)

We explored expanding the stack with curated media (music videos, K-Pop/J-Pop/Anime music, video-game music) and SHIPPED a Music Videos service (v0.16.26), then decided to keep the core lean and REMOVE it together with the Spotify integration. Everything is recoverable and documented here so any piece can be re-added as a scoped task.

## What was removed & how to recover it

Removed in installer-v0.17.0: the Spotify half of Playlist Sync (Playlist Sync is now SiriusXM-only) and the "musicvideos" opt-in service. The exact pre-removal code is tagged **archive/media-expansion-v0.16.27**. Recover a file with:

```
git checkout archive/media-expansion-v0.16.27 -- nas/scripts/musicvideos
git show archive/media-expansion-v0.16.27:installer/src/renderer/components/SpotifyConnect.tsx
```

## How to re-add an opt-in download service (verified recipe)

Mirror the old "musicvideos" wiring across: an ENABLE_* flag in nas/scripts/.env.example; the compose service in nas/scripts/docker-compose.yml (bridge net for YouTube, or network_mode container:gluetun for VPN/P2P); the install-time profile + opt-in validation array in nas/scripts/setup.sh; the reboot profile case in nas/scripts/boot-orchestrator.sh; config+data dirs in nas/scripts/setup-folders.sh; wizard keys in installer/src/shared/env-schema.ts (+ superRefine) and env-render.ts (interface + line() emit); UI in installer/src/renderer/screens/ConfigureScreen.tsx (SERVICE_TOGGLES, OPT_IN_SERVICES, humanizeKey, a gated <section>); a CI image workflow in .github/workflows/; and a VARIANT in installer/test/unit/env-schema-parity.test.ts. The key-parity + env-schema-parity tests fail unless a new .env.example key is also in schema AND render.

## Per-feature findings (2026 research)

### Music Videos

The removed service used yt-dlp + a curated MUSIC_VIDEO_SOURCES list (no UI). For a real search-and-click UI, **Youtarr** (github.com/DialmasterOrg/Youtarr) is the only tool with true in-app YouTube keyword search + click-to-download — but VIDEO-ONLY. Writes NFO + native Plex/Jellyfin playlists, built-in auth.

### Anime music (headline ask: "search an anime -> all its music as audio and/or video")

**AnimeThemes.moe** fits — free, legal, organized BY anime, every OP/ED as BOTH video (WebM) and audio (~320k OGG). Verified API recipe:

```
GET https://api.animethemes.moe/search?q=<name>&fields[search]=anime
GET https://api.animethemes.moe/anime/<slug>?include=animethemes.song.artists,animethemes.animethemeentries.videos.audio
```

each theme yields a video link (v.animethemes.moe/*.webm) and audio link (a.animethemes.moe/*.ogg). Gap: existing downloaders are dormant + "dump my whole MAL list", NOT search-driven — so a thin custom web UI over this API is the one justified build. Full OST (BGM) is NOT on AnimeThemes -> use slskd.

### K-Pop / J-Pop music

Use the **slskd** Soulseek web UI ALREADY in this stack (ENABLE_SOULSEEK -> slskd at LAN_IP:5030, VPN-routed): search -> filter -> pick -> download; deepest free catalog for these genres, often FLAC, zero new auth. Pair with a **beets** (MusicBrainz) tagging pass so Plexamp groups it.

### Video Game Music

KHInsider + VGMdb (metadata). See docs/MEDIA-CATEGORIES-RESEARCH-2026-06-22.md.

### Universal blocker: music tagging

Plex/Jellyfin music libraries group by EMBEDDED tags, not folders. yt-dlp leaves album-artist broken ("Various Artists"); slskd doesn't tag. Fix = a **beets + MusicBrainz** pass + "Prefer local metadata". This tagging step, not a downloader UI, is the highest-value future addition.

### Adopt vs build

No 2026 tool unifies search + tagged-music-audio + video, and the servers force separate music vs music-video libraries anyway. Lean on slskd (already present) for audio; a thin AnimeThemes UI is the only justified custom build; beets tagging is the real win.

## Kept research

docs/MEDIA-CATEGORIES-RESEARCH-2026-06-22.md (the original 4-category research).
