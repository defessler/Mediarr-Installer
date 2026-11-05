# Fail fast on old Compose and podman-compose

## What

Make VPN-off installs stop with a clear message on Compose before 2.20 and on podman-compose, which can't parse the `!reset` override in `docker-compose.no-vpn.yml`.

## Why

VPN is off by default, so every default install layers that override. Hosts that can't parse it hung at "Start the stack" for the 600 second timeout and then failed with a generic error.

## Done when

Shipped in v0.10.13. A VPN-off install on an old Compose now fails fast. Checked against the code on 2026-11-03.

## Notes

Finding H1 in `docs/remediation-findings.md`. Only the fail-fast subset shipped. The standalone compose files option from the finding wasn't built.
