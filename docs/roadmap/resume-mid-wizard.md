# Resume the wizard mid-run

## What

Persist wizard state so closing the app mid-run resumes where it left off.

## Why

An install is long, and users close the window.

## Done when

Shipped. Checked against `installer/src` on 2026-11-03.

## Notes

Phase 2, estimated 2h. The plan used Zustand persist.
