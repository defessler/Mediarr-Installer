# Name the field in Configure errors

## What

Make a blocking Configure error expand its group and name the field with a readable label, instead of a raw env key in a collapsed group.

## Why

A first-timer who accepted the defaults hit an error naming `QBITTORRENT_PASS` inside a collapsed group, right after the footer said "Ready to install".

## Done when

Shipped in v0.10.10 and v0.10.12. Errors expand their group and use humanized labels. Checked against the code on 2026-11-03.

## Notes

Finding H3 in `docs/remediation-findings.md`. Click-to-jump and seeding a default qBittorrent password were options in the finding.
