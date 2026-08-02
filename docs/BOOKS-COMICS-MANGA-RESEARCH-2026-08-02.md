# Books, Comics, and Manga: Research (2026-08-02)

Status: RESEARCHED, and phase 1 is BUILT. See "Decisions" below for where the shipped
shape differs from the recommendation this document originally made.

The question was "what are the options for downloading manga, comics, and books the way we
download movies and TV, and what's the best way to serve them." The short answer is that those
three media types have three different answers, and only one of them looks like Sonarr.

## Decisions (2026-08-02)

The maintainer took the research and made three calls that override the single-reader
recommendation further down. The plan of record is:

- **All three phases**, not just the reader.
- **Both readers**, Komga and Kavita, rather than Kavita alone. It works out as a split
  rather than an overlap: Komga has no ebook support and Kavita only gets generic OPDS on
  Android, so Komga owns Comics + Manga and Kavita owns Books.
- **LazyLibrarian** for books, rather than the drop-folder-only posture this document
  recommends. The concern below still stands and is the reason phase 2 carries extra work:
  LazyLibrarian treats several shadow libraries as first-class providers, so it ships with
  those written OFF in `config.ini` and Prowlarr-fed Torznab/Newznab as the configured path,
  with the docs saying plainly that the others exist and are disabled.

### Phase 1: shipped

Komga (`:49158`) and Kavita (`:49157`), both opt-in and default-off, wired across compose,
`setup.sh`, `setup-folders.sh`, `boot-orchestrator.sh`, `stop-all.sh`, `setup-firewall.sh`,
`post-deploy-validate.sh`, `relocate-stack.sh`, the Homepage renderer, and the wizard.
Docs at `site/content/reading.md`.

An independent audit of the first pass caught eight missed wiring sites, including two that
would have failed silently on a live NAS: the firewall never opened 49157/49158, and the
wizard's Update path never added the profiles, so enabling a reader via Update rather than a
fresh install would have started nothing with no error. Both are fixed. That audit also
found `optin-render-gate.test.ts` had a `profile` field it declared and never asserted, so
there was no automated guard on profile wiring at all. There is one now.

### Phase 2: shipped

Mylar3 (`:49159`) and LazyLibrarian (`:49160`), both opt-in and default-off, both wired as
native Prowlarr Applications so they sync the user's existing indexers and hand transfers to
SABnzbd and qBittorrent.

The new code is `reading_app_api_setup()` in `setup-arr-config.py`. Both apps ship their REST
API disabled with an empty key and expose no environment variable for it, so unlike the arrs
(whose keys we harvest from `config.xml`) these have to be configured before there is a key
to harvest. It writes `config.ini`, restarts the container, and returns the key for
`add_prowlarr_app()`.

Two source-verified details worth keeping, because both would have failed silently:

- Mylar3's ComicVine key is `comicvine_api` in section `[CV]`, **not** `comicvine_api_key`
  as the synthesis below assumes. We don't write it at all now (it's a user-supplied key with
  no env var), but the wrong name is recorded here so nobody re-derives it from the old text.
- `configparser` must have `optionxform = str` set before reading. LazyLibrarian's keys are
  UPPERCASE, and configparser's default would rewrite the whole file lowercase on save, which
  LazyLibrarian then ignores. A perfectly healthy-looking config.ini that does nothing.

LazyLibrarian's posture is written explicitly rather than left at defaults:
`SHOW_DIRECT_PROV=0` and `SHOW_IRC_PROV=0` (those gate Anna's Archive, Z-Library,
AudioBookBay, and IRC), with `SHOW_NEWZ_PROV=1` and `SHOW_TORZ_PROV=1` keeping the
Prowlarr-fed path on. Verified against `lazylibrarian/configdefs.py`.

### Phase 3: not started

Audiobookshelf, library-only. The permission footgun is in the section below: it refuses
PUID/PGID, wants `user: "1000:10"` on UGOS, and needs its config and metadata dirs
pre-created or it dies with EACCES on `/metadata/streams`.

## Independently verified, 2026-08-02

Every load-bearing status claim below was re-checked against the GitHub API directly rather than
taken from a search summary. `pushed_at` is the honest liveness signal, not `updated_at`.

