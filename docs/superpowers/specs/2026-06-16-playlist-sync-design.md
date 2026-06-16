# Playlist Sync — design & implementation spec (v0.13.0)

Hands-off, recurring, track-for-track mirror of SiriusXM channels + public Spotify
playlists into the Music library, played as Plex/Plexamp playlists. Opt-in.
Audio is acquired Soulseek-first with a yt-dlp fallback. **SiriusXM is the
fully-free, no-account path; Spotify requires a free Spotify Developer app** (and
per sockseek's docs may require the app owner to hold Premium — see Caveats).

> This doc reflects the AS-BUILT implementation. Where it diverged from the
> original plan, the change + reason is noted inline.

## Data flow (per scheduled run, hands-off)
1. **SiriusXM** → for each channel slug, GET `https://xmplaylist.com/api/station/{slug}/most-heard?days=7`
   (mandatory `User-Agent`; rate-limit aware) → write a header'd `Artist,Title` CSV (`poll-xmplaylist.py`).
2. **Spotify** → each public playlist URL handed to sockseek with the user's Spotify app creds.
3. **Download** → `sockseek` per source: Soulseek-first, yt-dlp fallback; per-playlist output folder +
   per-playlist `--index-path` so daily re-runs only fetch NEW additions; `--write-playlist` → `.m3u`.
4. **Normalise** → rewrite the `.m3u` entries to bare filenames so Plex resolves them against the file's
   own directory regardless of the `/data`-vs-`/media` mount prefix.
5. **Plex** → POST `/playlists/upload?sectionID=<MusicSectionId>&path=<.m3u>` per playlist, idempotent
   (delete an existing playlist of the same title first). Plex does NOT auto-import `.m3u`.

## The downloader: sockseek (formerly sldl / slsk-batchdl)
- Repo `github.com/fiso64/sockseek`, **pinned to release `v2.6.0`**. No published multi-arch image →
  built from source in CI (`.github/workflows/playlistsync-image.yml`) and the NAS only PULLS the result
  (respects the stack's no-local-build rule). Master is mid-TargetFramework-migration → unsafe; the tag is.
- Verified CLI/config keys used: positional `<input>`, `--input-type csv|spotify`, `--artist-col`/`--title-col`
  (CSV is header-mapped, hence the `Artist,Title` header), `--path`, `--playlist-path`, `--index-path`,
  `--write-playlist`, `--config`; conf keys `username`/`password`/`pref-format`/`yt-dlp`/`spotify-id`/`spotify-secret`.

## Env contract (opt-in, explicit-true like ENABLE_SOULSEEK)
- `ENABLE_PLAYLIST_SYNC=false`
- `PLAYLIST_SLSK_USER` / `PLAYLIST_SLSK_PASS` — a SECOND free Soulseek account (slskd holds the stack's
  one session; Soulseek = 1 session/account). REQUIRED when on.
- `SIRIUSXM_CHANNELS=` — comma list of xmplaylist slugs (e.g. `octane,siriusxmhits1`). Fully free.
- `SPOTIFY_PLAYLISTS=` — comma list of public Spotify URLs, each optionally `Label|URL`.
- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` — **REQUIRED whenever `SPOTIFY_PLAYLISTS` is non-empty**
  (sockseek needs your own Spotify app for ALL Spotify inputs, incl. public). Free to create.
- `PLAYLIST_SYNC_CRON=0 4 * * *`, `PLAYLIST_PREF_FORMAT=flac`, `PLAYLIST_RUN_ON_START=true`,
  `PLAYLIST_SXM_DAYS`/`PLAYLIST_SXM_MIN_PLAYS` (optional SiriusXM window/floor).
- At least one of `SIRIUSXM_CHANNELS` / `SPOTIFY_PLAYLISTS` must be set. **Requires Plex** (the upload is Plex-only).

## Container: `playlistsync` (new, VPN-routed)
- Image `ghcr.io/defessler/mediarr-playlistsync:latest`. **One-time:** make the GHCR package PUBLIC after
  the first CI build, or the NAS's anonymous pull 401s.
- Alpine runtime + the self-contained sockseek binary + python3 + yt-dlp + ffmpeg + busybox crond + tini.
  Runs as **root** and chowns downloaded files to `PUID:PGID` to match the library (no s6/PUID drop).
- `network_mode: container:gluetun` (Soulseek/yt-dlp egress via VPN, like slskd) → NO `networks:`/`security_opt:`/`ports:`.
  The `docker-compose.no-vpn.yml` override moves it to the `media` bridge and re-asserts `no-new-privileges`.
  It reaches Plex at `${LAN_IP}:32400` (allowed by gluetun's `FIREWALL_OUTBOUND_SUBNETS`).
- `volumes:` `${DATA_ROOT}/Media/Music:/data/Music`; `${INSTALL_DIR}/plex/config:/plex-config:ro`;
  `${INSTALL_DIR}/playlistsync/config:/config` (generated `sockseek.conf` + per-playlist indexes).
- `profiles: ["playlists"]`, `depends_on: gluetun`, `restart: unless-stopped`.
- **sync.sh** has two modes: default = scheduler (generate conf from env, install a crontab from
  `PLAYLIST_SYNC_CRON`, optional run-on-start, exec `crond -f`); `run` = one pass over all sources.
  Per-playlist folders (correctness over disk: each playlist is self-contained/complete).

## Files
NEW:
- `nas/scripts/playlistsync/Dockerfile` — multi-stage; cross-compiles sockseek on `$BUILDPLATFORM` for both
  arches (no QEMU dotnet), self-contained single-file; runtime = alpine + python3/yt-dlp/ffmpeg/tini.
- `nas/scripts/playlistsync/poll-xmplaylist.py` — slug → `Artist,Title` CSV (UA, rate-limit aware, slug-resolve).
- `nas/scripts/playlistsync/sync.sh` — scheduler + one-pass orchestrator (poll → sockseek → normalise → plex-upload).
- `nas/scripts/playlistsync/plex-upload.py` — token from `/plex-config` Preferences.xml; idempotent `/playlists/upload`.
- `.github/workflows/playlistsync-image.yml` — buildx multi-arch → ghcr on changes under playlistsync/.
- Wiki page `Playlist-Sync` (post-ship).

> CHANGE vs plan: the `sldl.conf` template file was dropped — sync.sh GENERATES `/config/sockseek.conf`
> from env at startup (creds via env, never baked into an image layer; matches slskd's env-driven posture).

SHARED edits:
- `nas/scripts/docker-compose.yml` (+ `docker-compose.no-vpn.yml`) — the `playlistsync` service + bridge override.
- `nas/scripts/.env.example` — the new vars + honest Spotify documentation.
- `nas/scripts/setup.sh` — `is_optin_enabled ENABLE_PLAYLIST_SYNC && PROFILES+=("playlists")` (+ vpn coupling).
- `nas/scripts/setup-folders.sh` — `Media/Music/Playlists` + `playlistsync/config`.
- `installer/src/shared/env-schema.ts` + `env-render.ts` — new vars (opt-in invariant; Spotify-creds gate; Plex gate).
- `installer/src/renderer/screens/ConfigureScreen.tsx` + `store/wizard.ts` — a "Playlist Sync" section + defaults.

## Risks / honest caveats (documented for the user)
- **Spotify is NOT guaranteed subscription-free:** sockseek requires your own Spotify Developer app for all
  Spotify inputs (incl. public), and its docs state the app owner needs Premium. SiriusXM is the fully-free path.
- Spotify reads ride sockseek's Spotify integration — breakage there breaks the Spotify half (SiriusXM unaffected).
- Single-vendor dependence on xmplaylist.com for SiriusXM (tolerant parsing + clear failure logs).
- Soulseek 2nd account + must configure shares (sockseek) or risk a ban.
- ToS-grey acquisition (same as the stack's existing Soulseek path) — personal use.
- Requires Plex (validation rejects Jellyfin-only). Per-playlist folders duplicate a track shared across
  playlists (correctness trade; a future dedup pass could de-duplicate).

## v0.14.0 — channel/playlist pickers (installer UI)
The wizard no longer needs raw slugs/URLs. **SiriusXM** is a searchable multi-select from a bundled
directory (`installer/src/shared/siriusxm-stations.ts` + `renderer/components/SiriusxmSelect.tsx`), with a
custom-slug escape hatch. **Spotify** is a "Connect" OAuth flow (`main/spotify-oauth.ts` — a loopback server
on 127.0.0.1:48721 + IPC `spotify:connect` + `renderer/components/SpotifyConnect.tsx`) that lists the user's
playlists to check off, with a paste-URL fallback. The OAuth captures `SPOTIFY_REFRESH_TOKEN` (threaded
through env-schema/render/.env.example/docker-compose/sync.sh) so sockseek reads the user's PRIVATE
playlists via `--spotify-refresh` (conf key `spotify-refresh`).

## Ship
`installer-v0.13.0` shipped the feature; `installer-v0.14.0` ships the pickers. CI builds + publishes the
image; the GHCR package is already public.
