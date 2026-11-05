# Resume Retry from the failed step

## What

Make a normal step failure's Retry resume from the failed step without rewriting `.env`.

## Why

Retry rewrote `.env` and ran setup with resume off, which invalidated the checkpoint hash. A late-step failure replayed from step 1.

## Done when

Shipped in v0.11.0. Retry resumes from the failed step and falls back to a full re-run on any config edit. Checked against the code on 2026-11-03.

## Notes

Finding H4 in `docs/remediation-findings.md`.
