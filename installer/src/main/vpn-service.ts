// ── NordVPN API client (host-side) ───────────────────────────────────────────
// Calls api.nordvpn.com from the host machine — faster than going through
// the NAS, and the NAS doesn't need outbound HTTPS configured at this point.
//
// Mirrors the logic in nas/setup-nordvpn.sh: hits the credentials endpoint
// with the user's access token, validates the WireGuard key length (43→44
// padding fix), and lists countries for the picker.

import type { Country, VpnFetchResult } from '../shared/ipc.js'

const NORD_API = 'https://api.nordvpn.com'

async function nordGet<T>(path: string, token?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) {
    // Token auth: HTTP Basic with username "token" and the token as the password.
    const creds = Buffer.from(`token:${token}`).toString('base64')
    headers.Authorization = `Basic ${creds}`
  }
  const res = await fetch(`${NORD_API}${path}`, { headers })
  if (!res.ok) {
    throw new Error(`NordVPN API ${path} returned ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export async function fetchVpnKey(token: string): Promise<VpnFetchResult> {
  if (!token || token.length < 8) {
    throw new Error('NordVPN access token is empty or too short')
  }

  // 1. Pull the WireGuard private key from the credentials endpoint.
  const creds = await nordGet<{ nordlynx_private_key?: string }>(
    '/v1/users/services/credentials',
    token,
  )
  let key = (creds.nordlynx_private_key ?? '').trim()
  if (!key) throw new Error('NordVPN response did not include a WireGuard private key')

  // setup-nordvpn.sh's quirk: the API sometimes returns 43 chars; pad with '='.
  if (key.length === 43) key = `${key}=`
  if (key.length !== 44) {
    throw new Error(`Unexpected WireGuard key length ${key.length} (expected 44)`)
  }

  // 2. Pull the country list — used by the multi-select chip picker.
  const countriesRaw = await nordGet<Array<{ id: number; name: string; code: string }>>(
    '/v1/servers/countries',
  )
  const countries: Country[] = countriesRaw
    .map((c) => ({ id: c.id, name: c.name, code: c.code }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { privateKey: key, countries }
}
