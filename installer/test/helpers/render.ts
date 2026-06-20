// Emit a single value through the PRODUCTION renderEnv path and read back the
// raw line, so the escape/round-trip suites exercise the real line()+ESCAPE
// writer rather than a reimplementation of it.

import { renderEnv, type EnvFormValues } from '../../src/shared/env-render.js'

/** Minimal EnvFormValues satisfying every required field. Tests override one
 *  optional field and read it back; the rest is innocuous filler. */
export const BASE_ENV: EnvFormValues = {
  PUID: '1000',
  PGID: '10',
  TZ: 'UTC',
  LAN_IP: '192.168.1.2',
  QBITTORRENT_USER: 'admin',
  QBITTORRENT_PASS: 'password12',
  VPN_PROVIDER: 'nordvpn',
  VPN_TYPE: 'wireguard',
  VPN_COUNTRIES: 'United States',
}

/** Render `value` under `key` via renderEnv, then return the raw RHS of that
 *  `KEY=…` line exactly as written to .env. `key` must be a field renderEnv
 *  emits verbatim with no default/derivation — ARR_PASSWORD is the canonical
 *  choice (a free-form secret). A newline in `value` is always quoted+folded
 *  by ESCAPE, so the emitted entry never breaks across physical lines. */
export function emitField(value: string, key: keyof EnvFormValues = 'ARR_PASSWORD'): string {
  const rendered = renderEnv({ ...BASE_ENV, [key]: value })
  const prefix = `${key}=`
  const match = rendered.split('\n').find((l) => l.startsWith(prefix))
  if (match === undefined) throw new Error(`renderEnv did not emit ${key}`)
  return match.slice(prefix.length)
}
