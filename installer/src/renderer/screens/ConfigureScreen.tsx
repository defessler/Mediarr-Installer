import { createContext, useContext, useEffect, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import { envSchema } from '../../shared/env-schema.js'
import {
  type EnvFormValues,
  USENET_INDEXERS,
  PRIVATE_TRACKERS,
  BAZARR_PROVIDERS,
} from '../../shared/env-render.js'
import {
  VPN_PROVIDERS,
  findVpnProvider,
  type VpnField,
  type VpnProvider,
} from '../../shared/vpn-providers.js'
import type { Country } from '../../shared/ipc.js'
import { IndexerCard } from '../components/IndexerCard.js'
import { TimezoneSelect } from '../components/TimezoneSelect.js'
import { reportError } from '../store/errors.js'

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
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      <input
        type={type} placeholder={placeholder}
        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
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
  /** "needs" hint — shown when the toggle is on but its dependencies are off. */
  needs?: (keyof EnvFormValues)[]
}

const SERVICE_TOGGLES: ServiceToggle[] = [
  { key: 'ENABLE_PLEX',        label: 'Plex stack',   hint: 'Plex + Tautulli + Seerr (request system)' },
  { key: 'ENABLE_SONARR',      label: 'Sonarr',       hint: 'TV automation' },
  { key: 'ENABLE_RADARR',      label: 'Radarr',       hint: 'Movie automation' },
  { key: 'ENABLE_LIDARR',      label: 'Lidarr',       hint: 'Music automation' },
  { key: 'ENABLE_BAZARR',      label: 'Bazarr',       hint: 'Subtitle automation', needs: ['ENABLE_SONARR', 'ENABLE_RADARR'] },
  { key: 'ENABLE_QBITTORRENT', label: 'qBittorrent',  hint: 'Torrents (+ Gluetun VPN when VPN_ENABLED)' },
  { key: 'ENABLE_SABNZBD',     label: 'SABnzbd',      hint: 'Usenet downloader' },
  { key: 'ENABLE_RECYCLARR',   label: 'Recyclarr',    hint: 'Quality-profile sync for *arr', needs: ['ENABLE_SONARR', 'ENABLE_RADARR'] },
  { key: 'ENABLE_UNPACKERR',   label: 'Unpackerr',    hint: 'Auto-extract download archives', needs: ['ENABLE_SONARR', 'ENABLE_RADARR'] },
  { key: 'ENABLE_HOMEPAGE',    label: 'Homepage',     hint: 'Dashboard linking all the above' },
]

