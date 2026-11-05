# Wire the IPC layer and SSH and SFTP services

## What

Build the ssh-service and sftp-service, the preload bridge and a type-safe `invoke` wrapper.

## Why

The renderer never touches `ssh2` or the filesystem. Everything goes through a three-layer IPC model.

## Done when

Shipped. Checked against `installer/src` on 2026-11-03.

## Notes

Phase 1, estimated 4h. The channel design is section 4 of `installer/design.md`.
