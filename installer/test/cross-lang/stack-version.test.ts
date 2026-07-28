import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASH, PYTHON, NAS_SCRIPTS, extractShellFunc, runBash, runPython } from '../helpers/shell.js'

// scripts/stack-version answers "which build is this box on, and when did it
// go in". Three languages touch it: copy-nas-payload.mjs writes it at build
// time, setup.sh appends deployed= on every run, librarian.py and
// setup-arr-config.py read it back.
//
// It exists because there was no way to tell. Working out a NAS's version
// meant fingerprinting the rendered page by which features showed up, and a
// sidecar could sit several releases behind with nothing reporting it. A
// stamp nobody can parse would be worse than none, so the seam is pinned.

const SETUP_SH = join(NAS_SCRIPTS, 'setup.sh')
const LIBRARIAN = join(NAS_SCRIPTS, 'librarian.py')

/** Run the REAL stamp_deploy_time from setup.sh against a scripts dir. */
function stamp(scriptDir: string): void {
  const program =
    extractShellFunc(SETUP_SH, 'stamp_deploy_time') + '\n' +
    `SCRIPT_DIR=${JSON.stringify(scriptDir)}\n` +
    'stamp_deploy_time\n'
  runBash(program)
}

/** Read it back with the REAL stack_stamp from librarian.py. */
function readBack(installDir: string): Record<string, string> {
  const program = [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location('lib', ${JSON.stringify(LIBRARIAN)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    `m.install_dir = lambda: ${JSON.stringify(installDir)}`,
    'st = m.stack_stamp()',
    'print(json.dumps({**st, "summary": m.stamp_summary(st)}))',
  ].join('\n')
  const r = runPython(program)
  expect(r.status, `python exited ${r.status}: ${r.stdout}`).toBe(0)
  return JSON.parse(r.stdout.trim().split('\n').pop() as string)
}

function fixture(body: string | null): { install: string; scripts: string; cleanup: () => void } {
  const install = mkdtempSync(join(tmpdir(), 'mediarr-stamp-'))
  const scripts = join(install, 'scripts')
  mkdirSync(scripts)
  if (body !== null) writeFileSync(join(scripts, 'stack-version'), body, 'utf8')
  return { install, scripts, cleanup: () => rmSync(install, { recursive: true, force: true }) }
}

// Exactly what copy-nas-payload.mjs emits, comments and all.
const BUILT = [
  '# Written by copy-nas-payload.mjs at build time. setup.sh appends',
  '# deployed= on each run. Read by librarian.py and setup-arr-config.py.',
  'version=0.26.0',
  'sha=abc1234',
  'built=2026-07-28T17:49:45Z',
  'files=36',
  '',
].join('\n')

describe.skipIf(!PYTHON)('stack-version: python reads what the build wrote', () => {
  it('parses the build stamp and ignores comments', () => {
    const f = fixture(BUILT)
    try {
      const s = readBack(f.install)
      expect(s.version).toBe('0.26.0')
      expect(s.sha).toBe('abc1234')
      expect(s.built).toBe('2026-07-28T17:49:45Z')
      // Not deployed yet: the payload is uploaded but setup.sh hasn't finished.
      expect(s.deployed).toBe('')
      expect(s.summary).toBe('Mediarr v0.26.0 · built 2026-07-28 17:49:45')
    } finally { f.cleanup() }
  })

  it('degrades to nothing at all when the file is missing', () => {
    const f = fixture(null)
    try {
      const s = readBack(f.install)
      expect(s.version).toBe('')
      // A hand-rolled install has no stamp. Not knowing the version must
      // never be a reason to fail a storage report.
      expect(s.summary, 'no stamp means no line, not a crash').toBe('')
    } finally { f.cleanup() }
  })
})

describe.skipIf(!BASH || !PYTHON)('stack-version: bash stamps, python reads', () => {
  it('setup.sh adds deployed= and librarian.py sees it', () => {
    const f = fixture(BUILT)
    try {
      stamp(f.scripts)
      const s = readBack(f.install)
      expect(s.version, 'the build fields must survive stamping').toBe('0.26.0')
      expect(s.built).toBe('2026-07-28T17:49:45Z')
      expect(s.deployed, 'deployed must be an ISO UTC instant').toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      // Once deployed, that's the date worth showing, not the build date.
      expect(s.summary).toMatch(/^Mediarr v0\.26\.0 · deployed \d{4}-\d{2}-\d{2} /)
    } finally { f.cleanup() }
  })

  it('re-running setup.sh replaces the timestamp instead of stacking them', () => {
    const f = fixture(BUILT)
    try {
      stamp(f.scripts)
      stamp(f.scripts)
      stamp(f.scripts)
      const raw = readFileSync(join(f.scripts, 'stack-version'), 'utf8')
      const lines = raw.split('\n').filter((l) => l.startsWith('deployed='))
      expect(lines, 'three runs, one deployed= line').toHaveLength(1)
      expect(readBack(f.install).version).toBe('0.26.0')
    } finally { f.cleanup() }
  })

  it('stamps a checkout that has no build stamp at all', () => {
    // Running setup.sh straight from a git clone: there's no payload file,
    // so it makes one rather than skipping the timestamp.
    const f = fixture(null)
    try {
      stamp(f.scripts)
      const s = readBack(f.install)
      expect(s.deployed).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(s.version, 'an unbuilt checkout honestly reports unknown').toBe('unknown')
    } finally { f.cleanup() }
  })
})
