import { useWizard } from '../store/wizard.js'

const SERVICES: { name: string; port: string; note?: string }[] = [
  { name: 'Homepage',    port: '3000',  note: 'Start here' },
  { name: 'Plex',        port: '32400/web' },
  { name: 'Sonarr',      port: '49152' },
  { name: 'Radarr',      port: '49151' },
  { name: 'Lidarr',      port: '49154' },
  { name: 'Prowlarr',    port: '49150' },
  { name: 'Bazarr',      port: '49153' },
  { name: 'SABnzbd',     port: '49155' },
  { name: 'qBittorrent', port: '49156' },
  { name: 'Seerr',       port: '5056' },
  { name: 'Tautulli',    port: '8181' },
]

export function DoneScreen() {
  const { config, reset } = useWizard()
  const ip = config.LAN_IP ?? '<NAS-IP>'

  function open(url: string) {
    window.open(url, '_blank')
  }

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Setup complete</h1>
        <p className="text-slate-400 mt-1 text-sm">
          Click any service to open it in your browser. Some services need a
          one-time wizard (Plex, Tautulli, Seerr) — see the manual steps below.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3">
        {SERVICES.map((s) => {
          const url = `http://${ip}:${s.port}`
          return (
            <button
              key={s.name}
              onClick={() => open(url)}
              className="text-left p-3 bg-slate-800 hover:bg-slate-700 rounded-md border border-slate-700"
            >
              <div className="font-medium">
                {s.name} {s.note && <span className="text-emerald-400 text-xs ml-1">{s.note}</span>}
              </div>
              <div className="text-xs text-slate-400 font-mono">{url}</div>
            </button>
          )
        })}
      </div>

      <section className="space-y-2 border-t border-slate-800 pt-6">
        <h2 className="text-lg font-medium">Manual steps still needed</h2>
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-300">
          <li>
            Open <span className="font-mono text-emerald-400">http://{ip}:5056</span> and
            run the Seerr wizard. Connect Plex with the URL{' '}
            <span className="font-mono">http://plex:32400</span>.
          </li>
          <li>
            Open <span className="font-mono text-emerald-400">http://{ip}:8181</span> for Tautulli.
            Get a Plex token from Plex → Settings → Troubleshooting → Get X-Plex-Token.
          </li>
          <li>
            Open SABnzbd at <span className="font-mono text-emerald-400">http://{ip}:49155</span>{' '}
            and add your usenet provider under Config → Servers.
          </li>
        </ol>
      </section>

      <div className="flex justify-end pt-4 border-t border-slate-800">
        <button
          onClick={reset}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md"
        >
          Start over
        </button>
      </div>
    </div>
  )
}
