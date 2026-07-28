import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PYTHON, NAS_SCRIPTS, runPython } from '../helpers/shell.js'

// librarian.py carries the SAME fuzzy matcher twice: `fuzzy_score` in Python
// for the CLI's --filter, and `fuzzyScore` inside the SCRIPT constant for the
// page's search box. Its own docstring says "change one and change the other,
// or the same search ranks differently depending on whether you typed it into
// the CLI or the browser" — and nothing enforced that, so they drifted.
//
// The drift that got shipped: the JS lowercased the query but never the
// haystack. `rmx` matched "Arrival 2021 Remux-2160p" (a lowercase r sits in
// "Arrival") and missed "Dune 2021 Remux-2160p" (its only lowercase r is away
// in "radarr"), while the CLI matched both. Two items with identical quality,
// one findable and one not, for a reason no user could ever guess.
//
// So run BOTH real implementations over the same matrix and require identical
// answers. This is an oracle: neither side is reimplemented here.

const LIBRARIAN = join(NAS_SCRIPTS, 'librarian.py')

/** Pull the real fuzzyTerm/fuzzyScore out of the SCRIPT constant and make
 *  them callable, rather than copying the algorithm into the test. */
function loadJsFuzzy(): (q: string, t: string) => [boolean, number] {
  // Normalize CRLF: the repo checks out with Windows endings, and an
  // anchor of '\n}\n' silently matches nothing against '\r\n}\r\n',
  // which slices out an empty body instead of failing.
  const src = readFileSync(LIBRARIAN, 'utf8').replace(/\r\n/g, '\n')
  const start = src.indexOf('var ALNUM =')
  const scoreAt = src.indexOf('function fuzzyScore(', start)
  expect(start, 'ALNUM not found in librarian.py SCRIPT').toBeGreaterThan(-1)
  expect(scoreAt, 'fuzzyScore not found in librarian.py SCRIPT').toBeGreaterThan(-1)
  const end = src.indexOf('\n}\n', scoreAt) + 3
  const body = src.slice(start, end)
  expect(body, 'extracted an empty or truncated matcher').toContain('return [true, total];')
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn fuzzyScore;`)() as (q: string, t: string) => [boolean, number]
}

/** JSON with every non-ASCII character escaped. Windows hands the child
 *  process stdin in the console codepage, not UTF-8, so a literal "å" arrives
 *  as two characters, every later index shifts, and the score comes back one
 *  point off for a reason that has nothing to do with the matcher. */
function asciiJson(value: unknown): string {
  let out = ''
  for (const ch of JSON.stringify(value)) {
    const code = ch.charCodeAt(0)
    out += (code < 32 || code > 126)
      ? '\\u' + code.toString(16).padStart(4, '0')
      : ch
  }
  return out
}

/** Run the real Python fuzzy_score over the whole matrix in one process. */
function pyFuzzy(pairs: [string, string][]): [boolean, number][] {
  const program = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location('lib', ${JSON.stringify(LIBRARIAN)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'pairs = json.loads(sys.stdin.read())',
    'print(json.dumps([list(m.fuzzy_score(q, t)) for q, t in pairs]))',
  ].join('\n')
  const r = runPython(program, { input: asciiJson(pairs) })
  return JSON.parse(r.stdout.trim())
}

// Real item_haystack output: title, year, quality, codec, arr, kind. Mixed
// case is the whole point, and "Låtar" covers the isalnum vs [a-z0-9] gap.
const HAYSTACKS = [
  'Dune 2021 Remux-2160p x265 radarr movie',
  'Arrival 2021 Remux-2160p x265 radarr movie',
  'Severance 2022 WEBDL-1080p h264 sonarr series',
  'Zulu Dawn 1979 WEBDL-1080p x265 sonarr series',
  'Låtar Från Norr 2019 FLAC lidarr album',
  'THE BATMAN 2022 Bluray-2160p x265 radarr movie',
  'Marvels Agents of S.H.I.E.L.D. 2013 HDTV-720p sonarr series',
]

const QUERIES = [
  'rmx', 'rmx 216', 'remux', 'remux 2160', 'REMUX', 'Rmx 216',
  'sev', 'batman', 'BATMAN', 'shield', 'x265', 'radarr', 'sonarr movie',
  'flac', 'latar', 'norr', 'dune', 'zzz', 'web 1080', '2160p', '',
]

describe.skipIf(!PYTHON)('librarian fuzzy matcher: Python and JS agree', () => {
  const jsScore = loadJsFuzzy()
  const pairs: [string, string][] = []
  for (const q of QUERIES) for (const h of HAYSTACKS) pairs.push([q, h])
  const py = pyFuzzy(pairs)

  it('matches the same rows for every query', () => {
    pairs.forEach(([q, h], i) => {
      expect(jsScore(q, h)[0], `match differs for "${q}" against "${h}"`).toBe(py[i][0])
    })
  })

  it('ranks them identically too', () => {
    pairs.forEach(([q, h], i) => {
      expect(jsScore(q, h)[1], `score differs for "${q}" against "${h}"`).toBe(py[i][1])
    })
  })

  it('finds both Remux items for "rmx", the case that was broken', () => {
    const dune = 'Dune 2021 Remux-2160p x265 radarr movie'
    const arrival = 'Arrival 2021 Remux-2160p x265 radarr movie'
    expect(jsScore('rmx', dune)[0], 'Dune must match rmx').toBe(true)
    expect(jsScore('rmx', arrival)[0], 'Arrival must match rmx').toBe(true)
    expect(jsScore('rmx 216', dune)[0]).toBe(true)
  })

  it('an uppercase query still matches, and scores the same as lowercase', () => {
    const h = 'THE BATMAN 2022 Bluray-2160p x265 radarr movie'
    expect(jsScore('BATMAN', h)).toEqual(jsScore('batman', h))
  })
})