| Project | Archived | Last push | Latest release |
|---|---|---|---|
| Kavita | no | 2026-08-01 | v0.9.0.2 (2026-05-14) |
| Audiobookshelf | no | 2026-07-28 | v2.36.0 (2026-07-27) |
| Komga | no | 2026-08-01 | 1.25.0 (2026-06-30) |
| Suwayomi-Server | no | 2026-07-31 | v2.3.2243 (2026-07-13) |
| Mylar3 | no | 2026-07-23 | v0.10.0 (2026-06-13) |
| rreading-glasses | no | 2026-08-01 | no tagged releases |
| Bookshelf (Readarr fork) | no | **2026-02-04** | **none, ever** |
| Readarr | **yes** | 2025-06-27 | v0.4.18.2805 (2025-06-15) |

Also confirmed first-hand:

- **Prowlarr syncs to exactly seven app types.** Read from
  `src/NzbDrone.Core/Applications` on the default branch: LazyLibrarian, Lidarr, Mylar, Radarr,
  Readarr, Sonarr, Whisparr. Mylar is really there. Nothing for manga exists, and nothing is
  going to.
- **CVE-2026-47202 is real.** Pre-auth account takeover in Kavita, CVSSv4 9.3, an unauthenticated
  attacker who knows a username gets a JWT for that account including admin. Fixed in 0.9.0.2.
  That's a security floor for anything sitting on the LAN, not a preference.
- **Readarr's retirement is official**, and the Servarr wiki now carries it as "(Retired)".
- Our side of the plumbing checks out too: `add_prowlarr_app()` lives at
  `nas/scripts/setup-arr-config.py:1558` with Sonarr, Radarr, and Lidarr as calls one through
  three, so comics really would be a fourth call in the same shape. And `INDEXERS.md:187` does
  currently call MyAnonamouse "out of scope," which stops being true the moment books are
  mentioned anywhere.

## One correction to the research below

The synthesis treats the books lane as a dead end. That's right about the *application* and wrong
about the *metadata*, and the distinction matters if we ever revisit it.

Readarr died because its metadata backend went away, not because the app stopped working.
**rreading-glasses** is a drop-in replacement for that backend, it's the mirror the Servarr team
itself points at while declining to support it, and it's in active development as of yesterday
with 1,514 stars. So the metadata half of the problem is genuinely solved by a live project.

What's still missing is a maintained app to point at it. Readarr is archived. Bookshelf, the
consensus fork, has never cut a single release and hasn't been touched since February. Running
archived Readarr against a live mirror does work today, and plenty of people do exactly that, but
shipping it in an installer means shipping software that will never get another security fix.

Read the books section below with that framing: the blocker is the app, not the data.

---

# Books, Comics, and Manga on the Mediarr Stack

## The Recommendation

Ship three containers, all opt-in and default-off, added over three phases. One reading server covers all three media types. One acquirer, for comics only, plugs into the Prowlarr spine you already run. Books and manga get a folder and an honest explanation instead of an automation layer that doesn't exist yet.

| Service | Image | Port | Role | Flag |
|---|---|---|---|---|
| `kavita` | `lscr.io/linuxserver/kavita` (pin `version-v0.9.0.2` or newer) | `${LAN_IP}:49157:5000` | The one reading server: comics, manga, ebooks, PDF. Reads only, acquires nothing. | `ENABLE_KAVITA` |
| `mylar3` | `lscr.io/linuxserver/mylar3:latest` (tracks `MylarComics/mylar3`, v0.10.0+) | `${LAN_IP}:49158:8090` | Comic acquisition. Watchlists, pull-list, renaming, ComicInfo.xml tagging. | `ENABLE_MYLAR` |
| `audiobookshelf` | `ghcr.io/advplyr/audiobookshelf` (2.36.0+) | `${LAN_IP}:49159:80` | Audiobook and podcast library. Phase 3, only if you have audiobooks. | `ENABLE_AUDIOBOOKSHELF` |

Ports 49157 through 49159 are the first free slots in the house range. 32400, 8181, 8096, 5056, 3000, 49150-49156, 8191, 5030, 8889, 8890, and 9191 are all spoken for.

