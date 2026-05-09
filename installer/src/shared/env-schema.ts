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

  // VPN
  VPN_PROVIDER: z.string().min(1),
  VPN_TYPE: z.literal('wireguard'),
  VPN_COUNTRIES: z.string().min(1, 'pick at least one country'),
  NORDVPN_ACCESS_TOKEN: optStr,
  NORDVPN_PRIVATE_KEY: z
    .string()
    .min(1, 'WireGuard private key is required')
    .refine((v) => v.length === 43 || v.length === 44, 'WireGuard key should be 43 or 44 chars'),

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
  // If a usenet host is provided, require credentials too — otherwise
  // setup-arr-config.py would silently skip the server and the user
  // wouldn't know why downloads aren't working.
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
