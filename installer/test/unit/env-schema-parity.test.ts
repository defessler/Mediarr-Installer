import { describe, it, expect } from 'vitest'
import { renderEnv, type EnvFormValues } from '../../src/shared/env-render.js'
import { envObject } from '../../src/shared/env-schema.js'
import { BASE_ENV } from '../helpers/render.js'

// The round-trip invariant the schema comments care about: every key the
// wizard WRITES into .env must have a schema entry (else the validator
// silently ignores a value the user typed — the DOCKER_SOCK-class bug), and
// every schema key must actually be WRITTEN (else it's dead validation).

// Blank placeholders renderEnv writes for post-boot auto-discovery — these are
// intentionally absent from the schema (the wizard never collects them).
const AUTO_DISCOVERED = new Set([
  'SONARR_API_KEY', 'RADARR_API_KEY', 'LIDARR_API_KEY', 'PROWLARR_API_KEY',
  'SABNZBD_API_KEY', 'BAZARR_API_KEY', 'SEERR_API_KEY',
])
// Schema placeholders for public/no-account indexers — present so the .env
// round-trips them, but renderEnv writes no line (no credential collected).
const NO_KEY_PLACEHOLDERS = Object.keys(envObject.shape).filter((k) => k.endsWith('_NO_KEY'))

function emittedKeys(v: EnvFormValues): string[] {
  return renderEnv(v)
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=/)?.[1])
    .filter((k): k is string => !!k)
}

// Render across every branch so conditionally-emitted keys (per-VPN-provider
// gluetun vars, jellyfin, the podman socket, the opt-in services) all surface.
const VARIANTS: EnvFormValues[] = [
  BASE_ENV,
  { ...BASE_ENV, MEDIA_SERVER: 'jellyfin', JELLYFIN_API_KEY: 'k' },
  { ...BASE_ENV, DOCKER_SOCK: '/run/podman/podman.sock' },
  {
    ...BASE_ENV,
    ENABLE_SOULSEEK: 'true',
    ENABLE_AZURACAST: 'true',
    ENABLE_PLAYLIST_SYNC: 'true',
    CUSTOM_INDEXERS_JSON: '[]',
  },
  ...(['nordvpn', 'protonvpn', 'mullvad', 'airvpn', 'surfshark', 'custom'] as const).map(
    (p): EnvFormValues => ({
      ...BASE_ENV,
      VPN_ENABLED: 'true',
      VPN_PROVIDER: p,
      CUSTOM_VPN_ENV: p === 'custom' ? 'VPN_SERVICE_PROVIDER=pia\nOPENVPN_USER=u' : '',
    }),
  ),
]
const ALL_EMITTED = new Set(VARIANTS.flatMap(emittedKeys))
const SCHEMA_KEYS = new Set(Object.keys(envObject.shape))

describe('env-render ↔ env-schema key parity', () => {
  it('every key renderEnv emits has a schema entry (no silently-ignored input)', () => {
    const orphans = [...ALL_EMITTED].filter((k) => !SCHEMA_KEYS.has(k) && !AUTO_DISCOVERED.has(k))
    expect(orphans, `emitted keys with no schema entry: ${orphans.join(', ')}`).toEqual([])
  })

  it('every schema key is emitted by renderEnv (except documented no-key placeholders)', () => {
    const dead = [...SCHEMA_KEYS].filter((k) => !ALL_EMITTED.has(k) && !NO_KEY_PLACEHOLDERS.includes(k))
    expect(dead, `schema keys never emitted: ${dead.join(', ')}`).toEqual([])
  })

  it('the no-key placeholders are indeed never written to .env', () => {
    expect(NO_KEY_PLACEHOLDERS.length).toBeGreaterThan(0)
    for (const k of NO_KEY_PLACEHOLDERS) expect(ALL_EMITTED.has(k)).toBe(false)
  })
})