Nothing here goes into gluetun's network namespace, so none of these can be caught by the "marked for removal" recreate race that already bites qBittorrent, slskd, and playlistsync.

Why this shape and not the alternatives:

- One reader, not two. Kavita is the only candidate that handles comics, manga, and ebooks acceptably in one process, on .NET rather than the JVM, with a LinuxServer image that speaks PUID/PGID natively. Komga is genuinely better for a comics purist, but it's a second server, an uncapped JVM heap, and it uses the docker `user:` directive instead of PUID/PGID.
- One acquirer, because only one exists that adds zero new source surface. Mylar3 is one of exactly seven native Prowlarr Applications types, verified from `src/NzbDrone.Core/Applications` on Prowlarr's default branch. It hands NZBs to SABnzbd and torrents to qBittorrent. It's the Sonarr pattern, unchanged.
- Books and manga get deferred on purpose. Details below.

## How Do We Download It

The Sonarr/Radarr pattern transfers cleanly for exactly one of these three. That's the whole reason this can't be a single feature.

### Comics: The Pattern Transfers

Mylar3 from the `MylarComics/mylar3` fork is the answer, and it behaves the way you'd expect.

- Prowlarr push-syncs the whole indexer set. `setup-arr-config.py` already has the helper at line 1558, and Sonarr, Radarr, and Lidarr are calls one through three in the identical shape. Comics is a fourth call: `add_prowlarr_app(PROWLARR, PROWLARR_KEY, "Mylar", "Mylar", "MylarSettings", MYLAR_INT, MYLAR_KEY, [7030])`.
- SABnzbd and qBittorrent do the transfers, so the torrent leg is already inside gluetun and no new download path exists.
- Downloads land in the existing `Downloads/` tree on the same volume as `Media/Comics`, so hardlinks and atomic moves hold exactly as they do for TV.
- Mylar3 vendors a real ComicTagger tree (`lib/comictaggerlib/`, including `comicinfoxml.py`), so it embeds ComicInfo.xml into every archive. That's what makes a Mylar3-fed library read correctly in Kavita for free, without a metadata sidecar service.

Two things that don't transfer. First, hit rate. Comic coverage on general-purpose usenet and torrent indexers is thin next to a comics-focused source, so expect to find noticeably less than a Sonarr user expects. That's the honest price of keeping the source posture identical to the rest of the stack, and it belongs in the docs before install, not after. Second, the ComicVine API key. It's mandatory, free, rate-limited to roughly 200 requests an hour, and configured into `config.ini` through the web UI rather than an env var. First library import will crawl and look like a hang.

Point Mylar3's naming templates at the flat one-folder-per-series layout below, and ship with DDL off. Mylar3's optional direct-download path resolves to GetComics, which is a different posture from everything else in the stack.

### Books: The Pattern Is Gone, and Nothing Has Replaced It

Readarr was archived on 2025-06-27 with its metadata backend permanently offline. Prowlarr still lists Readarr as an Application type, which is a trap rather than an option. Everything downstream of it is in worse shape than it looks:

- Bookshelf (pennydreadful) is the community-consensus fork, and its ghcr `:hardcover` and `:softcover` images were built four minutes after its final commit on 2026-02-04. There's no live release channel of any kind, Docker or GitHub.
- Chaptarr has no public source repo and ships weekly Docker Hub builds nobody can read. A closed-source container holding this stack's Prowlarr API key is the exact shape of the Huntarr incident. Prowlarr's own maintainers declined to name-support it.
- LazyLibrarian is the painful one. It's genuinely alive (GitLab activity 2026-08-02, LinuxServer image rebuilt 2026-07-31) and it IS a full Prowlarr Applications push target, so the automation would work. But its own docs bake zlibrary, libgen, and Anna's Archive in as first-class provider rows, and there's no clean way to ship only the legitimate half.
- Shelfarr, Shelfmark, and Stacks are Prowlarr clients rather than sync targets, and each exists to reach shadow libraries whose domains moved repeatedly through 2026. Shelfarr's documented host port 5056 also collides with seerr in this very compose file.

