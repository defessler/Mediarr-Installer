import { useState } from 'react'
import { reportError } from '../store/errors.js'
import type { ProfileExportEnvelope, SavedProfile } from '../../shared/ipc.js'

interface Props {
  onClose: () => void
  onImported: (p: SavedProfile) => void
}

// Two-step flow: (1) pick the file (native open dialog), parse + validate
// the envelope client-side so we can show the user "Importing <label> –
// exported <when>" before they type a passphrase. (2) enter passphrase,
// submit, surface "wrong-passphrase" specifically if AES-GCM tag mismatched.

export function ImportProfileDialog({ onClose, onImported }: Props) {
  const [envelope, setEnvelope] = useState<ProfileExportEnvelope | null>(null)
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pickFile() {
    setBusy(true); setError(null)
    try {
      const r = await window.installer.dialog.openText({
        title: 'Pick a .mediarr-profile.json file',
        filters: [
          { name: 'Mediarr profile', extensions: ['mediarr-profile.json', 'json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (!r.opened || !r.content) return
      let parsed: unknown
      try {
        parsed = JSON.parse(r.content)
      } catch {
        setError(`Couldn't parse ${r.path ?? 'the file'} as JSON.`)
        return
      }
      const env = parsed as ProfileExportEnvelope
      if (env?.format !== 'mediarr-profile/v1' || !env?.cipher?.ct || !env?.kdf?.salt) {
        setError('That file isn\'t a Mediarr profile export (missing format / cipher / kdf fields).')
        return
      }
      setEnvelope(env)
    } catch (e) {
      reportError('Import profile', e)
    } finally {
      setBusy(false)
    }
  }

  async function doImport() {
    if (!envelope || !pass) return
    setBusy(true); setError(null)
    try {
      const saved = await window.installer.profiles.importProfile(envelope, pass)
      onImported(saved)
      onClose()
    } catch (e) {
      const msg = (e as Error)?.message ?? ''
      if (msg.includes('wrong-passphrase')) {
        setError('Passphrase didn\'t match.')
      } else {
        reportError('Import profile', e)
        setError(msg || 'Import failed.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 shadow-xl shadow-black/40 p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Import profile</h2>
          <p className="text-sm text-slate-400 mt-1">
            Loads a profile exported from this app on another machine. You'll
            need the passphrase that was set at export time.
          </p>
        </div>

        {!envelope && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={pickFile}
              disabled={busy}
              className="w-full px-4 py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md text-sm disabled:opacity-40"
            >
              {busy ? 'Opening…' : 'Pick .mediarr-profile.json file…'}
            </button>
            {error && (
              <div className="bg-rose-900/40 text-rose-200 rounded-md px-3 py-2 text-xs">
                {error}
              </div>
            )}
          </div>
        )}

        {envelope && (
          <div className="space-y-3">
            <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-sm">
              <div className="font-medium">
                {envelope.label}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">
                Exported {new Date(envelope.exportedAt).toLocaleString()}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono">
                {envelope.kdf.name} · {envelope.kdf.iters.toLocaleString()} iters · {envelope.cipher.name}
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-sm font-medium">Passphrase</label>
              <input
                type="password"
                autoFocus
                value={pass}
                onChange={(e) => { setPass(e.target.value); if (error) setError(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') doImport() }}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm"
                placeholder="The passphrase used at export time"
              />
            </div>

            {error && (
              <div className="bg-rose-900/40 text-rose-200 rounded-md px-3 py-2 text-xs">
                {error}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-between gap-2 pt-2 border-t border-slate-800">
          {envelope ? (
            <button
              type="button"
              onClick={() => { setEnvelope(null); setPass(''); setError(null) }}
              disabled={busy}
              className="px-3 py-2 text-sm text-slate-400 hover:text-slate-200 disabled:opacity-40"
            >
              ← Pick a different file
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
            >
              Cancel
            </button>
            {envelope && (
              <button
                type="button"
                onClick={doImport}
                disabled={busy || !pass}
                className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-40 font-medium"
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
