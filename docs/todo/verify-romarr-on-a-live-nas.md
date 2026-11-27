# Verify ROMarr on a live NAS

## What

Install with `ENABLE_ROMARR=true` on a real NAS and check that ROMarr comes up linked to Prowlarr, qBittorrent and SABnzbd, then grab and import one ROM end to end.

## Why

`configure_romarr` in `setup-arr-config.py` writes the Prowlarr indexer, both download clients and the two remote path mappings through ROMarr's REST API. The routes, field names and the `settings._api_key` location were read from ROMarr's source at commit `a875dad` and pinned by `installer/test/cross-lang/romarr-wiring.test.ts` against a fake store. None of it has run against the real container yet. The parts most likely to differ live are `no-new-privileges` with its `su-exec` entrypoint, and whether qBittorrent's `/downloads/Completed/romarr` paths map to files ROMarr can open.

## Done when

On a fresh install the ROMarr section of the log shows Prowlarr, qBittorrent, SABnzbd and the path mappings as added, a re-run shows them as updated with no duplicates, and one grabbed ROM lands under `Media/Games/<platform>`.

## Notes

Upstream is github.com/BlizzHacker/romarr. Its env seeding (`_seed_from_env` in `romarr/app.py`) runs once on first boot only, which is why the compose block sets no `PROWLARR_*` or `QBITTORRENT_*` env. The site page is `site/content/games.md`.
