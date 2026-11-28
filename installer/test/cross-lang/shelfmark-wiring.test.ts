import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { PYTHON, NAS_SCRIPTS, runPython } from '../helpers/shell.js'

// Pins shelfmark_plan() in setup-arr-config.py: the rules for what the
// installer writes into Shelfmark's settings files and, more to the point,
// what it leaves alone.
//
// Shelfmark replaced LazyLibrarian in v0.33.0. It is a Prowlarr client, so
// the stack writes Prowlarr's URL and key INTO it. That goes through its
// /config/plugins/<tab>.json files rather than compose env, for a reason read
// out of its core/settings_registry.py: an env var that is set but empty
// counts as set, and Prowlarr's key is blank at the first `compose up`.
//
// Every failure here is silent on Shelfmark's side. Direct downloads are off,
// so with no Prowlarr link every search just comes back empty. And a re-run
// that overwrote a setting the user changed would do it without a word.
//
// The tab and key names are Shelfmark's own, from release_sources/prowlarr/
// settings.py, download/clients/settings.py and config/settings.py at v1.7.2.

const ARR_PY = join(NAS_SCRIPTS, 'setup-arr-config.py')

const NAMES = [
  '_SHELFMARK_TABS', '_SHELFMARK_OUR_HOSTS', '_SHELFMARK_PATH_MAPPINGS',
  '_shelfmark_host', 'shelfmark_plan',
]

type Tabs = Record<string, Record<string, unknown>>

function plan(opts: {
  current?: Tabs
  prowlarrKey?: string | null
  qb?: [string, number, string, string] | null
  sabKey?: string | null
  firstRun?: boolean
}): Tabs {
  const program = [
    'import ast, json',
    'from urllib.parse import urlparse',
    `src = open(${JSON.stringify(ARR_PY)}, encoding='utf-8').read()`,
    'tree = ast.parse(src)',
    `NAMES = ${JSON.stringify(NAMES)}`,
    'def _name(n):',
    '    if isinstance(n, ast.FunctionDef): return n.name',
    '    if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name): return n.targets[0].id',
    'nodes = [n for n in tree.body if _name(n) in NAMES]',
    'missing = set(NAMES) - {_name(n) for n in nodes}',
    "assert not missing, f'not found in setup-arr-config.py: {missing}'",
    "ns = {'urlparse': urlparse}",
    'exec(compile(ast.Module(body=nodes, type_ignores=[]), "x", "exec"), ns)',
    `CUR = json.loads(${JSON.stringify(JSON.stringify(opts.current ?? {}))})`,
    `QB = json.loads(${JSON.stringify(JSON.stringify(opts.qb === undefined ? ['gluetun', 49156, 'admin', 'qbpass'] : opts.qb))})`,
    `PK = json.loads(${JSON.stringify(JSON.stringify(opts.prowlarrKey === undefined ? 'PROWKEY' : opts.prowlarrKey))})`,
    `SK = json.loads(${JSON.stringify(JSON.stringify(opts.sabKey === undefined ? 'SABKEY' : opts.sabKey))})`,
    `FIRST = ${opts.firstRun === false ? 'False' : 'True'}`,
    "print(json.dumps(ns['shelfmark_plan'](CUR, PK, tuple(QB) if QB else None, SK, FIRST)))",
  ].join('\n')
  return JSON.parse(runPython(program).stdout.trim())
}

/** What the files hold after a plan is written: the same merge
 *  configure_shelfmark does, one tab at a time. */
function apply(current: Tabs, changes: Tabs): Tabs {
  const out: Tabs = {}
  for (const tab of new Set([...Object.keys(current), ...Object.keys(changes)])) {
    out[tab] = { ...current[tab], ...changes[tab] }
  }
  return out
}

/** What Shelfmark writes for these tabs on its own first boot. */
const SHIPPED: Tabs = {
  prowlarr_config: { PROWLARR_ENABLED: false, PROWLARR_INDEXERS: [] },
  prowlarr_clients: {
    PROWLARR_TORRENT_CLIENT: '', PROWLARR_USENET_CLIENT: '',
    QBITTORRENT_CATEGORY: 'books', QBITTORRENT_CATEGORY_AUDIOBOOK: '',
    SABNZBD_CATEGORY: 'books', SABNZBD_CATEGORY_AUDIOBOOK: '',
  },
  downloads: { INGEST_DIR: '/books' },
  advanced: { PROWLARR_REMOTE_PATH_MAPPINGS: [] },
}

