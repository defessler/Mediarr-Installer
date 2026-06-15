# Design: Music stations + playlists from the NAS library (Plex + Plexamp)

Date: 2026-06-15
Status: approved (brainstorm), implementing

## Goal

Let the user play their own NAS music library "like SiriusXM stations (e.g. The
Pulse) or a Spotify playlist." Decided: **personal app, playlists-first**, with
always-on broadcast channels (AzuraCast) as a possible future add. The user runs
**Plex** with **Plex Pass**, and the gold-standard delivery is **Plexamp** — its
mood/genre/sonic *stations* + smart playlists are exactly the ask, all from the
user's own library, no external sources (honors the standing "NAS-only" rule;
Plexamp authenticates via the user's Plex account but plays only their server).

Plexamp is an app the user installs (iOS/Android/desktop) or the web player at
`plexamp.plex.tv` — the installer cannot install it on their devices. So the
installer's job is to **prepare Plex so Plexamp's stations + playlists work**,
then guide the user to it.

## Scope (approved: "do everything")

In `nas/scripts/setup-arr-config.py`, gated on `MEDIA_SERVER=plex` AND
`is_enabled(ENABLE_PLEX)` AND `is_enabled(ENABLE_LIDARR)` (no music → nothing to
do), and reusing the existing `plex_token`:

1. **Ensure a Plex *Music* library.** List libraries; if no artist/music-type
   library exists, create one named "Music" pointed at Plex's view of the music
   tree — `/media/Music` (the compose mounts `${DATA_ROOT}/Media` into Plex as
   `/media`, and Lidarr's root is `…/Media/Music`). If a music library already
   exists, SKIP and never modify the user's library.
2. **Enable Sonic Analysis** (Plex Pass — powers Plexamp mood/genre/sonic
   stations) and kick off an initial analysis pass on the music library.
3. **Confirm the Lidarr → Plex scan** already wired
   (`configure_plex_notification`, current code) targets the Music library so new
   downloads appear automatically. (Verify, don't duplicate.)

Discoverability:

4. **Wiki:** new `docs/MUSIC-PLAYBACK.md` — "Play your music like stations +
   playlists (Plexamp)": install Plexamp / web player, where Stations live, make
   a station + a playlist, and the sonic-analysis note. Cross-link from
   `MUSIC-SETUP.md`.
5. **Done screen:** one line under the existing post-install guidance pointing to
   Plexamp for stations + playlists (Plex installs only).
6. **Homepage dashboard:** a "Plexamp" tile under Media linking the web player
   (`https://plexamp.plex.tv`), in `render_homepage_services` (Plex installs).

## Non-negotiable design principles

- **Never break the install.** Library creation + sonic analysis are a
  best-effort ENHANCEMENT. Every Plex API call is wrapped so a failure (wrong
  Plex version, API drift, Plex Pass absent, timeout) logs a note and continues —
  it must NOT flip the install red or block any step. Mirrors the existing
  `note_unreachable`/best-effort patterns.
- **Idempotent.** Re-runs/updates must not create duplicate libraries or
  re-trigger churn; skip when the Music library already exists; enabling analysis
  is a no-op when already on.
- **Gated + isolated.** Jellyfin users and music-disabled installs are entirely
  unaffected (the whole block is skipped).
- **Honest fallback.** The exact Plex HTTP API for enabling/triggering *sonic*
  analysis is under-documented; the implementation uses the best-verified
  approach and the wiki documents the manual one-liner in case the API path is a
  no-op on a given Plex build.

## Caveats surfaced to the user (in the wiki)

- Plexamp is an installed app / web player, not a container.
- Sonic Analysis can take hours to crunch a large library on first run; stations
  improve as it completes.
- Plexamp signs in via plex.tv but streams only the NAS library — no external
  music sources.

## Out of scope (future)

- Always-on broadcast "stations" (AzuraCast) — the user said "both would be nice"
  but chose to focus on the personal app first. Separate spec if pursued.
- Navidrome (redundant given Plex Pass + Plexamp).

## Implementation note

Per "do everything with ultracode," implementation is orchestrated: a research
phase nails the exact Plex API (library list/create + sonic-analysis enable/
trigger) from authoritative sources, then per-file build agents apply the changes
(setup-arr-config.py; docs; DoneScreen.tsx), followed by integration validation
(py_compile + typecheck + build) and an adversarial verification before shipping.
