# Guide a lost session back to a reconnect

## What

Fix the EnvDetect "Re-detect" button, which re-ran against a stale session.

## Why

A user who installed Docker and clicked Re-detect concluded the tool still couldn't see it. The real fix was Back, then reconnect.

## Done when

Done another way. A lost session now tells you to go Back and reconnect, and the screen re-scans by itself afterwards. Checked against the code on 2026-11-03.

## Notes

Finding L4 in `docs/remediation-findings.md`. The finding's own fix was a "Reconnect and re-scan" primary button.
