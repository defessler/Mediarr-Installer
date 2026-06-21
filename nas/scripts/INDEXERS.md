# Indexer Reference — Usenet + Trackers (with anime + Korean-drama focus)

This doc explains every indexer the Mediarr stack supports, what it covers, what it requires (account / key / cookie), and which ones are realistic for anime + Korean drama specifically.

Read it before buying any indexer subscription — the right mix depends a lot on what you actually want to download.

---

## Table of contents

- [How indexers work in this stack](#how-indexers-work-in-this-stack)
- [Tier 1: Free, no account](#tier-1-free-no-account)
- [Tier 2: Paid usenet indexers](#tier-2-paid-usenet-indexers)
- [Tier 3: Public torrent indexers](#tier-3-public-torrent-indexers)
- [Tier 4: Private trackers (invite + ratio)](#tier-4-private-trackers-invite--ratio)
- [Anime — recommended mix](#anime--recommended-mix)
- [Korean drama — recommended mix](#korean-drama--recommended-mix)
- [What's not included + why](#whats-not-included--why)

---

## How indexers work in this stack

**Prowlarr is the indexer hub.** You add an indexer (any indexer) to Prowlarr once, and Prowlarr automatically syncs it to Sonarr, Radarr, and Lidarr via app-link. Searches go Prowlarr → indexer → results back through Prowlarr to the requesting arr.

This means:

- **You don't add indexers to Sonarr/Radarr directly.** Add them to Prowlarr; the arrs see them automatically.
- **The wizard's "Advanced → Usenet / Trackers" sections** are just credential collectors. The actual indexer entries are created in Prowlarr by `setup-indexers.py` during install (Step 8).
- **Public indexers go in automatically.** If an indexer requires no account (Nyaa for anime torrents, NZBKing for usenet), it's added without you typing anything. You just need to enable the parent download client (qBittorrent for torrents, SABnzbd for usenet).

### Usenet vs. torrents — quick refresher

- **Usenet** is a paid centralised file-distribution network. You pay a *provider* (Eweka, Newshosting, UsenetServer, etc.) for download access, then use an *indexer* (NZBGeek, AnimeTosho, etc.) to find the .nzb files that point at the binary articles. Two separate paid services. Fast (typically saturates your connection), no seeding, no peer interaction.
- **Torrents** are peer-to-peer. You don't pay anyone; you just need to find the .torrent or magnet (via an *indexer*, the same role as for usenet) and connect to peers. Speed depends on the swarm. You're expected to seed back after.

This document focuses on **indexers** (the "where do I find this?" layer). Usenet *providers* are a separate purchase — Eweka, Newshosting, and Frugal Usenet are the consensus picks for European, US, and budget respectively.

---

## Tier 1: Free, no account

These work out of the box. The wizard adds them automatically — no fields to fill in.

### Usenet

| Indexer | URL | Coverage | Notes |
|---|---|---|---|
| **AnimeTosho** | https://animetosho.org | Anime (broad), some Asian drama | The single best free indexer for anime. Aggregates from multiple sources including private trackers' public NZB exports. Optional API key raises the rate limit; not required for normal use. |
| **NZBKing** | https://nzbking.com | General usenet | Public Newznab-compatible indexer. No registration. Coverage is broad but shallow; expect more searching to find a specific release. |
| **Binsearch** | https://binsearch.info | General usenet | Public, no signup. Surfaces raw binary articles — works well for older content and is the fallback most other indexers fail back to. |

The wizard adds all three to Prowlarr at install time. Together they cover ~80% of common anime + general usenet searches.

### Torrents

| Indexer | URL | Coverage | Notes |
|---|---|---|---|
| **Nyaa** | https://nyaa.si | Anime (the primary one) | Largest open anime torrent index. No account needed. Categories distinguish raw / softsub / hardsub / dual-audio. |
| **SubsPlease** | https://subsplease.org | Current-season anime simulcasts | Specialised in same-day-as-airing simulcast rips. Use when you want this week's episode of an airing show. |
| **Tokyo Toshokan** | https://www.tokyotosho.info | Japanese media (anime + raws) | Long-running aggregator covering anime + Japanese raws + music. |
| **YTS** | https://yts.mx | Movies (English) | Small file sizes, English-friendly. Good entry point for a casual movie library. |
| **1337x** | https://1337x.to | General | Wide release coverage. CloudFlare-gated — the wizard's Flaresolverr proxy handles the challenge automatically. |
| **The Pirate Bay** | https://thepiratebay.org | General | Veteran public tracker. |
| **EZTV** | https://eztv.re | TV (English) | TV-only catalogue, RSS-friendly. |
| **Knaben** | https://knaben.org | General (Scandinavian-flavoured) | Norwegian-run general index with surprisingly good worldwide coverage; well-categorised. |
| **ShowRSS** | https://showrss.info | TV (English) | Curated RSS feeds for TV shows — handy as a Sonarr "always-on" feed for popular shows. |

The wizard adds all of these to Prowlarr automatically. You'll get them on a fresh install with no extra config.

---

## Tier 2: Paid usenet indexers

These charge a one-time or annual fee for a fuller-featured API. The wizard collects API keys but doesn't auto-add anything you don't have a key for.

Worth-it picks for anime + K-drama users:

| Indexer | URL | Anime | K-drama | Notes |
|---|---|---|---|---|
| **NZBGeek** | https://nzbgeek.info | ★★★☆☆ | ★★☆☆☆ | The most popular paid indexer overall. ~$13/year. Good general coverage; anime is acceptable but AnimeTosho often catches more. K-drama coverage is thin. |
| **NZBFinder** | https://nzbfinder.ws | ★★★★☆ | ★★☆☆☆ | Strong anime indexing, comparable to AnimeTosho but with deeper non-anime coverage. ~$15/year. |
| **NZBPlanet** | https://nzbplanet.net | ★★★☆☆ | ★★☆☆☆ | Solid all-rounder. ~$10/year. |
| **DrunkenSlug** | https://drunkenslug.com | ★★★★★ | ★★★☆☆ | **Often cited as the best for anime** by community. Invite-only — check r/usenet for the periodic open-registration windows. |
| **NZB.cat** | https://nzb.cat | ★★★★☆ | ★★☆☆☆ | Anime-strong indexer. Sometimes opens registration. |
| **DogNZB** | https://dognzb.cr | ★★★☆☆ | ★★☆☆☆ | Veteran indexer; invite-only. |
| **NinjaCentral** | https://ninjacentral.co.za | ★★★☆☆ | ★★☆☆☆ | Mid-tier, sometimes-open registration. |
| **Tabula Rasa** | https://tabula-rasa.pw | ★★★☆☆ | ★★☆☆☆ | Newer indexer with active uploaders. |

The honest answer: **for anime, the combination of free AnimeTosho + paid NZBFinder/DrunkenSlug covers ~95% of what you'll search for**. For K-drama, usenet is a poor fit; see the Korean drama section below.

---

## Tier 3: Public torrent indexers

Already listed in Tier 1. The wizard adds them all automatically.

---

## Tier 4: Private trackers (invite + ratio)

Private trackers offer fundamentally better selection + quality for niche content, at the cost of invite gates and ratio requirements (you have to upload back at least as much as you download).

The wizard collects credentials on the Configure → Advanced → Private trackers section.

### Anime

| Tracker | URL | Notes |
|---|---|---|
| **AnimeBytes** | https://animebytes.tv | The gold standard for anime. Massive catalogue, perfect tagging, lossless options. **Invite-only** — generally not in open recruitment. |
| **AnimeTorrents** | https://animetorrents.me | Anime tracker; periodically opens registration. |
| **U2.dmhy** | https://u2.dmhy.org | Chinese-run anime tracker — vast Chinese-fansub catalogue. Invite-only, registration in Chinese. |

### Asian (K-drama + C-drama + J-drama + Asian cinema)

| Tracker | URL | Notes |
|---|---|---|
| **AvistaZ** | https://avistaz.to | **The primary Asian content tracker.** Korean drama, Chinese drama, Hong Kong cinema, all curated. Strong English internal UI. **Sometimes opens registration** — check the homepage for "applications open" banners. Requires a `pid` (passkey) from your profile page. |
| **HomieHelpDesk (HHD)** | https://homiehelpdesk.net | Korean-focused tracker. Heavy on K-drama + K-cinema. Invite-only. |
| **Cinematik** | (varies) | Korean-influenced cinema tracker. |
| **CinemaZ** | https://cinemaz.to | AvistaZ sister site — international + indie cinema. Korean cinema spillover. |

### General-purpose

| Tracker | URL | Notes |
|---|---|---|
| **IPTorrents** | https://iptorrents.com | Well-established general tracker. Cookie-based auth — copy your session cookie from a browser and paste in the wizard. |

---

## Anime — recommended mix

A realistic anime-watcher's indexer setup, in order of importance:

1. **AnimeTosho (free)** — added automatically. Covers ~80% of anime searches by itself.
2. **Nyaa (free)** — torrent fallback for anything AnimeTosho doesn't have. Added automatically.
3. **SubsPlease (free)** — added automatically. Most reliable simulcast source for currently-airing shows.
4. **Tokyo Toshokan (free)** — added automatically. Catches Japanese raws + lesser-known fansubs.
5. **AnimeBytes (private)** — if you can get an invite. Best quality + best catalogue, period.
6. **NZBFinder or DrunkenSlug (paid usenet)** — only worth it if you're a heavy usenet user. AnimeTosho + Nyaa cover most needs.

What this looks like in practice: a fresh wizard install with **no usenet provider** and **no private trackers** still has Nyaa + SubsPlease + Tokyo Toshokan + AnimeTosho. That's a working anime stack from zero.

---

## Korean drama — recommended mix

K-drama is overwhelmingly tracker-driven; usenet coverage is thin and irregular.

1. **AvistaZ (private, sometimes-open)** — the only realistic primary source for K-drama at scale. Watch their homepage for the "applications open" banner; submit when it opens (usually requires a brief application).
2. **HomieHelpDesk (private, invite-only)** — Korean-focused tracker if you have an invite path.
3. **CinemaZ (AvistaZ sister)** — Korean cinema overflow.
4. **Public trackers (Nyaa, 1337x)** — Nyaa has scattered K-drama uploads (esp. anime-influenced shows like *Hellbound*); 1337x has some recent K-drama with English subs.
5. **Paid usenet indexers** — only worth it for niche/older K-drama that's vanished from torrents. NZBFinder + NZBGeek occasionally have it.

The honest answer: **without AvistaZ access, K-drama acquisition is significantly harder**. The recommended path is to apply during an open-registration window and start there.

If you can't get AvistaZ, the public-only setup works for most current-season K-drama (Nyaa + 1337x cover the recent hits), but back-catalogue + obscure shows will be hit-or-miss.

---

## Music — recommended mix

Lidarr draws from the same indexer pool as Sonarr/Radarr, plus dedicated music trackers. In rough order of value:

1. **Redacted (RED) (private, invite/interview)** — the premier music tracker (What.CD lineage); unmatched depth + quality. API-key auth.
2. **Orpheus (OPS) (private, invite)** — the other top-tier music tracker, a great RED complement. API-key auth.
3. **RuTracker (free signup)** — a huge Russian general tracker with deep music / full-discography coverage; the single best *free* music source. Username/password auth, CloudFlare-gated so it routes through FlareSolverr (which the installer disables on arm64 — no RuTracker there). The signup form is in Russian.
4. **NZBFinder / NZB.su (paid usenet)** — both carry music alongside their general coverage; worth it if you already run usenet.

All are opt-in — added only when you supply credentials. In the wizard they appear under **Configure → Find indexers** with the **Music** filter; the keys live in `.env.example`.

---

## What's not included + why

A non-exhaustive list of indexers we deliberately don't ship + the reason:

| Indexer | Why not |
|---|---|
| **NZBStars** | Paid, was unreliable last we checked. Not worth competing with the established names. |
| **Newzleech** | Public free usenet indexer that's been intermittently down for years. Not stable enough to default-add. |
| **NZBIndex.com** | Freemium, but free tier is heavily ad-loaded + has download-count limits. Doesn't add coverage AnimeTosho doesn't already provide. |
| **Solidtorrents / BitSearch** | Removed from Prowlarr's upstream indexer DB (renamed / discontinued). Adding them produces "indexer not found" errors at install. |
| **Anidex** | Currently slow + sparsely-populated. Nyaa covers what it offers. |
| **Pantheon, Tracker01, ...** | Long tail of private trackers without strong English-language onboarding. Out of scope for a turnkey installer. |
| **MyAnonamouse** | Excellent ebook/audiobook tracker but out of scope for the Mediarr media stack. |

If you need an indexer not on this list, you can always add it directly in Prowlarr's UI after install — the wizard's auto-add is a sensible default, not a hard limit.
