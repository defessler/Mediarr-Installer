// Render the user-facing form values into a .env file. Mirrors the
// keys in nas/.env.example exactly. Anything not collected by the
// wizard is either omitted (auto-discovered later by setup-arr-config.py)
// or emitted with a documented default.

import { findVpnProvider } from './vpn-providers.js'

export interface EnvFormValues {
  // ── Service selection
  /** Per-user-facing-service opt-out flags. setup.sh translates these
   *  into COMPOSE_PROFILES so `docker compose up -d` only starts what
   *  the user wants. Default-on: profiles created before this field
   *  existed get every service (back-compat).
   *
   *  prowlarr + flaresolverr are intentionally ungated — they're cheap
   *  to run and Prowlarr is the indexer manager every arr depends on
   *  for indexers. gluetun is tied to qBittorrent's "torrenting" profile,
   *  so disabling qbittorrent also tears down the VPN sidecar. */
  ENABLE_PLEX?: string          // plex + tautulli + seerr (grouped — Tautulli/Seerr need Plex)
  ENABLE_SONARR?: string        // TV automation
  ENABLE_RADARR?: string        // Movies automation
  ENABLE_LIDARR?: string        // Music automation
  ENABLE_BAZARR?: string        // Subtitles (depends on sonarr/radarr at runtime)
  ENABLE_QBITTORRENT?: string   // Torrent client + gluetun VPN sidecar (when VPN_ENABLED)
  ENABLE_SABNZBD?: string       // Usenet client
  ENABLE_HOMEPAGE?: string      // Dashboard
  ENABLE_RECYCLARR?: string     // Quality-profile sync for sonarr/radarr
  ENABLE_UNPACKERR?: string     // Auto-extract archives in downloads

  // ── Identity
  PUID: string
  PGID: string
  TZ: string
  LAN_IP: string

  // ── Paths (NAS-family-portable)
  /** Where the wizard installs its compose stack — config dirs for
   *  every container live under this. Defaults per family:
   *    Synology: /volume1/docker/media
   *    Unraid:   /mnt/user/appdata/mediarr
   *    QNAP:     /share/Container/mediarr
   *    Generic:  /opt/mediarr
   *  docker-compose.yml references ${INSTALL_DIR}/<container>/config. */
  INSTALL_DIR?: string
  /** Where the user's media + downloads tree lives. Bind-mounted into
   *  every arr / qbittorrent / sabnzbd container as /data. Defaults
   *  per family:
   *    Synology: /volume1/Data
   *    Unraid:   /mnt/user/data
   *    QNAP:     /share/Data
   *    Generic:  /srv/data */
  DATA_ROOT?: string

  // ── Plex
  PLEX_CLAIM?: string

  // ── ARR Web UI auth (applied by setup-arr-config.py)
  ARR_USERNAME?: string
  ARR_PASSWORD?: string

  // ── qBittorrent
  QBITTORRENT_USER: string
  QBITTORRENT_PASS: string

  // ── SABnzbd usenet provider (optional — added on first install)
  USENET_HOST?: string
  USENET_PORT?: string
  USENET_USER?: string
  USENET_PASS?: string
  USENET_CONNECTIONS?: string
  USENET_SSL?: string         // '1' or '0'
  USENET_NAME?: string

  // ── VPN
  /** When 'false', setup.sh applies docker-compose.no-vpn.yml and gluetun
   *  is skipped. qBittorrent then runs on the regular bridge network. */
  VPN_ENABLED?: string          // 'true' | 'false' — default 'true'
  VPN_PROVIDER: string          // 'nordvpn' | 'protonvpn' | 'mullvad' | 'airvpn' | 'surfshark' | 'custom'
  VPN_TYPE: string              // 'wireguard' | 'openvpn'
  VPN_COUNTRIES: string         // 'United States,Canada'
  /** NordVPN-only: API token used to fetch a WireGuard private key. */
  NORDVPN_ACCESS_TOKEN?: string
  /** Generic WireGuard credentials (Gluetun reads these directly). */
  WIREGUARD_PRIVATE_KEY?: string
  WIREGUARD_ADDRESSES?: string      // tunnel address e.g. "10.2.0.2/32" — Proton, Mullvad, AirVPN
  WIREGUARD_PRESHARED_KEY?: string  // AirVPN
  /** OpenVPN credentials (Surfshark, etc.). */
  OPENVPN_USER?: string
  OPENVPN_PASSWORD?: string
  /** Free-form env block for the "Custom" provider escape hatch. */
  CUSTOM_VPN_ENV?: string
  /** Legacy field, kept for migration. New profiles use WIREGUARD_PRIVATE_KEY. */
  NORDVPN_PRIVATE_KEY?: string

