# Split the config form into screens

## What

Split the combined config form into separate screens for base config, VPN, qBittorrent, indexers and Bazarr providers, using zod and react-hook-form.

## Why

The first phase shipped one tall scrollable form to get a walking skeleton. The design calls for one screen per concern.

## Done when

The config is entered across separate screens, each validated with zod and react-hook-form.

## Notes

Phase 2, estimated 6h. Screens 5 to 9 in `installer/design.md`. It is still unticked, so check the current Configure screen before starting, since it may have gone another way.