So what replaces it: `${DATA_ROOT}/Media/Books` is a plain folder that Kavita indexes. Drop EPUBs and PDFs in, and Kavita picks them up. It parses EPUBs almost entirely from the internal OPF, where `calibre:series` and `calibre:series_index` drive grouping, so metadata beats whatever the filename says and you don't need naming discipline.

Deliberately not shipping a Calibre library. A Calibre library is a closed world keyed on `metadata.db`, and the Calibre manual says outright that the folder's contents are automatically managed and manually added files may be deleted. That rules out any arr-style hardlink into the library. Calibre-Web-Automated's ingest folder also deletes every file it processes, and issue #535 is a real user reporting an emptied folder after pointing it at a torrent completed directory. Given this project's data-safety history, that's the wrong shape to ship.

Two watch items worth revisiting rather than building now. Bindery (`ghcr.io/vavallee/bindery`) has the right posture (Newznab/Torznab only, documented public metadata APIs, no shadow libraries) but it was created 2026-04-11 and pulls from Prowlarr rather than receiving a push, so there's no existing helper to reuse. And a public-domain sidecar in the LibrARRian shape, feeding `Media/Books` from Project Gutenberg's sanctioned `/robot/harvest` endpoint plus the ~1,492 CC0 Standard Ebooks repos, would be the cleanest possible books feature with zero source question. It's just not v1.

### Manga: The Pattern Doesn't Exist At All

This is the sharpest finding in the research and it should shape the docs. Prowlarr has exactly seven Application types, and none of them is a manga app. Manga isn't in the Torznab/Newznab world in any form. There are no manga indexers. Every serious manga tool is an HTTP scraper of scanlation aggregator sites, driven by Mihon (formerly Tachiyomi) extensions, which is a completely separate acquisition lane with its own source concept. `setup-indexers.py` has nothing to sync to it.

Suwayomi is the only real tool, and it's the right one, but it doesn't ship as a service here. Three reasons:

- It ships zero extension repositories by design, so the installer would have to hand users a third-party scanlation source list to make it work at all. That's the most legally exposed thing this project could do. Tachiyomi ceased development on 2024-01-13 after Kakao Entertainment sent legal threats to individually named contributors, and the extension repo was pushed out to third parties precisely because the source list was the pressure point.
- The community index URL every guide cites (`index.min.json`) is now a 765-byte deprecation stub with two placeholder entries. It loads successfully and finds nothing, which is harder to debug than an empty store.
- Its Dockerfile, startup script, and config wiki expose no heap option anywhere, so it inherits 25% of host RAM on a box with no `mem_limit`. Its archival defaults also fail silently: `AUTO_DOWNLOAD_CHAPTERS` is false and three `UPDATE_EXCLUDE_*` flags default true, so a library nobody has opened in the reader gets skipped entirely.

What replaces it: a documented standalone recipe in `site/content/`, the same treatment Music Assistant already got. The recipe is genuinely clean because Suwayomi needs no import step at all. Point its downloads bind at `${DATA_ROOT}/Media/Manga` and it writes `{Source}/{Title}/{scanlator}_{chapter}.cbz` with a generated ComicInfo.xml inside every archive, which Kavita then reads directly. Kavita's filename parser struggles with the `{scanlator}_{chapter}` shape, but the embedded ComicInfo.xml overrides filename parsing, so it comes out right.

The recipe should carry four things verbatim: the downloads mount must be listed BEFORE the data mount or it silently no-ops, set `DOWNLOAD_AS_CBZ` explicitly because the docker README and the server wiki disagree on the default, set `mem_limit` and `JAVA_TOOL_OPTIONS=-Xmx512m`, and any env var you set permanently overwrites the runtime setting on every container start, which makes it un-editable from Suwayomi's own WebUI. Leave the extension store empty and let the user paste their own.

Meanwhile, `Media/Manga` still works today as a plain drop folder for whatever CBZs the household already has.

## What's the Best Way to Serve It

Kavita, on one port, for everything. `http://your-nas:49157`.

Plex contributes nothing, and it isn't close. There's no native CBZ, CBR, PDF, or EPUB support in 2026, users were still filing feature requests on the Plex forums in May 2026, and the only workaround ever built (`coryo/ComicReader.bundle`) last saw a commit on 2016-12-20 against a plugin system Plex dismantled years ago. Don't install it and don't imply a path exists.

