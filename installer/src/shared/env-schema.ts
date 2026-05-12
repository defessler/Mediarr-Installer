import { z } from 'zod'

const numericString = z.string().regex(/^\d+$/, 'must be a positive integer')
const ipv4 = z
  .string()
  .regex(
    /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/,
    'must be a valid IPv4 address',
  )

const optStr = z.string().optional()

export const envSchema = z.object({
  // Identity
  PUID: numericString,
  PGID: numericString,
  TZ: z.string().regex(/^[A-Z][a-zA-Z_]+\/[A-Za-z_+-]+$/, 'expected Area/City'),
  LAN_IP: ipv4,

  // Plex
  PLEX_CLAIM: optStr.refine(
    (v) => !v || v.startsWith('claim-'),
    'Plex claim tokens start with "claim-"',
  ),

  // ARR auth
  ARR_USERNAME: optStr,
  ARR_PASSWORD: optStr,

  // qBittorrent
  QBITTORRENT_USER: z.string().min(1),
  QBITTORRENT_PASS: z.string().min(8, 'at least 8 characters'),

  // SABnzbd usenet provider (all optional — host gates the rest)
  USENET_HOST: optStr,
  USENET_PORT: optStr.refine(
    (v) => !v || /^\d+$/.test(v),
    'must be a port number',
  ),
  USENET_USER: optStr,
  USENET_PASS: optStr,
  USENET_CONNECTIONS: optStr.refine(
    (v) => !v || /^\d+$/.test(v),
    'must be a positive integer',
  ),
  USENET_SSL: optStr,
  USENET_NAME: optStr,

  // VPN — required only when VPN_ENABLED !== 'false' (cross-validated below).
  VPN_ENABLED: optStr,
  VPN_PROVIDER: optStr,
  VPN_TYPE: z.union([z.literal('wireguard'), z.literal('openvpn'), z.literal('').optional()]).optional(),
  VPN_COUNTRIES: optStr,
  NORDVPN_ACCESS_TOKEN: optStr,
  NORDVPN_PRIVATE_KEY: optStr,
  WIREGUARD_PRIVATE_KEY: optStr,
  WIREGUARD_ADDRESSES: optStr,
  WIREGUARD_PRESHARED_KEY: optStr,
  OPENVPN_USER: optStr,
  OPENVPN_PASSWORD: optStr,
  CUSTOM_VPN_ENV: optStr,

  // Indexers (all optional — leave blank to skip)
  ANIMETOSHO_API_KEY: optStr,
  NZBGEEK_API_KEY: optStr,
  NZBFINDER_API_KEY: optStr,
  DRUNKENSLUG_API_KEY: optStr,
  NZBPLANET_API_KEY: optStr,
  NZBCAT_API_KEY: optStr,
  DOGNZB_API_KEY: optStr,
  NINJACZENTRAL_API_KEY: optStr,
  TABULARASA_API_KEY: optStr,

  // Private trackers
  AVISTAZ_USER: optStr,
  AVISTAZ_PASS: optStr,
  HHD_API_KEY: optStr,
  ANIMEBYTES_USER: optStr,
  ANIMEBYTES_PASS: optStr,
  ANIMETORRENTS_USER: optStr,
  ANIMETORRENTS_PASS: optStr,

  // Bazarr providers
  OPENSUBTITLES_USER: optStr,
  OPENSUBTITLES_PASS: optStr,
  OPENSUBTITLESCOM_USER: optStr,
  OPENSUBTITLESCOM_PASS: optStr,
  ADDIC7ED_USER: optStr,
  ADDIC7ED_PASS: optStr,
}).superRefine((v, ctx) => {
  // Usenet creds only meaningful when host is set.
  if (v.USENET_HOST) {
    if (!v.USENET_USER) {
      ctx.addIssue({ code: 'custom', path: ['USENET_USER'],
        message: 'username required when USENET_HOST is set' })
    }
    if (!v.USENET_PASS) {
      ctx.addIssue({ code: 'custom', path: ['USENET_PASS'],
        message: 'password required when USENET_HOST is set' })
    }
  }

  // VPN config only validated when VPN_ENABLED is explicitly on
  // (default = off; user opts in via the checkbox). Per-provider
  // validation lives in shared/vpn-providers.ts — here we only enforce
  // the gate-level invariants that apply regardless of provider.
  const vpnOn = (v.VPN_ENABLED ?? 'false').toLowerCase() === 'true'
  if (!vpnOn) return
  if (!v.VPN_PROVIDER) {
    ctx.addIssue({ code: 'custom', path: ['VPN_PROVIDER'],
      message: 'Pick a VPN provider (or turn VPN off).' })
    return
  }
  if (!v.VPN_COUNTRIES && v.VPN_PROVIDER !== 'custom') {
    ctx.addIssue({ code: 'custom', path: ['VPN_COUNTRIES'],
      message: 'Pick at least one country when VPN is enabled.' })
  }
  // Provider-specific required-creds checks. Mirror the registry in
  // vpn-providers.ts without pulling that module here (this file is
  // shared between renderer + main, and zod schemas live in shared too).
  const wg  = v.WIREGUARD_PRIVATE_KEY || v.NORDVPN_PRIVATE_KEY || ''
  const wgOk = wg.length >= 40 && wg.length <= 60
  const provider = v.VPN_PROVIDER
  if (provider === 'nordvpn' || provider === 'protonvpn'
      || provider === 'mullvad' || provider === 'airvpn') {
    if (!wg) {
      ctx.addIssue({ code: 'custom', path: ['WIREGUARD_PRIVATE_KEY'],
        message: 'WireGuard private key required.' })
    } else if (!wgOk) {
      ctx.addIssue({ code: 'custom', path: ['WIREGUARD_PRIVATE_KEY'],
        message: `WireGuard private keys are usually ~44 chars; got ${wg.length}.` })
    }
  }
  if (provider === 'protonvpn' || provider === 'mullvad' || provider === 'airvpn') {
    if (!v.WIREGUARD_ADDRESSES) {
      ctx.addIssue({ code: 'custom', path: ['WIREGUARD_ADDRESSES'],
        message: 'Tunnel address required (from your provider\'s WireGuard config).' })
    }
  }
  if (provider === 'surfshark') {
    if (!v.OPENVPN_USER) {
      ctx.addIssue({ code: 'custom', path: ['OPENVPN_USER'],
        message: 'Manual-setup username required (not your account email).' })
    }
    if (!v.OPENVPN_PASSWORD) {
      ctx.addIssue({ code: 'custom', path: ['OPENVPN_PASSWORD'],
        message: 'Manual-setup password required.' })
    }
  }
  if (provider === 'custom' && !v.CUSTOM_VPN_ENV) {
    ctx.addIssue({ code: 'custom', path: ['CUSTOM_VPN_ENV'],
      message: 'Paste a gluetun env block (at least VPN_SERVICE_PROVIDER and credentials).' })
  }
})

export type EnvSchema = z.infer<typeof envSchema>

export const connectionSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  authMethod: z.enum(['password', 'privateKey']),
  password: optStr,
  privateKeyPath: optStr,
  passphrase: optStr,
})
export type ConnectionSchema = z.infer<typeof connectionSchema>
