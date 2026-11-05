# Hash only the behavior-relevant env settings for resume

## What

Change the resume checkpoint in `nas/scripts/setup.sh` so it hashes the behavior-relevant subset of `.env`, or snapshots the hash after the prelude. Today `compute_env_hash` hashes the whole file.

## Why

The prelude mutates `.env` on every run. Benign normalization can therefore force a full replay. A future non-idempotent prelude edit would silently break resume. This matters more now that Retry leans on resume.

## Done when

A benign `.env` rewrite no longer invalidates the checkpoint. A change to a setting that affects behavior still does. A test run covers both cases.

## Notes

Effort M. Finding L2 in `docs/remediation-findings.md`, at `setup.sh:1046-1056`. It touches a tested core path, so it wants care and ideally a test run.