Jellyfin is a trap rather than a shortcut. Jellyfin's own docs say the bookshelf plugin is required for Books libraries, and the Jellyfin org archived that plugin on 2026-06-30. The docs also say online metadata is not supported for books at all. There's no panel navigation, no webtoon mode, and no cross-device progress sync. The one community fork on Codeberg last committed 2025-12-04.

That dead end is actually a design gift. Because neither media server can serve any of this, the reading server is standalone no matter which one the user picked. No conditional compose wiring, no `MEDIA_SERVER=plex|jellyfin` branch, no per-server API-key plumbing, no Homepage widget fork. One flag, one profile key, one tile.

What the household reads on:

- Desktop or laptop - Kavita's web UI directly. Webtoon, single-page, and dual-page for comics and manga, a rebuilt EPUB reader, a separate PDF reader. Zero setup, and it covers most people.
- Android - Mihon (v0.20.2, shipping weekly) pointed at Kavita's per-user OPDS URL from account settings. Offline downloads, proper RTL/LTR/webtoon handling, progress synced back. Mihon isn't on the Play Store, so it's a sideload or F-Droid, which is worth saying up front because it generates support questions. Honest caveat: Komga publishes an official Mihon extension while Kavita only gets generic OPDS, and that's the single real thing Komga buys you.
- iPhone, iPad, Mac - Panels from the App Store, over the same OPDS URL. It reads CBR, CBZ, PDF, and comic EPUB in one reader, and it writes page progress back through Kavita's progress API so the phone and the web UI stay in sync. Panels is free to try with a paid tier. Don't print a price, the commonly cited figure isn't published on their site. Paperback is the free alternative.
- Kobo, jailbroken Kindle, other e-ink - KOReader, which Kavita has done two-way progress sync with since v0.8.7 at `<server>/api/koreader/<api-token>`, covering archives, PDF, and EPUB. Two things the docs should say plainly. KOReader on a Kindle means jailbreaking the Kindle, and that's a user-side prerequisite, not a footnote. And use MANUAL sync, because Kavita's own wiki warns that automatic sync can undo reading progress and that they can't help recover it.
- Stock unjailbroken Kindle - Kavita's one-click send-to-Kindle email. No jailbreak, no sideloading.
- Audiobooks - the official Audiobookshelf app is a normal Play Store release on Android. On iOS the official app is still TestFlight-only with the beta reported full, but that's not the wall it's usually described as. ShelfPlayer and Plappa both ship on the App Store, both talk to an Audiobookshelf server, and Plappa syncs playback state back to it.
- TV - nothing, on purpose. No reader here works on a TV and nobody reads manga on one. Say it plainly rather than implying a path.

Homepage gets live tiles for `kavita` (Series, Files, takes username and password or an API key), `mylar` (Series, Issues, Wanted, API key), and `audiobookshelf` (books, podcasts, durations, API key). Note the Homepage widget key is `mylar`, not `mylar3`.

## On-Disk Layout

Everything stays on the single `${DATA_ROOT}` volume, so hardlinks and atomic moves keep working the way they do for TV and movies.

```
${DATA_ROOT}/
├── Media/
│   ├── Comics/                                 <- Mylar3 writes, Kavita reads
│   │   └── Amazing Spider-Man (1963)/
│   │       ├── Amazing Spider-Man (1963) #001.cbz
│   │       └── Amazing Spider-Man (1963) #002.cbz
│   ├── Manga/                                  <- drop folder, or a standalone Suwayomi
│   │   └── MangaDex/
│   │       └── Chainsaw Man/
│   │           └── Scanlator_Chapter 001.cbz
│   ├── Books/                                  <- drop folder, Kavita reads
│   │   └── Author Name/
│   │       └── Title.epub
│   ├── Audiobooks/                             <- phase 3, drop folder
│   │   └── Author Name/
│   │       └── 1 - Book Title/
│   └── Podcasts/                               <- phase 3, Audiobookshelf writes
└── Downloads/
    ├── Usenet/complete/comics
    └── Torrents/Completed/mylar

${INSTALL_DIR}/
├── kavita/
├── mylar3/
└── audiobookshelf/
    ├── config/
    └── metadata/
```

