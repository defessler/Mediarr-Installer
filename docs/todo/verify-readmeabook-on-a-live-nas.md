# Verify ReadMeABook on a live NAS

## What

Install with `ENABLE_READMEABOOK=true` and `ENABLE_AUDIOBOOKSHELF=true` on a real NAS, walk its first-run wizard with the values on the Reading page, and request one audiobook end to end.

## Why

ReadMeABook is the one reading service the installer doesn't configure. The compose block, the folder mounts and the wizard values on `site/content/reading.md` were worked out from its README and deployment docs at v1.3.0, and nothing has run. The parts most likely to differ live:

- Its bundled PostgreSQL on a NAS bind mount. `pgdata` must stay owned by the image's postgres user (UID 102), so `setup-folders.sh` deliberately creates only `readmeabook/config` and leaves the rest to docker and the entrypoint. Synology and UGOS ACLs may not accept that chown.
- `no-new-privileges` with an entrypoint that drops privileges through `gosu` and runs three processes under supervisord.
- Whether the wizard's default paths (`/downloads`, `/media/audiobooks`) work untouched for both clients, given SABnzbd reports paths under `/data/complete`.
- Whether `http://audiobookshelf:13378` is reachable from the container and the API token flow matches the page.

## Done when

The container reaches healthy on first boot and again after a NAS reboot, the wizard completes with every "Test" passing using only the values on the Reading page, and one requested audiobook is imported into `Media/Audiobooks` and marked available.

## Notes

Upstream is github.com/kikootwo/ReadMeABook. If the wizard values on the site page turn out wrong, fix the page in the same change. `relocate-stack.sh` moves `readmeabook/` with the other service folders, and a move that changes `pgdata`'s ownership would stop PostgreSQL from starting, so check a relocate too.
