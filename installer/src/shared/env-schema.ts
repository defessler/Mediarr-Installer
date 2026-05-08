import { z } from 'zod'

const numericString = z.string().regex(/^\d+$/, 'must be a positive integer')
const ipv4 = z
  .string()
  .regex(
    /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/,
    'must be a valid IPv4 address',
  )

export const envSchema = z.object({
  PUID: numericString,
  PGID: numericString,
  TZ: z.string().regex(/^[A-Z][a-zA-Z_]+\/[A-Za-z_+-]+$/, 'expected Area/City'),
  LAN_IP: ipv4,
  VPN_PROVIDER: z.string().min(1),
  VPN_TYPE: z.literal('wireguard'),
  VPN_COUNTRIES: z.string().min(1, 'pick at least one country'),
  NORDVPN_PRIVATE_KEY: z
    .string()
    .min(1, 'WireGuard private key is required')
    .refine((v) => v.length === 43 || v.length === 44, 'WireGuard key should be 43 or 44 chars'),
  QBITTORRENT_USER: z.string().min(1),
  QBITTORRENT_PASS: z.string().min(8, 'at least 8 characters'),
  PLEX_CLAIM: z
    .string()
    .optional()
    .refine((v) => !v || v.startsWith('claim-'), 'Plex claim tokens start with "claim-"'),
  NZBGEEK_API_KEY: z.string().optional(),
  ANIMETOSHO_API_KEY: z.string().optional(),
  OPENSUBTITLES_USERNAME: z.string().optional(),
  OPENSUBTITLES_PASSWORD: z.string().optional(),
  ADDIC7ED_USERNAME: z.string().optional(),
  ADDIC7ED_PASSWORD: z.string().optional(),
})

export type EnvSchema = z.infer<typeof envSchema>

export const connectionSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  authMethod: z.enum(['password', 'privateKey']),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  passphrase: z.string().optional(),
})
export type ConnectionSchema = z.infer<typeof connectionSchema>