Two rules that aren't style preferences.

Flat archive files inside exactly one folder per series. No per-volume subfolders. Komga mints a Series for every subfolder that contains files, at any depth, so the popular `Series/Volume 01/*.cbz` shape you'll find in most blog posts silently produces a series literally named "Volume 01". Kavita independently forbids files at the library root and forbids one series spanning two adjacent folders. Flat-inside-one-folder is the only shape both servers accept, which matters even though we're shipping Kavita, because it keeps the tree portable if you ever switch readers. Suwayomi's extra `{Source}` grouping level is harmless since it holds no files directly.

ComicInfo.xml lives INSIDE the archive, at its root, named exactly that. A loose sidecar next to a `.cbz` is read by nobody. Mylar3 writes it through its vendored ComicTagger and Suwayomi generates it on every download, so both paths handle this without a metadata service. Imported metadata overrides file and folder names in both readers, which is what makes an imperfect drop survivable. When a manual drop lands with a messy name, inject ComicInfo.xml rather than renaming files.

New entries go into `setup-folders.sh`'s `DATA_DIRS` array alongside the existing `Media/Movies` and `Media/TV Shows` lines, chowned PUID:PGID before first container start.

## Phased Plan

### Phase 1: Kavita Alone

One container, one `ENABLE_KAVITA` flag, three media folders, one Homepage tile. Zero acquisition, zero new source surface, nothing that can fail on a user's indexers.

This ships first because it's immediately useful on its own. Neither Plex nor Jellyfin serves books at all, so "point it at a folder and read what's already there" is a real feature the day it lands. It also front-loads the expensive decisions: it proves the folder layout, the PUID=1000/PGID=10 ownership on UGOS, the read-only mounts, the port, and all four client paths (Mihon, Panels, KOReader, send-to-Kindle) before anything is allowed to write into that tree. The layout rules are cheap now and painful to retrofit across a filled library later.

Because it's read-only and touches no existing service, it can't damage anything. If the rest of the arc never ships, phase 1 is still complete.

Kavita's library type is per-library and drives both the scanner and the reader UI, so use three separate read-only binds rather than one `/data`:

```
${INSTALL_DIR}/kavita:/config
${DATA_ROOT}/Media/Comics:/comics:ro
${DATA_ROOT}/Media/Manga:/manga:ro
${DATA_ROOT}/Media/Books:/books:ro
```

### Phase 2: Mylar3

`ENABLE_MYLAR`, the two download-category folders, the fourth `add_prowlarr_app()` call, the ComicVine key path, and the `mylar` Homepage tile.

This goes second because it's the first thing that writes into the library Kavita reads, and the first thing that touches Prowlarr's Applications sync and hands work to SABnzbd and qBittorrent. Proving the read path before the write path exists means that when comics start landing you're debugging one thing rather than two.

It's also the phase with the real unknown in it, so it wants its own smoke test on a live stack rather than riding along with an otherwise safe change. Ship with DDL off, the ComicVine key documented as a manual post-install step, and the coverage expectation stated up front.

New work beyond the compose block: `setup-arr-config.py` needs an ini-write path for Mylar3's `config.ini` (start Mylar, wait for the file, write `comicvine_api_key` plus `api_enabled` and `api_key`, restart). Same shape as the existing SABnzbd config manipulation, but it's real new code rather than the `config.xml` harvest the arrs use.

### Phase 3: Audiobookshelf, On Request Only

Library-only, no acquisition tool, because none exists that an installer can pin. Listenarr is the nicest audiobook story on paper (it has a LibriVox and Internet Archive indexer sitting as a first-class peer to Torznab) but there's no stable release at all, the canary image hasn't been rebuilt since 2026-06-30, and its own README warns about data loss.

Audiobookshelf earns its slot because it's the healthiest project in the whole survey, it's cheap (Node, roughly 100 to 150MB idle, no companion database), and audiobooks plus podcasts are the two media types nothing else in this stack touches. Its podcast RSS auto-download is a fully above-board acquisition path with no source question at all.