describe.skipIf(!PYTHON)('Shelfmark wiring', () => {
  it('links Prowlarr, both clients, both destinations and both mappings on a fresh install', () => {
    const p = plan({ current: SHIPPED })
    expect(p.prowlarr_config).toEqual({
      PROWLARR_URL: 'http://prowlarr:9696', PROWLARR_API_KEY: 'PROWKEY', PROWLARR_ENABLED: true,
    })
    expect(p.prowlarr_clients).toMatchObject({
      PROWLARR_TORRENT_CLIENT: 'qbittorrent',
      QBITTORRENT_URL: 'http://gluetun:49156', QBITTORRENT_USERNAME: 'admin', QBITTORRENT_PASSWORD: 'qbpass',
      PROWLARR_USENET_CLIENT: 'sabnzbd',
      SABNZBD_URL: 'http://sabnzbd:8080', SABNZBD_API_KEY: 'SABKEY',
      QBITTORRENT_CATEGORY_AUDIOBOOK: 'audiobooks', SABNZBD_CATEGORY_AUDIOBOOK: 'audiobooks',
    })
    // /books is Shelfmark's shipped destination and nothing is mounted there
    // in this stack. Left alone, every download lands inside the container.
    expect(p.downloads).toEqual({
      INGEST_DIR: '/data/Media/Books', DESTINATION_AUDIOBOOK: '/data/Media/Audiobooks',
    })
    expect(p.advanced.PROWLARR_REMOTE_PATH_MAPPINGS).toEqual([
      { host: 'qbittorrent', remotePath: '/downloads', localPath: '/data/Downloads/Torrents' },
      { host: 'sabnzbd', remotePath: '/data/complete', localPath: '/data/Downloads/Usenet/complete' },
    ])
  })

  it('has nothing to do on a re-run with nothing changed', () => {
    // An empty plan is what stops a re-run restarting a healthy Shelfmark.
    const after = apply(SHIPPED, plan({ current: SHIPPED }))
    expect(plan({ current: after, firstRun: false })).toEqual({})
  })

  it('corrects a rotated Prowlarr key and nothing else', () => {
    const after = apply(SHIPPED, plan({ current: SHIPPED }))
    expect(plan({ current: after, prowlarrKey: 'ROTATED', firstRun: false }))
      .toEqual({ prowlarr_config: { PROWLARR_API_KEY: 'ROTATED' } })
  })

  it('moves the qBittorrent link when VPN_ENABLED flips', () => {
    const noVpn = apply(SHIPPED, plan({ current: SHIPPED, qb: ['qbittorrent', 49156, 'admin', 'qbpass'] }))
    expect(plan({ current: noVpn, firstRun: false }))
      .toEqual({ prowlarr_clients: { QBITTORRENT_URL: 'http://gluetun:49156' } })
  })

  it('does not switch Prowlarr back on after the user turned it off', () => {
    // The reason first_run exists. The value alone can't say whether `false`
    // is Shelfmark's default or the user's decision.
    const after = apply(SHIPPED, plan({ current: SHIPPED }))
    after.prowlarr_config.PROWLARR_ENABLED = false
    expect(plan({ current: after, firstRun: false })).toEqual({})
  })

  it("leaves the user's own Prowlarr and clients on other hosts alone", () => {
    const theirs: Tabs = {
      ...SHIPPED,
      prowlarr_config: { PROWLARR_ENABLED: true, PROWLARR_URL: 'http://192.168.1.50:9696', PROWLARR_API_KEY: 'THEIRS' },
      prowlarr_clients: {
        ...SHIPPED.prowlarr_clients,
        PROWLARR_TORRENT_CLIENT: 'transmission',
        QBITTORRENT_URL: 'http://seedbox.example:8080',
        PROWLARR_USENET_CLIENT: 'nzbget',
        SABNZBD_URL: 'http://192.168.1.60:8080',
      },
    }
    const p = plan({ current: theirs, firstRun: false })
    expect(p.prowlarr_config).toBeUndefined()
    expect(p.prowlarr_clients).toBeUndefined()
  })

  it('keeps destinations and categories the user changed', () => {
    const after = apply(SHIPPED, plan({ current: SHIPPED }))
    after.downloads.INGEST_DIR = '/data/Media/Books/Inbox'
    after.downloads.DESTINATION_AUDIOBOOK = '/data/Elsewhere'
    after.prowlarr_clients.QBITTORRENT_CATEGORY = 'ebooks'
    expect(plan({ current: after, firstRun: false })).toEqual({})
  })

  it("keeps the user's own path mapping and only adds the missing one", () => {
    const mine = { host: 'qbittorrent', remotePath: '/downloads', localPath: '/data/elsewhere' }
    const p = plan({ current: { ...SHIPPED, advanced: { PROWLARR_REMOTE_PATH_MAPPINGS: [mine] } } })
    expect(p.advanced.PROWLARR_REMOTE_PATH_MAPPINGS).toEqual([
      mine,
      { host: 'sabnzbd', remotePath: '/data/complete', localPath: '/data/Downloads/Usenet/complete' },
    ])
  })

  it('writes no Prowlarr settings at all when the key is missing', () => {
    // A link with an empty key is the trap env seeding falls into. No link
    // and a warning beats a link that fails every search.
    const p = plan({ current: SHIPPED, prowlarrKey: null })
    expect(p.prowlarr_config).toBeUndefined()
  })

  it('picks only the clients that are switched on', () => {
    const p = plan({ current: SHIPPED, qb: null })
    expect(p.prowlarr_clients.PROWLARR_TORRENT_CLIENT).toBeUndefined()
    expect(p.prowlarr_clients.QBITTORRENT_URL).toBeUndefined()
    expect(p.prowlarr_clients.PROWLARR_USENET_CLIENT).toBe('sabnzbd')
  })

  it('works when Shelfmark has not written its own files yet', () => {
    const p = plan({ current: {} })
    expect(p.prowlarr_config.PROWLARR_ENABLED).toBe(true)
    expect(p.downloads.INGEST_DIR).toBe('/data/Media/Books')
  })
})
