# Verify Shelfmark on a live NAS

## What

Install with `ENABLE_SHELFMARK=true` on a real NAS and check that Shelfmark comes up linked to Prowlarr, qBittorrent and SABnzbd, then fetch one ebook and one audiobook end to end.

## Why

`configure_shelfmark` in `setup-arr-config.py` writes Shelfmark's settings into `config/plugins/*.json` and restarts the container. The tab names, key names and the env-over-file precedence were read from Shelfmark's source at v1.7.2, and `installer/test/cross-lang/shelfmark-wiring.test.ts` pins the rules for what gets written. None of it has run against the real container yet. The parts most likely to differ live:

- Whether the onboarding wizard on first launch keeps the Prowlarr link or writes over it.
- Whether the two path mappings resolve a real finished download. Their `host` is the client's name (`qbittorrent`, `sabnzbd`), which is what `get_client_host_identifier` in Shelfmark's `core/path_mappings.py` matches on, and not the URL's host. That matters with the VPN on, where qBittorrent's URL host is `gluetun`.
- Whether the lite image drops to `PUID:PGID` cleanly under `no-new-privileges`, and can still save the settings files the installer wrote as root and chowned.
- Whether an audiobook torrent hardlinks from `/data/Downloads/Torrents` into `/data/Media/Audiobooks`.

## Done when

On a fresh install the Shelfmark section of the log shows the settings as written, Settings -> Prowlarr in Shelfmark shows the link with a passing "Test", a re-run with nothing changed reports them as already set and doesn't restart the container, and one ebook lands in `Media/Books` and one audiobook in `Media/Audiobooks`.

## Notes

Upstream is github.com/calibrain/shelfmark. It replaced LazyLibrarian in v0.33.0. The compose block sets no `PROWLARR_*` env on purpose: Shelfmark counts a set-but-empty variable as set, and locks env-supplied fields in its UI. The site page is `site/content/reading.md`.
