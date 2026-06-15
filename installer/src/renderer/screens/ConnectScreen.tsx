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
import { toConnectConfig } from '../../shared/connect-config.js'

export function ConnectScreen() {
  const {
    connection, setConnection, setStep, setSessionId, mode, activeProfileId, activeProfileLabel,
  } = useWizard()
  // Passwords live in the wizard store and (via auto-save) in the
  // active profile. Reading/writing them through setConnection means
  // any change automatically syncs to disk. See useProfileAutosave.
  // NOTE: these go through editConnection (defined below) so changing a
  // password/passphrase/sudo password also invalidates a prior Test —
  // same as every other connection field.
  const password = connection.password ?? ''
  const setPassword = (v: string) => editConnection({ password: v })
  const passphrase = connection.passphrase ?? ''
  const setPassphrase = (v: string) => editConnection({ passphrase: v })
  const sudoPassword = connection.sudoPassword ?? ''
  const setSudoPassword = (v: string) => editConnection({ sudoPassword: v })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectResult | null>(null)
  const [testOk, setTestOk] = useState(false)

  // WHY: a green "verified" + enabled Continue must only ever describe the
  // exact credentials that were tested. Editing ANY connection field
  // (host/port/user/auth method/password/key/passphrase/sudo) invalidates a
  // prior Test, so route every field edit through here to clear testOk and
  // the result banner — forcing a re-test of the changed credentials before
  // Continue re-enables. Pure field edits all funnel through this wrapper.
  type ConnectionPatch = Parameters<typeof setConnection>[0]
  const editConnection = (patch: ConnectionPatch) => {
    setTestOk(false)
    setResult(null)
    setConnection(patch)
  }

  const isNonRoot = (connection.user ?? 'root') !== 'root'

  // Delegates to the shared builder so the initial connect here and the
  // reconnect-and-resume flow in RunScreen always produce an identical config.
  // (password / passphrase / sudoPassword are just connection.* ?? '' — see
  // above — so passing `connection` through reproduces this exactly.)
  function commonConfig() {
    return toConnectConfig(connection)
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
    // editConnection: editing the host invalidates a prior Test.
    editConnection(patch)
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
          <Plug size={36} className="text-sky-300" strokeWidth={1.5} aria-hidden="true" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">
          Connect to your NAS
          {mode === 'update' && (
            <span className="inline-flex items-center gap-1 ml-3 align-middle text-xs font-semibold uppercase tracking-wider text-sky-300 bg-sky-500/15 border border-sky-500/30 rounded-full px-2 py-0.5">
              <RefreshCw size={12} strokeWidth={2.5} aria-hidden="true" />
              Update
            </span>
          )}
          {mode === 'migrate' && (
            <span className="inline-flex items-center gap-1 ml-3 align-middle text-xs font-semibold uppercase tracking-wider text-amber-300 bg-amber-500/15 border border-amber-500/30 rounded-full px-2 py-0.5">
              <ArrowRight size={12} strokeWidth={2.5} aria-hidden="true" />
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
            <Users size={13} aria-hidden="true" />
            Switch profile
          </button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <label className="block text-sm font-medium mb-1" htmlFor="ssh-host">Host</label>
          {/* Border tint reflects what we think of the entered value:
              emerald for a parseable host (IP / hostname), slate for
              empty, no tint while typing partial values. Helps a kid
              know "yes that's a valid-looking host" without making
              them click Test to find out. */}
          {(() => {
            const hostValue = connection.host ?? ''
            const looksValid = /^([\w-]+\.)+[\w-]+$|^\d+\.\d+\.\d+\.\d+$/.test(hostValue)
            return (
              <input
                id="ssh-host"
                type="text"
                placeholder="192.168.1.10  (NOT your DSM URL — that's port 5000)"
                aria-required="true"
                aria-invalid={hostValue.length > 0 && !looksValid ? true : undefined}
                aria-describedby="host-hint"
                className={
                  'w-full px-3 py-2.5 bg-slate-800 border rounded-md focus:outline-none focus:ring-1 transition-colors ' +
                  (looksValid
                    ? 'border-emerald-700/50 focus:border-emerald-500 focus:ring-emerald-500/40'
                    : 'border-slate-700 focus:border-emerald-500 focus:ring-emerald-500/40')
                }
                value={hostValue}
                onChange={(e) => onHostChange(e.target.value)}
              />
            )
          })()}
          <span id="host-hint" className="sr-only">
            Enter your NAS LAN IP or hostname. The wizard accepts pasted DSM
            URLs and will strip the http(s):// and trailing path.
          </span>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="ssh-port">
            Port
            <span className="text-slate-500 text-xs ml-1">(SSH = 22)</span>
          </label>
          <input
            id="ssh-port"
            type="number"
            className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
            value={connection.port ?? 22}
            onChange={(e) => editConnection({ port: Number(e.target.value) || 22 })}
          />
          {connection.port && [80, 443, 5000, 5001].includes(connection.port) && (
            <motion.p
              initial={reduced ? { opacity: 1 } : { opacity: 0, y: -2 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
              className="mt-1 text-xs text-amber-300 inline-flex items-center gap-1.5"
            >
              <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
              Port {connection.port} is for HTTP/DSM, not SSH. Try 22.
            </motion.p>
          )}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1" htmlFor="ssh-user">User</label>
        <input
          id="ssh-user"
          type="text"
          aria-required="true"
          className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
          value={connection.user ?? 'root'}
          onChange={(e) => editConnection({ user: e.target.value })}
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
                onClick={() => editConnection({ authMethod: value })}
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
                <Icon size={16} />
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
              onChange={(e) => editConnection({ privateKeyPath: e.target.value })}
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
          <label className="block text-sm font-medium inline-flex items-center gap-2" htmlFor="ssh-sudo-pass">
            <Shield size={16} className="text-amber-300" strokeWidth={2} aria-hidden="true" />
            Sudo password
            <span className="ml-1 text-xs text-amber-300/90 font-normal">
              ({connection.user} is not root — needed for firewall + chmod)
            </span>
          </label>
          <PasswordInput
            id="ssh-sudo-pass"
            placeholder={connection.authMethod === 'password'
              ? 'Leave blank to reuse the SSH password'
              : 'Required for non-root key auth'}
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
          />
          <p className="text-xs text-slate-400 inline-flex items-center gap-1.5">
            <Lock size={13} className="text-slate-500" aria-hidden="true" />
            Stored in memory only — never written to disk or saved to your
            connection profile.
          </p>
        </motion.div>
      )}

      {/* (Save UI removed — auto-save handles writing changes back to
          the active profile. Switch profiles via the link above or
          the Welcome step.) */}

      {/* Animated test-result banner. Two states (success / error)
          slide in from the bottom and stay until the form changes.
          role=alert on the error variant + role=status on the success
          variant means screen readers announce the outcome as soon as
          it renders — important for keyboard-only users testing
          connections who can't see the visual banner appear. */}
      <AnimatePresence>
        {result && (
          <motion.div
            key={result.ok ? 'ok' : 'err'}
            initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            role={result.ok ? 'status' : 'alert'}
            aria-live={result.ok ? 'polite' : 'assertive'}
            className={
              `rounded-lg px-4 py-3 text-sm flex items-start gap-3 border ` +
              (result.ok
                ? 'bg-emerald-950/40 border-emerald-700/50 text-emerald-100'
                : 'bg-rose-950/40 border-rose-700/50 text-rose-100')
            }
          >
            {result.ok ? (
              <motion.span
                initial={reduced ? { scale: 1 } : { scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 16, delay: 0.05 }}
                className="shrink-0 mt-0.5"
                aria-hidden="true"
              >
                <CheckCircle2 size={22} className="text-emerald-400" />
              </motion.span>
            ) : (
              <AlertCircle size={22} className="text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
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
                  {/* Error-kind specific recovery hints. Maps each
                      ConnectResult.error.kind to a plain-language
                      "try this" checklist. We're explicitly NOT auto-
                      retrying — the user should understand why it
                      failed before clicking Test again, otherwise
                      they hit the same wall faster. */}
                  {result.error?.kind && (
                    <div className="mt-2 pt-2 border-t border-rose-700/40 text-rose-100/90 text-xs">
                      <div className="font-semibold mb-1">Try this:</div>
                      <ul className="list-disc pl-4 space-y-0.5 text-rose-200/85">
                        {result.error.kind === 'auth-failed' && (
                          <>
                            <li>Double-check the password — passwords are case-sensitive.</li>
                            <li>If you use 2-factor on DSM, generate an <em>application password</em> for SSH (Control Panel → User → Advanced).</li>
                            <li>Make sure the user you typed actually has SSH access. DSM 7 disables <code className="font-mono">root</code> by default — use your admin user instead.</li>
                          </>
                        )}
                        {result.error.kind === 'host-unreachable' && (
                          <>
                            <li>Is the host right? Paste your NAS IP (e.g. <code className="font-mono">192.168.1.10</code>), not a website URL.</li>
                            <li>Is the NAS on the same network as this computer? Try pinging it.</li>
                            <li>Is SSH enabled? On Synology: Control Panel → Terminal &amp; SNMP → check <em>Enable SSH service</em>.</li>
                          </>
                        )}
                        {result.error.kind === 'timeout' && (
                          <>
                            <li>The NAS isn't answering on this port. Default SSH is 22 — try that first.</li>
                            <li>Firewall? If you have one on the NAS or LAN, allow incoming TCP port {connection.port ?? 22}.</li>
                            <li>Try connecting from a terminal first: <code className="font-mono">ssh {connection.user ?? 'root'}@{connection.host || '<host>'} -p {connection.port ?? 22}</code></li>
                          </>
                        )}
                        {result.error.kind === 'unknown' && (
                          <>
                            <li>Open the install log (footer → Open log) for the full error.</li>
                            <li>Try the same login from a regular SSH terminal — does that work?</li>
                          </>
                        )}
                      </ul>
                    </div>
                  )}
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
          icon={<ArrowLeft size={18} />}
          onClick={() => setStep('welcome')}
        >
          Back
        </BigButton>
        {/* Inline status — replaces a silent disabled-button with a
            sighted-friendly explanation of WHY the next step isn't
            possible yet. role=status + aria-live='polite' so screen
            readers pick up state transitions without preemption. */}
        <div className="flex-1 text-sm text-center text-slate-400" role="status" aria-live="polite">
          {busy && !testOk && 'Testing connection…'}
          {!busy && !connection.host && 'Enter a host above to test'}
          {!busy && connection.host && !result && !testOk && 'Click Test to verify'}
          {testOk && (
            <span className="inline-flex items-center gap-1.5 text-emerald-300">
              <CheckCircle2 size={16} aria-hidden="true" />
              Connection works — click Continue
            </span>
          )}
        </div>
        <BigButton
          size="md"
          variant={testOk ? 'secondary' : 'primary'}
          icon={<ShieldCheck size={18} />}
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
          trailingIcon={<ArrowRight size={18} />}
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
