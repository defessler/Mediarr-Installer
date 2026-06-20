import { defineConfig } from 'vitest/config'

// Unit + cross-language tests for the installer. Pure logic lives in
// src/shared/* (no Electron, no DOM), so a plain node environment is all we
// need — the .js import specifiers resolve to .ts via Vite's bundler
// resolution, the same pipeline electron-vite builds with.
//
// The cross-language oracle suites shell out to bash / python3 to run the
// REAL nas-payload parsers against what the TS writer emits; they skip
// gracefully when those interpreters are absent (see test/helpers/shell.ts),
// and run for real in CI (ubuntu has both).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Oracle suites spawn subprocesses; keep the default fork pool but don't
    // let a single hung interpreter wedge the run.
    testTimeout: 20000,
  },
})
