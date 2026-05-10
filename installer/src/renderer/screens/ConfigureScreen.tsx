import { createContext, useContext, useEffect, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import { envSchema } from '../../shared/env-schema.js'
import {
  type EnvFormValues,
  USENET_INDEXERS,
  PRIVATE_TRACKERS,
  BAZARR_PROVIDERS,
} from '../../shared/env-render.js'
import type { Country } from '../../shared/ipc.js'
import { IndexerCard } from '../components/IndexerCard.js'
import { TimezoneSelect } from '../components/TimezoneSelect.js'

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
        if (!cancelled) setUsersError((e as Error).message)
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
      setConfig({ NORDVPN_PRIVATE_KEY: r.privateKey })
      setCountries(r.countries)
    } catch (e) {
      setVpnError((e as Error).message)
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
    <div className="h-full overflow-y-auto">
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
        <div>
          <label className="block text-sm font-medium mb-1">Target directory on NAS</label>
          <input
            type="text"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
            value={targetDir} onChange={(e) => setTargetDir(e.target.value)}
          />
        </div>
      </section>

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
                {users.length === 0 && !usersError && (
                  <option disabled>Loading users from NAS...</option>
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
                {groups.length === 0 && !usersError && (
                  <option disabled>Loading groups from NAS...</option>
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

      <section className="space-y-4">
        <h2 className="text-lg font-medium border-b border-slate-800 pb-2">VPN (NordVPN WireGuard)</h2>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={(config.VPN_ENABLED ?? 'false').toLowerCase() === 'true'}
            onChange={(e) =>
              update('VPN_ENABLED', e.target.checked ? 'true' : 'false')
            }
          />
          Route torrent traffic through a VPN (off by default; check to enable)
        </label>

        {(config.VPN_ENABLED ?? 'false').toLowerCase() !== 'true' ? (
          <div className="rounded-md border border-slate-700 bg-slate-900/40 p-3 text-sm text-slate-300">
            VPN off (default). qBittorrent will run on the regular network
            and your real public IP will be visible to torrent peers.
            Check the box above to add gluetun and route through NordVPN.
          </div>
        ) : (
          <>
        <p className="text-sm text-slate-400">
          Paste your NordVPN access token (Account &rarr; Set up NordVPN
          manually). We&apos;ll fetch the WireGuard private key directly from
          the NordVPN API.
        </p>

        <div>
          <label className="block text-sm font-medium mb-1">NordVPN access token</label>
          <div className="flex gap-2">
            <input
              type="password" placeholder="64-char hex token"
              className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
              value={vpnToken} onChange={(e) => setVpnToken(e.target.value)}
            />
            <button
              type="button"
              onClick={fetchVpnKey}
              disabled={vpnBusy || vpnToken.length < 16}
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
            >
              {vpnBusy ? 'Fetching...' : 'Fetch key'}
            </button>
          </div>
          {vpnError && (
            <div className="mt-2 text-rose-300 text-sm">{vpnError}</div>
          )}
          {config.NORDVPN_PRIVATE_KEY && !vpnError && (
            <div className="mt-2 text-emerald-300 text-sm">
              Got it — {config.NORDVPN_PRIVATE_KEY.length}-char WireGuard key cached.
            </div>
          )}
        </div>

        <Field label="Countries (comma-separated)" k="VPN_COUNTRIES" placeholder="United States,Canada" />
        {countries.length > 0 && (
          <details className="text-xs text-slate-400">
            <summary className="cursor-pointer">Available countries ({countries.length})</summary>
            <div className="mt-2 max-h-32 overflow-y-auto font-mono">
              {countries.map((c) => c.name).join(', ')}
            </div>
          </details>
        )}

        <div>
          <label className="block text-sm font-medium mb-1">
            WireGuard private key (auto-filled by Fetch key)
          </label>
          <textarea
            rows={2}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
            value={config.NORDVPN_PRIVATE_KEY ?? ''}
            onChange={(e) => update('NORDVPN_PRIVATE_KEY', e.target.value || undefined)}
          />
        </div>
          </>
        )}
      </section>

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

      <section className="space-y-4">
        <h2 className="text-lg font-medium border-b border-slate-800 pb-2">Plex</h2>
        <p className="text-sm text-slate-400">
          Get a token from{' '}
          <a className="text-emerald-400 underline" href="https://plex.tv/claim" target="_blank">plex.tv/claim</a>
          {' '}— expires in 4 minutes.
        </p>
        <Field label="Plex claim token" k="PLEX_CLAIM" placeholder="claim-xxxx" />
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

      {errors.length > 0 && (
        <div className="bg-rose-900/40 text-rose-200 rounded-md p-3 text-sm">
          <div className="font-medium mb-1">Fix these before continuing:</div>
          <ul className="list-disc list-inside space-y-0.5">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      <div className="flex justify-between pt-4 border-t border-slate-800">
        <button
          onClick={() => useWizard.getState().setStep('detect')}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md"
        >
          Back
        </button>
        <button
          onClick={go}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md"
        >
          Begin install →
        </button>
      </div>
    </div>
    </div>
    </ConfigCtx.Provider>
  )
}
