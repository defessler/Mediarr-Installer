# Research: adding support for music videos, J-pop/anime, K-pop, and VGM

**Date:** 2026-06-22 · **Status:** research only, nothing built · **Scope:** how to add
support for (1) music videos, (2) J-pop/anime tracks, (3) K-pop, (4) video-game music to the
Mediarr stack (Plex/Jellyfin + Lidarr + Prowlarr + Soulseek/slskd + Playlist Sync).

---

## TL;DR (the three conclusions that matter)

1. **Three of the four are *already reachable* through the existing Playlist Sync path.**
   `sockseek` (the Playlist Sync downloader) pulls tracks from **Soulseek**, which has deep
   coverage of J-pop, K-pop, anime themes, and game soundtracks — and sockseek accepts track
   lists from **Spotify, Tidal, Deezer, YouTube, Beatport charts, and ListenBrainz**, not just
   the SiriusXM CSV. So "K-pop / J-pop / anime / VGM **tracks**" is mostly a *documentation +
   feed-it-the-right-playlist* task, **not new code**. ([Soulseek niche coverage](https://wiki.dbzer0.com/piracy/megathread/music/),
   [sockseek inputs](https://github.com/fiso64/sockseek))

2. **Music videos are the only genuinely-new capability.** They're not Lidarr's domain and
   not Playlist Sync's audio path. The clean answer is a new opt-in service — **`ytdl-sub`**
   (yt-dlp + prebuilt **Plex/Jellyfin music-video presets**) — writing into a dedicated
   Plex/Jellyfin **Music Videos** library. ([ytdl-sub](https://github.com/jmbannon/ytdl-sub),
   [Jellyfin Music Videos](https://jellyfin.org/docs/general/server/media/music-videos/),
   [Plex music videos](https://support.plex.tv/articles/205568377-adding-local-artist-and-music-videos/))

3. **The universal blocker is metadata, and Lidarr is the wrong tool for it.** MusicBrainz
   has poor/romanization-broken coverage of J-pop/anime/K-pop/VGM, and Lidarr has **no OST
   handling** ([Lidarr #467](https://github.com/lidarr/Lidarr/issues/467)). The right strategy
   is **embedded tags + "prefer local metadata"** (Plex) / tag-extraction (Jellyfin), enriched
   from **category-specific databases** (VGMdb for games/anime, AnimeThemes for anime themes),
   *not* MusicBrainz matching. ([metadata priority](https://www.bulkmetadataeditor.com/tools/fix-plex-metadata))

**Net:** the cheapest wins are (a) document + lightly extend Playlist Sync for the audio
genres, and (b) add VGM/anime-theme fetchers; the biggest new build is music videos.

---

## Cross-cutting reality #1 — metadata (read this first)

Every one of these categories fails the same way in a MusicBrainz-driven tool:

- **Romanization / native script.** MusicBrainz may file マキシマム ザ ホルモン, not "Maximum
  the Hormone"; Lidarr then finds no releases. K-pop group/sub-unit naming and Hangul vs.
  romanized titles have the same problem.
- **No first-class soundtracks.** Lidarr explicitly has "no proper way to find/track/download
  OSTs for movies, games or anime" and the maintainers don't intend to add it
  ([#467](https://github.com/lidarr/Lidarr/issues/467)). Game/anime OSTs are "Various Artists"
  compilations with composer-credited tracks that MusicBrainz models poorly.
- **Doujin / indie.** Comiket/doujin music and small-label VGM often aren't in MusicBrainz at
  all.

**How Plex and Jellyfin actually resolve metadata** (this is the lever):
embedded tags **first**, then file/folder names, then online DBs (MusicBrainz), then user
overrides. So if the *files are well-tagged*, the niche-genre problem mostly disappears:
- **Plex:** enable **"Prefer local metadata"** on the music library → it trusts embedded tags
  over MusicBrainz.
- **Jellyfin:** extracts artist/album/track/cover from embedded tags directly; the
  [jellyfin-musictags-plugin](https://github.com/jyourstone/jellyfin-musictags-plugin) can
  surface arbitrary tags (genre, source) for browsing.
- **Tagging:** sockseek already writes `{artist} - {title}` and basic tags; for richer tags,
  MusicBrainz **Picard** (with the VGMdb/other plugins) before import, or accept sockseek's
  source tags. **VGMdb** is the authoritative DB for game/anime music metadata.

**Implication for the stack:** treat these genres as **download-and-tag**, served straight to
Plex/Jellyfin with *prefer-local-metadata* — the same posture Playlist Sync already uses.
Don't route them through Lidarr expecting clean matches.

---

## Cross-cutting reality #2 — what the stack already does

The Playlist Sync subsystem is genre-agnostic and more capable than its SiriusXM framing:

- **`sockseek`** downloads by `artist,title` from **Soulseek** (Soulseek-first), with a
  **yt-dlp** fallback. Soulseek's catalogue includes large J-pop / K-pop / C-pop archives,
  anime OP/ED theme collections, and console/PC game soundtracks in MP3 **and** lossless.
- **Inputs sockseek understands** go well beyond SiriusXM: **Spotify, Tidal, Deezer, YouTube,
  Beatport charts, ListenBrainz** — any of which can be a track-list feed.
- The stack already wires the **Spotify** input (the "Connect Spotify" button + a dev app).

So: **point Playlist Sync at a K-pop / J-pop / anime / VGM Spotify playlist and it already
works today** — downloads the tracks via Soulseek and builds the playlist in Plex/Jellyfin.
The "support" for the *track* genres is mostly latent. ([SoulSync, an adjacent tool](https://github.com/Nezreka/SoulSync))

**Quality caveat (applies to all Soulseek genres):** fake-lossless (FLAC transcoded from
lossy) is common. sockseek's `--pref-format flac` prefers FLAC but doesn't verify it's *real*
lossless; for audiophile correctness an analysis pass (e.g. spek/aucdtect) would be needed —
out of scope unless the user cares.

---

## Category 1 — Music videos (the genuinely-new build)

**The ask:** official music videos, playable in Plex/Jellyfin alongside the music.

**How the media servers handle it:**
- **Plex** ([docs](https://support.plex.tv/articles/205568377-adding-local-artist-and-music-videos/)):
  two layouts —
  - *Inline* (in the Music library): the video filename must **start with the exact track
    filename** + a `-Video_Type` suffix, in the track's folder. Plex attaches it to the track.
  - *Global Music Videos folder* (separate): `Artist - Title-Video_Type.ext`. Video types:
    `-live`, `-concert`, `-behindthescenes`, `-internet`, etc. Plexamp/clients surface these on
    the artist/track.
- **Jellyfin** ([docs](https://jellyfin.org/docs/general/server/media/music-videos/)):
  a **dedicated "Music Videos" library type**, organized like movies (mp4/mkv), **no external
  metadata providers** — embedded tags + filenames drive it; supports multiple versions via
  `- label` suffixes.

**Acquisition — the tool is `ytdl-sub`:**
- [`ytdl-sub`](https://github.com/jmbannon/ytdl-sub) = yt-dlp + declarative YAML "subscriptions"
  with **prebuilt music-video presets for Plex/Jellyfin/Kodi/Emby** (e.g. "Plex Music Videos"
  with a `Pop` genre tag). Subscribe to an artist's YouTube playlist / a "Topic" channel and it
  downloads + names + writes `.nfo`/poster for the server. No extra scrapers.
- Alternatives: [Youtarr](https://github.com/DialmasterOrg/Youtarr) (web UI, mirrors YT
  playlists into Plex/Jellyfin as native playlists), Tube Archivist (heavier, YT-replacement),
  MeTube (bare yt-dlp UI). **ytdl-sub fits best** — it targets the exact library layouts above.
- Metadata DB for music videos specifically: **IMVDb** exists but isn't wired into ytdl-sub;
  YouTube-derived title/artist/genre is the practical source.

**Integration into the stack (new opt-in service):**
- A `ytdl-sub` container (scheduled, like playlistsync), `ENABLE_MUSIC_VIDEOS` flag + a
  `MUSIC_VIDEO_SUBSCRIPTIONS` feed (artist YT playlists), writing to
  `${DATA_ROOT}/Media/MusicVideos`, plus a **Plex/Jellyfin "Music Videos" library** created by
  setup-arr-config.
- **Effort: medium-large** — this is an AzuraCast-style whole-stack wiring (env-schema/render,
  compose profile, boot-orchestrator, setup/folders, the wizard UI card, a library-create step,
  docs, parity tests). Comparable to the backlogged Music Assistant integration.
- **Legal/ToS:** ripping YouTube music videos is the same posture as the existing yt-dlp
  fallback — gate it the way Soulseek/Deezer are gated.

---

## Category 2 — J-pop & anime tracks

**Tracks (the bulk):** already reachable. Soulseek has extensive J-pop and anime-song archives;
feed Playlist Sync a J-pop/anime **Spotify playlist** (or a Last.fm/chart feed) → done today.
For full discographies/albums, **private trackers** are the curated route:
- **AnimeBytes** (anime + manga + **music**) and **JPopsuki** (J/K/C-pop, audio + MVs +
  concerts + dramas) — both **invite-only**, both **Prowlarr-addable** as indexers, then
  Lidarr/Prowlarr can search them. ([trackers](https://wotaku.wiki/torrenting/trackers))
  Caveat: Lidarr's MusicBrainz matching still fights you on tagging (see cross-cutting #1).

**Anime themes (OP/ED) — a dedicated, *better* source than generic Soulseek:**
- **[AnimeThemes.moe](https://api-docs.animethemes.moe/)** — a free, no-auth **API** (GraphQL +
  JSON:API) serving high-quality anime **openings/endings** as audio **and** video, with proper
  metadata. Self-hostable (Laravel + Docker) if desired.
- Tools: **[animethemes-dl](https://pypi.org/project/animethemes-dl/)** downloads the OP/EDs for
  *your* AniList/MAL list; [AnimeThemes-Downloader](https://github.com/Laezor/AnimeThemes-Downloader)
  does the same by username.
- **This is a clean candidate integration:** a small fetcher (like poll-xmplaylist) that pulls a
  user's AniList/MAL favourites → OP/ED audio (+ optional MV into the music-video library) →
  Playlist Sync-style playlist. Low effort, high value, no Soulseek needed, no ToS gray area
  (AnimeThemes is a curated community resource).

**Full anime OSTs** (background score, character songs): Soulseek + **VGMdb** for metadata
(VGMdb covers anime music, not just games).

---

## Category 3 — K-pop

**Mostly the same story as J-pop, and the lightest lift:** K-pop is *well* represented on both
Spotify (official) and Soulseek (lossless). The existing **Playlist Sync + a K-pop Spotify
playlist works today** — sockseek pulls each track from Soulseek with a yt-dlp fallback.
([sockseek + chart/playlist inputs](https://github.com/fiso64/sockseek))

- **Curated depth:** JPopsuki also carries K-pop; RED (Redacted, the largest music tracker)
  has K-pop with good lossless. Both via Prowlarr → Lidarr, with the usual metadata caveat.
- **Charts as a feed:** sockseek can take Beatport/ListenBrainz/Spotify-chart inputs, so a
  "weekly K-pop chart → playlist" is the same mechanism as the SiriusXM monthly archives we
  already ship.
- **Metadata:** romanization is the main annoyance — rely on embedded tags + prefer-local.

**Effort: smallest of the four** — largely "document that Spotify-playlist → Playlist Sync
already does this," optionally add a curated K-pop chart feed.

---

## Category 4 — Video game music (VGM)

**Two distinct needs — *tracks* vs *full OSTs*:**

- **Individual tracks / a VGM playlist:** Playlist Sync + a VGM Spotify playlist works today
  (Soulseek has huge VGM coverage, MP3 + lossless).
- **Full game soundtracks (the real VGM use case):** the dedicated free source is
  **[KHInsider](https://downloads.khinsider.com/)** — 100k+ albums / 3M+ tracks, MP3 (128–320)
  and often **FLAC**. The **[obskyr/khinsider](https://github.com/obskyr/khinsider)** Python
  script does whole-album batch downloads with `formatOrder=['flac','mp3']` (FLAC if available,
  else MP3). This is the cleanest "give me this game's full OST" path.
- **Metadata: [VGMdb](https://vgmdb.net)** is *the* authoritative DB (album, composer, catalog
  numbers) — the source Lidarr issue #467 itself points at. There's a Picard VGMdb plugin for
  tagging. Not Lidarr-integrated; use it at tag time.
- Also-rans: OverClocked ReMix (remixes/arrangements), Zophar's Domain (original-chip rips),
  VGMusic (MIDI). Mostly niche; KHInsider covers the mainstream need.

**Integration:** a `khinsider`-fetcher service (album URL / game name → FLAC-preferred OST →
`${DATA_ROOT}/Media/Music/Game OSTs/<Game>` → tag from VGMdb → Plex/Jellyfin). **Effort:
medium** — a focused downloader + library folder + tagging; smaller than music videos, larger
than the K-pop "just document it."

---

## Recommended roadmap (phased, cheapest-value-first)

| Phase | Work | Effort | Why first |
|---|---|---|---|
| **0** | **Document** that Playlist Sync + a genre Spotify playlist already downloads K-pop/J-pop/anime/VGM **tracks**; add a "prefer local metadata" note for Plex + the Jellyfin tag plugin. | XS | Unlocks 3 categories with zero code; sets metadata expectations. |
| **1** | **AnimeThemes fetcher** — small poll-style script: AniList/MAL list → OP/ED audio → Playlist Sync playlist (+ optional MV). | S–M | Free API, no ToS gray area, high "anime support" payoff. |
| **2** | **VGM/KHInsider fetcher** — game/album → FLAC-preferred OST → `Game OSTs` library, VGMdb-tagged. | M | The real VGM use case Spotify can't serve. |
| **3** | **Music Videos service** — `ytdl-sub` opt-in container + Plex/Jellyfin Music Videos library + wizard wiring. | M–L | The only net-new capability; AzuraCast-scale integration. |
| **(opt)** | **Private-tracker indexers** (AnimeBytes/JPopsuki/RED via Prowlarr) for curated discographies. | S per tracker | Needs invites; Lidarr metadata caveat remains. |

**Common metadata work threaded through all phases:** ensure downloads are tagged (sockseek
already does basic; add VGMdb/AnimeThemes enrichment where free) and the libraries run
**prefer-local-metadata**.

---

## Open questions / decisions for the user

1. **Playlists vs libraries?** Do you want these as *curated playlists* (Playlist-Sync style,
   minimal build) or *browsable libraries* (more metadata work)? Most of the above assumes
   playlists-first.
2. **Music videos — how much?** A few favourite artists (cheap, a handful of YT subscriptions)
   vs. a broad auto-grabbing library (bigger, more storage, more ToS exposure)?
3. **Private trackers?** Willing to get AnimeBytes/JPopsuki/RED invites? That's the only route
   to clean, complete discographies + proper release groups; otherwise Soulseek is the source.
4. **Lossless strictness?** Accept Soulseek's "maybe-fake FLAC," or add a verification step?
5. **ToS posture** is identical to the existing Soulseek/yt-dlp/Deezer gating — same sign-off
   model applies to KHInsider/YouTube-MV ripping.

---

## Sources

- Plex music videos & naming — https://support.plex.tv/articles/205568377-adding-local-artist-and-music-videos/ · https://support.plex.tv/articles/categories/your-media/naming-and-organizing-music-media/
- Jellyfin Music Videos library — https://jellyfin.org/docs/general/server/media/music-videos/
- ytdl-sub — https://github.com/jmbannon/ytdl-sub · https://ytdl-sub.readthedocs.io/ · Youtarr — https://github.com/DialmasterOrg/Youtarr
- Lidarr OST gap (#467) — https://github.com/lidarr/Lidarr/issues/467
- Metadata priority / prefer-local — https://www.bulkmetadataeditor.com/tools/fix-plex-metadata · Jellyfin tag plugin — https://github.com/jyourstone/jellyfin-musictags-plugin
- AnimeThemes API + tools — https://api-docs.animethemes.moe/ · https://pypi.org/project/animethemes-dl/ · https://github.com/Laezor/AnimeThemes-Downloader
- KHInsider + script — https://downloads.khinsider.com/ · https://github.com/obskyr/khinsider · VGMdb — https://vgmdb.net
- Asian-music trackers — https://wotaku.wiki/torrenting/trackers · JPopsuki — https://opentrackers.org/jpopsuki/
- Soulseek niche coverage — https://wiki.dbzer0.com/piracy/megathread/music/ · sockseek inputs — https://github.com/fiso64/sockseek · SoulSync — https://github.com/Nezreka/SoulSync

---

*Research only — nothing implemented. Gated like [docs/MUSIC-SOURCES-DEEZER-RESEARCH.md]: any
build waits on the user's category/playlist-vs-library/tracker/ToS decisions above.*
