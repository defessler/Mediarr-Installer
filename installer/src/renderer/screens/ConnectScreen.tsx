import { useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import {
  ArrowLeft, ArrowRight, Plug, ShieldCheck, AlertCircle, CheckCircle2,
  Lock, KeyRound, Users, Shield, AlertTriangle, RefreshCw,
} from 'lucide-react'
import { useWizard, type WizardStep } from '../store/wizard.js'
import { BigButton } from '../components/BigButton.js'
import { PasswordInput } from '../components/PasswordInput.js'
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

  const reduced = useReducedMotion()
  return (
    <div className="h-full flex flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto">
    <div className="max-w-2xl mx-auto px-8 py-10 space-y-7">
      <motion.header
        initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="text-center"
      >
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-500/20 to-sky-700/30 border border-sky-500/30 mb-4">
          <Plug size={32} className="text-sky-300" strokeWidth={1.5} />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">
          Connect to your NAS
          {mode === 'update' && (
            <span className="inline-flex items-center gap-1 ml-3 align-middle text-xs font-semibold uppercase tracking-wider text-sky-300 bg-sky-500/15 border border-sky-500/30 rounded-full px-2 py-0.5">
              <RefreshCw size={10} strokeWidth={2.5} />
              Update
            </span>
          )}
          {mode === 'migrate' && (
            <span className="inline-flex items-center gap-1 ml-3 align-middle text-xs font-semibold uppercase tracking-wider text-amber-300 bg-amber-500/15 border border-amber-500/30 rounded-full px-2 py-0.5">
              <ArrowRight size={10} strokeWidth={2.5} />
              Migrate
            </span>
          )}
        </h1>
        <p className="text-slate-400 mt-2 text-base max-w-lg mx-auto">
          On Synology: <span className="text-slate-300">Control Panel → Terminal → enable SSH</span> first.
          Use your admin user — DSM 7 disables root login by default.
        </p>
      </motion.header>

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
            className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded transition-colors"
          >
            <Users size={11} />
            Switch profile
          </button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <label className="block text-sm font-medium mb-1">Host</label>
          {/* Border tint reflects what we think of the entered value:
              emerald for a parseable host (IP / hostname), slate for
              empty, no tint while typing partial values. Helps a kid
              know "yes that's a valid-looking host" without making
              them click Test to find out. */}
          <input
            type="text" placeholder="192.168.1.10  (NOT your DSM URL — that's port 5000)"
            className={
              'w-full px-3 py-2.5 bg-slate-800 border rounded-md focus:outline-none focus:ring-1 transition-colors ' +
              (connection.host && /^([\w-]+\.)+[\w-]+$|^\d+\.\d+\.\d+\.\d+$/.test(connection.host)
                ? 'border-emerald-700/50 focus:border-emerald-500 focus:ring-emerald-500/40'
                : 'border-slate-700 focus:border-emerald-500 focus:ring-emerald-500/40')
            }
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
            className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
            value={connection.port ?? 22}
            onChange={(e) => setConnection({ port: Number(e.target.value) || 22 })}
          />
          {connection.port && [80, 443, 5000, 5001].includes(connection.port) && (
            <motion.p
              initial={reduced ? { opacity: 1 } : { opacity: 0, y: -2 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
              className="mt-1 text-xs text-amber-300 inline-flex items-center gap-1.5"
            >
              <AlertTriangle size={11} className="shrink-0" />
              Port {connection.port} is for HTTP/DSM, not SSH. Try 22.
            </motion.p>
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
        {/* Segmented control. Bare <input type="radio"> here was hard
            to hit (tiny dot, no hover feedback) and visually inert.
            Two big pills with icons read as "tap one of these" in a
            way radios never do, and Motion's layoutId slides the
            selected highlight between them when the choice changes. */}
        <div
          role="radiogroup"
          aria-label="Authentication method"
          className="relative inline-flex p-1 bg-slate-900 border border-slate-800 rounded-lg mb-3 gap-1"
        >
          {([
            { value: 'password',   label: 'Password',    Icon: Lock },
            { value: 'privateKey', label: 'Private key', Icon: KeyRound },
          ] as const).map(({ value, label, Icon }) => {
            const selected = connection.authMethod === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setConnection({ authMethod: value })}
                className={
                  'relative z-10 inline-flex items-center gap-2 px-4 h-9 rounded-md text-sm font-medium ' +
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ' +
                  'focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 transition-colors ' +
                  (selected ? 'text-white' : 'text-slate-400 hover:text-slate-200')
                }
              >
                {selected && (
                  <motion.span
                    layoutId="connect-auth-pill"
                    className="absolute inset-0 bg-emerald-600 rounded-md shadow-md shadow-emerald-900/40 border border-emerald-400/30 -z-10"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <Icon size={14} />
                {label}
              </button>
            )
          })}
        </div>
        {connection.authMethod === 'password' ? (
          <PasswordInput
            placeholder="SSH password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        ) : (
          <div className="space-y-2">
            <input
              type="text" placeholder="C:\Users\you\.ssh\id_ed25519"
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
              value={connection.privateKeyPath ?? ''}
              onChange={(e) => setConnection({ privateKeyPath: e.target.value })}
            />
            <PasswordInput
              placeholder="Passphrase (if encrypted)"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* Sudo password — only relevant for non-root SSH users.
          Several setup steps (iptables, chmod, /usr/local/etc/rc.d
          install) need root, so we wrap them in `sudo -S` and pipe
          the password to stdin. */}
      {isNonRoot && (
        <motion.div
          initial={reduced ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="rounded-md border border-amber-700/40 bg-amber-900/10 p-3 space-y-2 overflow-hidden"
        >
          <label className="block text-sm font-medium inline-flex items-center gap-2">
            <Shield size={14} className="text-amber-300" strokeWidth={2} />
            Sudo password
            <span className="ml-1 text-xs text-amber-300/90 font-normal">
              ({connection.user} is not root — needed for firewall + chmod)
            </span>
          </label>
          <PasswordInput
            placeholder={connection.authMethod === 'password'
              ? 'Leave blank to reuse the SSH password'
              : 'Required for non-root key auth'}
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
          />
          <p className="text-xs text-slate-400 inline-flex items-center gap-1.5">
            <Lock size={11} className="text-slate-500" />
            Stored in memory only — never written to disk or saved to your
            connection profile.
          </p>
        </motion.div>
      )}

      {/* (Save UI removed — auto-save handles writing changes back to
          the active profile. Switch profiles via the link above or
          the Welcome step.) */}

      {/* Animated test-result banner. Two states (success / error)
          slide in from the bottom and stay until the form changes. */}
      <AnimatePresence>
        {result && (
          <motion.div
            key={result.ok ? 'ok' : 'err'}
            initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className={
              `rounded-lg px-4 py-3 text-sm flex items-start gap-3 border ` +
              (result.ok
                ? 'bg-emerald-950/40 border-emerald-700/50 text-emerald-100'
                : 'bg-rose-950/40 border-rose-700/50 text-rose-100')
            }
          >
            {result.ok ? (
              <CheckCircle2 size={20} className="text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle size={20} className="text-rose-400 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              {result.ok ? (
                <>
                  <div className="font-semibold">Connection successful</div>
                  <div className="text-emerald-200/70 text-xs mt-0.5">
                    Logged in as{' '}
                    <span className="font-mono text-emerald-100">
                      {connection.user ?? 'root'}@{connection.host}
                    </span>
                    {connection.port && connection.port !== 22 && (
                      <span className="font-mono text-emerald-100">:{connection.port}</span>
                    )}
                    {' '}— click Continue to open the SSH session.
                  </div>
                </>
              ) : (
                <>
                  <div className="font-semibold flex items-center gap-2">
                    Couldn't connect
                    <span className="text-xs text-rose-300/70 font-mono">{result.error?.kind}</span>
                  </div>
                  <div className="text-rose-200/80 text-xs mt-0.5 whitespace-pre-wrap font-mono">
                    {result.error?.message}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </div>

    {/* Sticky footer: Back / status / Test / Continue. Two-stage CTA —
        Test verifies, Continue (highlighted only after Test passes)
        opens the persistent session. Mistake-proof: a child can't
        accidentally proceed without confirming the credentials. */}
    <div className="border-t border-slate-800 bg-slate-950 px-8 py-3 shrink-0">
      <div className="max-w-2xl mx-auto flex items-center gap-3">
        <BigButton
          size="md"
          variant="secondary"
          icon={<ArrowLeft size={16} />}
          onClick={() => setStep('welcome')}
        >
          Back
        </BigButton>
        <div className="flex-1" />
        <BigButton
          size="md"
          variant={testOk ? 'secondary' : 'primary'}
          icon={<ShieldCheck size={16} />}
          loading={busy && !testOk}
          disabled={busy || !connection.host}
          onClick={test}
          title={
            busy
              ? 'Already testing — wait for the result'
              : !connection.host
                ? 'Enter a host (e.g. 192.168.1.10) first'
                : 'Try the SSH credentials without persisting a session'
          }
        >
          {busy && !testOk ? 'Testing...' : testOk ? 'Re-test' : 'Test connection'}
        </BigButton>
        <BigButton
          size="md"
          variant="primary"
          trailingIcon={<ArrowRight size={16} />}
          loading={busy && testOk}
          disabled={busy || !testOk}
          onClick={connectAndContinue}
          title={
            !testOk
              ? 'Run "Test connection" first and confirm it succeeds'
              : 'Open the SSH session and advance to the next step'
          }
        >
          Continue
        </BigButton>
      </div>
    </div>
    </div>
  )
}
