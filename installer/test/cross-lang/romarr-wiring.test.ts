import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { PYTHON, NAS_SCRIPTS, runPython } from '../helpers/shell.js'

// Pins configure_romarr() in setup-arr-config.py against a fake ROMarr store.
//
// ROMarr is the one acquirer that isn't a Prowlarr Application, so the stack
// writes the Prowlarr link INTO ROMarr over its own API. Everything that can
// go wrong there is silent on the ROMarr side: a duplicate download client
// splits grabs between two rows, a missing path mapping leaves finished
// downloads sitting un-imported, and an empty Prowlarr key makes every search
// come back empty with no error. So each of those gets a test.
//
// The fake store mirrors ROMarr's own routes as read from its source
// (romarr/app.py at a875dad): POST /api/v1/indexer and /api/v1/downloadclient
// replace the row whose id matches or append a new one, and GET /api/v1/config
// returns settings with indexers, download_clients and remote_path_mappings.

const ARR_PY = join(NAS_SCRIPTS, 'setup-arr-config.py')

const NAMES = ['_ROMARR_OUR_HOSTS', '_ROMARR_PATH_MAPPINGS', '_romarr_host', '_romarr_upsert', 'configure_romarr']

type Row = Record<string, unknown>
type Store = { indexers: Row[]; download_clients: Row[]; remote_path_mappings: Row[] }
type Outcome = { ret: boolean; store: Store; posts: string[]; puts: number; log: [string, string][]; unreachable: number }

function run(opts: {
  store?: Partial<Store>
  romKey?: string | null
  prowlarrKey?: string | null
  qb?: [string, number, string, string] | null
  sabKey?: string | null
}): Outcome {
  const store: Store = { indexers: [], download_clients: [], remote_path_mappings: [], ...opts.store }
  const program = [
    'import ast, json, types',
    'from urllib.parse import urlparse',
    `src = open(${JSON.stringify(ARR_PY)}, encoding='utf-8').read()`,
    'tree = ast.parse(src)',
    `NAMES = ${JSON.stringify(NAMES)}`,
    'def _name(n):',
    '    if isinstance(n, ast.FunctionDef): return n.name',
    '    if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name): return n.targets[0].id',
    'nodes = [n for n in tree.body if _name(n) in NAMES]',
    "missing = set(NAMES) - {_name(n) for n in nodes}",
    "assert not missing, f'not found in setup-arr-config.py: {missing}'",
    "ns, log, posts, counts = {'urlparse': urlparse}, [], [], {'puts': 0, 'unreachable': 0}",
    "for lvl in ('ok', 'warn', 'fail', 'info', 'skip'):",
    '    ns[lvl] = (lambda l: lambda m: log.append([l, m]))(lvl)',
    "ns['section'] = lambda t: None",
    "ns['wait_ready'] = lambda *a, **k: True",
    "def _unreach(): counts['unreachable'] += 1",
    "ns['note_unreachable'] = _unreach",
    `ROM_KEY = json.loads(${JSON.stringify(JSON.stringify(opts.romKey === undefined ? 'ROMKEY' : opts.romKey))})`,
    // The 120s key poll reads time.time(); this stub never advances, so a
    // missing key would spin forever. Make the deadline pass on the 2nd read.
    "clock = iter([0, 0, 999, 999, 999])",
    "ns['time'] = types.SimpleNamespace(sleep=lambda s: None, time=lambda: next(clock))",
    "ns['read_json_key'] = lambda path, *keys: ROM_KEY if path.endswith('romarr.json') and keys == ('settings', '_api_key') else None",
    `STORE = json.loads(${JSON.stringify(JSON.stringify(store))})`,
    'seq = [0]',
    "ns['GET'] = lambda b, k, p: json.loads(json.dumps(STORE)) if p == '/api/v1/config' and k == ROM_KEY else None",
    'def _post(b, k, p, body):',
    "    assert k == ROM_KEY",
    "    coll = 'indexers' if p == '/api/v1/indexer' else 'download_clients'",
    "    posts.append(body['type'])",
    '    body = dict(body)',
    "    if not body.get('id'):",
    "        seq[0] += 1; body['id'] = f'new{seq[0]}'; STORE[coll].append(body)",
    '    else:',
    "        STORE[coll] = [body if r['id'] == body['id'] else r for r in STORE[coll]]",
    '    return body, 200',
    "ns['POST_status'] = _post",
    'def _put(b, k, p, body):',
    "    counts['puts'] += 1",
    "    STORE['remote_path_mappings'] = body['remote_path_mappings']",
    '    return {}',
    "ns['PUT'] = _put",
    'exec(compile(ast.Module(body=nodes, type_ignores=[]), "x", "exec"), ns)',
    `QB = json.loads(${JSON.stringify(JSON.stringify(opts.qb === undefined ? ['gluetun', 49156, 'admin', 'qbpass'] : opts.qb))})`,
    `PK = json.loads(${JSON.stringify(JSON.stringify(opts.prowlarrKey === undefined ? 'PROWKEY' : opts.prowlarrKey))})`,
    `SK = json.loads(${JSON.stringify(JSON.stringify(opts.sabKey === undefined ? 'SABKEY' : opts.sabKey))})`,
    "ret = ns['configure_romarr']('http://nas:49162', '/i/romarr/config/romarr.json', PK, tuple(QB) if QB else None, SK)",
    "print(json.dumps({'ret': ret, 'store': STORE, 'posts': posts, 'puts': counts['puts'], 'log': log, 'unreachable': counts['unreachable']}))",
  ].join('\n')
  return JSON.parse(runPython(program).stdout.trim())
}

