import { z } from 'zod'
import { ENABLE_DISABLED_VALUES, LIVETV_PACKS } from './env-render.js'

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

export const envObject = z.object({
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
  ENABLE_FLARESOLVERR: optStr,
  // OPT-IN (default off, unlike the rest). The superRefine block below
  // gates its creds + Lidarr dependency on an explicit-true check, not
  // flagOn, so a missing key never triggers required-cred validation.
  ENABLE_SOULSEEK: optStr,
  // OPT-IN (default off), mirroring ENABLE_SOULSEEK. The superRefine block
  // below gates its creds + a source requirement + the Plex requirement on an
  // explicit-true check. A missing key stays OFF everywhere.
  ENABLE_PLAYLIST_SYNC: optStr,
  // OPT-IN (default off), mirroring ENABLE_SOULSEEK. The superRefine block
  // below escalates the Dispatcharr admin credentials to required on an
  // explicit-true check. A missing key stays OFF everywhere.
  ENABLE_DISPATCHARR: optStr,
  // ── TRaSH Guide profile picks (consumed by setup-arr-config.py to
  // generate recyclarr.yml's `include:` blocks). Defaults to the most
  // common TRaSH choices: WEB-1080p for Sonarr, HD Bluray + WEB for
  // Radarr. Validated against the small enum of profiles we ship
  // dropdowns for — accept anything else as free-form so power users
  // who hand-edit recyclarr.yml don't get blocked, but the wizard
  // itself only ever writes one of these.
  TRASH_SONARR_PROFILE: optStr,
  TRASH_RADARR_PROFILE: optStr,

  // Identity
  PUID: numericString,
  PGID: numericString,
  // IANA timezone format. Most zones are `Region/City` (America/Chicago)
  // but a handful are `Region/Subregion/City` (America/Argentina/Buenos_Aires,
  // America/Indiana/Indianapolis). The old single-slash regex rejected
  // those — and accept short forms like `UTC` / `GMT` / `Etc/GMT+5` too.
  TZ: z.string().regex(
    /^(UTC|GMT|[A-Za-z][a-zA-Z_]+(\/[A-Za-z_+\-0-9]+){1,3})$/,
    'expected an IANA timezone like America/Chicago or America/Argentina/Buenos_Aires',
  ),
  LAN_IP: ipv4,

  // Paths (NAS-family-portable). Absolute paths only — relative paths
  // would resolve against /root or wherever sudo's cwd lands and that
  // way lies madness. Cross-validated below: INSTALL_DIR and DATA_ROOT
  // must NOT be the same dir (the .env file + compose stack would
  // collide with the user's media).
  //
  // REQUIRED + non-empty (not optStr): an emptied field must FAIL
  // safeParse, not silently fall through to env-render's /volume1
  // default. On a non-Synology NAS (UGREEN/Unraid/QNAP/Linux) that
  // default points at a path which doesn't exist, and clearing
  // INSTALL_DIR also blanks the wizard's targetDir → setup.sh would
  // write a root-anchored /.env while the rendered .env still says
  // /volume1 (an internally inconsistent broken install). Failing the
  // parse blocks the Ready footer + go() before that can happen.
  INSTALL_DIR: z.string().min(1, 'required — set an absolute install path')
    .refine((v) => v.startsWith('/'), 'must be an absolute path starting with /'),
  DATA_ROOT: z.string().min(1, 'required — set an absolute data path')
    .refine((v) => v.startsWith('/'), 'must be an absolute path starting with /'),

  // Container-runtime socket override (Podman). renderEnv emits this key
  // verbatim and setup.sh exports it as DOCKER_HOST, so a relative path or
  // typo here breaks every docker/compose call on the NAS. WHY validate:
  // without a schema entry the non-strict object silently drops the key
  // from validation while renderEnv still writes whatever the user typed —
  // so add it back to restore the round-trip invariant (every emitted key
  // has a schema entry) and reject implausible values. Accept exactly what
  // setup.sh accepts: a plain absolute path (it prepends unix://) OR a
  // unix:// / tcp:// / ssh:// URI (used as-is).
  DOCKER_SOCK: optStr.refine(
    (v) => !v || v.startsWith('/') || /^(unix|tcp|ssh):\/\//.test(v),
    'must be an absolute socket path (/run/podman/podman.sock) or a unix:// / tcp:// / ssh:// URI',
  ),

  // Media server — 'plex' (default) or 'jellyfin'. Free-form-tolerant
  // (empty = plex) so older .envs without the key validate fine.
  MEDIA_SERVER: optStr.refine(
    (v) => !v || v === 'plex' || v === 'jellyfin',
    'must be "plex" or "jellyfin"',
  ),
  // Derived by renderEnv from MEDIA_SERVER; round-trips through .env.
  SEERR_IMAGE: optStr,

  // Plex
  PLEX_CLAIM: optStr.refine(
    (v) => !v || v.startsWith('claim-'),
    'Plex claim tokens start with "claim-"',
  ),

  // Jellyfin — API key pasted post-first-run. No fixed format (Jellyfin
  // keys are 32-char hex but we don't hard-enforce), just optional.
  JELLYFIN_API_KEY: optStr,

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

  // Soulseek (slskd + soularr) — optional at the schema level; the
  // superRefine block escalates SLSKD_USER/SLSKD_PASS to required and
  // checks the slskd API-key length only when ENABLE_SOULSEEK is
  // explicitly true. SLSKD_API_KEY stays OPTIONAL even then — it's an
  // internal secret setup.sh auto-generates when blank, so blank is the
  // expected, valid default (length is only validated if the user pins one).
  SLSKD_USER: optStr,
  SLSKD_PASS: optStr,
  SLSKD_API_KEY: optStr,
  SOULARR_INTERVAL: optStr.refine(
    (v) => !v || /^\d+$/.test(v),
    'must be a positive integer (seconds)',
  ),

  // Playlist Sync (SiriusXM → Plex) — all optional at the schema
  // level; the superRefine block escalates the creds + a source requirement +
  // the Plex requirement to required only when ENABLE_PLAYLIST_SYNC is
  // explicitly true. Standalone: it runs its OWN sockseek downloader (its own
  // 2nd Soulseek account), so it does NOT depend on ENABLE_SOULSEEK.
  PLAYLIST_SLSK_USER: optStr,
  PLAYLIST_SLSK_PASS: optStr,
  SIRIUSXM_CHANNELS: optStr,
  PLAYLIST_SYNC_CRON: optStr.refine(
    (v) => !v || /^\S+(\s+\S+){4}$/.test(v.trim()),
    'must be a 5-field cron expression like "0 4 * * *"',
  ),
  PLAYLIST_PREF_FORMAT: optStr,
  PLAYLIST_RUN_ON_START: optStr,
  PLAYLIST_SXM_DAYS: optStr.refine(
    (v) => !v || /^\d+$/.test(v),
    'must be a positive integer (days)',
  ),
  PLAYLIST_SXM_MIN_PLAYS: optStr.refine(
    (v) => !v || /^\d+$/.test(v),
    'must be a non-negative integer',
  ),
  PLAYLIST_MONTHLY_ARCHIVE: optStr,

  // Live TV & DVR (Dispatcharr) — all optional at the schema level; the
  // superRefine block escalates the admin creds to required only when
  // ENABLE_DISPATCHARR is explicitly true. LIVETV_CHANNEL_PACKS may be empty
  // (the user brings their own IPTV sources), but any token present must be a
  // known pack id — derived from LIVETV_PACKS (env-render.ts, the wizard's
  // checkbox list) so the two can't drift; setup-dispatcharr.py's PACKS dict
  // mirrors the same ids on the python side.
  DISPATCHARR_ADMIN_USER: optStr,
  DISPATCHARR_ADMIN_PASS: optStr,
  LIVETV_CHANNEL_PACKS: optStr.refine(
    (v) => !v || v.split(',').filter((t) => t.trim()).every((t) =>
      LIVETV_PACKS.some((p) => p.id === t.trim().toLowerCase())),
    `must be a comma list of: ${LIVETV_PACKS.map((p) => p.id).join(', ')}`,
  ),

  // SABnzbd usenet provider (all optional — host gates the rest)
  USENET_HOST: optStr,
  USENET_PORT: optStr.refine(
    (v) => !v || (/^\d+$/.test(v) && +v >= 1 && +v <= 65535),
    'must be a port number between 1 and 65535',
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
  NZBSU_API_KEY: optStr,

  // Public torrent placeholders (no creds collected; presence in the
  // schema lets the .env round-trip include them as empty values).
  NYAA_NO_KEY: optStr,
  SUBSPLEASE_NO_KEY: optStr,
  ANIDEX_NO_KEY: optStr,
  TOKYOTOSHO_NO_KEY: optStr,
  X1337_NO_KEY: optStr,
  THEPIRATEBAY_NO_KEY: optStr,
  EZTV_NO_KEY: optStr,
  THERARBG_NO_KEY: optStr,
  BITSEARCH_NO_KEY: optStr,
  YTS_NO_KEY: optStr,

  // Private trackers
  AVISTAZ_USER: optStr,
  AVISTAZ_PASS: optStr,
  AVISTAZ_PID:  optStr,
  HHD_API_KEY: optStr,
  ANIMEBYTES_USER: optStr,
  ANIMEBYTES_PASS: optStr,
  ANIMETORRENTS_USER: optStr,
  ANIMETORRENTS_PASS: optStr,
  IPTORRENTS_COOKIE: optStr,
  TORRENTLEECH_RSSKEY: optStr,
  HDTORRENTS_USER: optStr,
  HDTORRENTS_PASS: optStr,
  RUTRACKER_USER: optStr,
  RUTRACKER_PASS: optStr,
  BTN_API_KEY: optStr,
  MTV_API_KEY: optStr,
  PTP_USER: optStr,
  PTP_KEY: optStr,
  RED_API_KEY: optStr,
  ORPHEUS_API_KEY: optStr,

  // Custom user-defined indexers — JSON-string blob managed by an
  // in-app editor on the Configure screen. setup-indexers.py parses
  // this at install time and registers each entry against Prowlarr.
  // Optional fields (note, tags) tolerated as missing; only `name`
  // + `url` + `apiKey` are required by the runtime validator.
  CUSTOM_INDEXERS_JSON: optStr,

  // Bazarr providers
  OPENSUBTITLES_USER: optStr,
  OPENSUBTITLES_PASS: optStr,
  OPENSUBTITLESCOM_USER: optStr,
  OPENSUBTITLESCOM_PASS: optStr,
  ADDIC7ED_USER: optStr,
  ADDIC7ED_PASS: optStr,
})

// envObject is the per-field schema; envSchema layers the cross-field rules
// on top. Both are exported — envObject.shape gives tests the canonical env
// key set via zod's public API (the .superRefine() wrapper hides .shape).
export const envSchema = envObject.superRefine((v, ctx) => {
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

  // Soulseek — OPT-IN, so gate on an explicit true (NOT flagOn, which
  // treats a missing key as enabled). Only true/1/yes/on opts in,
  // matching is_optin_enabled in setup.sh / setup-arr-config.py and
  // isOptInEnabled in env-render.ts. When on: Soulseek creds are
  // required, the slskd API key (if supplied) must be 16–255 chars
  // (upstream constraint), and Lidarr must also be enabled (soularr
  // reads Lidarr's wanted list — useless without it).
  const slskOn = ['true', '1', 'yes', 'on']
    .includes((v.ENABLE_SOULSEEK ?? '').trim().toLowerCase())
  if (slskOn) {
    if (!v.SLSKD_USER || v.SLSKD_USER.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['SLSKD_USER'],
        message: 'Soulseek username required when Soulseek is enabled' })
    }
    if (!v.SLSKD_PASS || v.SLSKD_PASS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['SLSKD_PASS'],
        message: 'Soulseek password required when Soulseek is enabled' })
    }
    if (v.SLSKD_API_KEY && (v.SLSKD_API_KEY.length < 16 || v.SLSKD_API_KEY.length > 255)) {
      ctx.addIssue({ code: 'custom', path: ['SLSKD_API_KEY'],
        message: 'slskd API key must be 16–255 characters' })
    }
    if (!flagOn(v.ENABLE_LIDARR)) {
      ctx.addIssue({ code: 'custom', path: ['ENABLE_SOULSEEK'],
        message: 'Soulseek feeds Lidarr — enable Lidarr too' })
    }
  }

  // Playlist Sync — OPT-IN, gate on explicit true (mirrors is_optin_enabled,
  // NOT flagOn). When on: a 2nd free Soulseek account is required, at least one
  // SiriusXM channel must be configured, and a media server (Plex or Jellyfin)
  // must be enabled (the playlist upload targets it).
  const playlistOn = ['true', '1', 'yes', 'on']
    .includes((v.ENABLE_PLAYLIST_SYNC ?? '').trim().toLowerCase())
  if (playlistOn) {
    if (!v.PLAYLIST_SLSK_USER || v.PLAYLIST_SLSK_USER.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['PLAYLIST_SLSK_USER'],
        message: 'A second Soulseek account (username) is required when Playlist Sync is enabled' })
    } else if (
      !!v.SLSKD_USER
      && v.PLAYLIST_SLSK_USER.trim().toLowerCase() === v.SLSKD_USER.trim().toLowerCase()
    ) {
      // Soulseek allows ONE login session per account, so Playlist Sync MUST use a
      // different account than the main slskd one. Reusing it makes both fight over
      // the single session, and a mismatched password is silently rejected as
      // INVALIDPASS — the "no playlists ever download" failure. Any brand-new
      // username auto-registers on first connect, so a fresh name needs no setup.
      ctx.addIssue({ code: 'custom', path: ['PLAYLIST_SLSK_USER'],
        message: 'Use a DIFFERENT Soulseek account than your main one (above) — Soulseek allows one login session per account, so reusing it makes both fail to connect. Pick any new username; it auto-registers on first use.' })
    }
    if (!v.PLAYLIST_SLSK_PASS || v.PLAYLIST_SLSK_PASS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['PLAYLIST_SLSK_PASS'],
        message: 'Soulseek password required when Playlist Sync is enabled' })
    }
    const hasSource = !!v.SIRIUSXM_CHANNELS && v.SIRIUSXM_CHANNELS.trim().length > 0
    if (!hasSource) {
      ctx.addIssue({ code: 'custom', path: ['SIRIUSXM_CHANNELS'],
        message: 'Add at least one SiriusXM channel to sync' })
    }
    // Needs a media server to upload playlists to. Works with EITHER: Plex
    // (auto-claimed token) or Jellyfin (an API key you create in the dashboard
    // post-deploy — jellyfin-upload.py skips cleanly until it's set, so we do
    // NOT require it at wizard time). Error only if NEITHER is configured.
    if (v.MEDIA_SERVER !== 'jellyfin' && !flagOn(v.ENABLE_PLEX)) {
      ctx.addIssue({ code: 'custom', path: ['ENABLE_PLAYLIST_SYNC'],
        message: 'Playlist Sync needs a media server — enable Plex, or choose Jellyfin as your media server' })
    }
  }

  // Live TV & DVR (Dispatcharr) — OPT-IN, gate on explicit true (mirrors
  // is_optin_enabled, NOT flagOn). When on: the admin login is required —
  // setup-dispatcharr.py creates that account on Dispatcharr's first boot and
  // authenticates with it to pre-seed channel packs, so a blank credential
  // means the whole feature deploys unconfigured. No media-server requirement:
  // Dispatcharr's own web UI plays live TV and its own DVR records, with or
  // without Plex/Jellyfin (Plex live tuning additionally needs Plex Pass).
  const dispatcharrOn = ['true', '1', 'yes', 'on']
    .includes((v.ENABLE_DISPATCHARR ?? '').trim().toLowerCase())
  if (dispatcharrOn) {
    if (!v.DISPATCHARR_ADMIN_USER || v.DISPATCHARR_ADMIN_USER.trim().length === 0) {
      ctx.addIssue({ code: 'custom', path: ['DISPATCHARR_ADMIN_USER'],
        message: 'Admin username required when Live TV is enabled (the installer creates this Dispatcharr login)' })
    }
    if (!v.DISPATCHARR_ADMIN_PASS || v.DISPATCHARR_ADMIN_PASS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['DISPATCHARR_ADMIN_PASS'],
        message: 'Admin password required when Live TV is enabled' })
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

  // The VPN provider-id is validated whenever VPN_ENABLED is on — a
  // hand-edited/migrated .env with a bogus VPN_PROVIDER must be caught even
  // for a Soulseek/Playlist-Sync-only VPN (setup.sh starts gluetun for those
  // too, not just qBittorrent). The provider-specific CREDENTIAL/country
  // checks further down stay gated on qBittorrent (historically the only
  // required-cred path) so this doesn't change validation for existing configs.
  const vpnOn = (v.VPN_ENABLED ?? 'false').toLowerCase() === 'true'
  if (!vpnOn) return
  if (!v.VPN_PROVIDER) {
    ctx.addIssue({ code: 'custom', path: ['VPN_PROVIDER'],
      message: 'Pick a VPN provider (or turn VPN off).' })
    return
  }
  // Reject a NON-empty provider that isn't in the registry. Without this, a
  // hand-edited / migrated .env with e.g. VPN_PROVIDER=pia was silently
  // rendered as a NordVPN .env (findVpnProvider's old default), dropping the
  // user's intended provider with no warning. Mirror the VpnProviderId set
  // from vpn-providers.ts here (this shared file deliberately doesn't import
  // that module — see the cred-checks note below). 'custom' is the escape
  // hatch for any gluetun provider we don't model.
  const KNOWN_VPN_PROVIDERS = ['nordvpn', 'protonvpn', 'mullvad', 'airvpn', 'surfshark', 'custom']
  if (!KNOWN_VPN_PROVIDERS.includes(v.VPN_PROVIDER)) {
    ctx.addIssue({ code: 'custom', path: ['VPN_PROVIDER'],
      message: 'Unknown VPN provider — pick a supported one or use Custom.' })
    return
  }
  // Credential/country requirements only apply when qBittorrent is in the
  // stack (the historical required-cred path); a provider-only VPN for
  // Soulseek/Playlist-Sync still gets the provider-id sanity check above.
  if (!qbitOn) return
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
