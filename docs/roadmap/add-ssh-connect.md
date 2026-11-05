# Connect over SSH with a password or key

## What

Add SSH connect with a password or a private key path, plus a test-connect call.

## Why

The installer reaches the NAS over SSH and SFTP.

## Done when

Shipped. Checked against `installer/src` on 2026-11-03.

## Notes

Phase 1, estimated 3h. The first phase had no profile saving. The connection layer is section 1 of `installer/design.md`.
