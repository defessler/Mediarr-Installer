# Write the env file atomically

## What

Replace the in-place truncate of `.env` in `setup-arr-config.py` with a temp file and an atomic replace.

## Why

The write-back runs about seven times per install. A crash mid-write could corrupt the secrets file.

## Done when

Shipped in v0.10.4. Checked against the code on 2026-11-03.

## Notes

Finding L1 in `docs/remediation-findings.md`.
