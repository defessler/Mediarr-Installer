# Package the Windows build

## What

Package the installer for Windows and smoke-test it on a real NAS.

## Why

Windows x64 is the primary target.

## Done when

Shipped. It landed in a different shape than planned. The Windows build is a zip rather than NSIS. Checked against `installer/src` on 2026-11-03.

## Notes

Phase 1, estimated 3h. Build and distribution is section 6 of `installer/design.md`.