One hard prerequisite. Audiobookshelf refuses PUID and PGID outright and wants the docker `user:` directive, which on UGOS means `user: "1000:10"` rather than the documented `1000:1000`. Issue #4471 has been open since 2025-07-10 showing the container dying with EACCES on `mkdir /metadata/streams` when run as non-root, so `setup-folders.sh` has to pre-create and chown `${INSTALL_DIR}/audiobookshelf/{config,metadata}` to 1000:10 before first start or the service never boots.

Two things outside the phasing. The standalone Suwayomi manga recipe can land any time, because it's prose plus a compose snippet and ships nothing. And the public-domain books sidecar is a phase 4 idea worth revisiting once we know whether the indexer-driven books path is ever going to find anything.

## What This Costs

Containers - three, all opt-in and default-off, so nobody pays for a feature they didn't ask for. On a box already running roughly fifteen, that matters.

RAM - Kavita is .NET and modest, call it 150 to 300MB depending on library size and concurrent readers. Mylar3 is Python and light, around 100MB. Audiobookshelf is Node, roughly 100 to 150MB idle with CPU spikes only during bulk scans. None of these is a JVM, which is exactly why Komga, Suwayomi, and Grimmory are all absent. Komga self-limits to about 1GB by default with no cap in its compose, Suwayomi has no heap option anywhere in its Dockerfile or docs, and Grimmory is Spring Boot plus a mandatory MariaDB sidecar.

Env keys - roughly six to eight, and every one needs registration in BOTH `env-schema.ts` and `env-render.ts` or the key-parity test fails in CI. This project has been bitten by exactly that before with the playlistsync key. Three new profile keys go into the `COMPOSE_PROFILES` builder in `setup.sh` and the matching one in `stop-all.sh`.

Ongoing maintenance, honestly:

