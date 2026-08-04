import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { PYTHON, NAS_SCRIPTS, runPython } from '../helpers/shell.js'

// Pins three things about add_prowlarr_app(), all three found live on a real
// NAS as "✘ Prowlarr app: LazyLibrarian" / "Mylar3 — not wired up", and all
// three invisible from the log the user actually saw.
//
// 1. FIELD CASING. Prowlarr's application schemas don't agree with themselves
//    about the case of field names, exactly like the indexer schemas that
//    setup-indexers.py's _set_field_case_insensitive already exists to handle.
//    We used a case-SENSITIVE index here, so against a PascalCase schema the
//    apiKey and baseUrl we thought we set were silently dropped. The POST is
//    still well-formed, so Prowlarr answers 400 from its reachability test and
//    the failure presents as "cannot connect to the app" — sending everyone,
//    including me, to debug container networking that was never broken.
//
// 2. THE FORCESAVE RETURN. The success path ended in a bare `return`, i.e.
//    None. The contract is True/False and the LazyLibrarian caller branches on
//    it, so an app that HAD just been wired up via forceSave was reported to
//    the user as having no search sources at all.
//
// 3. NAMING THE CAUSE. forceSave skips the reachability test, so when even
//    forceSave fails the one thing it cannot mean is "the app is down". It
//    means a bad Prowlarr key (401), a body Prowlarr won't take (400), or no
//    Prowlarr at all. The old message told the user to add it by hand in every
//    case, which is wrong advice for two of the three.

const ARR_PY = join(NAS_SCRIPTS, 'setup-arr-config.py')

type Outcome = { ret: boolean | null; fields: Record<string, unknown>; log: [string, string][] }

/** Drive the REAL add_prowlarr_app() with a stubbed Prowlarr behind it.
 *
 *  The module is extracted by AST rather than imported: setup-arr-config.py
 *  runs a full configuration pass at import time. We lift just this function
 *  out, which also means the test breaks loudly if it's renamed or removed
 *  rather than quietly passing against nothing. */
function wire(opts: {
  schemaFields: string[]
  /** which POSTs succeed: 'all' | 'forceSaveOnly' | 'none' */
  posts: 'all' | 'forceSaveOnly' | 'none'
  code?: number
}): Outcome {
  const program = [
    'import ast, json, types',
    `src = open(${JSON.stringify(ARR_PY)}, encoding='utf-8').read()`,
    'tree = ast.parse(src)',
    "fns = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'add_prowlarr_app']",
    "assert fns, 'add_prowlarr_app not found in setup-arr-config.py'",
    'ns, log = {}, []',
    "for lvl in ('ok', 'warn', 'fail', 'info', 'skip'):",
    '    ns[lvl] = (lambda l: lambda m: log.append([l, m]))(lvl)',
    // The retry loop sleeps 5s twice; nothing here needs real time to pass.
    'ns["time"] = types.SimpleNamespace(sleep=lambda s: None)',
    'exec(compile(ast.Module(body=fns, type_ignores=[]), "x", "exec"), ns)',
    `FIELDS = json.loads(${JSON.stringify(JSON.stringify(opts.schemaFields))})`,
    `MODE = ${JSON.stringify(opts.posts)}`,
    `CODE = ${JSON.stringify(opts.code ?? 401)}`,
    "SCHEMA = [{'implementation': 'Mylar', 'fields': [{'name': n} for n in FIELDS]}]",
    'seen = {}',
    "ns['GET'] = lambda b, k, p: (SCHEMA if 'schema' in p else [])",
    'def _result(path):',
    "    if MODE == 'all': return {'id': 1}",
    "    if MODE == 'forceSaveOnly' and 'forceSave' in path: return {'id': 1}",
    '    return None',
    'def _post(b, k, p, d):',
    "    seen['data'] = d",
    '    return _result(p)',
    "ns['POST'] = _post",
    "ns['POST_status'] = lambda b, k, p, d: (_result(p), CODE)",
    "ret = ns['add_prowlarr_app']('http://p', 'k', 'Mylar3', 'Mylar', 'MylarSettings',",
    "                             'http://mylar3:8090', 'MYKEY', [7030], optional=True)",
    "fields = {f['name']: f.get('value') for f in seen['data']['fields']}",
    "print(json.dumps({'ret': ret, 'fields': fields, 'log': log}))",
  ].join('\n')
  return JSON.parse(runPython(program).stdout.trim())
}

// Prowlarr has shipped both spellings across versions. Both must work.
const PASCAL = ['ProwlarrUrl', 'BaseUrl', 'ApiKey', 'SyncCategories']
const CAMEL = ['prowlarrUrl', 'baseUrl', 'apiKey', 'syncCategories']

describe.skipIf(!PYTHON)('Prowlarr application wiring', () => {
  it.each([
    ['PascalCase', PASCAL, 'ApiKey', 'BaseUrl'],
    ['camelCase', CAMEL, 'apiKey', 'baseUrl'],
  ])('populates the credential fields on a %s schema', (_label, fields, keyField, urlField) => {
    const { fields: sent } = wire({ schemaFields: fields, posts: 'all' })
    // The regression: these came back undefined against PascalCase, and the
    // resulting 400 read as a connectivity fault rather than an empty apiKey.
    expect(sent[keyField]).toBe('MYKEY')
    expect(sent[urlField]).toBe('http://mylar3:8090')
  })

  it('warns when the schema has no field to hold the API key', () => {
    // If Prowlarr ever renames these, we save an app that cannot authenticate.
    // Silence there is what made the original bug take a live run to find.
    const { log } = wire({ schemaFields: ['BaseUrl', 'ProwlarrUrl'], posts: 'all' })
    const warned = log.filter(([lvl]) => lvl === 'warn').map(([, m]) => m)
    expect(warned.join(' ')).toContain('apiKey')
  })

  it('reports success when only forceSave lands', () => {
    // Was a bare `return` (None). The LazyLibrarian caller treats a falsy
    // return as "this app has no search sources", so a successful forceSave
    // produced a scary and completely wrong warning.
    const { ret } = wire({ schemaFields: PASCAL, posts: 'forceSaveOnly' })
    expect(ret).toBe(true)
  })

  it.each([
    [401, 'API key'],
    [400, 'request body'],
  ])('names the cause when even forceSave fails with %i', (code, phrase) => {
    const { ret, log } = wire({ schemaFields: PASCAL, posts: 'none', code })
    expect(ret).toBe(false)
    expect(log.at(-1)?.[1]).toContain(phrase)
  })

  it('always returns a boolean, never None', () => {
    // The contract the callers rely on. None is falsy, so a bare return
    // doesn't crash — it just quietly misreports success as failure.
    for (const posts of ['all', 'forceSaveOnly', 'none'] as const) {
      expect(typeof wire({ schemaFields: PASCAL, posts }).ret).toBe('boolean')
    }
  })
})
