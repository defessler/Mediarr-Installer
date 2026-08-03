import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { PYTHON, NAS_SCRIPTS, runPython } from '../helpers/shell.js'

// The invariant this pins, in one sentence: PRUNING OUR CATALOGUE MUST NEVER
// PRUNE A USER'S INSTALL.
//
// The catalogues in setup-bazarr-providers.py and setup-indexers.py get
// trimmed over time as services die or turn out to be unreliable. That is fine
// for a FRESH install — the dropped entry simply stops being added. What must
// never happen is a re-run against an EXISTING install removing a provider the
// user has, whether they enabled it by hand or it was in an older catalogue.
//
// Bazarr makes that easy to get wrong. `enabled_providers` is one of its
// "array keys": the settings endpoint takes the posted list as authoritative,
// so posting only the providers WE know about would delete everything else.
// enable_providers() guards this by posting `enabled | pending` — the union.
// This test proves the union is real, because the failure mode is silent and
// only shows up on someone else's box, months later, as "my subtitle providers
// keep getting reset".

const BAZARR_PY = join(NAS_SCRIPTS, 'indexers', 'setup-bazarr-providers.py')

/** Drive the REAL enable_providers() with a stubbed HTTP layer and return the
 *  form fields it would have POSTed. */
function postedProviders(alreadyEnabled: string[], toAdd: [string, string][]): string[] {
  const program = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location('bz', ${JSON.stringify(BAZARR_PY)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    `ALREADY = json.loads(${JSON.stringify(JSON.stringify(alreadyEnabled))})`,
    `TO_ADD = [tuple(x) + (None,) for x in json.loads(${JSON.stringify(JSON.stringify(toAdd))})]`,
    'captured = {}',
    // Silence the module's console helpers: their output would pollute the
    // JSON on stdout, and their ✔ / – glyphs raise UnicodeEncodeError under
    // the default Windows codepage, killing the script before it prints.
    'm.ok = m.skip = m.warn = m.fail = m.section = lambda *a, **k: None',
    // Stub the two HTTP calls. GET reports a user who already has providers;
    // POST_FORM records what we would have sent instead of sending it.
    "m.GET = lambda base, key, path: {'general': {'enabled_providers': ALREADY}}",
    'def fake_post(base, key, path, fields):',
    "    captured['fields'] = fields",
    '    return {}',
    'm.POST_FORM = fake_post',
    "m.enable_providers('http://x', 'k', TO_ADD)",
    "sent = [v for (f, v) in captured.get('fields', []) if f == 'settings-general-enabled_providers']",
    'print(json.dumps(sent))',
  ].join('\n')
  return JSON.parse(runPython(program).stdout.trim())
}

describe.skipIf(!PYTHON)('Bazarr provider setup is additive', () => {
  it('keeps providers the user already has but our catalogue no longer lists', () => {
    // The exact scenario: we drop a provider from the catalogue, the user still
    // has it enabled, and a re-run must leave it alone.
    const sent = postedProviders(
      ['podnapisi', 'subscene', 'somethingtheuseraddedbyhand'],
      [['Gestdown', 'gestdown']],
    )
    expect(sent).toContain('gestdown')                       // the new one lands
    expect(sent).toContain('subscene')                       // a dropped entry survives
    expect(sent).toContain('somethingtheuseraddedbyhand')    // so does a manual one
    expect(sent).toContain('podnapisi')
  })

  it('posts the UNION, never just our own list', () => {
    const already = ['a', 'b', 'c']
    const sent = postedProviders(already, [['New', 'newprovider']])
    for (const p of already) expect(sent).toContain(p)
    expect(sent).toContain('newprovider')
    expect(sent.length).toBe(already.length + 1)
  })

  it('no-ops when everything we would add is already enabled', () => {
    // Nothing pending means no POST at all, so nothing can be clobbered by a
    // re-run that had nothing to do.
    const sent = postedProviders(['gestdown', 'podnapisi'], [['Gestdown', 'gestdown']])
    expect(sent).toEqual([])
  })
})

describe('indexer setup has no delete path', () => {
  it('never issues a DELETE against Prowlarr', () => {
    // setup-indexers.py is purely additive by construction. If someone ever
    // adds a prune step, this fails and they have to come read the comment
    // above about why pruning our catalogue must not prune the user's install.
    const src = readIndexers()
    // Match the HTTP VERB as a quoted literal, which is how a real delete call
    // would appear. Matching the word "delete" case-insensitively instead just
    // hits prose like "no need to delete + re-add in Prowlarr".
    expect(
      /['"]DELETE['"]/.test(src),
      "setup-indexers.py gained a DELETE call — see the header comment: pruning our catalogue must not prune a user's install",
    ).toBe(false)
  })
})

function readIndexers(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:fs').readFileSync(join(NAS_SCRIPTS, 'indexers', 'setup-indexers.py'), 'utf8')
}
