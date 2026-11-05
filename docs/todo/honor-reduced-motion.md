# Honor reduced motion everywhere

## What

Stop the two looping animations, the stepper pulse and a shimmer, when the user prefers reduced motion.

## Why

They were the one leak in an otherwise thorough reduced-motion story.

## Done when

`globals.css` clamps every animation and transition under reduced motion. Checked against the code on 2026-11-03.

## Notes

Finding L5 in `docs/remediation-findings.md`.
