import { z } from 'zod'
import { ENABLE_DISABLED_VALUES } from './env-render.js'

const numericString = z.string().regex(/^\d+$/, 'must be a positive integer')
const ipv4 = z
  .string()
  .regex(
    /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/,
    'must be a valid IPv4 address',
  )

const optStr = z.string().optional()

/** Default-on enable-flag check, mirrors env-render.ts isEnabled().
 *  Kept here as a private function (rather than re-imported) so we can
 *  duplicate the trivial logic without forcing zod consumers to import
 *  env-render's runtime helpers. */
const flagOn = (v: string | undefined): boolean =>
  !ENABLE_DISABLED_VALUES.has((v ?? '').trim().toLowerCase())

export const envSchema = z.object({
  // Service selection — per-service ENABLE_* opt-out flags. All optional;
  // missing is treated as enabled. The superRefine block below uses
  // these to skip credential validation for services the user has
  // turned off (no point demanding QBITTORRENT_PASS when qBittorrent
  // isn't in the stack).
  ENABLE_PLEX: optStr,
  ENABLE_SONARR: optStr,
  ENABLE_RADARR: optStr,
  ENABLE_LIDARR: optStr,
  ENABLE_BAZARR: optStr,
  ENABLE_QBITTORRENT: optStr,
  ENABLE_SABNZBD: optStr,
  ENABLE_HOMEPAGE: optStr,
  ENABLE_RECYCLARR: optStr,
  ENABLE_UNPACKERR: optStr,

  // Identity
  PUID: numericString,
  PGID: numericString,
  TZ: z.string().regex(/^[A-Z][a-zA-Z_]+\/[A-Za-z_+-]+$/, 'expected Area/City'),
  LAN_IP: ipv4,

  // Paths (NAS-family-portable). Absolute paths only — relative paths
  // would resolve against /root or wherever sudo's cwd lands and that
  // way lies madness. Cross-validated below: INSTALL_DIR and DATA_ROOT
  // must NOT be the same dir (the .env file + compose stack would
  // collide with the user's media).
  INSTALL_DIR: optStr.refine((v) => !v || v.startsWith('/'),
    'must be an absolute path starting with /'),
  DATA_ROOT: optStr.refine((v) => !v || v.startsWith('/'),
    'must be an absolute path starting with /'),

  // Plex
  PLEX_CLAIM: optStr.refine(
    (v) => !v || v.startsWith('claim-'),
    'Plex claim tokens start with "claim-"',
  ),

  // ARR auth
  ARR_USERNAME: optStr,
  ARR_PASSWORD: optStr,

  // qBittorrent — fields are optional at the schema level; the
  // superRefine block below escalates them to required *only* when
  // ENABLE_QBITTORRENT is on (default). Avoids a "password too short"
  // error when the user has explicitly disabled qBittorrent and
  // doesn't care.
  QBITTORRENT_USER: optStr,
  QBITTORRENT_PASS: optStr,

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
  // INSTALL_DIR and DATA_ROOT can't be the same path — the wizard
  // writes .env + docker-compose.yml under INSTALL_DIR, and bind-
  // mounts DATA_ROOT into every container as /data. If they're the
  // same, the user's media tree gets the wizard's compose tooling
  // dropped on top of it. Allow a nested layout (DATA_ROOT under
  // INSTALL_DIR or vice-versa) — that's just unusual, not broken.
  if (v.INSTALL_DIR && v.DATA_ROOT && v.INSTALL_DIR === v.DATA_ROOT) {
    ctx.addIssue({ code: 'custom', path: ['DATA_ROOT'],
      message: 'must differ from INSTALL_DIR (compose tooling and media tree should be separate)' })
  }

  // qBittorrent credentials — required only when the service is in
  // the stack (ENABLE_QBITTORRENT defaults to on; explicit false-y opts
  // out). When disabled, we don't validate the user/pass at all — the
  // user shouldn't have to invent a password for a container that
  // will never start.
  const qbitOn = flagOn(v.ENABLE_QBITTORRENT)
  if (qbitOn) {
    if (!v.QBITTORRENT_USER || v.QBITTORRENT_USER.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['QBITTORRENT_USER'],
        message: 'required when qBittorrent is enabled' })
    }
    if (!v.QBITTORRENT_PASS || v.QBITTORRENT_PASS.length < 8) {
      ctx.addIssue({ code: 'custom', path: ['QBITTORRENT_PASS'],
        message: 'at least 8 characters (qBittorrent enforces this on first boot)' })
    }
  }

  // SABnzbd usenet creds only meaningful when host is set AND SABnzbd
  // is enabled. Skipping the host-set check entirely when SAB is off
  // means a pre-populated USENET_HOST from a previous run doesn't
  // false-fire validation after the user disables SABnzbd.
  if (flagOn(v.ENABLE_SABNZBD) && v.USENET_HOST) {
    if (!v.USENET_USER) {
      ctx.addIssue({ code: 'custom', path: ['USENET_USER'],
        message: 'username required when USENET_HOST is set' })
    }
    if (!v.USENET_PASS) {
      ctx.addIssue({ code: 'custom', path: ['USENET_PASS'],
        message: 'password required when USENET_HOST is set' })
    }
  }

  // VPN config only validated when VPN_ENABLED is explicitly on AND
  // qBittorrent is in the stack. Without qBittorrent there's no
  // service the VPN routes for, so even VPN_ENABLED=true should not
  // trigger required-cred validation (the install just won't activate
  // the "vpn" profile in COMPOSE_PROFILES).
  const vpnOn = (v.VPN_ENABLED ?? 'false').toLowerCase() === 'true'
  if (!vpnOn || !qbitOn) return
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
