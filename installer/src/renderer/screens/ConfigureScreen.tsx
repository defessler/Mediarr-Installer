import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import {
  Settings2, ArrowLeft, ArrowRight,
  Boxes, Award, Shield, HardDrive, UserCircle, KeyRound, Lock, Wrench,
  Newspaper, Users, Captions,
  PlaySquare, Tv, Film, Music, Music2, Download, Package, LayoutDashboard,
  Clock, CheckCircle2, XCircle, AlertTriangle, Info, ChevronDown,
  type LucideIcon,
} from 'lucide-react'
import { BigButton } from '../components/BigButton.js'
import { PasswordInput } from '../components/PasswordInput.js'
import { useWizard } from '../store/wizard.js'
import { RelocationWarning } from './EnvDetectScreen.js'
import { envSchema } from '../../shared/env-schema.js'
import {
  type EnvFormValues,
  USENET_INDEXERS,
  PUBLIC_TRACKERS,
  PRIVATE_TRACKERS,
  BAZARR_PROVIDERS,
  LIVETV_PACKS,
  isEnabled,
  isOptInEnabled,
} from '../../shared/env-render.js'
import {
  VPN_PROVIDERS,
  findVpnProvider,
  type VpnField,
  type VpnProvider,
} from '../../shared/vpn-providers.js'
import type { Country } from '../../shared/ipc.js'
import { IndexerCard } from '../components/IndexerCard.js'
import { IndexerBrowser } from '../components/IndexerBrowser.js'
import { CustomIndexerEditor } from '../components/CustomIndexerEditor.js'
import { TimezoneSelect } from '../components/TimezoneSelect.js'
import { SiriusxmSelect } from '../components/SiriusxmSelect.js'
import { reportError } from '../store/errors.js'

/** Centered hero header for the Configure screen. Defined at module
 *  scope so it doesn't re-mount per keystroke (same lesson the comment
 *  below records about co-located components). */
function ConfigureHeader() {
  const reduced = useReducedMotion()
  return (
    <motion.header
      initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="text-center"
    >
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-emerald-700/30 border border-emerald-500/30 mb-4">
        <Settings2 size={36} className="text-emerald-300" strokeWidth={1.5} aria-hidden="true" />
      </div>
      <h1 className="text-3xl font-bold tracking-tight">Make it yours</h1>
      <p className="text-slate-400 mt-2 text-base max-w-lg mx-auto">
        We pre-filled what we could from the scan. Review the values below
        — change anything that doesn't look right, then hit Continue.
      </p>
    </motion.header>
  )
}

// React component identity matters: a component defined inside a parent
// function render gets a new reference every render, which React treats
// as a different *type* — so the DOM tree is unmounted and remounted on
// every keystroke. That's why the username field used to lose focus.
//
// Hoisting Field to module level fixes that. We pass `config` and the
// `update` setter through a Context so existing call sites can stay as
// `<Field label="..." k="..." />` without prop-drilling.
type ConfigCtxValue = {
  config: Partial<EnvFormValues>
  update: <K extends keyof EnvFormValues>(key: K, value: EnvFormValues[K] | undefined) => void
}
const ConfigCtx = createContext<ConfigCtxValue | null>(null)

function Field({ label, k, type = 'text', placeholder }: {
  label: string
  k: keyof EnvFormValues
  type?: string
  placeholder?: string
}) {
  const ctx = useContext(ConfigCtx)
  if (!ctx) return null
  const { config, update } = ctx
  // Stable ID per field key so the label can htmlFor-link, and
  // screen readers say the right thing on focus. The ENV-style
  // keys (PUID, ARR_USERNAME, etc.) are already stable identifiers.
  const inputId = `cfg-${k}`
  // Password fields get the show/hide eye toggle via PasswordInput —
  // typing a credential into a field of black dots is exactly the kind
  // of "did I get that right?" friction we want to remove from the
  // Configure step, especially for kids working through this with a
  // parent looking over their shoulder.
  if (type === 'password') {
    return (
      <div>
        <label className="block text-sm font-medium mb-1" htmlFor={inputId}>{label}</label>
        <PasswordInput
          id={inputId}
          placeholder={placeholder}
          className="py-2"
          value={(config[k] as string | undefined) ?? ''}
          onChange={(e) => update(k, e.target.value || undefined)}
        />
      </div>
    )
  }
  return (
    <div>
      <label className="block text-sm font-medium mb-1" htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type={type} placeholder={placeholder}
        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
        value={(config[k] as string | undefined) ?? ''}
        onChange={(e) => update(k, e.target.value || undefined)}
      />
    </div>
  )
}

// ── Services section ────────────────────────────────────────────────────────
//
// User-facing service checklist. Each toggle writes ENABLE_<NAME> into
// .env; setup.sh reads them to build COMPOSE_PROFILES so `docker compose
// up -d` only starts what's selected. Default-on for back-compat with
// pre-existing profiles. See env-render.ts for the canonical list.
//
// Grouping rules:
//   - Plex stack (plex + tautulli + seerr) toggles together — Tautulli +
//     Seerr have hard runtime deps on Plex, so independent toggles would
//     just produce broken containers.
//   - qBittorrent automatically pulls in gluetun when VPN_ENABLED=true
//     (the existing VPN gate, unchanged).
//   - Prowlarr + Flaresolverr stay always-on — they're cheap and every
//     arr needs Prowlarr for indexers.
//
// Dependencies the UI calls out but doesn't enforce (the user knows
// their setup; we don't auto-uncheck for them):
//   - Bazarr needs Sonarr or Radarr to be useful (subtitles for what?)
//   - Recyclarr / Unpackerr need Sonarr or Radarr
//   - Seerr needs Plex + arrs to request anything

interface ServiceToggle {
  key: keyof EnvFormValues
  label: string
  hint?: string
  /** Per-service Lucide icon. Children + scanning users pick a service by
   *  glyph (📺 Sonarr, 🎬 Radarr, 🎵 Lidarr) much faster than by reading
   *  ten near-identical bullet lines. */
  icon: LucideIcon
  /** Tailwind colour class for the icon — matches the service's visual
   *  vocabulary across the rest of the wizard (Plex = amber, Sonarr =
   *  sky, etc.) so the eye learns "this row is Sonarr-ish" once and
   *  applies it everywhere. */
  iconColor: string
  /** "needs" hint — shown when the toggle is on but its dependencies are off. */
  needs?: (keyof EnvFormValues)[]
  /** Standing caveat rendered as an amber note under the hint regardless of
   *  toggle state — for a service whose cost the user should weigh BEFORE
   *  enabling. Unlike `needs`, it isn't gated on the toggle already being on. */
  warn?: string
}

const SERVICE_TOGGLES: ServiceToggle[] = [
  { key: 'ENABLE_PLEX',        label: 'Media server', hint: 'Plex or Jellyfin + Seerr (request system)',     icon: PlaySquare,      iconColor: 'text-amber-400' },
  { key: 'ENABLE_SONARR',      label: 'Sonarr',       hint: 'TV automation',                                 icon: Tv,              iconColor: 'text-sky-400' },
  { key: 'ENABLE_RADARR',      label: 'Radarr',       hint: 'Movie automation',                              icon: Film,            iconColor: 'text-yellow-400' },
  { key: 'ENABLE_LIDARR',      label: 'Lidarr',       hint: 'Music automation',                              icon: Music,           iconColor: 'text-fuchsia-400' },
  { key: 'ENABLE_SOULSEEK',    label: 'Soulseek',     hint: 'slskd (via VPN) + soularr → Lidarr',            icon: Music2,          iconColor: 'text-pink-400',    needs: ['ENABLE_LIDARR'] },
  { key: 'ENABLE_PLAYLIST_SYNC', label: 'Playlist Sync', hint: 'SiriusXM playlists → Plex or Jellyfin (auto-download)', icon: Music2, iconColor: 'text-green-400' },
  { key: 'ENABLE_DISPATCHARR', label: 'Live TV & DVR', hint: 'Dispatcharr — free live channels + a DVR tuner for Plex/Jellyfin', icon: Tv, iconColor: 'text-cyan-400' },
  { key: 'ENABLE_BAZARR',      label: 'Bazarr',       hint: 'Subtitle automation',                           icon: Captions,        iconColor: 'text-violet-400',  needs: ['ENABLE_SONARR', 'ENABLE_RADARR'] },
  { key: 'ENABLE_QBITTORRENT', label: 'qBittorrent',  hint: 'Torrents (+ Gluetun VPN when VPN_ENABLED)',     icon: Download,        iconColor: 'text-blue-400' },
  { key: 'ENABLE_SABNZBD',     label: 'SABnzbd',      hint: 'Usenet downloader',                             icon: Newspaper,       iconColor: 'text-orange-400' },
  { key: 'ENABLE_RECYCLARR',   label: 'Recyclarr',    hint: 'Quality-profile sync for *arr',                 icon: Award,           iconColor: 'text-emerald-400', needs: ['ENABLE_SONARR', 'ENABLE_RADARR'] },
  { key: 'ENABLE_UNPACKERR',   label: 'Unpackerr',    hint: 'Auto-extract download archives',                icon: Package,         iconColor: 'text-rose-400',    needs: ['ENABLE_SONARR', 'ENABLE_RADARR'] },
  { key: 'ENABLE_HOMEPAGE',    label: 'Homepage',     hint: 'Dashboard linking all the above',               icon: LayoutDashboard, iconColor: 'text-teal-400' },
  { key: 'ENABLE_FLARESOLVERR', label: 'FlareSolverr', hint: 'CloudFlare bypass for indexers (auto-off on ARM)', icon: Shield,         iconColor: 'text-amber-300' },
]

