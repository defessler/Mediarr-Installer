import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { BASH, NAS_SCRIPTS, extractShellFunc, runBash } from '../helpers/shell.js'

// relocate-stack.sh's clean() lexically canonicalises a path the SAME way the
// Docker / Podman daemon does (Go filepath.Clean), so a non-canonical-but-
// equivalent .env path doesn't read as a path change and wedge a legit same-
// path re-run with "destination already exists". It is only ever fed ABSOLUTE
// paths (NEW_INSTALL / NEW_DATA from .env), so we fuzz absolute paths against a
// Go path.Clean reference oracle — codifying the audit's 2,205-case check as a
// permanent regression gate.

const RELOCATE_SH = join(NAS_SCRIPTS, 'relocate-stack.sh')

/** Go path.Clean, for forward-slash paths. The bash clean() must match this
 *  for every absolute input. */
function goPathClean(p: string): string {
  if (p === '') return '.'
  const rooted = p[0] === '/'
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!rooted) out.push('..')
    } else {
      out.push(seg)
    }
  }
  const res = (rooted ? '/' : '') + out.join('/')
  return res === '' ? '.' : res
}

/** Run bash clean() over many paths in ONE invocation — args carry the paths
 *  (stdin carries the program), one cleaned path per delimited line. */
function bashCleanMany(paths: string[]): string[] {
  const program =
    extractShellFunc(RELOCATE_SH, 'clean') +
    '\nfor p in "$@"; do clean "$p"; printf "\\n"; done'
  const out = runBash(program, { args: paths }).stdout
  const parts = out.split('\n')
  parts.pop() // drop the trailing '' after the final delimiter
  return parts
}

// Seeded LCG so a fuzz failure reproduces exactly.
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe.skipIf(!BASH)('clean() ↔ Go path.Clean oracle', () => {
  it('matches on the documented edge cases', () => {
    const cases: [string, string][] = [
      ['/', '/'],
      ['/volume1//Data', '/volume1/Data'],
      ['/volume1/./Data', '/volume1/Data'],
      ['/volume1/Media/../Data', '/volume1/Data'],
      ['/volume1/Data/.', '/volume1/Data'],
      ['/volume1/Data/', '/volume1/Data'],
      ['/volume1/../volume2/Data', '/volume2/Data'],
      ['/a/b/../../c', '/c'],
      ['/../a', '/a'],
      ['/a/..', '/'],
      ['/path with spaces/x/../y', '/path with spaces/y'],
    ]
    for (const [input, want] of cases) expect(goPathClean(input), `oracle(${input})`).toBe(want)
    const got = bashCleanMany(cases.map(([i]) => i))
    cases.forEach(([input, want], i) => expect(got[i], `clean(${input})`).toBe(want))
  })

  // Fuzz breadth on top of the pinned edge cases above. clean() is pure shell;
  // all 150 paths run in ONE batched bash invocation — ~5s on a local git-bash
  // dev box (measured), near-instant on CI's Linux bash. The per-test 60s
  // override (vs the 20s global testTimeout) is headroom for a slow/loaded
  // Windows runner; the edge cases above are what actually pin correctness, so
  // the fuzz count trades only breadth, not coverage of the tricky paths.
  it('matches the oracle on 150 fuzzed absolute paths', () => {
    const rng = makeRng(0xc0ffee)
    const segs = ['a', 'b', 'foo', 'bar', 'x y', '.', '..', '']
    const paths: string[] = []
    for (let n = 0; n < 150; n++) {
      const count = 1 + Math.floor(rng() * 7)
      let p = ''
      for (let i = 0; i < count; i++) p += '/' + segs[Math.floor(rng() * segs.length)]
      if (rng() < 0.2) p += '/' // sometimes a trailing slash
      paths.push(p)
    }
    const got = bashCleanMany(paths)
    expect(got.length).toBe(paths.length)
    paths.forEach((p, i) => expect(got[i], `clean(${JSON.stringify(p)})`).toBe(goPathClean(p)))
  }, 60000)
})
