# Gate FlareSolverr on arm64 in setup.sh

## What

Move the arm64 FlareSolverr disable, and the 32-bit and FreeBSD blocks, from the renderer into `setup.sh`.

## Why

Only a renderer effect dropped FlareSolverr on arm64, where its Chromium crash-loops. A manual `bash setup.sh`, an old `.env` or an imported x86 profile re-armed the container.

## Done when

Shipped in v0.10.4. The `setup.sh` layer now protects every entry path. Checked against the code on 2026-11-03.

## Notes

Finding H2 in `docs/remediation-findings.md`.