const ofType = (rows: Row[], t: string) => rows.filter((r) => r.type === t)
const warnings = (o: Outcome) => o.log.filter(([l]) => l === 'warn').map(([, m]) => m).join(' ')

describe.skipIf(!PYTHON)('ROMarr wiring', () => {
  it('wires Prowlarr, both clients and both path mappings on a fresh install', () => {
    const o = run({})
    expect(o.ret).toBe(true)
    const [prowlarr] = ofType(o.store.indexers, 'prowlarr')
    expect(prowlarr).toMatchObject({ url: 'http://prowlarr:9696', api_key: 'PROWKEY', enable: true })
    expect(ofType(o.store.download_clients, 'qbittorrent')[0])
      .toMatchObject({ host: 'gluetun', port: 49156, username: 'admin', password: 'qbpass', category: 'romarr' })
    expect(ofType(o.store.download_clients, 'sabnzbd')[0])
      .toMatchObject({ host: 'sabnzbd', port: 8080, api_key: 'SABKEY', category: 'romarr' })
    expect(o.store.remote_path_mappings).toEqual([
      { remote: '/downloads', local: '/data/Downloads/Torrents' },
      { remote: '/data/complete', local: '/data/Downloads/Usenet/complete' },
    ])
  })

  it('updates its own rows on a re-run instead of adding duplicates', () => {
    // The re-run is how a rotated Prowlarr key gets fixed. ROMarr returns
    // secrets as ******** so the only safe move is to resend them by id.
    const first = run({})
    const again = run({ store: first.store, prowlarrKey: 'ROTATED' })
    expect(ofType(again.store.indexers, 'prowlarr')).toHaveLength(1)
    expect(ofType(again.store.indexers, 'prowlarr')[0].api_key).toBe('ROTATED')
    expect(ofType(again.store.download_clients, 'qbittorrent')).toHaveLength(1)
    expect(ofType(again.store.download_clients, 'sabnzbd')).toHaveLength(1)
    expect(again.puts).toBe(0)
  })

  it('moves the qBittorrent row when VPN_ENABLED flips', () => {
    const noVpn = run({ qb: ['qbittorrent', 49156, 'admin', 'qbpass'] })
    const vpn = run({ store: noVpn.store })
    const rows = ofType(vpn.store.download_clients, 'qbittorrent')
    expect(rows).toHaveLength(1)
    expect(rows[0].host).toBe('gluetun')
  })

  it("leaves the user's own client on another host alone", () => {
    const theirs = { id: 'u1', type: 'qbittorrent', host: '192.168.1.50', port: 8080 }
    const o = run({ store: { download_clients: [theirs] } })
    expect(o.posts).not.toContain('qbittorrent')
    expect(ofType(o.store.download_clients, 'qbittorrent')).toEqual([theirs])
  })

  it("keeps the user's own path mapping and only adds the missing one", () => {
    const mine = { remote: '/downloads', local: '/data/elsewhere' }
    const o = run({ store: { remote_path_mappings: [mine] } })
    expect(o.store.remote_path_mappings).toEqual([
      mine,
      { remote: '/data/complete', local: '/data/Downloads/Usenet/complete' },
    ])
  })

  it('warns, and stores no Prowlarr row, when the Prowlarr key is missing', () => {
    // An indexer row with an empty key is the exact trap env seeding falls
    // into, so we'd rather have no row and a warning than a row that fails.
    const o = run({ prowlarrKey: null })
    expect(o.ret).toBe(false)
    expect(o.store.indexers).toEqual([])
    expect(warnings(o)).toContain('no Prowlarr link')
  })

  it('warns when neither download client is on', () => {
    const o = run({ qb: null, sabKey: null })
    expect(o.store.download_clients).toEqual([])
    expect(warnings(o)).toContain('no download client')
  })

  it('backs off cleanly when ROMarr has not written its key yet', () => {
    const o = run({ romKey: null })
    expect(o.ret).toBe(false)
    expect(o.posts).toEqual([])
    expect(o.unreachable).toBe(1)
  })
})