// The OPT-IN services: unlike the default-on bundle, a missing/empty
// ENABLE_<NAME> means OFF (isOptInEnabled, not isEnabled). Loading an
// older .env without these keys must leave them UNCHECKED. Kept as one
// shared set so the toggle grid and the group badge can't drift apart.
const OPT_IN_SERVICES = new Set<keyof EnvFormValues>(['ENABLE_SOULSEEK', 'ENABLE_PLAYLIST_SYNC', 'ENABLE_DISPATCHARR'])

function ServicesSection({
  config, update,
}: {
  config: Partial<EnvFormValues>
  update: <K extends keyof EnvFormValues>(k: K, v: EnvFormValues[K] | undefined) => void
}) {
  // Imported from env-render so the renderer, setup.sh, and setup-arr-
  // config.py all agree on what counts as disabled (0/no/off/false).
  // ENABLE_SOULSEEK / ENABLE_PLAYLIST_SYNC / ENABLE_DISPATCHARR are the
  // OPT-IN services: a missing/empty value means OFF, so they use
  // isOptInEnabled instead of the default-on isEnabled. Without this, an
  // older profile loaded without the key would show their toggle ON.
  const isOn = (k: keyof EnvFormValues) =>
    OPT_IN_SERVICES.has(k)
      ? isOptInEnabled(config[k] as string | undefined)
      : isEnabled(config[k] as string | undefined)
  const enabledCount = SERVICE_TOGGLES.filter((t) => isOn(t.key)).length

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold border-b-2 border-slate-800 pb-2 flex items-center gap-2">
        <Boxes size={20} className="text-emerald-400" strokeWidth={1.75} aria-hidden="true" />
        Services
        <span className="text-xs font-normal text-slate-500">
          ({enabledCount} of {SERVICE_TOGGLES.length} enabled — Prowlarr + Flaresolverr always on)
        </span>
      </h2>
      <p className="text-xs text-slate-400">
        Uncheck what you don&apos;t want. setup.sh maps these to{' '}
        <code className="font-mono">COMPOSE_PROFILES</code> so docker only
        starts (and the install only configures) what&apos;s selected. Defaults
        match the historical bundle; you can come back and re-run the wizard
        to enable a service later.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {SERVICE_TOGGLES.map((t) => {
          const on = isOn(t.key)
          // "needs" check: surface a yellow hint when the user has this
          // on but none of its declared dependencies is on. We don't
          // disable the toggle — maybe they want Bazarr against an
          // externally-managed Sonarr; the hint is enough.
          const unmetDep =
            on && t.needs && !t.needs.some((dep) => isOn(dep))
          const Icon = t.icon
          return (
            <label
              key={t.key}
              className={
                'flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ' +
                (on
                  ? 'border-emerald-700/50 bg-emerald-900/10 hover:border-emerald-600/70'
                  : 'border-slate-700 bg-slate-900/40 opacity-70 hover:opacity-100')
              }
            >
              <input
                type="checkbox"
                className="mt-0.5 shrink-0"
                checked={on}
                onChange={(e) => update(t.key, e.target.checked ? 'true' : 'false')}
              />
              {/* Per-service icon tile — gives every row a unique visual
                  anchor at a glance. Tinted square preserves the service's
                  colour vocabulary even when the toggle is off (dimmed
                  via the parent's opacity). */}
              <div
                className={
                  'shrink-0 w-9 h-9 rounded-md flex items-center justify-center ' +
                  (on
                    ? 'bg-slate-800/70 border border-slate-700/60'
                    : 'bg-slate-800/30 border border-slate-700/30')
                }
              >
                <Icon size={20} className={t.iconColor} strokeWidth={1.75} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{t.label}</div>
                {t.hint && (
                  <div className="text-xs text-slate-400 mt-0.5">{t.hint}</div>
                )}
                {unmetDep && (
                  <div className="text-xs text-amber-300/90 mt-1">
                    Heads up — typically used with{' '}
                    {t.needs!
                      .map((d) => SERVICE_TOGGLES.find((x) => x.key === d)?.label ?? d)
                      .join(' or ')}
                    , both of which are off right now.
                  </div>
                )}
                {t.warn && (
                  <div className="text-xs text-amber-300/90 mt-1 flex items-start gap-1">
                    <AlertTriangle size={12} className="shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
                    <span>{t.warn}</span>
                  </div>
                )}
              </div>
            </label>
          )
        })}
      </div>
    </section>
  )
}

// ── TRaSH Guide profile section ─────────────────────────────────────────────
//
// Recyclarr syncs TRaSH Guide quality profiles + custom-format bundles
// into Sonarr / Radarr. The wizard auto-runs `recyclarr sync` after
// install; this section lets the user pick WHICH profile bundle to
// apply. setup-arr-config.py reads TRASH_SONARR_PROFILE +
// TRASH_RADARR_PROFILE from .env and renders the matching
// `include:` block in recyclarr.yml.
//
// Surfaced ONLY when ENABLE_RECYCLARR is on (and its parent arr is on).
// Hidden otherwise so the screen doesn't get cluttered with options the
// user has opted out of. Mirrors how the VPN section only renders when
// VPN_ENABLED + ENABLE_QBITTORRENT are both on.

// Profile catalogue — keys match setup-arr-config.py's SONARR_PROFILE_
// RECIPES / RADARR_PROFILE_RECIPES dicts. If you add a new TRaSH profile
// here, ALSO add the matching entry on the Python side or the install
// will fall back to the default. Keep the labels human-readable —
// these go straight into the dropdown.
const SONARR_TRASH_PROFILES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'web-1080p',    label: 'WEB-1080p',    hint: 'Most users — 1080p web releases (default)' },
  { value: 'web-2160p',    label: 'WEB-2160p',    hint: '4K web releases (HDR / DV scored)' },
  { value: 'bluray-1080p', label: 'Bluray → WEB-1080p', hint: 'Sonarr has no separate Bluray recipe — uses WEB-1080p, which already scores Bluray sources highest' },
  { value: 'bluray-2160p', label: 'Bluray → WEB-2160p', hint: 'Sonarr folds Bluray into WEB — uses the WEB-2160p profile' },
  { value: 'anime',        label: 'Anime',        hint: 'Anime-specific scoring (sub groups, encoders)' },
]
const RADARR_TRASH_PROFILES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'hd-bluray-web',    label: 'HD Bluray + WEB',     hint: '1080p Bluray + web (default — most users)' },
  { value: 'uhd-bluray-web',   label: 'UHD Bluray + WEB',    hint: '4K Bluray + web (HDR / DV scored)' },
  { value: 'remux-web-2160p',  label: 'Remux + WEB 2160p',   hint: 'Top-tier 4K REMUX (largest files)' },
  { value: 'anime',            label: 'Anime',               hint: 'Anime-specific scoring' },
]

function TrashProfilesSection({
  config, update,
}: {
  config: Partial<EnvFormValues>
  update: <K extends keyof EnvFormValues>(k: K, v: EnvFormValues[K] | undefined) => void
}) {
  const recyclarrOn = isEnabled(config.ENABLE_RECYCLARR)
  const sonarrOn    = isEnabled(config.ENABLE_SONARR)
  const radarrOn    = isEnabled(config.ENABLE_RADARR)
  // Hide entire section when Recyclarr isn't selected — no point showing
  // profile pickers that won't be used. Also hide when BOTH Sonarr and
  // Radarr are off (Recyclarr has nothing to sync into).
  if (!recyclarrOn || (!sonarrOn && !radarrOn)) return null

  const sonarrValue = config.TRASH_SONARR_PROFILE || 'web-1080p'
  const radarrValue = config.TRASH_RADARR_PROFILE || 'hd-bluray-web'

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold border-b-2 border-slate-800 pb-2 flex items-center gap-2">
        <Award size={20} className="text-amber-400" strokeWidth={1.75} aria-hidden="true" />
        TRaSH Guide profiles
        <span className="text-xs font-normal text-slate-500">
          (which quality bundle Recyclarr applies)
        </span>
      </h2>
      <p className="text-xs text-slate-400">
        After install, Recyclarr will push the selected TRaSH Guide quality
        profile + custom-format scoring rules into Sonarr / Radarr. Pick the
        bundle that matches your library size + bandwidth. Power users can
        hand-edit{' '}
        <code className="font-mono">recyclarr.yml</code>{' '}
        afterwards — the wizard preserves edits unless your picks change.
        Re-run weekly to pick up guide updates via{' '}
        <code className="font-mono">recyclarr-sync.sh</code>.
      </p>
      <div className="grid grid-cols-2 gap-4">
        {sonarrOn && (
          <div>
            <label className="block text-sm font-medium mb-1 inline-flex items-center gap-1.5" htmlFor="trash-sonarr-profile">
              <Tv size={15} className="text-sky-400" strokeWidth={1.75} aria-hidden="true" />
              Sonarr profile
            </label>
            <select
              id="trash-sonarr-profile"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
              value={sonarrValue}
              onChange={(e) => update('TRASH_SONARR_PROFILE', e.target.value)}
            >
              {SONARR_TRASH_PROFILES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            {/* Hint text crossfades when the selection changes — gives a
                clear visual signal that the description tracks the
                dropdown without yanking the user's eye. */}
            <AnimatePresence mode="wait">
              <motion.div
                key={sonarrValue}
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.15 }}
                className="text-xs text-slate-400 mt-1"
              >
                {SONARR_TRASH_PROFILES.find((p) => p.value === sonarrValue)?.hint}
              </motion.div>
            </AnimatePresence>
          </div>
        )}
        {radarrOn && (
          <div>
            <label className="block text-sm font-medium mb-1 inline-flex items-center gap-1.5" htmlFor="trash-radarr-profile">
              <Film size={15} className="text-yellow-400" strokeWidth={1.75} aria-hidden="true" />
              Radarr profile
            </label>
            <select
              id="trash-radarr-profile"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
              value={radarrValue}
              onChange={(e) => update('TRASH_RADARR_PROFILE', e.target.value)}
            >
              {RADARR_TRASH_PROFILES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <AnimatePresence mode="wait">
              <motion.div
                key={radarrValue}
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.15 }}
                className="text-xs text-slate-400 mt-1"
              >
                {RADARR_TRASH_PROFILES.find((p) => p.value === radarrValue)?.hint}
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </div>
      {/* Lidarr note — Recyclarr doesn't support Lidarr (no Custom
          Format ecosystem for music arrs). Surfacing the note inline so
          users with ENABLE_LIDARR=true don't wonder why there's no
          Lidarr dropdown here. */}
      {isEnabled(config.ENABLE_LIDARR) && (
        <p className="text-xs text-slate-500 italic inline-flex items-start gap-1.5">
          <Music size={13} className="text-fuchsia-400 shrink-0 mt-0.5" strokeWidth={1.75} aria-hidden="true" />
          <span>
            Lidarr isn&apos;t supported by Recyclarr — for music quality definitions
            see{' '}
            <a
              className="text-emerald-400 underline hover:text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded inline-flex items-center gap-1"
              href="https://trash-guides.info/Lidarr/lidarr-setup-quality-profiles/"
              target="_blank" rel="noreferrer"
            >
              TRaSH&apos;s Lidarr page
            </a>
            {' '}and set the size limits by hand in Lidarr&apos;s Settings → Profiles.
          </span>
        </p>
      )}
    </section>
  )
}

