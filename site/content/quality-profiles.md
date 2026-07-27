---
title: "Quality Profiles"
description: "Choose 1080p or 4K, WEB or Bluray, and change your mind whenever you like."
lede: "Choose 1080p or 4K, WEB or Bluray, and change your mind whenever you like."
group: "Using your stack"
order: 8
---
This guide explains quality profiles, what they are, what the installer sets up for you, and how to change them without reinstalling.

> **In one sentence:** a quality profile tells Sonarr and Radarr which release to grab when several exist. The installer picks sensible defaults for you, and you can change them by editing one line in `.env` and re-running the wizard.

> For how profiles affect what actually gets downloaded day to day, see [Movies & TV](Movies-and-TV).
> To set your profile picks during first-time setup, see [Installation](Installation).

## What a quality profile is

When a movie or TV episode is available in multiple versions (1080p WEB-DL, 4K Bluray Remux, a bad HDTV rip) Sonarr and Radarr use a **quality profile** to decide which one to grab. The profile defines:

- **Resolution** - 1080p or 4K (2160p)
- **Source** - WEB (streaming encode) or Bluray (disc rip / remux)
- **Scoring** - custom formats from the [TRaSH Guides](https://trash-guides.info) rank releases by things like audio codec, HDR type, and release group quality

You never have to hand-craft these settings. The installer uses **Recyclarr** to pull the TRaSH Guide profiles and load them straight into Sonarr and Radarr automatically.

## What the installer sets by default

| App | Default profile |
|---|---|
| Sonarr | `web-1080p` |
| Radarr | `hd-bluray-web` |

These are the TRaSH Guide community-recommended picks for a typical home server: good quality, reasonable file sizes, wide compatibility. **Most setups never need to change them.**

## Available profiles

**Sonarr:**

| Profile key | What it applies |
|---|---|
| `web-1080p` | Default. 1080p streaming releases (WEB), with Bluray sources scored highest within this profile |
| `web-2160p` | 4K WEB (HDR / Dolby Vision scored) |
| `bluray-1080p` | Alias for `web-1080p`. TRaSH has no separate Sonarr Bluray recipe, and WEB-1080p already scores Bluray sources highest |
| `bluray-2160p` | Alias for `web-2160p`, same reason as above |
| `anime` | Anime-specific scoring (sub groups, encoders) |

**Radarr:**

| Profile key | What it applies |
|---|---|
| `hd-bluray-web` | Default. 1080p Bluray + WEB, whichever scores higher |
| `uhd-bluray-web` | 4K Bluray + WEB (HDR / Dolby Vision scored) |
| `remux-web-2160p` | Top-tier 4K Remux (largest files, best quality) |
| `anime` | Anime-specific scoring |

## Changing your profile after install

You do not need to reinstall fully. Edit `.env` (in your install directory) and change the profile key:

```
TRASH_SONARR_PROFILE=web-1080p
TRASH_RADARR_PROFILE=hd-bluray-web
```

Then re-run the installer. The Configure screen lets you pick a new profile from a dropdown, and the installer re-runs `recyclarr sync` automatically to push the new scoring rules into Sonarr and Radarr. Existing downloads are not affected. Only future grabs use the new scoring.

If you prefer to skip the wizard, edit `recyclarr.yml` in your install directory by hand, then run:

```
docker exec recyclarr recyclarr sync
```

## A note on 4K

The `web-2160p`, `uhd-bluray-web`, and `remux-web-2160p` profiles pull 4K files, which are significantly larger and require:

- Enough free disk space (Remux files can be 50 to 80 GB per movie)
- A Plex or Jellyfin client that can play 4K, and ideally direct-play it, since transcoding 4K is CPU-heavy

Do not switch to a 4K profile unless your playback setup handles it. You can set Sonarr and Radarr to different profiles, for example 4K movies but 1080p TV.

## Tips

- **Recyclarr runs on a schedule** - it re-syncs profiles automatically so any upstream TRaSH Guide improvements land in your setup without any action from you.
- **Nothing is downloading?** A very strict profile combined with limited indexers can mean no release scores high enough. Try loosening the profile or adding more [Indexers](Indexers).
- **Profiles do not affect existing media** - only future grabs. Sonarr and Radarr will upgrade an already-imported file if a better-scoring release appears and your profile has upgrades enabled.
- See [Movies & TV](Movies-and-TV) for how Sonarr and Radarr use profiles when searching and importing.