- Kavita's version floor is a security floor, not a preference. CVE-2026-47202 is a CVSS 9.3 pre-auth account takeover that hands out an admin JWT from a known username, and every version before v0.9.0.2 is affected. Track a moving tag or pin at or above that, and make sure no doc or example ever suggests an older tag on a service sitting on the LAN.
- Kavita's online metadata is paywalled at $4/month for Kavita+. Free Kavita reads ComicInfo.xml, embedded EPUB metadata, and filenames only. The usual free workaround is Komf, and Komf hasn't had a commit since 2025-12-12 or an image rebuild since 2025-12-06, so there's no reliable escape hatch. The saving grace is that Mylar3 embeds ComicInfo.xml itself and EPUBs carry their own OPF metadata, so the two things we actually ship read well for free.
- Mylar3's release cadence is slow even on the live fork. v0.9.0 in April and v0.10.0 in June are the only 2026 releases, and real work happens on the `nightly` branch. LinuxServer rebuilds weekly so the image stays current, but don't read the release page as the health signal.
- The ComicVine key stays a documented manual step forever, because it's UI-configured.
- Two docs sections that will need occasional touching: the manga recipe (Suwayomi's extension store situation moves) and the books section (if a durable Readarr successor ever appears, that page changes).
- `INDEXERS.md` currently says MyAnonaMouse is out of scope. That becomes wrong the moment books are mentioned anywhere, so it needs a pass.

## Sources and Posture

Plainly, per service:

Uses your own Prowlarr indexers, nothing new:

- Mylar3 - Prowlarr push-syncs the whole existing indexer set. Payloads move through SABnzbd and qBittorrent. Byte-identical posture to Sonarr, Radarr, and Lidarr. Its outbound calls are HTTPS indexer queries, which is Prowlarr's own posture, and Prowlarr already sits on the bridge.

Fetches no content at all:

- Kavita - serves files off disk. Its only outbound calls are optional metadata lookups.
- Audiobookshelf - the same, plus podcast RSS, which is a fully legitimate lane with no source question.

Documented but not shipped:

- Suwayomi - scrapes scanlation aggregator sites through Mihon extensions the user supplies. This is a genuinely new source lane with its own legitimacy question, which is why it lives in the docs as a standalone recipe rather than in the compose file.

VPN routing - none of the three shipped services needs gluetun, and putting them there would be a downgrade. They're either serving local files or making HTTPS indexer queries, and the actual P2P transfers already happen inside qBittorrent, which is in the namespace. Staying on the bridge also keeps them clear of the recreate race.

If someone runs the standalone Suwayomi recipe, the VPN answer is still no. It's HTTPS scraping with no P2P and no inbound port, and commercial VPN exit IPs draw harder Cloudflare challenges, so routing through gluetun would raise the failure rate rather than lower it. The real dependency is FlareSolverr, which the stack already runs. A container in `network_mode: container:gluetun` also can't resolve `flaresolverr` by service name on the media bridge, which settles it.

Two settings to verify are off and stay off. Mylar3's optional DDL path resolves to GetComics, same source as Kapowarr. Write it explicitly disabled, never enable it from the wizard, and don't write a docs section walking someone through turning it on.

## Open Questions for the Maintainer

These are the calls only you can make.

1. Is the comics hit rate worth the support bill? With DDL off, Mylar3 against a typical general-purpose indexer set will find noticeably less than a Sonarr user expects, and some people will read that as broken. Per this project's own principle, a comic indexer that returns nothing should `warn()` and never show a red "Failed". But if the answer is "it finds almost nothing," phase 2 might not be worth building at all, and phase 1 alone is still a real feature.

2. Kavita or Komga? The one thing Komga genuinely buys is the official Mihon extension for Android manga reading, which is a cleaner integration than Kavita's generic OPDS. If the household reads manga on Android phones every day, that might outweigh a second JVM container with a documented heap footgun. If not, Kavita's three-formats-in-one-process wins.

3. How do we handle the Kavita+ paywall in the docs? Free Kavita is ComicInfo-only for metadata, Komf is dormant, and Kavita+ is $4/month. The options are to state the paywall plainly and accept that a manual drop folder will look sparse, or to lean on the fact that Mylar3 and Suwayomi both embed metadata themselves and say so.

4. Where's the line on the manga docs? A standalone Suwayomi recipe names the tool, describes the plumbing, and leaves the extension store empty for the user to fill. That's the line I'd draw. But it's your name on the repo, so it's your call whether even naming Suwayomi is further than you want to go.

5. Does anyone actually have audiobooks? Phase 3 is dead weight otherwise, and it's the phase with the permission footgun in it.

## Flagged for Human Verification

Things the research could not confirm, or confirmed only by inference, that should be checked before code gets written.

- The Prowlarr to Mylar3 sync against the MylarComics fork. This is the one that actually blocks phase 2. Prowlarr's `Mylar.cs` has no version gate and no fork detection, and the fork keeps the API surface, so it should work verbatim. But nobody has publicly re-validated the connector against v0.10.0. Smoke-test `add_prowlarr_app` with implementation `"Mylar"` on a live instance before shipping, and treat a sync failure as a warning rather than a failed install.
- The LinuxServer Kavita image against read-only library mounts on UGOS with PGID=10. LSIO images normally only chown `/config`, so it should be fine, but that's an assumption rather than a verified fact. Check it on the NAS during phase 1.
- Panels pricing. The vendor calls the tier "Premium" and publishes no price anywhere on their site, and the commonly cited $9.99/year figure has no source. Don't put a number in the docs, point at the App Store listing.
- The claim that "exactly two" purpose-built book request front-ends exist. The verification pass marked this UNVERIFIABLE because an exhaustive negative over GitHub can't be established from outside, and it did surface at least one thing the survey missed. Read it as "two worth considering," not a census.
- Chaptarr's licensing status. The GPL-violation and Discord-ban details rest entirely on forum reports nobody could open, and the verification pass marked it UNVERIFIABLE. The "do not ship" call doesn't depend on those details (no public source plus an API key it would hold is enough), so this only matters if the docs ever describe why.
- Comicarr's "Mylar3-compatible API" claim, if it ever becomes relevant. Nobody has opened its API surface, and Prowlarr's Mylar connector has no Comicarr awareness. It's a hypothesis, not a fact.
- One methodology note worth carrying forward: WebFetch's prose summarizer misreported repo booleans and dropped years from release dates during this research, in both directions. Read boolean repo flags from raw GitHub API JSON, and use `pushed_at` rather than `updated_at` when judging whether a project is alive. That single field error is what made Komf and JellyBook look healthier than they are.