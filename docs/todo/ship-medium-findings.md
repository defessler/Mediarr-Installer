# Ship the medium findings M1 to M9 and M11

## What

Fix the medium findings M1 to M9 and M11 from the whole-app discovery pass.

## Why

They were concentrated rough edges in re-install safety, platform handling, wizard behavior and the VPN killswitch.

## Done when

Shipped across v0.10.4 to v0.11.0. Checked against the code on 2026-11-03.

## Notes

The per-version list is in `docs/remediation-findings.md`. M10, the `HOMEPAGE_ALLOWED_HOSTS` default, is not planned.
