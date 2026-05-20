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

  // ── TRaSH Guide profile selection
  /** Which Sonarr quality profile Recyclarr should sync from TRaSH
   *  Guides. setup-arr-config.py's render_recyclarr_config() reads this
   *  to pick the right `include:` template list. Recognised values:
   *    'web-1080p'        (default — most users)
   *    'web-2160p'        (4K web releases)
   *    'bluray-1080p'     (1080p Bluray)
   *    'bluray-2160p'     (4K REMUX + Bluray)
   *    'anime'            (anime-specific scoring)
   *  Power users can hand-edit recyclarr.yml — these picks just seed
   *  it. Missing = default. */
  TRASH_SONARR_PROFILE?: string
  /** Which Radarr quality profile Recyclarr should sync. Recognised:
   *    'hd-bluray-web'    (default — 1080p HD Bluray + WEB)
   *    'uhd-bluray-web'   (4K Bluray + WEB)
   *    'remux-web-2160p'  (top-tier 4K REMUX)
   *    'anime'            (anime-specific scoring) */
  TRASH_RADARR_PROFILE?: string

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
  // Free, public, no-signup indexers — added automatically. These
  // env keys are placeholders only (no fields collected), kept here
  // so the IndexerDef type-check against keyof EnvFormValues passes
  // and the Configure-screen card renders for documentation.
  NZBKING_NO_KEY?: string
  BINSEARCH_NO_KEY?: string
  // Free-with-signup indexers — API key collected, sent to .env.
  ABNZB_API_KEY?: string
  ALTHUB_API_KEY?: string
  // Paid usenet indexers
  NZBGEEK_API_KEY?: string
  NZBFINDER_API_KEY?: string
  DRUNKENSLUG_API_KEY?: string
  NZBPLANET_API_KEY?: string
  NZBCAT_API_KEY?: string
  DOGNZB_API_KEY?: string
  NINJACZENTRAL_API_KEY?: string
  TABULARASA_API_KEY?: string
  NZBSU_API_KEY?: string

  // ── Public torrent trackers — placeholders, no key collected.
  // Added automatically by setup-indexers.py; presence in EnvFormValues
  // lets the IndexerDef.fields type-check passes uniformly.
  NYAA_NO_KEY?: string
  SUBSPLEASE_NO_KEY?: string
  ANIDEX_NO_KEY?: string
  TOKYOTOSHO_NO_KEY?: string
  X1337_NO_KEY?: string
  TGX_NO_KEY?: string
  THEPIRATEBAY_NO_KEY?: string
  LIMETORRENTS_NO_KEY?: string
  EZTV_NO_KEY?: string
  THERARBG_NO_KEY?: string
  BITSEARCH_NO_KEY?: string
  YTS_NO_KEY?: string

  // ── Additional private trackers (TV / movies / music / general)
  BTN_API_KEY?: string
  MTV_API_KEY?: string
  PTP_USER?: string
  PTP_KEY?: string
  RED_API_KEY?: string
  ORPHEUS_API_KEY?: string
  TORRENTLEECH_RSSKEY?: string
  HDTORRENTS_USER?: string
  HDTORRENTS_PASS?: string

  // ── Custom user-defined indexers (JSON catalogue)
  // The wizard exposes an in-app editor for one or more user-supplied
  // Newznab-compatible indexers. Serialised as a JSON string in .env
  // so setup-indexers.py can read it without an extra IPC round-trip;
  // the wizard parses + edits it via its native object form. Empty /
  // unset = no custom entries (the default).
  CUSTOM_INDEXERS_JSON?: string

  // ── Private torrent trackers
  AVISTAZ_USER?: string
  AVISTAZ_PASS?: string
  /** AvistaZ "passkey" — find it under Profile → Profile → Passkey on
   *  the AvistaZ site. Required (Prowlarr's AvistaZ indexer rejects
   *  the add without it). The old wizard collected user + pass but
   *  NOT pid, so AvistaZ always silently skipped. */
  AVISTAZ_PID?: string
  HHD_API_KEY?: string
  ANIMEBYTES_USER?: string
  ANIMEBYTES_PASS?: string
  ANIMETORRENTS_USER?: string
  ANIMETORRENTS_PASS?: string
  /** IPTorrents — cookie-based auth (paste the entire session cookie
   *  string from a browser DevTools → Application → Cookies → iptorrents.com).
   *  Prowlarr's IPTorrents indexer uses cookie auth, not user/pass. */
  IPTORRENTS_COOKIE?: string

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
    '# TRaSH Guide profile picks — consumed by setup-arr-config.py to',
    '# generate recyclarr.yml. Defaults seed the most common TRaSH',
    '# choices. Power users can hand-edit recyclarr.yml afterwards.',
    line('TRASH_SONARR_PROFILE', v.TRASH_SONARR_PROFILE || 'web-1080p'),
    line('TRASH_RADARR_PROFILE', v.TRASH_RADARR_PROFILE || 'hd-bluray-web'),
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
    line('ABNZB_API_KEY', v.ABNZB_API_KEY),
    line('ALTHUB_API_KEY', v.ALTHUB_API_KEY),
    line('NZBGEEK_API_KEY', v.NZBGEEK_API_KEY),
    line('NZBFINDER_API_KEY', v.NZBFINDER_API_KEY),
    line('DRUNKENSLUG_API_KEY', v.DRUNKENSLUG_API_KEY),
    line('NZBPLANET_API_KEY', v.NZBPLANET_API_KEY),
    line('NZBCAT_API_KEY', v.NZBCAT_API_KEY),
    line('DOGNZB_API_KEY', v.DOGNZB_API_KEY),
    line('NINJACZENTRAL_API_KEY', v.NINJACZENTRAL_API_KEY),
    line('TABULARASA_API_KEY', v.TABULARASA_API_KEY),
    line('NZBSU_API_KEY', v.NZBSU_API_KEY),
    '',
    '# Private torrent trackers',
    line('AVISTAZ_USER', v.AVISTAZ_USER),
    line('AVISTAZ_PASS', v.AVISTAZ_PASS),
    line('AVISTAZ_PID',  v.AVISTAZ_PID),
    line('HHD_API_KEY', v.HHD_API_KEY),
    line('ANIMEBYTES_USER', v.ANIMEBYTES_USER),
    line('ANIMEBYTES_PASS', v.ANIMEBYTES_PASS),
    line('ANIMETORRENTS_USER', v.ANIMETORRENTS_USER),
    line('ANIMETORRENTS_PASS', v.ANIMETORRENTS_PASS),
    line('IPTORRENTS_COOKIE', v.IPTORRENTS_COOKIE),
    line('TORRENTLEECH_RSSKEY', v.TORRENTLEECH_RSSKEY),
    line('HDTORRENTS_USER', v.HDTORRENTS_USER),
    line('HDTORRENTS_PASS', v.HDTORRENTS_PASS),
    line('BTN_API_KEY', v.BTN_API_KEY),
    line('MTV_API_KEY', v.MTV_API_KEY),
    line('PTP_USER', v.PTP_USER),
    line('PTP_KEY', v.PTP_KEY),
    line('RED_API_KEY', v.RED_API_KEY),
    line('ORPHEUS_API_KEY', v.ORPHEUS_API_KEY),
    '',
    '# Custom user-defined indexers (JSON-blob managed by the wizard editor)',
    line('CUSTOM_INDEXERS_JSON', v.CUSTOM_INDEXERS_JSON),
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