function ServicesSection({
  config, update,
}: {
  config: Partial<EnvFormValues>
  update: <K extends keyof EnvFormValues>(k: K, v: EnvFormValues[K] | undefined) => void
}) {
  // Default-on for any missing key, matching env-render's isEnabled().
  const isOn = (k: keyof EnvFormValues) =>
    ((config[k] as string | undefined) ?? 'true').toLowerCase() !== 'false'
  const enabledCount = SERVICE_TOGGLES.filter((t) => isOn(t.key)).length

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium border-b border-slate-800 pb-2 flex items-center gap-2">
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
          return (
            <label
              key={t.key}
              className={
                'flex items-start gap-2 rounded-md border p-3 cursor-pointer transition-colors ' +
                (on
                  ? 'border-emerald-700/50 bg-emerald-900/10'
                  : 'border-slate-700 bg-slate-900/40 opacity-70')
              }
            >
              <input
                type="checkbox"
                className="mt-0.5 shrink-0"
                checked={on}
                onChange={(e) => update(t.key, e.target.checked ? 'true' : 'false')}
              />
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
              </div>
            </label>
          )
        })}
      </div>
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
        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <input
      type={field.type === 'password' ? 'password' : 'text'}
      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
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
    // Clear PROVIDER-SPECIFIC secret fields when switching so e.g. a
    // stale Mullvad WireGuard key doesn't carry into a Surfshark
    // profile. VPN_COUNTRIES + VPN_ENABLED stay — they're provider-
    // agnostic and the user shouldn't have to re-type the country
    // list just because they switched from NordVPN to Mullvad.
    const blanks: Partial<EnvFormValues> = {
      VPN_PROVIDER: newId,
      VPN_TYPE: findVpnProvider(newId).vpnType,
      WIREGUARD_PRIVATE_KEY: undefined,
      WIREGUARD_ADDRESSES: undefined,
      WIREGUARD_PRESHARED_KEY: undefined,
      OPENVPN_USER: undefined,
      OPENVPN_PASSWORD: undefined,
      NORDVPN_ACCESS_TOKEN: undefined,
      NORDVPN_PRIVATE_KEY: undefined,
      CUSTOM_VPN_ENV: undefined,
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
      <h2 className="text-lg font-medium border-b border-slate-800 pb-2">VPN</h2>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => update('VPN_ENABLED', e.target.checked ? 'true' : 'false')}
        />
        Route torrent traffic through a VPN (off by default; check to enable)
      </label>

      {!enabled ? (
        <div className="rounded-md border border-slate-700 bg-slate-900/40 p-3 text-sm text-slate-300">
          VPN off (default). qBittorrent runs on the regular network and your
          real public IP is visible to torrent peers. Check the box above to
          add gluetun (Mediarr's VPN container) and route through your provider.
        </div>
      ) : (
        <>
          {/* Provider picker — radio-card grid */}
          <div className="space-y-1">
            <label className="block text-sm font-medium">VPN provider</label>
            <div className="grid grid-cols-2 gap-2">
              {VPN_PROVIDERS.map((p) => {
                const picked = p.id === currentId
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => switchProvider(p.id)}
                    className={
                      'text-left rounded-md border p-2 text-sm transition-colors ' +
                      (picked
                        ? 'border-emerald-600/70 bg-emerald-900/20 text-emerald-100'
                        : 'border-slate-700 bg-slate-800/40 hover:bg-slate-800 text-slate-200')
                    }
                  >
                    <div className="font-medium">{p.label}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{p.blurb}</div>
                  </button>
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
                <input
                  type="password"
                  placeholder="Paste your provider access token"
                  className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
                  value={vpnToken} onChange={(e) => setVpnToken(e.target.value)}
                />
                <button
                  type="button"
                  onClick={fetchVpnKey}
                  disabled={vpnBusy || vpnToken.length < 16}
                  className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
                  title="Fetch and cache the WireGuard private key"
                >
                  {vpnBusy ? 'Fetching…' : 'Fetch key'}
                </button>
              </div>
              {vpnError && <div className="text-rose-300 text-sm">{vpnError}</div>}
              {config.WIREGUARD_PRIVATE_KEY && !vpnError && (
                <div className="text-emerald-300 text-sm">
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

// Phase 1: a single tall scrollable form. Phase 2 splits this into
// per-step screens with auto-detection and country pickers.
export function ConfigureScreen() {
  const { config, setConfig, sessionId, targetDir, setTargetDir, setStep } = useWizard()
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
  const [qbitSameAsArr, setQbitSameAsArr] = useState(true)
  useEffect(() => {
    if (!qbitSameAsArr) return
    const u = config.ARR_USERNAME ?? ''
    const p = config.ARR_PASSWORD ?? ''
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
      setErrors(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
      return
    }
    setErrors([])
    setStep('run')
  }

  return (
    <ConfigCtx.Provider value={{ config, update }}>
    <div className="h-full flex flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto">
    <div className="max-w-3xl mx-auto p-8 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Configure the stack</h1>
        <p className="text-slate-400 mt-1 text-sm">
          These values populate the <code className="bg-slate-800 px-1 rounded">.env</code> file
          uploaded to your NAS. Defaults are sensible — review and adjust.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-medium border-b border-slate-800 pb-2">Install location</h2>
        <p className="text-xs text-slate-400">
          Two paths matter: where the wizard's compose stack + config dirs
          land (<code className="font-mono">INSTALL_DIR</code>), and where your
          media + downloads live (<code className="font-mono">DATA_ROOT</code>).
          The Detect screen auto-fills both based on the NAS family it found
          — override for non-standard layouts.
        </p>
        <div>
          <label className="block text-sm font-medium mb-1">
            Install directory <span className="text-slate-500 text-xs ml-1">(compose stack + per-container configs)</span>
          </label>
          <input
            type="text"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md font-mono text-sm"
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
      </section>

      <ServicesSection config={config} update={update} />

      <section className="space-y-4">
        <h2 className="text-lg font-medium border-b border-slate-800 pb-2">Identity</h2>

        {/* Container user / group — pulled from the NAS's /etc/passwd
            and /etc/group on screen entry. Picking a user auto-fills
            PUID + the user's primary GID; the group select can override
            the GID independently (handy when you want files owned by a
            shared "users" group rather than the user's private group). */}
        <div className="rounded-md border border-slate-700/50 bg-slate-900/40 p-3 space-y-3">
          <label className="block text-sm font-medium">
            Container user / group
            <span className="text-slate-500 text-xs ml-2">
              (these own the media files — pick something other than the install user)
            </span>
          </label>

          {usersError && (
            <div className="text-xs text-rose-300">
              Couldn&apos;t read users from the NAS: {usersError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">User</label>
              <select
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
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
              <label className="block text-xs text-slate-400 mb-1">Group</label>
              <select
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
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

      <section className="space-y-4">
        <h2 className="text-lg font-medium border-b border-slate-800 pb-2">Arr Web UI auth</h2>
        <p className="text-sm text-slate-400">
          Optional. Applied to Sonarr, Radarr, Lidarr, Prowlarr by setup-arr-config.py.
          LAN connections bypass the prompt automatically. Leave blank to skip.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Username" k="ARR_USERNAME" />
          <Field label="Password" k="ARR_PASSWORD" type="password" />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium border-b border-slate-800 pb-2">qBittorrent WebUI</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={qbitSameAsArr}
            onChange={(e) => setQbitSameAsArr(e.target.checked)}
          />
          Use same credentials as ARR Web UI
        </label>
        {!qbitSameAsArr && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Username" k="QBITTORRENT_USER" />
            <Field label="Password (8+ chars)" k="QBITTORRENT_PASS" type="password" />
          </div>
        )}
        {qbitSameAsArr && (
          <p className="text-xs text-slate-500">
            qBittorrent will use{' '}
            <span className="font-mono text-slate-300">
              {config.ARR_USERNAME || '<empty>'}
            </span>{' '}
            from the ARR auth section above. Note: qBittorrent requires the
            password to be at least 8 characters.
          </p>
        )}
      </section>

      {/* Plex claim is collected on the Run screen instead — it expires
          4 minutes after generation, so capturing it earlier risks the
          token going stale while the user fills out other fields. The
          RunScreen has a PlexClaimRefresh widget right above the Start
          button with a live countdown and a "Get fresh token" link. */}
      <section className="rounded-md border border-slate-800 bg-slate-900/30 p-3 text-sm text-slate-400 flex items-start gap-2">
        <span className="text-emerald-400 shrink-0">i</span>
        <span>
          <strong className="text-slate-300">Plex claim token</strong> is
          collected on the <em>next</em> screen, right before install starts —
          tokens expire 4 minutes after you generate them, so we keep it for
          last.
        </span>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium border-b border-slate-800 pb-2">SABnzbd usenet provider</h2>
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
            <label className="block text-sm font-medium mb-1">SSL</label>
            <select
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
              value={config.USENET_SSL ?? '1'}
              onChange={(e) => update('USENET_SSL', e.target.value)}
            >
              <option value="1">On (recommended)</option>
              <option value="0">Off</option>
            </select>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium border-b border-slate-800 pb-2">Usenet indexers</h2>
        <p className="text-sm text-slate-400">
          AnimeTosho, ABNzb, and Althub are added automatically (no key needed).
          Toggle others on if you have an account.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {USENET_INDEXERS.map((d) => (
            <IndexerCard key={d.id} def={d} values={config} onChange={setConfig} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium border-b border-slate-800 pb-2">Private torrent trackers</h2>
        <div className="grid grid-cols-2 gap-3">
          {PRIVATE_TRACKERS.map((d) => (
            <IndexerCard key={d.id} def={d} values={config} onChange={setConfig} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium border-b border-slate-800 pb-2">Bazarr subtitle providers</h2>
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
        <button
          onClick={() => useWizard.getState().setStep('detect')}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md text-sm"
        >
          Back
        </button>
        <div className="flex-1 text-sm text-center">
          {errors.length > 0 ? (
            <span className="text-rose-300">
              ✘ {errors.length} {errors.length === 1 ? 'issue' : 'issues'} above to fix
            </span>
          ) : (
            <span className="text-emerald-300">✓ Ready to install</span>
          )}
        </div>
        <button
          onClick={go}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md text-sm"
        >
          Begin install →
        </button>
      </div>
    </div>
    </div>
    </ConfigCtx.Provider>
  )
}
