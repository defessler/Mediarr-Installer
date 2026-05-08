import { useState } from 'react'
import { useWizard } from '../store/wizard.js'
import type { ConnectResult } from '../../shared/ipc.js'

export function ConnectScreen() {
  const { connection, setConnection, setStep, setSessionId } = useWizard()
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectResult | null>(null)
  const [testOk, setTestOk] = useState(false)

  async function test() {
    setBusy(true); setResult(null); setTestOk(false)
    try {
      const r = await window.installer.ssh.testConnect({
        host: connection.host ?? '',
        port: connection.port ?? 22,
        user: connection.user ?? 'root',
        authMethod: connection.authMethod ?? 'password',
        password: connection.authMethod === 'password' ? password : undefined,
        privateKeyPath: connection.authMethod === 'privateKey' ? connection.privateKeyPath : undefined,
        passphrase: connection.authMethod === 'privateKey' ? passphrase : undefined,
      })
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
      const r = await window.installer.ssh.connect({
        host: connection.host ?? '',
        port: connection.port ?? 22,
        user: connection.user ?? 'root',
        authMethod: connection.authMethod ?? 'password',
        password: connection.authMethod === 'password' ? password : undefined,
        privateKeyPath: connection.authMethod === 'privateKey' ? connection.privateKeyPath : undefined,
        passphrase: connection.authMethod === 'privateKey' ? passphrase : undefined,
      })
      setSessionId(r.sessionId)
      setStep('detect')
    } catch (e) {
      setResult({ ok: false, error: { kind: 'unknown', message: (e as Error).message } })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Connect to your NAS</h1>
        <p className="text-slate-400 mt-1 text-sm">
          For the cleanest install, log in as <code className="bg-slate-800 px-1 rounded">root</code>.
          On Synology: Control Panel → Terminal → enable SSH; then set a root password.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <label className="block text-sm font-medium mb-1">Host</label>
          <input
            type="text" placeholder="192.168.1.10"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
            value={connection.host ?? ''}
            onChange={(e) => setConnection({ host: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Port</label>
          <input
            type="number"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
            value={connection.port ?? 22}
            onChange={(e) => setConnection({ port: Number(e.target.value) || 22 })}
          />
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

      {result && (
        <div className={`rounded-md px-3 py-2 text-sm ${result.ok ? 'bg-emerald-900/40 text-emerald-200' : 'bg-rose-900/40 text-rose-200'}`}>
          {result.ok
            ? '✔ Connection successful'
            : `✘ ${result.error?.kind}: ${result.error?.message}`}
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          onClick={test} disabled={busy || !connection.host}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
        >
          {busy ? 'Testing…' : 'Test connection'}
        </button>
        <button
          onClick={connectAndContinue} disabled={busy || !testOk}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-40 ml-auto"
        >
          Continue →
        </button>
      </div>
    </div>
  )
}