/** High-level group used by the legacy section headers. The Configure
 *  screen now layers a unified search + chip-filter view over the whole
 *  catalogue, but downstream consumers (setup-indexers.py mapping,
 *  legacy renderers) still key off these category strings. */
export type IndexerCat =
  | 'usenet-free'           // no signup OR free signup
  | 'usenet-paid'           // paid account / invite-only
  | 'tracker-public'        // anyone can grab feeds; no account
  | 'tracker-private'       // paid / invite-only private tracker

/** Tag taxonomy for the search/filter UI. An indexer can carry
 *  multiple tags — e.g. AnimeBytes is both 'anime' and 'tracker-private'.
 *  Filter chips on the Configure screen offer one selection per
 *  semantic axis (content / cost / signup); a card is shown when it
 *  matches EVERY active filter (AND across axes, OR within an axis
 *  when we add multi-pick later). */
export type IndexerTag =
  // Content
  | 'general'   // catchall — TV + movies + everything
  | 'tv'        // TV-focused
  | 'movies'    // movie-focused
  | 'anime'     // anime / animation
  | 'kdrama'    // Korean drama specifically
  | 'asian'     // Korean / Chinese / Japanese live action (broader)
  | 'music'     // FLAC / lossless audio focus
  | 'books'     // ebooks / audiobooks
  // Kind
  | 'usenet'
  | 'torrent'
  // Cost
  | 'free'
  | 'paid'
  // Signup gating
  | 'no-signup'      // public, anyone
  | 'free-signup'    // free account, anyone can register
  | 'invite-only'    // need an existing member to invite you
  | 'application'    // open application / interview gates entry

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
  /** Filter tags consumed by the Configure-screen search UI. Older
   *  entries auto-derive content tags from `category` when this is
   *  omitted; new entries should always set this explicitly so the
   *  filter chips have meaningful options. */
  tags?: IndexerTag[]
}