  // ── Usenet indexers (paste API key to enable)
  ANIMETOSHO_API_KEY?: string
  NZBGEEK_API_KEY?: string
  NZBFINDER_API_KEY?: string
  DRUNKENSLUG_API_KEY?: string
  NZBPLANET_API_KEY?: string
  NZBCAT_API_KEY?: string
  DOGNZB_API_KEY?: string
  NINJACZENTRAL_API_KEY?: string
  TABULARASA_API_KEY?: string

  // ── Private torrent trackers
  AVISTAZ_USER?: string
  AVISTAZ_PASS?: string
  HHD_API_KEY?: string
  ANIMEBYTES_USER?: string
  ANIMEBYTES_PASS?: string
  ANIMETORRENTS_USER?: string
  ANIMETORRENTS_PASS?: string

  // ── Bazarr subtitle providers
  OPENSUBTITLES_USER?: string
  OPENSUBTITLES_PASS?: string
  OPENSUBTITLESCOM_USER?: string
  OPENSUBTITLESCOM_PASS?: string
  ADDIC7ED_USER?: string
  ADDIC7ED_PASS?: string
}

const ESCAPE = (v: string) => {
  // .env consumed by docker compose: quote if value contains whitespace
  // or special chars; escape embedded backslashes, double quotes,
  // dollar signs, and backticks (the last two trigger expansion inside
  // double quotes).
  if (v === '') return ''
  if (/[\s"$`\\]/.test(v)) {
    return `"${v.replace(/([\\"$`])/g, '\\$1')}"`
  }
  return v
}

const line = (k: string, v?: string) =>
  v === undefined || v === '' ? `${k}=` : `${k}=${ESCAPE(v)}`

/** Render the VPN section of .env based on the selected provider. We
 *  always emit VPN_ENABLED / VPN_PROVIDER / VPN_TYPE / VPN_COUNTRIES
 *  so existing setup.sh / validation scripts have a stable baseline,
 *  then layer the provider's specific gluetun env vars on top via
 *  `toGluetunEnv()`. Old-NordVPN-only profiles still get
 *  NORDVPN_PRIVATE_KEY emitted (as an alias) for back-compat with
 *  shell scripts that haven't been updated. */
function renderVpnBlock(v: EnvFormValues): string[] {
  const out: string[] = [
    '# VPN — set VPN_ENABLED=true to route qBittorrent through gluetun.',
    '# Gluetun (the actual VPN client) reads VPN_SERVICE_PROVIDER + VPN_TYPE',
    '# + the per-provider credentials emitted below.',
    line('VPN_ENABLED', v.VPN_ENABLED || 'false'),
  ]
  // VPN off → skip credential emission entirely (gluetun never starts).
  if ((v.VPN_ENABLED || 'false').toLowerCase() !== 'true') {
    out.push(line('VPN_PROVIDER', v.VPN_PROVIDER || 'nordvpn'))
    return out
  }
  const provider = findVpnProvider(v.VPN_PROVIDER)
  // VPN_PROVIDER + VPN_TYPE come from the registry, not the user's
  // form state — picking Surfshark must always emit VPN_TYPE=openvpn
  // even if the form's VPN_TYPE field is stale from a NordVPN default.
  out.push(line('VPN_PROVIDER', provider.id))
  out.push(line('VPN_TYPE', provider.vpnType))
  out.push(line('VPN_COUNTRIES', v.VPN_COUNTRIES))
  // The provider knows which gluetun env vars it needs and how to
  // build them from the collected form values.
  const gluetunEnv = provider.toGluetunEnv(v)
  for (const [k, val] of Object.entries(gluetunEnv)) {
    // Skip VPN_SERVICE_PROVIDER / VPN_TYPE / SERVER_COUNTRIES — already
    // emitted under their canonical keys above, gluetun reads either name.
    if (k === 'VPN_SERVICE_PROVIDER' || k === 'VPN_TYPE' || k === 'SERVER_COUNTRIES') continue
    out.push(line(k, val))
  }
  // Back-compat alias: setup-nordvpn.sh and older external scripts
  // still read NORDVPN_PRIVATE_KEY directly. Mirror the live WireGuard
  // key into it ONLY when provider=nordvpn (otherwise we'd leak a key
  // under a misleading name into a Proton/Mullvad/AirVPN .env).
  if (provider.id === 'nordvpn') {
    out.push(line('NORDVPN_PRIVATE_KEY', v.WIREGUARD_PRIVATE_KEY || v.NORDVPN_PRIVATE_KEY))
    out.push(line('NORDVPN_ACCESS_TOKEN', v.NORDVPN_ACCESS_TOKEN))
  }
  return out
}

