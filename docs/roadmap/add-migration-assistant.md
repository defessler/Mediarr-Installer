# Add the migration assistant

## What

Wrap the migration scripts, such as `migration/fix-plex-paths.py`, in a guided flow.

## Why

Moving an existing setup is a separate job from a fresh install.

## Done when

Shipped. Checked against `installer/src` on 2026-11-03.

## Notes

Phase 3, estimated 4h. `nas/migration/` never ships in the payload, so check how the flow reaches those scripts.
