import { useWizard } from '../store/wizard.js'

export function WelcomeScreen() {
  const { setMode, setStep } = useWizard()

  function pick(mode: 'install' | 'update') {
    setMode(mode)
    setStep('connect')
  }

  return (
    <div className="h-full overflow-y-auto">
    <div className="max-w-3xl mx-auto p-8 space-y-8">
      <header>
        <h1 className="text-3xl font-semibold">NAS Arr Installer</h1>
        <p className="text-slate-400 mt-2">
          A guided wizard for installing or updating the Arr media stack on your
          Synology NAS over SSH. Wraps the bash + Python automation in this repo.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => pick('install')}
          className="text-left p-6 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-emerald-700 rounded-md transition-colors"
        >
          <div className="text-emerald-400 text-sm uppercase tracking-wider mb-2">
            Fresh install
          </div>
          <div className="text-lg font-medium mb-1">Set up the stack</div>
          <div className="text-sm text-slate-400">
            Full wizard: detect environment, fill config, upload payload, run
            <code className="bg-slate-900 px-1 rounded mx-1">setup.sh</code>,
            and verify health.
          </div>
        </button>

        <button
          onClick={() => pick('update')}
          className="text-left p-6 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-sky-700 rounded-md transition-colors"
        >
          <div className="text-sky-400 text-sm uppercase tracking-wider mb-2">
            Update existing
          </div>
          <div className="text-lg font-medium mb-1">Pull newer images</div>
          <div className="text-sm text-slate-400">
            Skips the wizard; just runs
            <code className="bg-slate-900 px-1 rounded mx-1">docker compose pull</code>
            and
            <code className="bg-slate-900 px-1 rounded mx-1">up -d</code>
            on an existing install.
          </div>
        </button>
      </div>

      <section className="rounded-md border border-slate-800 bg-slate-900/40 p-4 space-y-2 text-sm">
        <h2 className="font-medium">Before you begin</h2>
        <ul className="space-y-1.5 text-slate-300 list-disc list-inside">
          <li>
            SSH is enabled on the NAS (Control Panel &rarr; Terminal &amp; SNMP).
          </li>
          <li>
            Docker is installed via Synology Package Center.
          </li>
          <li>
            For fresh installs: a NordVPN account (for the WireGuard key) and a
            Plex account (for the claim token).
          </li>
        </ul>
      </section>
    </div>
    </div>
  )
}