/** Build the effective tag set for an indexer — explicit `tags` PLUS
 *  derived ones from `category` so legacy entries still filter
 *  sensibly. Helper so the UI doesn't have to redo this logic per
 *  render, and so setup-indexers.py-side TS code (if we add it
 *  someday) shares the same derivation rule. */
export function indexerTags(def: IndexerDef): IndexerTag[] {
  const tags = new Set<IndexerTag>(def.tags ?? [])
  // Derive from category — never override explicit tags.
  if (def.category === 'usenet-free') {
    tags.add('usenet')
    tags.add('free')
  } else if (def.category === 'usenet-paid') {
    tags.add('usenet')
    if (!tags.has('free')) tags.add('paid')
  } else if (def.category === 'tracker-public') {
    tags.add('torrent')
    tags.add('free')
    if (!tags.has('free-signup')) tags.add('no-signup')
  } else if (def.category === 'tracker-private') {
    tags.add('torrent')
    if (!tags.has('free')) tags.add('paid')
  }
  return Array.from(tags)
}

export const USENET_INDEXERS: IndexerDef[] = [
  // ── Free / no-signup public usenet ────────────────────────────
  // NZBKing + Binsearch removed in v0.3.29 — both consistently failed
  // Prowlarr's reachability probe (NZBKing went read-only late 2024;
  // Binsearch's bundled URL drift across mirrors had no stable pin).
  // Their *_NO_KEY env-key types stay in EnvFormValues for back-compat
  // with .env files written by older installer versions — the schema
  // ignores them on read.
  {
    id: 'ANIMETOSHO_API_KEY', name: 'AnimeTosho',
    href: 'https://animetosho.org',
    note: 'Best free anime indexer. Added automatically; key only raises rate limits.',
    fields: [{ key: 'ANIMETOSHO_API_KEY', label: 'API key (optional)' }],
    category: 'usenet-free',
    tags: ['anime', 'no-signup'],
  },
  // ── Free-with-signup usenet ───────────────────────────────────
  {
    id: 'ABNZB_API_KEY', name: 'ABNzb',
    href: 'https://abnzb.com',
    note: 'Free signup → API key. ~50–100 daily calls — fine for casual use.',
    fields: [{ key: 'ABNZB_API_KEY', label: 'API key' }],
    category: 'usenet-free',
    tags: ['general', 'free-signup'],
  },
  {
    id: 'ALTHUB_API_KEY', name: 'Althub',
    href: 'https://althub.co.za',
    note: 'Free signup → API key. South-African-hosted, similar to ABNzb.',
    fields: [{ key: 'ALTHUB_API_KEY', label: 'API key' }],
    category: 'usenet-free',
    tags: ['general', 'free-signup'],
  },
  // ── Paid usenet — well-established indexers ───────────────────
  {
    id: 'NZBGEEK_API_KEY', name: 'NZBGeek',
    href: 'https://nzbgeek.info', note: 'Paid account. Excellent retention + categorisation.',
    fields: [{ key: 'NZBGEEK_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
    tags: ['general', 'free-signup'],
  },
  {
    id: 'NZBFINDER_API_KEY', name: 'NZBFinder',
    href: 'https://nzbfinder.ws', note: 'Paid account. Strong general coverage.',
    fields: [{ key: 'NZBFINDER_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
    tags: ['general', 'free-signup'],
  },
  {
    id: 'NZBPLANET_API_KEY', name: 'NZBPlanet',
    href: 'https://nzbplanet.net', note: 'Paid account.',
    fields: [{ key: 'NZBPLANET_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
    tags: ['general', 'free-signup'],
  },
  {
    id: 'NZBCAT_API_KEY', name: 'NZB.cat',
    href: 'https://nzb.cat', note: 'Paid account.',
    fields: [{ key: 'NZBCAT_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
    tags: ['general', 'free-signup'],
  },
  {
    id: 'DRUNKENSLUG_API_KEY', name: 'DrunkenSlug',
    href: 'https://drunkenslug.com', note: 'Invite-only.',
    fields: [{ key: 'DRUNKENSLUG_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
    tags: ['general', 'invite-only'],
  },
  {
    id: 'DOGNZB_API_KEY', name: 'DogNZB',
    href: 'https://dognzb.cr', note: 'Invite-only.',
    fields: [{ key: 'DOGNZB_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
    tags: ['general', 'invite-only'],
  },
  {
    id: 'NINJACZENTRAL_API_KEY', name: 'NinjaCentral',
    href: 'https://ninjacentral.co.za',
    note: 'Paid account.',
    fields: [{ key: 'NINJACZENTRAL_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
    tags: ['general', 'free-signup'],
  },
  {
    id: 'TABULARASA_API_KEY', name: 'Tabula Rasa',
    href: 'https://tabula-rasa.pw',
    note: 'Paid account.',
    fields: [{ key: 'TABULARASA_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
    tags: ['general', 'free-signup'],
  },
  {
    id: 'NZBSU_API_KEY', name: 'NZB.su',
    href: 'https://nzb.su',
    note: 'Paid account. General-purpose, long-running indexer.',
    fields: [{ key: 'NZBSU_API_KEY', label: 'API key' }],
    category: 'usenet-paid',
    tags: ['general', 'free-signup'],
  },
]

/** Public torrent trackers — no account needed. Each is added with
 *  no auth fields; setup-indexers.py just registers them by name. */
export const PUBLIC_TRACKERS: IndexerDef[] = [
  // ── Anime / Asian focused public ──────────────────────────────
  {
    id: 'NYAA_NO_KEY', name: 'Nyaa',
    href: 'https://nyaa.si',
    note: 'The anime torrent index — fansubs, manga, music. Free, public, no account.',
    fields: [],
    category: 'tracker-public',
    tags: ['anime', 'no-signup'],
  },
  {
    id: 'SUBSPLEASE_NO_KEY', name: 'SubsPlease',
    href: 'https://subsplease.org',
    note: 'Weekly anime fansubs (HorribleSubs successor). RSS-based, no account.',
    fields: [],
    category: 'tracker-public',
    tags: ['anime', 'no-signup'],
  },
  {
    id: 'ANIDEX_NO_KEY', name: 'AniDex',
    href: 'https://anidex.info',
    note: 'Anime / manga / Asian video. Free, public, no account.',
    fields: [],
    category: 'tracker-public',
    tags: ['anime', 'no-signup'],
  },
  {
    id: 'TOKYOTOSHO_NO_KEY', name: 'Tokyo Toshokan',
    href: 'https://www.tokyotosho.info',
    note: 'Long-running anime + Japanese torrent index. Free, public, no account.',
    fields: [],
    category: 'tracker-public',
    tags: ['anime', 'asian', 'no-signup'],
  },
  // ── General public ────────────────────────────────────────────
  {
    id: 'X1337_NO_KEY', name: '1337x',
    href: 'https://1337x.to',
    note: 'General-purpose public tracker — movies, TV, software. No account.',
    fields: [],
    category: 'tracker-public',
    tags: ['general', 'no-signup'],
  },
  {
    id: 'TGX_NO_KEY', name: 'TorrentGalaxy',
    href: 'https://torrentgalaxy.to',
    note: 'General-purpose public tracker. Good UI, no account.',
    fields: [],
    category: 'tracker-public',
    tags: ['general', 'no-signup'],
  },
  {
    id: 'THEPIRATEBAY_NO_KEY', name: 'The Pirate Bay',
    href: 'https://thepiratebay.org',
    note: 'The original public tracker. Catch-all coverage, no account.',
    fields: [],
    category: 'tracker-public',
    tags: ['general', 'no-signup'],
  },
  {
    id: 'LIMETORRENTS_NO_KEY', name: 'LimeTorrents',
    href: 'https://www.limetorrents.lol',
    note: 'General-purpose public tracker. No account.',
    fields: [],
    category: 'tracker-public',
    tags: ['general', 'no-signup'],
  },
  {
    id: 'EZTV_NO_KEY', name: 'EZTV',
    href: 'https://eztvx.to',
    note: 'TV-shows-only public tracker. RSS-based, no account.',
    fields: [],
    category: 'tracker-public',
    tags: ['tv', 'no-signup'],
  },
  {
    id: 'THERARBG_NO_KEY', name: 'TheRARBG',
    href: 'https://therarbg.com',
    note: 'RARBG community successor. General-purpose, no account.',
    fields: [],
    category: 'tracker-public',
    tags: ['general', 'no-signup'],
  },
  {
    id: 'BITSEARCH_NO_KEY', name: 'BitSearch',
    href: 'https://bitsearch.to',
    note: 'Federated torrent search engine. No account.',
    fields: [],
    category: 'tracker-public',
    tags: ['general', 'no-signup'],
  },
  // ── Specialty public ──────────────────────────────────────────
  {
    id: 'YTS_NO_KEY', name: 'YTS (movies)',
    href: 'https://yts.mx',
    note: 'Small-size movie torrents (mostly x265/HEVC). Free, public, no account.',
    fields: [],
    category: 'tracker-public',
    tags: ['movies', 'no-signup'],
  },
]

export const PRIVATE_TRACKERS: IndexerDef[] = [
  // ── Asian / K-drama focused ───────────────────────────────────
  {
    id: 'AVISTAZ_USER', name: 'AvistaZ', href: 'https://avistaz.to',
    note: 'Korean / Chinese / Japanese live action. Passkey (PID) is on your AvistaZ Profile page.',
    fields: [
      { key: 'AVISTAZ_USER', label: 'Username' },
      { key: 'AVISTAZ_PASS', label: 'Password', password: true },
      { key: 'AVISTAZ_PID',  label: 'PID / Passkey' },
    ],
    category: 'tracker-private',
    tags: ['asian', 'kdrama', 'movies', 'tv', 'application'],
  },
  {
    id: 'HHD_API_KEY', name: 'HomieHelpDesk', href: 'https://homiehelpdesk.net',
    note: 'Korean movies / dramas.',
    fields: [{ key: 'HHD_API_KEY', label: 'API key' }],
    category: 'tracker-private',
    tags: ['kdrama', 'asian', 'movies', 'tv', 'free-signup'],
  },
  // ── Anime ─────────────────────────────────────────────────────
  {
    id: 'ANIMEBYTES_USER', name: 'AnimeBytes', href: 'https://animebytes.tv',
    note: 'Highest-quality anime tracker (invite-only).',
    fields: [
      { key: 'ANIMEBYTES_USER', label: 'Username' },
      { key: 'ANIMEBYTES_PASS', label: 'Password', password: true },
    ],
    category: 'tracker-private',
    tags: ['anime', 'invite-only'],
  },
  {
    id: 'ANIMETORRENTS_USER', name: 'AnimeTorrents', href: 'https://animetorrents.me',
    note: 'Anime (application-based).',
    fields: [
      { key: 'ANIMETORRENTS_USER', label: 'Username' },
      { key: 'ANIMETORRENTS_PASS', label: 'Password', password: true },
    ],
    category: 'tracker-private',
    tags: ['anime', 'application'],
  },
  // ── General private ───────────────────────────────────────────
  {
    id: 'IPTORRENTS_COOKIE', name: 'IPTorrents', href: 'https://iptorrents.com',
    note: 'General-purpose private tracker. Cookie-only auth: log in to IPT in your browser, open DevTools → Application → Cookies → iptorrents.com, copy the entire cookie string (uid=...; pass=...; etc).',
    fields: [
      { key: 'IPTORRENTS_COOKIE', label: 'Browser cookie string' },
    ],
    category: 'tracker-private',
    tags: ['general', 'paid'],
  },
  {
    id: 'TORRENTLEECH_RSSKEY', name: 'TorrentLeech', href: 'https://www.torrentleech.org',
    note: 'General-purpose private tracker. RSS key from your Profile → RSS feed page.',
    fields: [
      { key: 'TORRENTLEECH_RSSKEY', label: 'RSS feed key' },
    ],
    category: 'tracker-private',
    tags: ['general', 'paid'],
  },
  {
    id: 'HDTORRENTS_USER', name: 'HD-Torrents', href: 'https://hd-torrents.org',
    note: 'High-definition movies + TV, private tracker.',
    fields: [
      { key: 'HDTORRENTS_USER', label: 'Username' },
      { key: 'HDTORRENTS_PASS', label: 'Password', password: true },
    ],
    category: 'tracker-private',
    tags: ['movies', 'tv', 'application'],
  },
  // ── TV focused ────────────────────────────────────────────────
  {
    id: 'BTN_API_KEY', name: 'BroadcasTheNet (BTN)', href: 'https://broadcasthe.net',
    note: 'The premier TV-only private tracker. Invite-only; API key from Profile → Edit → Authentication keys.',
    fields: [{ key: 'BTN_API_KEY', label: 'API key' }],
    category: 'tracker-private',
    tags: ['tv', 'invite-only'],
  },
  {
    id: 'MTV_API_KEY', name: 'MoreThanTV (MTV)', href: 'https://www.morethantv.me',
    note: 'TV-focused private tracker. Open signups sometimes; API key from Settings → Access.',
    fields: [{ key: 'MTV_API_KEY', label: 'API key' }],
    category: 'tracker-private',
    tags: ['tv', 'invite-only'],
  },
  // ── Movie focused ─────────────────────────────────────────────
  {
    id: 'PTP_USER', name: 'PassThePopcorn (PTP)', href: 'https://passthepopcorn.me',
    note: 'The premier movies-only private tracker. Invite/interview-only; pass key is on Profile → Security.',
    fields: [
      { key: 'PTP_USER', label: 'Username' },
      { key: 'PTP_KEY', label: 'Passkey' },
    ],
    category: 'tracker-private',
    tags: ['movies', 'application'],
  },
  // ── Music focused ─────────────────────────────────────────────
  {
    id: 'RED_API_KEY', name: 'Redacted (RED)', href: 'https://redacted.sh',
    note: 'High-quality music private tracker. Invite/interview-only; API key from Profile → Access settings.',
    fields: [{ key: 'RED_API_KEY', label: 'API key' }],
    category: 'tracker-private',
    tags: ['music', 'application'],
  },
  {
    id: 'ORPHEUS_API_KEY', name: 'Orpheus Network (OPS)', href: 'https://orpheus.network',
    note: 'Music private tracker (What.CD-style). Invite-only; API key from User → Settings → Access.',
    fields: [{ key: 'ORPHEUS_API_KEY', label: 'API key' }],
    category: 'tracker-private',
    tags: ['music', 'invite-only'],
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