/** Default-on if the field is missing or empty. Backwards-compat with
 *  profiles created before service selection existed — those .envs
 *  have no ENABLE_* keys, so we treat every service as enabled. The
 *  user explicitly opts a service OFF by setting ENABLE_FOO to any
 *  of false/0/no/off (any case).
 *
 *  CRITICAL: the disable set here MUST match the shell helpers in
 *  setup.sh (is_enabled) and the python helper in setup-arr-config.py
 *  (is_enabled). If a user types '0' in .env, every layer must agree
 *  that it means disabled — otherwise the wizard would emit
 *  ENABLE_FOO=true into a freshly-rendered .env (renderer treats '0'
 *  as enabled) while setup.sh skips the service (treats '0' as
 *  disabled), leaving the user wondering why their .env says yes but
 *  the install says no. */
export const ENABLE_DISABLED_VALUES = new Set(['false', '0', 'no', 'off'])
export const isEnabled = (v: string | undefined): boolean =>
  !ENABLE_DISABLED_VALUES.has((v ?? '').trim().toLowerCase())

export function renderEnv(v: EnvFormValues): string {
  return [
    '# Generated by Mediarr Installer',
    '# Service selection — ENABLE_<svc>=false opts that service out of',
    '# the stack. setup.sh translates these into COMPOSE_PROFILES so',
    '# docker compose only starts what you asked for. prowlarr + flare-',
    '# solverr are always on (cheap; Prowlarr is the indexer manager).',
    line('ENABLE_PLEX',        isEnabled(v.ENABLE_PLEX)        ? 'true' : 'false'),
    line('ENABLE_SONARR',      isEnabled(v.ENABLE_SONARR)      ? 'true' : 'false'),
    line('ENABLE_RADARR',      isEnabled(v.ENABLE_RADARR)      ? 'true' : 'false'),
    line('ENABLE_LIDARR',      isEnabled(v.ENABLE_LIDARR)      ? 'true' : 'false'),
    line('ENABLE_BAZARR',      isEnabled(v.ENABLE_BAZARR)      ? 'true' : 'false'),
    line('ENABLE_QBITTORRENT', isEnabled(v.ENABLE_QBITTORRENT) ? 'true' : 'false'),
    line('ENABLE_SABNZBD',     isEnabled(v.ENABLE_SABNZBD)     ? 'true' : 'false'),
    line('ENABLE_HOMEPAGE',    isEnabled(v.ENABLE_HOMEPAGE)    ? 'true' : 'false'),
    line('ENABLE_RECYCLARR',   isEnabled(v.ENABLE_RECYCLARR)   ? 'true' : 'false'),
    line('ENABLE_UNPACKERR',   isEnabled(v.ENABLE_UNPACKERR)   ? 'true' : 'false'),
    '',
    '# Identity',
    line('PUID', v.PUID),
    line('PGID', v.PGID),
    line('TZ', v.TZ),
    '',
    '# Paths — NAS-family-portable. docker-compose.yml references both.',
    line('INSTALL_DIR', v.INSTALL_DIR || '/volume1/docker/media'),
    line('DATA_ROOT',   v.DATA_ROOT   || '/volume1/Data'),
    '',
    '# Network',
    line('LAN_IP', v.LAN_IP),
    '',
    '# Plex',
    line('PLEX_CLAIM', v.PLEX_CLAIM),
    '',
    '# ARR Web UI Auth',
    line('ARR_USERNAME', v.ARR_USERNAME),
    line('ARR_PASSWORD', v.ARR_PASSWORD),
    '',
    '# ARR API keys (auto-discovered after first boot — leave blank)',
    'SONARR_API_KEY=',
    'RADARR_API_KEY=',
    'LIDARR_API_KEY=',
    'PROWLARR_API_KEY=',
    'SABNZBD_API_KEY=',
    'BAZARR_API_KEY=',
    'SEERR_API_KEY=',
    '',
    '# qBittorrent WebUI',
    line('QBITTORRENT_USER', v.QBITTORRENT_USER),
    line('QBITTORRENT_PASS', v.QBITTORRENT_PASS),
    '',
    '# SABnzbd usenet provider (optional)',
    line('USENET_HOST', v.USENET_HOST),
    line('USENET_PORT', v.USENET_PORT || '563'),
    line('USENET_USER', v.USENET_USER),
    line('USENET_PASS', v.USENET_PASS),
    line('USENET_CONNECTIONS', v.USENET_CONNECTIONS || '8'),
    line('USENET_SSL', v.USENET_SSL || '1'),
    line('USENET_NAME', v.USENET_NAME || 'primary'),
    '',
    // VPN block — driven by the provider registry so the env-vars
    // emitted always match what the picked provider's gluetun config
    // actually needs. Avoids two failure modes the previous flat-emit
    // had: stale NORDVPN_PRIVATE_KEY shadowing a freshly-typed
    // WIREGUARD_PRIVATE_KEY, and VPN_TYPE getting persisted from
    // defaults even after picking a Surfshark (openvpn) profile.
    ...renderVpnBlock(v),
    '',
    '# Usenet indexers',
    line('ANIMETOSHO_API_KEY', v.ANIMETOSHO_API_KEY),
    line('NZBGEEK_API_KEY', v.NZBGEEK_API_KEY),
    line('NZBFINDER_API_KEY', v.NZBFINDER_API_KEY),
    line('DRUNKENSLUG_API_KEY', v.DRUNKENSLUG_API_KEY),
    line('NZBPLANET_API_KEY', v.NZBPLANET_API_KEY),
    line('NZBCAT_API_KEY', v.NZBCAT_API_KEY),
    line('DOGNZB_API_KEY', v.DOGNZB_API_KEY),
    line('NINJACZENTRAL_API_KEY', v.NINJACZENTRAL_API_KEY),
    line('TABULARASA_API_KEY', v.TABULARASA_API_KEY),
    '',
    '# Private torrent trackers',
    line('AVISTAZ_USER', v.AVISTAZ_USER),
    line('AVISTAZ_PASS', v.AVISTAZ_PASS),
    line('HHD_API_KEY', v.HHD_API_KEY),
    line('ANIMEBYTES_USER', v.ANIMEBYTES_USER),
    line('ANIMEBYTES_PASS', v.ANIMEBYTES_PASS),
    line('ANIMETORRENTS_USER', v.ANIMETORRENTS_USER),
    line('ANIMETORRENTS_PASS', v.ANIMETORRENTS_PASS),
    '',
    '# Bazarr subtitle providers',
    line('OPENSUBTITLES_USER', v.OPENSUBTITLES_USER),
    line('OPENSUBTITLES_PASS', v.OPENSUBTITLES_PASS),
    line('OPENSUBTITLESCOM_USER', v.OPENSUBTITLESCOM_USER),
    line('OPENSUBTITLESCOM_PASS', v.OPENSUBTITLESCOM_PASS),
    line('ADDIC7ED_USER', v.ADDIC7ED_USER),
    line('ADDIC7ED_PASS', v.ADDIC7ED_PASS),
    '',
  ].join('\n')
}

