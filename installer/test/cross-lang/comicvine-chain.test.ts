import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PYTHON, NAS_SCRIPTS, runPython } from '../helpers/shell.js'
import { renderEnv } from '../../src/shared/env-render.js'

// Walks the ComicVine key end to end: what a user types in the wizard, through
// the rendered .env, into the [CV] section of Mylar3's config.ini as the real
// Python writes it.
//
// Each link had its own passing test when v0.31.0 shipped, and Mylar3 search
// still came back blank. env-key-reachable pins that an input exists,
// key-parity pins that the three key lists agree, and I proved by hand that the
// Python writes the value. What nothing covered was the JOIN: whether the thing
// a person types survives every hop to the file Mylar3 reads. Two separate
// defects hid in exactly that gap, so the chain gets its own oracle.
//
// Mylar3 with no key answers a search with an EMPTY page rather than an error
// (webserve.py hits a bare return when COMICVINE_API is None), so every failure
// along this chain presents identically and none of them says what went wrong.

const ARR_PY = join(NAS_SCRIPTS, 'setup-arr-config.py')
const KEY = 'CHAIN-TEST-CV-KEY'

/** The (section, option) the SHIPPED script actually writes the key to, read
 *  out of its Mylar3 call site.
 *
 *  Load-bearing, and the first version of this test got it wrong. Hardcoding
 *  'CV'/'comicvine_api' here meant the test asserted against its own constant
 *  rather than the script's, so changing the caller to the plausible-but-wrong
 *  'comicvine_api_key' left all three cases green. A test that picks both sides
 *  of its own comparison cannot fail. Parsing the real tuple is what makes the
 *  red-check bite. */
function shippedCvTarget(): { section: string; option: string } {
  const src = readFileSync(ARR_PY, 'utf8')
  const m = src.match(/extra=\(\[\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*_cv_key\s*\)\]/)
  if (!m) throw new Error('Mylar3 ComicVine call site not found in setup-arr-config.py')
  return { section: m[1], option: m[2] }
}

/** Run the REAL reading_app_api_setup() against a temp config.ini seeded the
 *  way Mylar3 seeds it on first boot, and report what landed in [CV]. */
function writeThroughPython(cvKey: string): { cv: string | null; apiEnabled: string | null } {
  const { section, option } = shippedCvTarget()
  const program = [
    'import ast, configparser, os, tempfile, types, json',
    `src = open(${JSON.stringify(ARR_PY)}, encoding='utf-8').read()`,
    'tree = ast.parse(src)',
    "fns = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'reading_app_api_setup']",
    "assert fns, 'reading_app_api_setup not found in setup-arr-config.py'",
    'ns = {}',
    "for lvl in ('ok', 'warn', 'fail', 'info', 'skip'):",
    '    ns[lvl] = lambda m: None',
    'ns.update(configparser=configparser, os=os,',
    '          time=types.SimpleNamespace(time=lambda: 0.0, sleep=lambda s: None),',
    '          subprocess=types.SimpleNamespace(run=lambda *a, **k: None),',
    "          CONTAINER_RT='docker')",
    'exec(compile(ast.Module(body=fns, type_ignores=[]), "x", "exec"), ns)',
    'd = tempfile.mkdtemp()',
    "ini = os.path.join(d, 'config.ini')",
    // Mylar3's own first boot writes no [CV] section at all, so the code under
    // test has to create it. That's the real starting state, not a convenient one.
    "open(ini, 'w', encoding='utf-8').write('[General]\\nhttp_port = 8090\\n')",
    `CV = ${JSON.stringify(cvKey)}`,
    // Drive the SHIPPED (section, option), not a pair the test picked, and read
    // back from the pair Mylar3 itself requires. If the caller ever writes
    // somewhere else, those two disagree and this goes red.
    `SECTION, OPTION = ${JSON.stringify(section)}, ${JSON.stringify(option)}`,
    "ns['reading_app_api_setup']('Mylar3', 'mylar3', ini, 'API', 'api_enabled', 'api_key',",
    '                            probe_url=None, extra=[(SECTION, OPTION, CV)])',
    'p = configparser.ConfigParser(interpolation=None)',
    'p.optionxform = str',
    "p.read(ini, encoding='utf-8')",
    // Mylar3 reads [CV] comicvine_api. That expectation is fixed by Mylar3's
    // own config.py, so it is the one thing this test is allowed to hardcode.
    "print(json.dumps({'cv': p.get('CV', 'comicvine_api', fallback=None),",
    "                  'apiEnabled': p.get('API', 'api_enabled', fallback=None)}))",
  ].join('\n')
  return JSON.parse(runPython(program).stdout.trim())
}

describe('ComicVine key, wizard to config.ini', () => {
  it('renders into .env exactly as typed', () => {
    const line = renderEnv({ MYLAR_COMICVINE_KEY: KEY } as never)
      .split('\n')
      .find((l) => l.startsWith('MYLAR_COMICVINE_KEY='))
    expect(line).toBe(`MYLAR_COMICVINE_KEY=${KEY}`)
  })

  it.skipIf(!PYTHON)('lands in Mylar3 [CV] comicvine_api, creating the section', () => {
    const { cv, apiEnabled } = writeThroughPython(KEY)
    // comicvine_api, NOT comicvine_api_key, which is what every guide guesses.
    expect(cv).toBe(KEY)
    // The same call has to leave the API on, or Prowlarr can't wire Mylar3 up.
    expect(apiEnabled).toBe('1')
  })

  it.skipIf(!PYTHON)('carries a key through the whole chain unchanged', () => {
    // The join the individual tests missed. Take the value out of the rendered
    // .env rather than the literal, so a renderer that quoted, trimmed or
    // escaped it would surface here instead of in someone's install.
    const rendered = renderEnv({ MYLAR_COMICVINE_KEY: KEY } as never)
      .split('\n')
      .find((l) => l.startsWith('MYLAR_COMICVINE_KEY='))!
      .split('=')[1]
    expect(writeThroughPython(rendered).cv).toBe(KEY)
  })
})
