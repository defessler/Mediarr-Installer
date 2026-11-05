# Sign the releases

## What

Code-sign the Windows build with an EV certificate and notarize the macOS build.

## Why

Code signing was skipped for v1, and the docs describe the SmartScreen warning instead.

## Done when

Released builds are signed, and Windows shows no SmartScreen warning from a missing signature.

## Notes

Phase 3, estimated 6h. The macOS half depends on the macOS build item.
