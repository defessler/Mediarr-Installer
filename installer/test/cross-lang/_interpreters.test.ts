import { describe, it, expect } from 'vitest'
import { BASH, PYTHON } from '../helpers/shell.js'

// Standalone sentinel — deliberately in its OWN file so it can't be edited away
// as a side effect of changing any single oracle suite. Every cross-language
// suite does `describe.skipIf(!BASH)` / `!PYTHON`, so a missing interpreter
// makes that suite pass with ZERO assertions. On CI that is a silent-green lie:
// the entire point of these suites is to execute the REAL shipped bash/python
// parsers against the TS writer's output. GitHub Actions sets CI=1 and the
// installer-ci unit-tests job provisions both interpreters, so require both
// there; locally accept either (a Windows dev box may legitimately have only
// git-bash or only python on PATH).
describe('cross-language interpreters', () => {
  it('oracle interpreters are available (CI requires BOTH; else the oracle suites are blind)', () => {
    if (process.env.CI) expect(Boolean(BASH && PYTHON)).toBe(true)
    else expect(Boolean(BASH || PYTHON)).toBe(true)
  })
})
