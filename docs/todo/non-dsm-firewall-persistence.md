# Persist the firewall rule on non-DSM hosts

## What

Offer an opt-in, idempotent systemd unit or firewalld permanent rule on hosts that aren't Synology DSM, plus a re-check.

## Why

Firewall persistence is Synology-only. A non-DSM host with a real blocking DOCKER-USER or firewalld rule gets one-shot guidance and no persistent rule. `diagnose-firewall.sh` still only prints guidance.

## Done when

On a non-DSM host the installer can offer a persistent rule, and a later run re-checks it. It has been verified on real non-DSM hardware.

## Notes

Finding L3 in `docs/remediation-findings.md`, sized M, at `setup.sh:1081` and `diagnose-firewall.sh:185-186`. It can't be verified without the hardware.
