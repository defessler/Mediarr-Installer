import { useState } from 'react'
import { useWizard, type WizardStep } from '../store/wizard.js'
import type { ConnectResult } from '../../shared/ipc.js'

export function ConnectScreen() {
  const {
    connection, setConnection, setStep, setSessionId, mode, activeProfileId, activeProfileLabel,
  } = useWizard()
  // Passwords live in the wizard store and (via auto-save) in the
  // active profile. Reading/writing them through setConnection means
  // any change automatically syncs to disk. See useProfileAutosave.
  const password = connection.password ?? ''
  const setPassword = (v: string) => setConnection({ password: v })
  const passphrase = connection.passphrase ?? ''
  const setPassphrase = (v: string) => setConnection({ passphrase: v })
  const sudoPassword = connection.sudoPassword ?? ''
  const setSudoPassword = (v: string) => setConnection({ sudoPassword: v })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectResult | null>(null)
  const [testOk, setTestOk] = useState(false)

  const isNonRoot = (connection.user ?? 'root') !== 'root'

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
      if (activeProfileId) {
        window.installer.profiles.touch(activeProfileId).catch(() => {})
      }
      // Install flow probes the environment first; update flow jumps
      // straight to running docker compose pull; migrate flow goes
      // straight to the library-import screen (which reads .env API
      // keys over the freshly-established SSH session on mount).
      const next: WizardStep =
        mode === 'update'  ? 'run-update'
        : mode === 'migrate' ? 'migrate'
        : 'detect'
      setStep(next)
    } catch (e) {
      setResult({ ok: false, error: { kind: 'unknown', message: (e as Error).message } })
    } finally {
      setBusy(false)
    }
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
    <div className="h-full flex flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto">
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
            On Synology: Control Panel &rarr; Terminal &rarr; enable SSH first.
            Logging in as your admin user (with a sudo password below) is the
            easiest path — DSM7 disables root SSH by default and you&apos;d
            need to re-enable it manually.
          </p>
        </div>
        <button
          onClick={() => setStep('welcome')}
          className="text-sm text-slate-400 hover:text-slate-200 shrink-0"
        >
          ← Back to start
        </button>
      </div>

      {/* Active profile reminder — picker now lives on Welcome.
          (Note: the App-level header pill also shows this — kept here
          so it's adjacent to the auth fields the user is editing.) */}
      {activeProfileId && activeProfileLabel && (
        <div className="rounded-md border border-slate-800 bg-slate-900/30 p-2 text-xs text-slate-400 flex items-center justify-between">
          <span>
            Editing profile{' '}
            <span className="text-slate-200 font-medium">{activeProfileLabel}</span>
            {' '}— all changes auto-save.
          </span>
          <button
            onClick={() => setStep('welcome')}
            className="text-emerald-400 hover:underline"
          >
            Switch profile
          </button>
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

      {/* (Save UI removed — auto-save handles writing changes back to
          the active profile. Switch profiles via the link above or
          the Welcome step.) */}

      {/* Full multi-line error stays in the scroll body — long messages
          (sudo hints, DSM7 advice) need room. The footer below shows a
          compact one-line summary so the buttons can stay pinned. */}
      {result && !result.ok && (
        <div className="rounded-md px-3 py-2 text-sm whitespace-pre-wrap font-mono bg-rose-900/40 text-rose-200">
          {result.error?.kind}: {result.error?.message}
        </div>
      )}
    </div>
    </div>

    {/* Sticky footer: Back / inline status / Test / Continue are always
        visible regardless of how far the form has been scrolled. */}
    <div className="border-t border-slate-800 bg-slate-950 px-8 py-3 shrink-0">
      <div className="max-w-2xl mx-auto flex items-center gap-3">
        <button
          onClick={() => setStep('welcome')}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md text-sm"
        >
          Back
        </button>
        <div className="flex-1 text-sm text-center">
          {busy ? (
            <span className="text-slate-400">Working...</span>
          ) : result?.ok ? (
            <span className="text-emerald-300">✓ Connection successful</span>
          ) : result && !result.ok ? (
            <span className="text-rose-300">
              ✘ {result.error?.kind} — see details above
            </span>
          ) : null}
        </div>
        <button
          onClick={test} disabled={busy || !connection.host}
          title={
            busy
              ? 'Already testing — wait for the result'
              : !connection.host
                ? 'Enter a host (e.g. 192.168.1.10) first'
                : 'Try the SSH credentials without persisting a session'
          }
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40 text-sm"
        >
          {busy ? 'Testing...' : 'Test connection'}
        </button>
        <button
          onClick={connectAndContinue} disabled={busy || !testOk}
          title={
            busy
              ? 'Working — please wait'
              : !testOk
                ? 'Run "Test connection" first and confirm it succeeds'
                : 'Open the SSH session and advance to the next step'
          }
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-40 text-sm"
        >
          Continue
        </button>
      </div>
    </div>
    </div>
  )
}