// ── Indexer + provider catalogue (drives the toggle-card UI) ────────────────

export type IndexerCat = 'usenet-free' | 'usenet-paid' | 'tracker-private'

export interface IndexerDef {
  /** Form key */
  id: keyof EnvFormValues
  /** Display name */
  name: string
  /** Where to register / get an API key — opens externally */
  href?: string
  /** Brief one-liner */
  note?: string
  /** Auth fields the indexer needs */
  fields: { key: keyof EnvFormValues; label: string; password?: boolean }[]
  category: IndexerCat
}

export const USENET_INDEXERS: IndexerDef[] = [
  {
    id: 'NZBGEEK_API_KEY', name: 'NZBGeek',
    href: 'https://nzbgeek.info', note: 'Paid account.',
    fields: [{ key: 'NZBGEEK_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
  },
  {
    id: 'NZBFINDER_API_KEY', name: 'NZBFinder',
    href: 'https://nzbfinder.ws', note: 'Paid account.',
    fields: [{ key: 'NZBFINDER_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
  },
  {
    id: 'NZBPLANET_API_KEY', name: 'NZBPlanet',
    href: 'https://nzbplanet.net', note: 'Paid account.',
    fields: [{ key: 'NZBPLANET_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
  },
  {
    id: 'NZBCAT_API_KEY', name: 'NZB.cat',
    href: 'https://nzb.cat', note: 'Paid account.',
    fields: [{ key: 'NZBCAT_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
  },
  {
    id: 'DRUNKENSLUG_API_KEY', name: 'DrunkenSlug',
    href: 'https://drunkenslug.com', note: 'Invite-only.',
    fields: [{ key: 'DRUNKENSLUG_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
  },
  {
    id: 'DOGNZB_API_KEY', name: 'DogNZB',
    href: 'https://dognzb.cr', note: 'Invite-only.',
    fields: [{ key: 'DOGNZB_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
  },
  {
    id: 'NINJACZENTRAL_API_KEY', name: 'NinjaCentral',
    href: 'https://ninjacentral.co.za',
    fields: [{ key: 'NINJACZENTRAL_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
  },
  {
    id: 'TABULARASA_API_KEY', name: 'Tabula Rasa',
    href: 'https://tabula-rasa.pw',
    fields: [{ key: 'TABULARASA_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
  },
  {
    id: 'ANIMETOSHO_API_KEY', name: 'AnimeTosho (optional key)',
    href: 'https://animetosho.org', note: 'Free without a key; key only raises rate limits.',
    fields: [{ key: 'ANIMETOSHO_API_KEY', label: 'API key (optional)' }],
    category: 'usenet-free',
  },
]

export const PRIVATE_TRACKERS: IndexerDef[] = [
  {
    id: 'AVISTAZ_USER', name: 'AvistaZ', href: 'https://avistaz.to',
    note: 'Korean/Asian movies and TV.',
    fields: [
      { key: 'AVISTAZ_USER', label: 'Username' },
      { key: 'AVISTAZ_PASS', label: 'Password', password: true },
    ],
    category: 'tracker-private',
  },
  {
    id: 'HHD_API_KEY', name: 'HomieHelpDesk', href: 'https://homiehelpdesk.net',
    note: 'Korean movies/dramas.',
    fields: [{ key: 'HHD_API_KEY', label: 'API key' }],
    category: 'tracker-private',
  },
  {
    id: 'ANIMEBYTES_USER', name: 'AnimeBytes', href: 'https://animebytes.tv',
    note: 'Highest-quality anime tracker (invite-only).',
    fields: [
      { key: 'ANIMEBYTES_USER', label: 'Username' },
      { key: 'ANIMEBYTES_PASS', label: 'Password', password: true },
    ],
    category: 'tracker-private',
  },
  {
    id: 'ANIMETORRENTS_USER', name: 'AnimeTorrents', href: 'https://animetorrents.me',
    note: 'Anime (application-based).',
    fields: [
      { key: 'ANIMETORRENTS_USER', label: 'Username' },
      { key: 'ANIMETORRENTS_PASS', label: 'Password', password: true },
    ],
    category: 'tracker-private',
  },
]

export const BAZARR_PROVIDERS: IndexerDef[] = [
  {
    id: 'OPENSUBTITLES_USER', name: 'OpenSubtitles.org',
    href: 'https://www.opensubtitles.org', note: 'Free account.',
    fields: [
      { key: 'OPENSUBTITLES_USER', label: 'Username' },
      { key: 'OPENSUBTITLES_PASS', label: 'Password', password: true },
    ],
    category: 'usenet-free',
  },
  {
    id: 'OPENSUBTITLESCOM_USER', name: 'OpenSubtitles.com',
    href: 'https://www.opensubtitles.com', note: 'Free account; larger DB.',
    fields: [
      { key: 'OPENSUBTITLESCOM_USER', label: 'Username' },
      { key: 'OPENSUBTITLESCOM_PASS', label: 'Password', password: true },
    ],
    category: 'usenet-free',
  },
  {
    id: 'ADDIC7ED_USER', name: 'Addic7ed',
    href: 'https://www.addic7ed.com', note: 'Free account.',
    fields: [
      { key: 'ADDIC7ED_USER', label: 'Username' },
      { key: 'ADDIC7ED_PASS', label: 'Password', password: true },
    ],
    category: 'usenet-free',
  },
]
