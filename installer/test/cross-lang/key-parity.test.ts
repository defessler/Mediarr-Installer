import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderEnv,
  USENET_INDEXERS,
  PUBLIC_TRACKERS,
  PRIVATE_TRACKERS,
  BAZARR_PROVIDERS,
} from '../../src/shared/env-render.js'
import { envObject } from '../../src/shared/env-schema.js'
import { NAS_SCRIPTS } from '../helpers/shell.js'
import { BASE_ENV } from '../helpers/render.js'

// Cross-language guards that a rename in ONE language can't silently drop a
// credential — the "indexer split-brain". The .env.example template (which
// read_env_merged copies to seed a manual .env) and the python indexer readers
// must stay in lock-step with the TS catalogue / schema.

const ENV_EXAMPLE = join(NAS_SCRIPTS, '.env.example')
const INDEXERS_PY = join(NAS_SCRIPTS, 'indexers', 'setup-indexers.py')
const BAZARR_PY = join(NAS_SCRIPTS, 'indexers', 'setup-bazarr-providers.py')

const SCHEMA_KEYS = new Set(Object.keys(envObject.shape))

function keysFromAssignments(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map((l) => l.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter((k): k is string => !!k),
  )
}

describe('.env.example ↔ env-schema', () => {
  const exampleKeys = keysFromAssignments(readFileSync(ENV_EXAMPLE, 'utf8'))

  it('every key in .env.example is either a real schema key or a documented NAS-only key', () => {
    // .env.example also documents keys the wizard never collects (NAS-side
    // derived/optional settings + the post-boot auto-discovered API keys).
    // Those are legitimately absent from the schema; anything else means the
    // template documents a key the validator would silently ignore.
    const NAS_ONLY = new Set([
      'LAN_SUBNET', 'HOMEPAGE_ALLOWED_HOSTS',
      'MONITORED_DISK_1', 'MONITORED_DISK_2', 'MONITORED_DISK_3', 'MONITORED_DISK_4',
      'VPN_PORT_FORWARDING',
      'SONARR_API_KEY', 'RADARR_API_KEY', 'LIDARR_API_KEY', 'PROWLARR_API_KEY',
      'SABNZBD_API_KEY', 'BAZARR_API_KEY', 'SEERR_API_KEY',
    ])
    const orphans = [...exampleKeys].filter((k) => !SCHEMA_KEYS.has(k) && !NAS_ONLY.has(k))
    expect(orphans, `.env.example keys with no schema entry: ${orphans.join(', ')}`).toEqual([])
  })

  it('every ENABLE_* service flag the wizard writes is documented in .env.example', () => {
    const emitted = [...keysFromAssignments(renderEnv(BASE_ENV))].filter((k) => k.startsWith('ENABLE_'))
    expect(emitted.length).toBeGreaterThan(0)
    const undocumented = emitted.filter((k) => !exampleKeys.has(k))
    expect(undocumented, `ENABLE_* flags missing from .env.example: ${undocumented.join(', ')}`).toEqual([])
  })
})

describe('indexer credential keys ↔ python readers (no silent credential drop)', () => {
  const indexersSrc = readFileSync(INDEXERS_PY, 'utf8')
  const bazarrSrc = readFileSync(BAZARR_PY, 'utf8')

  // The actual credentials are the indexer FIELD keys (public _NO_KEY trackers
  // carry none — they're registered by name in python, not by env key).
  const fieldKeys = (defs: { fields: { key: string }[] }[]) =>
    [...new Set(defs.flatMap((d) => d.fields.map((f) => f.key)))]

  it('every TS usenet/torrent credential key is referenced in setup-indexers.py', () => {
    const keys = fieldKeys([...USENET_INDEXERS, ...PUBLIC_TRACKERS, ...PRIVATE_TRACKERS])
    expect(keys.length).toBeGreaterThan(0)
    const missing = keys.filter((k) => !indexersSrc.includes(k))
    expect(missing, `TS catalogue keys never read by setup-indexers.py: ${missing.join(', ')}`).toEqual([])
  })

  it('every TS subtitle credential key is referenced in setup-bazarr-providers.py', () => {
    const keys = fieldKeys(BAZARR_PROVIDERS)
    expect(keys.length).toBeGreaterThan(0)
    const missing = keys.filter((k) => !bazarrSrc.includes(k))
    expect(missing, `TS catalogue keys never read by setup-bazarr-providers.py: ${missing.join(', ')}`).toEqual([])
  })
})
