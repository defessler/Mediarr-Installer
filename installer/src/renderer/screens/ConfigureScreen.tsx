import { useState } from 'react'
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

// Phase 1: a single tall scrollable form. Phase 2 splits this into
// per-step screens with auto-detection and country pickers.
export function ConfigureScreen() {
  const { config, setConfig, targetDir, setTargetDir, setStep } = useWizard()
  const [errors, setErrors] = useState<string[]>([])
  const [vpnToken, setVpnToken] = useState('')
  const [vpnBusy, setVpnBusy] = useState(false)
  const [vpnError, setVpnError] = useState<string | null>(null)
  const [countries, setCountries] = useState<Country[]>([])

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

  const Field = ({ label, k, type = 'text', placeholder }: {
    label: string; k: keyof EnvFormValues; type?: string; placeholder?: string
  }) => (
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

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-8 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 80px)' }}>
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
        <div className="grid grid-cols-2 gap-4">
          <Field label="Username" k="QBITTORRENT_USER" />
          <Field label="Password (8+ chars)" k="QBITTORRENT_PASS" type="password" />
        </div>
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
  )
}