// ── VPN section ─────────────────────────────────────────────────────────────
//
// Provider-aware UI driven by the shared `VPN_PROVIDERS` registry. The
// user picks a provider, the form renders its declared fields, the
// "Fetch key" button shows only when the provider has an upstream API
// (NordVPN today). Switching provider blanks out the previously-set
// secrets so we don't carry a Mullvad key into a Surfshark profile.
//
// All field state lives in the same EnvFormValues / config bag the
// rest of the screen uses — env-render.ts emits the right .env block
// based on `VPN_PROVIDER` and the provider's `toGluetunEnv()`.

function VpnFieldInput({ field, value, onChange }: {
  field: VpnField
  value: string
  onChange: (v: string) => void
}) {
  if (field.type === 'textarea') {
    return (
      <textarea
        rows={5}
        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <input
      type={field.type === 'password' ? 'password' : 'text'}
      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
      value={value}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function VpnSection({
  config, update, vpnToken, setVpnToken, vpnBusy, vpnError, fetchVpnKey, countries,
}: {
  config: Partial<EnvFormValues>
  update: <K extends keyof EnvFormValues>(k: K, v: EnvFormValues[K] | undefined) => void
  vpnToken: string
  setVpnToken: (v: string) => void
  vpnBusy: boolean
  vpnError: string | null
  fetchVpnKey: () => void
  countries: Country[]
}) {
  const enabled = (config.VPN_ENABLED ?? 'false').toLowerCase() === 'true'
  const currentId = config.VPN_PROVIDER || 'nordvpn'
  const provider = findVpnProvider(currentId)

  function switchProvider(newId: VpnProvider['id']) {
    if (newId === currentId) return
    const newProv = findVpnProvider(newId)
    // Clear provider-specific credential fields when switching so a stale
    // Mullvad WireGuard tunnel-address doesn't carry into a NordVPN profile.
    // VPN_COUNTRIES + VPN_ENABLED stay — they're provider-agnostic.
    //
    // WIREGUARD_PRIVATE_KEY is intentionally NOT cleared when the new provider
    // is also WireGuard-based: all four WireGuard providers (NordVPN,
    // ProtonVPN, Mullvad, AirVPN) use the same key format, the key is
    // generated locally and registered with each provider independently,
    // so it's fully portable. Clearing it just forces the user to re-paste
    // or re-fetch a key they already have when they click between providers.
    const blanks: Partial<EnvFormValues> = {
      VPN_PROVIDER: newId,
      VPN_TYPE: newProv.vpnType,
      // Tunnel address is provider-assigned (a /32 from their IP pool) and
      // is different for every provider — always clear it.
      WIREGUARD_ADDRESSES: undefined,
      WIREGUARD_PRESHARED_KEY: undefined,
      OPENVPN_USER: undefined,
      OPENVPN_PASSWORD: undefined,
      NORDVPN_ACCESS_TOKEN: undefined,
      NORDVPN_PRIVATE_KEY: undefined,
      CUSTOM_VPN_ENV: undefined,
    }
    // Only wipe the WireGuard private key when switching TO a non-WireGuard
    // provider. The key is irrelevant for OpenVPN/custom setups.
    if (newProv.vpnType !== 'wireguard') {
      blanks.WIREGUARD_PRIVATE_KEY = undefined
    }
    // Use setConfig so all fields update in one batch.
    for (const [k, v] of Object.entries(blanks)) {
      update(k as keyof EnvFormValues, v as EnvFormValues[keyof EnvFormValues] | undefined)
    }
  }

  // When a provider exposes a fetchKey API (NordVPN today), its access
  // token field is already rendered in the "Fetch key" widget at the
  // top of the dynamic-fields block. We hide it from the regular field
  // list so the user doesn't see two copies of "NordVPN access token".
  const dedupedFields = provider.fields.filter(
    (f) => provider.fetchKeyEnvVar === undefined || f.envKey !== provider.fetchKeyEnvVar,
  )

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold border-b-2 border-slate-800 pb-2 flex items-center gap-2">
        <Shield size={20} className="text-sky-400" strokeWidth={1.75} aria-hidden="true" />
        VPN
      </h2>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => update('VPN_ENABLED', e.target.checked ? 'true' : 'false')}
        />
        Route torrent traffic through a VPN (off by default; check to enable)
      </label>

      {!enabled ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
          className="rounded-md border border-amber-700/40 bg-amber-900/10 p-3 text-sm text-slate-300 flex items-start gap-3"
        >
          <div className="shrink-0 w-8 h-8 rounded-md bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mt-0.5">
            <AlertTriangle size={16} className="text-amber-300" strokeWidth={2} aria-hidden="true" />
          </div>
          <div>
            <div className="font-medium text-amber-100">VPN off (default)</div>
            <div className="text-xs text-slate-400 mt-1">
              qBittorrent runs on the regular network and your real public IP is
              visible to torrent peers. Check the box above to add Gluetun and
              route through your provider.
            </div>
          </div>
        </motion.div>
      ) : (
        <>
          {/* Provider picker — radio-card grid */}
          <div className="space-y-1">
            <label className="block text-sm font-medium">VPN provider</label>
            <div className="grid grid-cols-2 gap-2">
              {VPN_PROVIDERS.map((p) => {
                const picked = p.id === currentId
                return (
                  <motion.button
                    type="button"
                    key={p.id}
                    onClick={() => switchProvider(p.id)}
                    whileHover={{ y: -1 }}
                    whileTap={{ scale: 0.98 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    className={
                      'text-left rounded-md border p-2 text-sm transition-colors focus:outline-none ' +
                      'focus-visible:ring-2 focus-visible:ring-emerald-400/50 ' +
                      (picked
                        ? 'border-emerald-600/70 bg-emerald-900/20 text-emerald-100 shadow-md shadow-emerald-900/30'
                        : 'border-slate-700 bg-slate-800/40 hover:bg-slate-800 text-slate-200')
                    }
                  >
                    <div className="font-medium flex items-center gap-1.5">
                      {picked && <CheckCircle2 size={14} className="text-emerald-400" aria-hidden="true" />}
                      {p.label}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">{p.blurb}</div>
                  </motion.button>
                )
              })}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              <a
                href={provider.helpUrl}
                target="_blank" rel="noreferrer"
                className="text-emerald-400 hover:underline"
              >
                Where do I find these credentials? →
              </a>
            </p>
          </div>

          {/* Optional "Fetch key" button — only for providers with an API */}
          {provider.fetchKeyEnvVar && (
            <div className="rounded-md border border-slate-700/50 bg-slate-900/30 p-3 space-y-2">
              <label className="block text-sm font-medium">
                {provider.label} access token
                <span className="text-slate-500 text-xs ml-2">
                  (we'll fetch your WireGuard key from {provider.label}'s API)
                </span>
              </label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <PasswordInput
                    placeholder="Paste your provider access token"
                    className="py-2"
                    value={vpnToken}
                    onChange={(e) => setVpnToken(e.target.value)}
                  />
                </div>
                <BigButton
                  size="md"
                  variant={vpnToken.length >= 16 && !vpnBusy ? 'primary' : 'secondary'}
                  icon={!vpnBusy ? <KeyRound size={16} /> : undefined}
                  onClick={fetchVpnKey}
                  disabled={vpnBusy || vpnToken.length < 16}
                  loading={vpnBusy}
                  title="Fetch and cache the WireGuard private key"
                >
                  {vpnBusy ? 'Fetching…' : 'Fetch key'}
                </BigButton>
              </div>
              {vpnError && (
                <div className="text-rose-300 text-sm inline-flex items-center gap-1.5">
                  <XCircle size={16} aria-hidden="true" />
                  {vpnError}
                </div>
              )}
              {config.WIREGUARD_PRIVATE_KEY && !vpnError && (
                <div className="text-emerald-300 text-sm inline-flex items-center gap-1.5">
                  <CheckCircle2 size={16} aria-hidden="true" />
                  Got it — {config.WIREGUARD_PRIVATE_KEY.length}-char WireGuard key cached.
                </div>
              )}
            </div>
          )}

          {/* Dynamic per-provider fields — the access-token field is
              skipped (rendered above by the Fetch widget) so there's
              only ever one input per env-var. */}
          {dedupedFields.map((f) => {
            const value = (config[f.envKey] as string | undefined) ?? ''
            return (
              <div key={f.envKey}>
                <label className="block text-sm font-medium mb-1">{f.label}</label>
                <VpnFieldInput
                  field={f}
                  value={value}
                  onChange={(v) => update(f.envKey, (v || undefined) as EnvFormValues[typeof f.envKey])}
                />
                {f.helpHint && (
                  <p className="text-xs text-slate-500 mt-1">{f.helpHint}</p>
                )}
              </div>
            )
          })}

          {/* Country picker hint — only when the provider's API gave us
              the canonical list (NordVPN today). */}
          {countries.length > 0 && (
            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer">
                Known servers from {provider.label} ({countries.length} countries)
              </summary>
              <div className="mt-2 max-h-32 overflow-y-auto font-mono">
                {countries.map((c) => c.name).join(', ')}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  )
}

// ── Collapsible group ───────────────────────────────────────────────────────
//
// The Configure form used to be one long single-column scroll of ~11
// sections, which made things (notably the Soulseek/Music setup) easy to
// miss. We now fold those sections into five collapsible groups with a
// sticky jump bar. This wrapper is purely structural — every section's
// own markup/logic is unchanged, just nested under a toggle.
const CONFIG_GROUPS = [
  { id: 'services',  label: 'Services',        icon: Boxes },
  { id: 'downloads', label: 'Downloads & VPN', icon: Download },
  { id: 'music',     label: 'Music',           icon: Music2 },
  { id: 'locations', label: 'Locations',       icon: HardDrive },
  { id: 'advanced',  label: 'Advanced',        icon: Wrench },
] as const

// Human-readable labels for the env keys that can fail validation (the
// env-schema superRefines). Shown in the Configure error list instead of raw
// keys like "QBITTORRENT_PASS", so a first-timer sees "qBittorrent password".
// Unmapped keys fall back to a generic SNAKE_CASE → "Snake case" humanization.
const FIELD_LABELS: Record<string, string> = {
  DATA_ROOT: 'Media folder',
  INSTALL_DIR: 'Install folder',
  QBITTORRENT_USER: 'qBittorrent username',
  QBITTORRENT_PASS: 'qBittorrent password',
  SLSKD_USER: 'Soulseek username',
  SLSKD_PASS: 'Soulseek password',
  SLSKD_API_KEY: 'slskd API key',
  ENABLE_SOULSEEK: 'Soulseek',
  ENABLE_PLAYLIST_SYNC: 'Playlist Sync',
  PLAYLIST_SLSK_USER: 'Soulseek username (Playlist Sync)',
  PLAYLIST_SLSK_PASS: 'Soulseek password (Playlist Sync)',
  SIRIUSXM_CHANNELS: 'SiriusXM channels',
  PLAYLIST_SYNC_CRON: 'Playlist Sync schedule',
  ENABLE_DISPATCHARR: 'Live TV & DVR',
  DISPATCHARR_ADMIN_USER: 'Live TV admin username',
  DISPATCHARR_ADMIN_PASS: 'Live TV admin password',
  LIVETV_CHANNEL_PACKS: 'Live TV channel packs',
  USENET_USER: 'Usenet username',
  USENET_PASS: 'Usenet password',
  VPN_PROVIDER: 'VPN provider',
  VPN_COUNTRIES: 'VPN country',
  WIREGUARD_PRIVATE_KEY: 'WireGuard private key',
  OPENVPN_USER: 'OpenVPN username',
  OPENVPN_PASS: 'OpenVPN password',
  NORDVPN_PRIVATE_KEY: 'NordVPN key',
  PLEX_CLAIM: 'Plex claim token',
}
function humanizeKey(key: string): string {
  return FIELD_LABELS[key] ?? (key.charAt(0) + key.slice(1).toLowerCase().replace(/_/g, ' '))
}

function CollapsibleGroup({
  id, title, icon, subtitle, badge, open, onToggle, children,
}: {
  id: string
  title: string
  icon: ReactNode
  subtitle?: string
  badge?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section
      id={id}
      className="scroll-mt-24 rounded-xl border border-slate-800 bg-slate-900/30 overflow-hidden"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-slate-800/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
      >
        <span className="shrink-0">{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-lg font-semibold text-slate-100">{title}</span>
            {badge != null && (
              <span className="text-xs font-normal text-slate-500">{badge}</span>
            )}
          </span>
          {subtitle && (
            <span className="block text-xs text-slate-500 mt-0.5">{subtitle}</span>
          )}
        </span>
        <ChevronDown
          size={20}
          className={
            'shrink-0 text-slate-500 transition-transform duration-200 ' +
            (open ? 'rotate-180' : '')
          }
          aria-hidden="true"
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-6 pt-3 space-y-8 border-t border-slate-800/60">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

// One tall scrollable form with auto-detection (PUID/LAN_IP from NAS),
// country pickers (when the VPN provider's API gives us the list), and
// inline validation. Earlier roadmap split this into per-step screens
// but the single-page form scored better in usability testing — users
// could see the full picture at once and tab between fields naturally.
export function ConfigureScreen() {
  const { config, setConfig, sessionId, targetDir, setTargetDir, setStep, existingInstallDir, existingDataRoot } = useWizard()
  const [errors, setErrors] = useState<string[]>([])
  const [vpnToken, setVpnToken] = useState('')
  const [vpnBusy, setVpnBusy] = useState(false)
  const [vpnError, setVpnError] = useState<string | null>(null)
  const [countries, setCountries] = useState<Country[]>([])
  // Users and groups discovered on the NAS — populated on mount via SSH.
  interface NasUser  { name: string; uid: number; gid: number; comment: string }
  interface NasGroup { name: string; gid: number }
  const [users, setUsers] = useState<NasUser[]>([])
  const [groups, setGroups] = useState<NasGroup[]>([])
  const [usersError, setUsersError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    ;(async () => {
      try {
        // Pull both files in one exec. Filter to:
        //   users:  uid 0 (root) OR uid in 1024..59999 (Synology user range)
        //   groups: gid 0, gid 100 ('users'), or 1024..59999
        const cmd =
          `awk -F: '$3 == 0 || ($3 >= 1024 && $3 < 60000) ` +
          `{ print "U:" $1 ":" $3 ":" $4 ":" $5 }' /etc/passwd; ` +
          `awk -F: '$3 == 0 || $3 == 100 || ($3 >= 1024 && $3 < 60000) ` +
          `{ print "G:" $1 ":" $3 }' /etc/group`
        const r = await window.installer.ssh.exec({ sessionId, cmd })
        if (cancelled) return
        if (r.exitCode !== 0) {
          throw new Error((r.stderr || 'Failed to read /etc/passwd').trim())
        }
        const us: NasUser[] = []; const gs: NasGroup[] = []
        for (const line of r.stdout.split('\n')) {
          const p = line.split(':')
          if (p[0] === 'U' && p.length >= 5) {
            us.push({ name: p[1], uid: Number(p[2]), gid: Number(p[3]), comment: p[4] || '' })
          } else if (p[0] === 'G' && p.length >= 3) {
            gs.push({ name: p[1], gid: Number(p[2]) })
          }
        }
        setUsers(us.sort((a, b) => a.uid - b.uid))
        setGroups(gs.sort((a, b) => a.gid - b.gid))
      } catch (e) {
        if (!cancelled) {
          setUsersError((e as Error).message)
          reportError('Load NAS users/groups', e)
        }
      }
    })()
    return () => { cancelled = true }
  }, [sessionId])

  function selectContainerUser(uid: string) {
    if (!uid) {
      setConfig({ PUID: undefined as unknown as string, PGID: undefined as unknown as string })
      return
    }
    const u = users.find((x) => String(x.uid) === uid)
    if (u) setConfig({ PUID: String(u.uid), PGID: String(u.gid) })
    else setConfig({ PUID: uid })
  }

  function selectContainerGroup(gid: string) {
    setConfig({ PGID: gid || (undefined as unknown as string) })
  }

  // When "use same auth" is on, qBittorrent inherits ARR_USERNAME /
  // ARR_PASSWORD on every render so the user only edits one place.
  //
  // Seed the box from the LOADED config (lazy initializer — useState only honors
  // its first value, and loadFromProfile has already hydrated the store before
  // this screen mounts). A fresh install (qBit at its 'admin'/empty default) or a
  // profile that previously mirrored ARR opens CHECKED (keeps the convenience); a
  // profile with DISTINCT saved qBit creds opens UNCHECKED, so the mount-time
  // mirror below can't silently overwrite a user's separate qBit password.
  const [qbitSameAsArr, setQbitSameAsArr] = useState(() => {
    const q = config.QBITTORRENT_USER ?? ''
    const qp = config.QBITTORRENT_PASS ?? ''
    const a = config.ARR_USERNAME ?? ''
    const ap = config.ARR_PASSWORD ?? ''
    return ((q === '' || q === 'admin') && qp === '') ? true : (q === a && qp === ap)
  })
  useEffect(() => {
    if (!qbitSameAsArr) return
    const u = config.ARR_USERNAME ?? ''
    const p = config.ARR_PASSWORD ?? ''
    // WHY: ARR auth is optional and usually blank, but this box defaults
    // checked — so without this guard the mount-time mirror copies empty
    // ARR creds over the shipped QBITTORRENT_USER=admin default, then the
    // schema (which requires qBit creds when qBittorrent is on) forces the
    // user to invent credentials they meant to leave at the default. Only
    // mirror once the user has actually typed an ARR username or password;
    // until then leave the qBit defaults untouched.
    if (u === '' && p === '') return
    if (config.QBITTORRENT_USER !== u || config.QBITTORRENT_PASS !== p) {
      setConfig({ QBITTORRENT_USER: u, QBITTORRENT_PASS: p })
    }
  }, [qbitSameAsArr, config.ARR_USERNAME, config.ARR_PASSWORD, config.QBITTORRENT_USER, config.QBITTORRENT_PASS, setConfig])

  async function fetchVpnKey() {
    setVpnBusy(true); setVpnError(null)
    try {
      const r = await window.installer.vpn.fetchKey(vpnToken)
      // Store under the generic gluetun env-var name. NORDVPN_PRIVATE_KEY
      // also gets the same value for backwards compatibility with
      // .env-consuming scripts that haven't been updated yet.
      setConfig({
        WIREGUARD_PRIVATE_KEY: r.privateKey,
        NORDVPN_PRIVATE_KEY: r.privateKey,
      })
      setCountries(r.countries)
    } catch (e) {
      setVpnError((e as Error).message)
      reportError('VPN key fetch', e)
    } finally {
      setVpnBusy(false)
    }
  }

  function update<K extends keyof EnvFormValues>(key: K, value: EnvFormValues[K] | undefined) {
    setConfig({ [key]: value } as Partial<EnvFormValues>)
  }

  function go() {
    const parsed = envSchema.safeParse(config)
    if (!parsed.success) {
      // The qBittorrent user/pass inputs are GATED behind the "Use same
      // credentials as ARR Web UI" checkbox (qbitSameAsArr) — when it's
      // checked they aren't even rendered. So an all-defaults Continue
      // (qBit pass empty, fails the 8-char rule) would otherwise show a
      // blocking error pointing at a field the user can't see. Reveal the
      // qBit fields whenever validation flags them, so the SAME Continue
      // click that surfaces the error also makes the input editable.
      const qbitFlagged = parsed.error.issues.some(
        (i) => i.path[0] === 'QBITTORRENT_USER' || i.path[0] === 'QBITTORRENT_PASS',
      )
      // Capture whether the fields were hidden BEFORE we reveal them, so the
      // error text can tell the user exactly how to get out of the dead-end.
      const qbitWasHidden = qbitFlagged && qbitSameAsArr
      if (qbitFlagged) setQbitSameAsArr(false)
      setErrors(parsed.error.issues.map((i) => {
        const base = `${humanizeKey(i.path.join('.'))}: ${i.message}`
        // Make the qBit credential errors actionable: when the creds were
        // mirrored from (blank) ARR auth, the user needs to either fill an
        // ARR password or use the qBit field we just revealed.
        if (qbitWasHidden && (i.path[0] === 'QBITTORRENT_USER' || i.path[0] === 'QBITTORRENT_PASS')) {
          return `${base} — fill it in the qBittorrent WebUI fields just revealed under Downloads & VPN, or set an ARR password in Advanced.`
        }
        return base
      }))
      // Un-hide every flagged field. The error list references env keys whose
      // inputs may live inside collapsed groups (all but Services start
      // collapsed), so a first-timer can be blocked by a field they literally
      // can't see (e.g. the required qBittorrent password under "Downloads &
      // VPN"). Expand all groups so every flagged input is reachable. (A
      // targeted open-only-the-offending-group would need a field→group map;
      // opening all is the simple, robust version.)
      setOpenGroups(CONFIG_GROUPS.reduce((acc, g) => { acc[g.id] = true; return acc }, {} as Record<string, boolean>))
      return
    }
    setErrors([])
    setStep('run')
  }

  // Live validity for the footer claim + Continue: re-derived on every config
  // change (the SAME parse go() runs), so the footer never falsely asserts
  // "Ready to install" on an invalid config and the state can't get stuck after
  // a failed attempt. Continue stays clickable so go() can surface the specific
  // issues on demand — but go() itself refuses to advance while invalid, so a
  // click on an incomplete config shows the fixes instead of proceeding.
  const liveValid = useMemo(() => envSchema.safeParse(config).success, [config])

  // Collapsible-group open/closed state. Services is open on entry; the
  // rest collapse so the screen reads as a short, scannable list. jumpTo
  // opens the target group, then scrolls to its anchor on the next frame.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ services: true })
  const toggleGroup = (id: string) =>
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }))
  const jumpTo = (id: string) => {
    setOpenGroups((prev) => ({ ...prev, [id]: true }))
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
  // Enabled-service count for the Services group badge. Mirrors
  // ServicesSection's isOn (opt-in services → isOptInEnabled).
  const enabledServiceCount = SERVICE_TOGGLES.filter((t) =>
    OPT_IN_SERVICES.has(t.key)
      ? isOptInEnabled(config[t.key] as string | undefined)
      : isEnabled(config[t.key] as string | undefined),
  ).length

  return (
    <ConfigCtx.Provider value={{ config, update }}>
    <div className="h-full flex flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* Sticky jump bar — wayfinding across the five collapsible groups so
          nothing (notably the Music setup) hides at the bottom of a long
          scroll. A chip opens its group and scrolls to it. */}
      <div className="sticky top-0 z-10 bg-slate-950/90 backdrop-blur border-b border-slate-800">
        <div className="max-w-3xl mx-auto px-8 py-2 flex items-center gap-2 overflow-x-auto">
          {CONFIG_GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => jumpTo(g.id)}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-slate-800/70 text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
            >
              <g.icon size={13} aria-hidden="true" />
              {g.label}
            </button>
          ))}
        </div>
      </div>
    <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
      <ConfigureHeader />

      {/* ── Group 1: Services ──────────────────────────────────── */}
      <CollapsibleGroup
        id="services"
        title="Services"
        icon={<Boxes size={20} className="text-emerald-400" strokeWidth={1.75} aria-hidden="true" />}
        badge={`${enabledServiceCount} of ${SERVICE_TOGGLES.length} enabled`}
        open={!!openGroups.services}
        onToggle={() => toggleGroup('services')}
      >
        <ServicesSection config={config} update={update} />

        {/* Media-server picker — Plex or Jellyfin (mutually exclusive).
            Only shown when the media-server group is enabled. Drives
            MEDIA_SERVER in .env; setup.sh activates the matching compose
            profile and the configurator wires the right server. */}
        {isEnabled(config.ENABLE_PLEX as string | undefined) && (
          <section className="rounded-md border border-slate-800 p-3 space-y-2">
            <div className="text-sm font-medium flex items-center gap-2">
              <PlaySquare size={16} className="text-amber-400" strokeWidth={2} aria-hidden="true" />
              Media server
            </div>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Media server">
              {([
                { id: 'plex',     name: 'Plex',     blurb: 'Claim token + Tautulli analytics' },
                { id: 'jellyfin', name: 'Jellyfin', blurb: 'Free & open-source, no account' },
              ] as const).map((ms) => {
                const active = (config.MEDIA_SERVER || 'plex') === ms.id
                return (
                  <button
                    key={ms.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => update('MEDIA_SERVER', ms.id)}
                    className={
                      'text-left rounded-md border p-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 ' +
                      (active
                        ? 'border-amber-500/50 bg-amber-900/20'
                        : 'border-slate-700 bg-slate-900/40 hover:border-slate-600')
                    }
                  >
                    <div className="text-sm font-medium">{ms.name}</div>
                    <div className="text-xs text-slate-400">{ms.blurb}</div>
                  </button>
                )
              })}
            </div>
            {(config.MEDIA_SERVER || 'plex') === 'jellyfin' && (
              <p className="text-xs text-slate-400">
                The request manager runs as{' '}
                <span className="font-mono text-slate-300">Jellyseerr</span> (supports
                Jellyfin). Tautulli is Plex-only, so it&apos;s skipped — Jellyfin has
                built-in playback stats.
              </p>
            )}
          </section>
        )}

        {/* Plex claim is collected on the Run screen instead — it expires
            4 minutes after generation, so capturing it earlier risks the
            token going stale while the user fills out other fields. The
            RunScreen has a PlexClaimRefresh widget right above the Start
            button with a live countdown and a "Get fresh token" link.
            Hide the banner when Plex is opted out of the stack, or when the
            user picked Jellyfin (no claim token — see the Jellyfin note). */}
        {isEnabled(config.ENABLE_PLEX as string | undefined)
          && (config.MEDIA_SERVER || 'plex') !== 'jellyfin' && (
          <section className="rounded-md border border-amber-700/30 bg-amber-900/10 p-3 text-sm text-slate-300 flex items-start gap-3">
            <div className="shrink-0 w-8 h-8 rounded-md bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mt-0.5">
              <Clock size={16} className="text-amber-300" strokeWidth={2} aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <div className="font-medium text-amber-100">
                Plex claim comes up on the next screen
              </div>
              <div className="text-xs text-slate-400">
                Claim tokens expire 4 minutes after you generate them, so we keep
                it for last — the next screen has a fresh-token countdown +
                one-click link to{' '}
                <a
                  href="https://plex.tv/claim"
                  target="_blank"
                  rel="noreferrer"
                  className="text-amber-300 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 rounded"
                  aria-label="Open plex.tv/claim in a new tab"
                >
                  plex.tv/claim
                </a>
                .
              </div>
            </div>
          </section>
        )}

        {/* Jellyfin has no claim token — it's set up in the browser after
            install. Tell the user the post-install step so the arr → library
            wiring can be completed (optional; the stack works without it). */}
        {isEnabled(config.ENABLE_PLEX as string | undefined)
          && (config.MEDIA_SERVER || 'plex') === 'jellyfin' && (
          <section className="rounded-md border border-sky-700/30 bg-sky-900/10 p-3 text-sm text-slate-300 flex items-start gap-3">
            <div className="shrink-0 w-8 h-8 rounded-md bg-sky-500/15 border border-sky-500/30 flex items-center justify-center mt-0.5">
              <Info size={16} className="text-sky-300" strokeWidth={2} aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <div className="font-medium text-sky-100">
                Jellyfin finishes setting up in your browser
              </div>
              <div className="text-xs text-slate-400">
                No claim token needed. After install, open{' '}
                <span className="font-mono text-slate-300">http://&lt;NAS&gt;:8096</span>,
                complete the first-run wizard, then (optionally) generate an API key
                under Dashboard → API Keys and paste it into the Run screen so the
                arrs auto-refresh Jellyfin on import.
              </div>
            </div>
          </section>
        )}
      </CollapsibleGroup>

      {/* ── Group 2: Downloads & VPN ───────────────────────────── */}
      <CollapsibleGroup
        id="downloads"
        title="Downloads & VPN"
        icon={<Download size={20} className="text-blue-400" strokeWidth={1.75} aria-hidden="true" />}
        subtitle="qBittorrent, the VPN tunnel, and your Usenet provider"
        open={!!openGroups.downloads}
        onToggle={() => toggleGroup('downloads')}
      >
        {/* VPN section only renders when qBittorrent is in the stack —
            gluetun is the VPN sidecar for qBittorrent, so without
            qBittorrent there's nothing to route through it. Avoids
            surprising the user with a half-filled VPN form whose key
            would be silently unused at install time. */}
        {isEnabled(config.ENABLE_QBITTORRENT as string | undefined) && (
          <VpnSection
            config={config}
            update={update}
            vpnToken={vpnToken}
            setVpnToken={setVpnToken}
            vpnBusy={vpnBusy}
            vpnError={vpnError}
            fetchVpnKey={fetchVpnKey}
            countries={countries}
          />
        )}

        {/* qBittorrent WebUI credentials only matter when qBittorrent is
            in the stack — same reasoning as the VPN section above. */}
        {isEnabled(config.ENABLE_QBITTORRENT as string | undefined) && (
          <section className="space-y-4">
            <h2 className="text-xl font-semibold border-b-2 border-slate-800 pb-2 flex items-center gap-2">
              <Lock size={20} className="text-emerald-400" strokeWidth={1.75} aria-hidden="true" />
              qBittorrent WebUI
            </h2>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={qbitSameAsArr}
                onChange={(e) => setQbitSameAsArr(e.target.checked)}
              />
              Use same credentials as ARR Web UI
            </label>
            <AnimatePresence initial={false}>
              {!qbitSameAsArr && (
                <motion.div
                  key="qbit-fields"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden"
                >
                  <div className="grid grid-cols-2 gap-4 pt-1">
                    <Field label="Username" k="QBITTORRENT_USER" />
                    <Field label="Password (8+ chars)" k="QBITTORRENT_PASS" type="password" />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {qbitSameAsArr && (
              <p className="text-xs text-slate-500">
                qBittorrent will use{' '}
                <span className="font-mono text-slate-300">
                  {config.ARR_USERNAME || '<empty>'}
                </span>{' '}
                from the ARR auth section in Advanced. Note: qBittorrent requires
                the password to be at least 8 characters.
              </p>
            )}
          </section>
        )}

        {/* SABnzbd usenet provider — optional account-based news server.
            Lives here with the other downloaders (moved out of Advanced). */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b-2 border-slate-800 pb-2 flex items-center gap-2">
            <Newspaper size={20} className="text-orange-400" strokeWidth={1.75} aria-hidden="true" />
            SABnzbd usenet provider
          </h2>
          <p className="text-sm text-slate-400">
            Optional. Adds a news server to SABnzbd at first install. Leave the
            host blank to skip — you can always add servers later in
            <a className="text-emerald-400 underline mx-1" href="#" onClick={(e) => e.preventDefault()}>
              SABnzbd → Config → Servers
            </a>.
            Common providers: <code className="text-slate-300">news.eweka.nl</code>,
            {' '}<code className="text-slate-300">news.usenetserver.com</code>,
            {' '}<code className="text-slate-300">news.giganews.com</code>.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Host" k="USENET_HOST" placeholder="news.eweka.nl" />
            <Field label="Port" k="USENET_PORT" placeholder="563" />
            <Field label="Username" k="USENET_USER" />
            <Field label="Password" k="USENET_PASS" type="password" />
            <Field label="Connections" k="USENET_CONNECTIONS" placeholder="8" />
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="cfg-usenet-ssl">SSL</label>
              <select
                id="cfg-usenet-ssl"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
                value={config.USENET_SSL ?? '1'}
                onChange={(e) => update('USENET_SSL', e.target.value)}
              >
                <option value="1">On (recommended)</option>
                <option value="0">Off</option>
              </select>
            </div>
          </div>
        </section>
      </CollapsibleGroup>

      {/* ── Group 3: Music ─────────────────────────────────────── */}
      <CollapsibleGroup
        id="music"
        title="Music"
        icon={<Music2 size={20} className="text-pink-400" strokeWidth={1.75} aria-hidden="true" />}
        subtitle="Soulseek music source for Lidarr (via VPN) + Playlist Sync"
        open={!!openGroups.music}
        onToggle={() => toggleGroup('music')}
      >
        {isOptInEnabled(config.ENABLE_SOULSEEK as string | undefined) ? (
          <section className="space-y-4">
            <p className="text-sm text-slate-400">
              Soulseek finds music for Lidarr off the Soulseek network — through
              your VPN, like torrents. All you need is a{' '}
              <span className="font-medium text-slate-300">free Soulseek account</span>,
              and there&apos;s no sign-up page: just pick a{' '}
              <span className="font-medium text-slate-300">unique username and password</span>{' '}
              below — they&apos;re registered on the Soulseek network automatically the
              first time the client connects (a name someone already took rejects the
              login, so make it distinctive). (If you already use the official
              Soulseek desktop app from{' '}
              <a
                href="https://www.slsknet.org"
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 hover:underline"
              >
                slsknet.org
              </a>
              , enter those same credentials.){' '}
              <span className="text-amber-300/90">Needs Lidarr.</span>
            </p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Soulseek username" k="SLSKD_USER" />
              <Field label="Soulseek password" k="SLSKD_PASS" type="password" />
            </div>
            {/* Everything else is optional with sensible defaults. The slskd API
                key is an INTERNAL secret shared between the two Soulseek
                containers (NOT a login) — setup.sh auto-generates one when it's
                blank, so we don't make the user invent a random string. */}
            <details className="text-sm group">
              <summary className="cursor-pointer text-slate-400 hover:text-slate-200 select-none inline-flex items-center gap-1.5 [&::-webkit-details-marker]:hidden">
                <ChevronDown size={14} className="text-slate-500 transition-transform group-open:rotate-180" aria-hidden="true" />
                Optional settings — you can skip these
              </summary>
              <div className="mt-3 space-y-3">
                <Field
                  label="Scan interval (seconds)"
                  k="SOULARR_INTERVAL"
                  placeholder="300 (default)"
                />
                <Field
                  label="slskd API key — leave blank, generated for you"
                  k="SLSKD_API_KEY"
                  type="password"
                  placeholder="auto-generated on install"
                />
                <p className="text-xs text-slate-500">
                  The API key is an internal secret shared between the two
                  Soulseek containers — <span className="text-slate-400">not</span> a
                  Soulseek login. Leave it blank and the installer generates one
                  for you; only set it to pin a specific value. Scan interval
                  defaults to 300s.
                </p>
              </div>
            </details>
            <p className="text-xs text-slate-500">
              To turn this off, untick <span className="font-medium">Soulseek</span> in
              the Services group above.
            </p>
          </section>
        ) : (
          <div className="rounded-md border border-pink-700/30 bg-pink-900/10 p-4 flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 rounded-md bg-pink-500/15 border border-pink-500/30 flex items-center justify-center">
              <Music2 size={20} className="text-pink-300" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <div className="space-y-3 min-w-0">
              <div>
                <div className="font-medium text-pink-100">Add a music source</div>
                <p className="text-xs text-slate-400 mt-1">
                  Soulseek (slskd + soularr) lets Lidarr grab music it can&apos;t
                  find on your other indexers — routed through your VPN like
                  torrents. It needs Lidarr enabled; we&apos;ll turn that on too if
                  it isn&apos;t already.
                </p>
              </div>
              <BigButton
                size="md"
                variant="primary"
                icon={<Music2 size={16} />}
                onClick={() => {
                  update('ENABLE_SOULSEEK', 'true')
                  if (!isEnabled(config.ENABLE_LIDARR as string | undefined)) {
                    update('ENABLE_LIDARR', 'true')
                  }
                }}
              >
                Enable Soulseek
              </BigButton>
            </div>
          </div>
        )}

        {/* ── Playlist Sync ───────────────────────────────────────
            Opt-in, toggled in the Services group (like Soulseek). Mirrors
            SiriusXM channels into Plex OR Jellyfin playlists, downloading
            each track Soulseek-first (its OWN 2nd account) with a yt-dlp
            fallback. Works with either media server. */}
        <div className="border-t border-slate-800 pt-4">
          {isOptInEnabled(config.ENABLE_PLAYLIST_SYNC as string | undefined) ? (
            <section className="space-y-4">
              <p className="text-sm text-slate-400">
                Playlist Sync mirrors specific{' '}
                <span className="font-medium text-slate-300">SiriusXM channels</span>{' '}
                into Plex or Jellyfin — it downloads each track Soulseek-first (with a yt-dlp
                fallback) on a schedule, so those playlists stay fresh in Plexamp.
                It needs its{' '}
                <span className="font-medium text-slate-300">own free Soulseek account</span>{' '}
                (separate from the one above — Soulseek allows one session per
                login).
              </p>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Soulseek username (2nd account)" k="PLAYLIST_SLSK_USER" />
                <Field label="Soulseek password (2nd account)" k="PLAYLIST_SLSK_PASS" type="password" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-300">SiriusXM channels</label>
                <SiriusxmSelect
                  value={(config.SIRIUSXM_CHANNELS as string | undefined) ?? ''}
                  onChange={(v) => update('SIRIUSXM_CHANNELS', v || undefined)}
                />
                <p className="text-xs text-slate-500">
                  Pick channels by name — the list comes from{' '}
                  <a href="https://xmplaylist.com" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">xmplaylist.com</a>{' '}
                  (free, no account). Anything not in the list can be added as a custom slug.
                </p>
              </div>
              <p className="text-xs text-slate-500">
                Add at least one SiriusXM channel.
              </p>
              <details className="text-sm group">
                <summary className="cursor-pointer text-slate-400 hover:text-slate-200 select-none inline-flex items-center gap-1.5 [&::-webkit-details-marker]:hidden">
                  <ChevronDown size={14} className="text-slate-500 transition-transform group-open:rotate-180" aria-hidden="true" />
                  Optional — schedule &amp; audio format
                </summary>
                <div className="mt-3 space-y-3">
                  <Field label="Schedule (cron)" k="PLAYLIST_SYNC_CRON" placeholder="0 4 * * * (daily 4am)" />
                  <Field label="Preferred format" k="PLAYLIST_PREF_FORMAT" placeholder="flac (default)" />
                </div>
              </details>
              <p className="text-xs text-slate-500">
                To turn this off, untick <span className="font-medium">Playlist Sync</span> in
                the Services group above.
              </p>
            </section>
          ) : (
            <div className="rounded-md border border-green-700/30 bg-green-900/10 p-4 flex items-start gap-3">
              <div className="shrink-0 w-9 h-9 rounded-md bg-green-500/15 border border-green-500/30 flex items-center justify-center">
                <Music2 size={20} className="text-green-300" strokeWidth={1.75} aria-hidden="true" />
              </div>
              <div className="space-y-3 min-w-0">
                <div>
                  <div className="font-medium text-green-100">Auto-sync SiriusXM playlists</div>
                  <p className="text-xs text-slate-400 mt-1">
                    Mirror specific SiriusXM channels into your media server — each
                    track is downloaded Soulseek-first (yt-dlp fallback) on a schedule
                    and surfaced as a playlist you can play in Plexamp (Plex) or
                    Finamp (Jellyfin).
                  </p>
                </div>
                <BigButton
                  size="md"
                  variant="primary"
                  icon={<Music2 size={16} />}
                  onClick={() => {
                    update('ENABLE_PLAYLIST_SYNC', 'true')
                    if (!isEnabled(config.ENABLE_PLEX as string | undefined)) {
                      update('ENABLE_PLEX', 'true')
                    }
                  }}
                >
                  Enable Playlist Sync
                </BigButton>
              </div>
            </div>
          )}
        </div>

      </CollapsibleGroup>

      {/* ── Group: Live TV & DVR ───────────────────────────────── */}
      <CollapsibleGroup
        id="livetv"
        title="Live TV & DVR"
        icon={<Tv size={20} className="text-cyan-400" strokeWidth={1.75} aria-hidden="true" />}
        subtitle="free live channels + a DVR tuner (Dispatcharr)"
        open={!!openGroups.livetv}
        onToggle={() => toggleGroup('livetv')}
      >
        {isOptInEnabled(config.ENABLE_DISPATCHARR as string | undefined) ? (
          <section className="space-y-4">
            <p className="text-sm text-slate-400">
              Dispatcharr manages live-TV channels and shows up to{' '}
              <span className="font-medium text-slate-300">Plex and Jellyfin as an HDHomeRun tuner</span>.
              Its built-in DVR records shows into{' '}
              <code className="font-mono text-slate-300">Media/Recordings</code>, where your media
              server indexes them like any other files — so recording works even{' '}
              <span className="font-medium text-slate-300">without a Plex Pass</span>{' '}
              (live tuning inside Plex itself needs Plex Pass; Jellyfin does live TV
              free; Dispatcharr&apos;s own web UI plays live TV for everyone).
            </p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Admin username" k="DISPATCHARR_ADMIN_USER" placeholder="admin" />
              <Field label="Admin password" k="DISPATCHARR_ADMIN_PASS" type="password" />
            </div>
            <p className="text-xs text-slate-500">
              The installer creates this login on Dispatcharr&apos;s first boot and uses
              it to set up the channels below — it&apos;s also how you sign in at{' '}
              <code className="font-mono">http://&lt;NAS&gt;:9191</code>.
            </p>
            <div className="space-y-1.5">
              <div className="text-sm font-medium text-slate-300">Free channel packs</div>
              <p className="text-xs text-slate-500">
                Free, ad-supported streaming channels (the providers&apos; own public
                streams, ads intact) with a full programme guide — pre-configured
                automatically. Untick anything you don&apos;t want; you can also add
                your own IPTV sources later in Dispatcharr itself.
              </p>
              <div className="grid grid-cols-2 gap-2 pt-1">
                {LIVETV_PACKS.map((p) => {
                  const selected = new Set(
                    ((config.LIVETV_CHANNEL_PACKS as string | undefined) ?? '')
                      .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
                  )
                  const on = selected.has(p.id)
                  return (
                    <label
                      key={p.id}
                      className="flex items-center gap-2.5 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2 cursor-pointer hover:border-slate-700 transition-colors"
                    >
                      <input
                        type="checkbox"
                        className="accent-emerald-500"
                        checked={on}
                        onChange={() => {
                          if (on) selected.delete(p.id); else selected.add(p.id)
                          // Keep the canonical pack order, not click order.
                          const next = LIVETV_PACKS.filter((x) => selected.has(x.id))
                            .map((x) => x.id).join(',')
                          update('LIVETV_CHANNEL_PACKS', next)
                        }}
                      />
                      <span className="text-sm text-slate-200">{p.name}</span>
                      <span className="text-xs text-slate-500 ml-auto">{p.channels}</span>
                    </label>
                  )
                })}
              </div>
            </div>
            <p className="text-xs text-slate-500">
              To turn this off, untick <span className="font-medium">Live TV &amp; DVR</span> in
              the Services group above.
            </p>
          </section>
        ) : (
          <div className="rounded-md border border-cyan-700/30 bg-cyan-900/10 p-4 flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 rounded-md bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
              <Tv size={20} className="text-cyan-300" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <div className="space-y-3 min-w-0">
              <div>
                <div className="font-medium text-cyan-100">Add live TV &amp; a DVR</div>
                <p className="text-xs text-slate-400 mt-1">
                  Dispatcharr bundles 2,000+ free ad-supported channels (Pluto TV,
                  Samsung TV Plus, Plex Live TV, Roku, Tubi) with a programme guide,
                  appears to Plex/Jellyfin as an HDHomeRun tuner, and records shows
                  into your media library with its own DVR — no Plex Pass needed for
                  recording, and Jellyfin gets live TV free.
                </p>
              </div>
              <BigButton
                size="md"
                variant="primary"
                icon={<Tv size={16} />}
                onClick={() => {
                  update('ENABLE_DISPATCHARR', 'true')
                  // An older imported profile has no pack key — seed the default
                  // all-packs selection so enabling gives a full guide.
                  if (config.LIVETV_CHANNEL_PACKS === undefined) {
                    update('LIVETV_CHANNEL_PACKS', LIVETV_PACKS.map((p) => p.id).join(','))
                  }
                }}
              >
                Enable Live TV &amp; DVR
              </BigButton>
            </div>
          </div>
        )}
      </CollapsibleGroup>

      {/* ── Group 4: Locations & Identity ──────────────────────── */}
      <CollapsibleGroup
        id="locations"
        title="Locations & Identity"
        icon={<HardDrive size={20} className="text-emerald-400" strokeWidth={1.75} aria-hidden="true" />}
        subtitle="where it installs + which user owns the files"
        open={!!openGroups.locations}
        onToggle={() => toggleGroup('locations')}
      >
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b-2 border-slate-800 pb-2 flex items-center gap-2">
            <HardDrive size={20} className="text-emerald-400" strokeWidth={1.75} aria-hidden="true" />
            Install location
          </h2>
          <p className="text-xs text-slate-400">
            Two paths matter: where the wizard's compose stack + config dirs
            land (<code className="font-mono">INSTALL_DIR</code>), and where your
            media + downloads live (<code className="font-mono">DATA_ROOT</code>).
            The Detect screen auto-fills both based on the NAS family it found
            — override for non-standard layouts.
          </p>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="cfg-install-dir">
              Install directory <span className="text-slate-500 text-xs ml-1">(compose stack + per-container configs)</span>
            </label>
            <input
              id="cfg-install-dir"
              type="text"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md font-mono text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
              placeholder="/volume1/docker/media"
              value={config.INSTALL_DIR ?? targetDir}
              onChange={(e) => {
                // Keep INSTALL_DIR (used by docker-compose.yml) and the
                // wizard's targetDir (used by SFTP upload + setup.sh
                // invocation) in lockstep — they're conceptually the
                // same value, just exposed twice for historical reasons.
                const v = e.target.value
                setConfig({ INSTALL_DIR: v || undefined })
                setTargetDir(v)
              }}
            />
          </div>
          <Field
            label="Data root (media + downloads, bind-mounted as /data inside containers)"
            k="DATA_ROOT"
            placeholder="/volume1/Data"
          />
          {/* Same "relocating an existing install" warning the Detect screen
              shows — rendered here so editing the path on Configure (or
              loading a profile and tweaking it) gets the heads-up that this
              stops the stack + moves data. existing* come from the last
              detect (null when none ran / no prior install), so this is
              silent on a fresh box. */}
          <RelocationWarning
            installDir={config.INSTALL_DIR ?? targetDir}
            dataRoot={config.DATA_ROOT ?? ''}
            existingInstallDir={existingInstallDir}
            existingDataRoot={existingDataRoot}
          />
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b-2 border-slate-800 pb-2 flex items-center gap-2">
            <UserCircle size={20} className="text-emerald-400" strokeWidth={1.75} aria-hidden="true" />
            Identity
          </h2>

          {/* Container user / group — pulled from the NAS's /etc/passwd
              and /etc/group on screen entry. Picking a user auto-fills
              PUID + the user's primary GID; the group select can override
              the GID independently (handy when you want files owned by a
              shared "users" group rather than the user's private group). */}
          <div className="rounded-md border border-slate-700/50 bg-slate-900/40 p-3 space-y-3">
            <label className="block text-sm font-medium inline-flex items-center gap-2 w-full">
              <Users size={16} className="text-emerald-400" strokeWidth={1.75} aria-hidden="true" />
              Container user / group
              <span className="text-slate-500 text-xs">
                (these own the media files — pick something other than the install user)
              </span>
            </label>

            {usersError && (
              <div
                className="text-xs text-rose-300 inline-flex items-start gap-1.5"
                role="alert"
              >
                <XCircle size={13} className="text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                <span>Couldn&apos;t read users from the NAS: {usersError}</span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1" htmlFor="cfg-container-user">User</label>
                <select
                  id="cfg-container-user"
                  aria-label="Container user (owns media files)"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
                  value={config.PUID ?? ''}
                  onChange={(e) => selectContainerUser(e.target.value)}
                >
                  <option value="">— Pick a user —</option>
                  {users.map((u) => (
                    <option key={u.uid} value={u.uid}>
                      {u.name} (uid {u.uid}{u.comment ? ` — ${u.comment.slice(0, 40)}` : ''})
                      {u.uid === 0 ? ' [root, not recommended]' : ''}
                    </option>
                  ))}
                  {users.length === 0 && !usersError && sessionId && (
                    <option disabled>Loading users from NAS...</option>
                  )}
                  {!sessionId && users.length === 0 && (
                    <option disabled>(connect to populate from NAS)</option>
                  )}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1" htmlFor="cfg-container-group">Group</label>
                <select
                  id="cfg-container-group"
                  aria-label="Container group (owns media files)"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
                  value={config.PGID ?? ''}
                  onChange={(e) => selectContainerGroup(e.target.value)}
                >
                  <option value="">— Pick a group —</option>
                  {groups.map((g) => (
                    <option key={g.gid} value={g.gid}>
                      {g.name} (gid {g.gid}){g.gid === 0 ? ' [root]' : ''}
                    </option>
                  ))}
                  {groups.length === 0 && !usersError && sessionId && (
                    <option disabled>Loading groups from NAS...</option>
                  )}
                  {!sessionId && groups.length === 0 && (
                    <option disabled>(connect to populate from NAS)</option>
                  )}
                </select>
              </div>
            </div>

            <p className="text-xs text-slate-500">
              Don&apos;t see your media user? Create one in DSM &rarr; Control
              Panel &rarr; User &amp; Group with read/write on your media share,
              then come back to this screen.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="PUID (user ID)" k="PUID" />
            <Field label="PGID (group ID)" k="PGID" />
          </div>
          <TimezoneSelect
            value={config.TZ ?? ''}
            onChange={(tz) => update('TZ', tz || undefined)}
          />
          <Field label="LAN IP of your NAS" k="LAN_IP" placeholder="192.168.1.10" />
        </section>
      </CollapsibleGroup>

      {/* ── Group 5: Advanced ──────────────────────────────────── */}
      <CollapsibleGroup
        id="advanced"
        title="Advanced"
        icon={<Wrench size={20} className="text-slate-400" strokeWidth={1.75} aria-hidden="true" />}
        subtitle="indexers, quality profiles, app logins — all optional"
        open={!!openGroups.advanced}
        onToggle={() => toggleGroup('advanced')}
      >
        <TrashProfilesSection config={config} update={update} />

        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b-2 border-slate-800 pb-2 flex items-center gap-2">
            <KeyRound size={20} className="text-emerald-400" strokeWidth={1.75} aria-hidden="true" />
            Arr Web UI auth
          </h2>
          <p className="text-sm text-slate-400">
            Optional. Applied to Sonarr, Radarr, Lidarr, Prowlarr by setup-arr-config.py.
            LAN connections bypass the prompt automatically. Leave blank to skip.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Username" k="ARR_USERNAME" />
            <Field label="Password" k="ARR_PASSWORD" type="password" />
          </div>
        </section>

        {/* Unified indexer browser — Usenet + public/private trackers in
            one filterable catalog. Bazarr subtitle providers stay separate
            below (different concern). */}
        <IndexerBrowser
          catalog={[...USENET_INDEXERS, ...PUBLIC_TRACKERS, ...PRIVATE_TRACKERS]}
          values={config}
          onChange={setConfig}
        />

        {/* JSON-backed custom indexer editor for entries the curated
            catalog doesn't ship with. Persisted as CUSTOM_INDEXERS_JSON
            in .env; setup-indexers.py reads + registers each at
            install time. */}
        <CustomIndexerEditor values={config} onChange={setConfig} />

        <section className="space-y-3">
          <h2 className="text-xl font-semibold border-b-2 border-slate-800 pb-2 flex items-center gap-2">
            <Captions size={20} className="text-violet-400" strokeWidth={1.75} aria-hidden="true" />
            Bazarr subtitle providers
          </h2>
          <p className="text-sm text-slate-400">
            Free providers (YIFY, Podnapisi) are added automatically. Add account-based
            providers below for better coverage.
          </p>
          <div className="grid grid-cols-2 gap-3">
            {BAZARR_PROVIDERS.map((d) => (
              <IndexerCard key={d.id} def={d} values={config} onChange={setConfig} />
            ))}
          </div>
        </section>
      </CollapsibleGroup>

      {/* Full error list stays in the scrollable body so the user can
          read all of them. The footer below shows a compact "N issues"
          summary so the buttons can stay pinned. */}
      {errors.length > 0 && (
        <div className="bg-rose-900/40 text-rose-200 rounded-md p-3 text-sm">
          <div className="font-medium mb-1">Fix these before continuing:</div>
          <ul className="list-disc list-inside space-y-0.5">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
    </div>
    </div>

    {/* Sticky footer: Back / status / Begin install. Pinned to the
        bottom so the action buttons are always reachable from a long
        form. */}
    <div className="border-t border-slate-800 bg-slate-950 px-8 py-3 shrink-0">
      <div className="max-w-3xl mx-auto flex items-center gap-3">
        <BigButton
          size="md"
          variant="secondary"
          icon={<ArrowLeft size={18} />}
          onClick={() => {
            const { sessionId, setStep } = useWizard.getState()
            // Edit/offline mode reaches Configure with NO SSH session;
            // jumping Back to Detect would dead-end on "No SSH session".
            // Go to Welcome instead. With a live session, Back → Detect.
            setStep(sessionId ? 'detect' : 'welcome')
          }}
        >
          Back
        </BigButton>
        <div className="flex-1 text-sm text-center">
          {liveValid ? (
            <span className="text-emerald-300">✓ Ready to install</span>
          ) : errors.length > 0 ? (
            <span className="text-rose-300">
              ✘ {errors.length} {errors.length === 1 ? 'thing to fix' : 'things to fix'} above
            </span>
          ) : (
            <span className="text-amber-300">Complete the required fields, then Continue</span>
          )}
        </div>
        <BigButton
          size="md"
          variant="primary"
          trailingIcon={<ArrowRight size={18} />}
          onClick={go}
          title={liveValid ? 'Move to the install step' : 'Continue to see what still needs filling in'}
        >
          Continue
        </BigButton>
      </div>
    </div>
    </div>
    </ConfigCtx.Provider>
  )
}
