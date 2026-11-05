# Raise the export passphrase floor

## What

Require a stronger passphrase for profile export and raise the PBKDF2 iterations.

## Why

The old floor let `password1234` through on a file that bundles every secret. PBKDF2 at 200k was low for a portable file.

## Done when

Shipped in v0.10.7. The passphrase floor is raised and PBKDF2 is at 600k. Checked against the code on 2026-11-03.

## Notes

Finding L7 in `docs/remediation-findings.md`. An "omit secrets" export mode was an optional extra in the finding.
