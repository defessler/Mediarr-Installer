import { useEffect, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import type { ConnectResult, SavedProfile } from '../../shared/ipc.js'

export function ConnectScreen() {
  const { connection, setConnection, setStep, setSessionId, mode } = useWizard()
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [sudoPassword, setSudoPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectResult | null>(null)
  const [testOk, setTestOk] = useState(false)

  const isNonRoot = (connection.user ?? 'root') !== 'root'

  // ── Profiles ───────────────────────────────────────────────────────────────
  const [profiles, setProfiles] = useState<SavedProfile[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileLabel, setProfileLabel] = useState('')
  const [saveSecret, setSaveSecret] = useState(true)

  async function refreshProfiles() {
    try {
      const list = await window.installer.profiles.list()
      setProfiles(list)
    } catch (e) {
      console.warn('Profile list failed:', e)
    }
  }

  useEffect(() => { refreshProfiles() }, [])

  async function loadProfile(id: string) {
    setSelectedId(id)
    if (!id) return
    const p = profiles.find((x) => x.id === id)
    if (!p) return
    setConnection({
      host: p.host,
      port: p.port,
      user: p.user,
      authMethod: p.authMethod,
      privateKeyPath: p.privateKeyPath,
    })
    // Reset typed-in secrets so we don't mix old + new.
    setPassword('')
    setPassphrase('')
    setResult(null)
    setTestOk(false)

    if (p.hasSecret) {
      const secret = await window.installer.profiles.getSecret(id)
      if (secret !== null) {
        if (p.authMethod === 'password') setPassword(secret)
        else setPassphrase(secret)
      }
    }
  }

  function commonConfig() {
    const user = connection.user ?? 'root'
    return {
      host: connection.host ?? '',
      port: connection.port ?? 22,
      user,
      authMethod: connection.authMethod ?? 'password',
      password: connection.authMethod === 'password' ? password : undefined,
      privateKeyPath: connection.authMethod === 'privateKey' ? connection.privateKeyPath : undefined,
      passphrase: connection.authMethod === 'privateKey' ? passphrase : undefined,
      // Only relevant when user != 'root' — ssh-service ignores it otherwise.
      // For password-auth as a non-root user, default to reusing the SSH
      // password since most Synology setups have the same password for both.
      sudoPassword: user !== 'root'
        ? (sudoPassword || (connection.authMethod === 'password' ? password : undefined))
        : undefined,
    } as const
  }

  async function test() {
    setBusy(true); setResult(null); setTestOk(false)
    try {
      const r = await window.installer.ssh.testConnect(commonConfig())
      setResult(r)
      setTestOk(r.ok)
    } catch (e) {
      setResult({ ok: false, error: { kind: 'unknown', message: (e as Error).message } })
    } finally {
      setBusy(false)
    }
  }

  async function connectAndContinue() {
    setBusy(true)
    try {
      const r = await window.installer.ssh.connect(commonConfig())
      setSessionId(r.sessionId)
      if (selectedId) {
        // Best effort — non-fatal if it fails (e.g. file locked)
        window.installer.profiles.touch(selectedId).catch(() => {})
      }
      // Install flow probes the environment first; update flow jumps
      // straight to running docker compose pull.
      setStep(mode === 'update' ? 'run-update' : 'detect')
    } catch (e) {
      setResult({ ok: false, error: { kind: 'unknown', message: (e as Error).message } })
    } finally {
      setBusy(false)
    }
  }

  async function saveProfile() {
    const label = profileLabel.trim() || `${connection.user ?? 'root'}@${connection.host ?? ''}`
    const secret =
      saveSecret
        ? (connection.authMethod === 'password' ? password : passphrase) || undefined
        : undefined
    try {
      await window.installer.profiles.save({
        id: selectedId || undefined,
        label,
        host: connection.host ?? '',
        port: connection.port ?? 22,
        user: connection.user ?? 'root',
        authMethod: connection.authMethod ?? 'password',
        privateKeyPath: connection.authMethod === 'privateKey' ? connection.privateKeyPath : undefined,
        secret,
      })
      setSavingProfile(false)
      setProfileLabel('')
      await refreshProfiles()
    } catch (e) {
      setResult({ ok: false, error: { kind: 'unknown', message: 'Profile save failed: ' + (e as Error).message } })
    }
  }

  async function deleteSelected() {
    if (!selectedId) return
    if (!window.confirm('Delete this saved profile?')) return
    await window.installer.profiles.delete(selectedId)
    setSelectedId('')
    await refreshProfiles()
  }

  // Smart-parse the host field: strip http(s)://, trailing path, and
  // pull `host:port` apart so the user can paste their DSM URL and we
  // still get the right hostname for SSH.
  function parseHost(input: string): { host: string; port?: number } {
    let s = input.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
    const m = s.match(/^([^:]+):(\d+)$/)
    if (m) return { host: m[1], port: Number(m[2]) }
    return { host: s }
  }

  function onHostChange(raw: string) {
    const { host, port } = parseHost(raw)
    const patch: { host: string; port?: number } = { host }
    if (port !== undefined) patch.port = port
    setConnection(patch)
  }

  return (
    <div className="h-full overflow-y-auto">
    <div className="max-w-2xl mx-auto p-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            Connect to your NAS
            {mode === 'update' && (
              <span className="ml-2 text-sm text-sky-400 align-middle">(update mode)</span>
            )}
          </h1>
          <p className="text-slate-400 mt-1 text-sm">
            For the cleanest install, log in as <code className="bg-slate-800 px-1 rounded">root</code>.
            On Synology: Control Panel &rarr; Terminal &rarr; enable SSH; then set a root password.
          </p>
        </div>
        <button
          onClick={() => setStep('welcome')}
          className="text-sm text-slate-400 hover:text-slate-200 shrink-0"
        >
          ← Back to start
        </button>
      </div>

      {/* ── Saved profile picker ──────────────────────────────────────────── */}
      {profiles.length > 0 && (
        <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 space-y-2">
          <label className="block text-xs uppercase tracking-wide text-slate-400">
            Saved profile
          </label>
          <div className="flex gap-2">
            <select
              className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
              value={selectedId}
              onChange={(e) => loadProfile(e.target.value)}
            >
              <option value="">— Use new connection —</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.user}@{p.host})
                </option>
              ))}
            </select>
            {selectedId && (
              <button
                onClick={deleteSelected}
                className="px-3 py-2 text-sm bg-rose-900/40 hover:bg-rose-900/60 text-rose-200 rounded-md"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <label className="block text-sm font-medium mb-1">Host</label>
          <input
            type="text" placeholder="192.168.1.10  (NOT your DSM URL — that's port 5000)"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
            value={connection.host ?? ''}
            onChange={(e) => onHostChange(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">
            Port
            <span className="text-slate-500 text-xs ml-1">(SSH = 22)</span>
          </label>
          <input
            type="number"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
            value={connection.port ?? 22}
            onChange={(e) => setConnection({ port: Number(e.target.value) || 22 })}
          />
          {connection.port && [80, 443, 5000, 5001].includes(connection.port) && (
            <p className="mt-1 text-xs text-amber-300">
              Port {connection.port} is for HTTP/DSM, not SSH. Try 22.
            </p>
          )}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">User</label>
        <input
          type="text"
          className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
          value={connection.user ?? 'root'}
          onChange={(e) => setConnection({ user: e.target.value })}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Authentication</label>
        <div className="flex gap-4 mb-3">
          <label className="flex items-center gap-2">
            <input type="radio" checked={connection.authMethod === 'password'}
              onChange={() => setConnection({ authMethod: 'password' })} />
            Password
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={connection.authMethod === 'privateKey'}
              onChange={() => setConnection({ authMethod: 'privateKey' })} />
            Private key
          </label>
        </div>
        {connection.authMethod === 'password' ? (
          <input
            type="password" placeholder="SSH password"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
        ) : (
          <div className="space-y-2">
            <input
              type="text" placeholder="C:\Users\you\.ssh\id_ed25519"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
              value={connection.privateKeyPath ?? ''}
              onChange={(e) => setConnection({ privateKeyPath: e.target.value })}
            />
            <input
              type="password" placeholder="Passphrase (if encrypted)"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
              value={passphrase} onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* Sudo password — only relevant for non-root SSH users.
          Several setup steps (iptables, chmod, /usr/local/etc/rc.d
          install) need root, so we wrap them in `sudo -S` and pipe
          the password to stdin. */}
      {isNonRoot && (
        <div className="rounded-md border border-amber-700/40 bg-amber-900/10 p-3 space-y-2">
          <label className="block text-sm font-medium">
            Sudo password
            <span className="ml-2 text-xs text-amber-300">
              ({connection.user} is not root — needed for firewall + chmod steps)
            </span>
          </label>
          <input
            type="password"
            placeholder={connection.authMethod === 'password'
              ? 'Leave blank to reuse the SSH password'
              : 'Required for non-root key auth'}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
            value={sudoPassword} onChange={(e) => setSudoPassword(e.target.value)}
          />
          <p className="text-xs text-slate-400">
            Stored in memory only — never written to disk or saved to your
            connection profile.
          </p>
        </div>
      )}

      {/* ── Save profile UI ───────────────────────────────────────────────── */}
      {savingProfile ? (
        <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Profile name</label>
            <input
              type="text" placeholder={`${connection.user ?? 'root'}@${connection.host ?? 'host'}`}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
              value={profileLabel} onChange={(e) => setProfileLabel(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox" checked={saveSecret}
              onChange={(e) => setSaveSecret(e.target.checked)}
            />
            Also save the {connection.authMethod === 'password' ? 'password' : 'key passphrase'} (encrypted via OS keystore)
          </label>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setSavingProfile(false); setProfileLabel('') }}
              className="px-3 py-2 text-sm bg-slate-700 hover:bg-slate-600 rounded-md"
            >Cancel</button>
            <button
              onClick={saveProfile}
              className="px-3 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 rounded-md"
            >Save</button>
          </div>
        </div>
      ) : (
        <div className="text-right">
          <button
            onClick={() => setSavingProfile(true)}
            disabled={!connection.host}
            className="text-sm text-emerald-400 hover:underline disabled:opacity-40"
          >
            {selectedId ? 'Update saved profile' : 'Save as profile'}
          </button>
        </div>
      )}

      {result && (
        <div className={`rounded-md px-3 py-2 text-sm ${result.ok ? 'bg-emerald-900/40 text-emerald-200' : 'bg-rose-900/40 text-rose-200'}`}>
          {result.ok
            ? 'Connection successful'
            : `${result.error?.kind}: ${result.error?.message}`}
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          onClick={test} disabled={busy || !connection.host}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
        >
          {busy ? 'Testing...' : 'Test connection'}
        </button>
        <button
          onClick={connectAndContinue} disabled={busy || !testOk}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-40 ml-auto"
        >
          Continue
        </button>
      </div>
    </div>
    </div>
  )
}
