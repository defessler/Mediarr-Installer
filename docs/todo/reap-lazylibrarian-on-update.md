# Remove the retired LazyLibrarian container on Update

## What

Make the wizard's Update path stop and remove the `lazylibrarian` container, the way a full install run already does.

## Why

LazyLibrarian left the stack in v0.33.0. `stop_disabled_services` in `setup.sh` reaps its container by name, but the Update path runs its own embedded bash (two builders in `UpdateRunScreen.tsx`) and never calls `setup.sh`. An install that only ever updates keeps the old container running on port 49160, on an image nothing pulls any more, with no tile and no firewall rule pointing at it.

## Done when

After an Update on an install that had `ENABLE_LAZYLIBRARIAN=true`, `docker ps -a` shows no `lazylibrarian` container, its config folder is still on disk, and the log says it was removed and that Shelfmark replaced it.

## Notes

Both builders need the same lines, and `test/cross-lang/optin-render-gate.test.ts` is the place to pin them. The site page currently tells people a full re-run is what removes it, so update `site/content/reading.md` in the same change.
