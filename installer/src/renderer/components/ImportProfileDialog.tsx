import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Download, X as XIcon, FileText, Lock, AlertCircle, ArrowLeft } from 'lucide-react'
import { BigButton } from './BigButton.js'
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

  // ESC closes the dialog unless mid-import (PBKDF2 takes ~200ms; not
  // worth letting the user accidentally cancel and have to retype the
  // passphrase). Same pattern as ExportProfileDialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function pickFile() {
    setBusy(true); setError(null)
    try {
      const r = await window.installer.dialog.openText({
        title: 'Pick a .mediarr-profile.json file',
        // Electron filter extensions are single-segment; "json" matches
        // the .mediarr-profile.json files we write since the OS just
        // looks at the last "." in the filename.
        filters: [
          { name: 'Mediarr profile (.json)', extensions: ['json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (!r.opened) {
        if (r.error) setError(r.error)
        return
      }
      if (!r.content) {
        setError('Couldn\'t read the file.')
        return
      }
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

  const reduced = useReducedMotion()
  return (
    <motion.div
      initial={reduced ? { opacity: 1 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-dialog-title"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <motion.div
        initial={reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 360, damping: 30 }}
        className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60 p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-10 h-10 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
              <Download size={20} className="text-emerald-300" />
            </div>
            <div>
              <h2 id="import-dialog-title" className="text-lg font-bold tracking-tight">Import profile</h2>
              <p className="text-sm text-slate-400 mt-1">
                Load a profile exported from another machine. You'll need
                the passphrase that was set at export time.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-slate-400 hover:text-slate-100 p-1 rounded hover:bg-slate-800 transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>

        {!envelope && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={pickFile}
              disabled={busy}
              className="w-full px-4 py-4 bg-slate-800 hover:bg-slate-700 border border-dashed border-slate-600 hover:border-slate-500 rounded-md text-sm disabled:opacity-40 transition-colors flex items-center justify-center gap-2 font-medium"
            >
              <FileText size={18} className="text-slate-400" />
              {busy ? 'Opening…' : 'Pick .mediarr-profile.json file…'}
            </button>
            {error && (
              <motion.div
                initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-rose-950/40 border border-rose-700/50 text-rose-200 rounded-md px-3 py-2 text-xs flex items-start gap-2"
              >
                <AlertCircle size={14} className="text-rose-400 shrink-0 mt-0.5" />
                <span>{error}</span>
              </motion.div>
            )}
          </div>
        )}

        {envelope && (
          <motion.div
            initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-3"
          >
            <div className="rounded-lg border border-emerald-700/30 bg-emerald-900/10 p-3 text-sm">
              <div className="font-semibold text-base">{envelope.label}</div>
              <div className="text-xs text-slate-400 mt-0.5">
                Exported {new Date(envelope.exportedAt).toLocaleString()}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono">
                {envelope.kdf.name} · {envelope.kdf.iters.toLocaleString()} iters · {envelope.cipher.name}
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-sm font-semibold flex items-center gap-1.5">
                <Lock size={13} className="text-emerald-400" />
                Passphrase
              </label>
              <input
                type="password"
                autoFocus
                value={pass}
                onChange={(e) => { setPass(e.target.value); if (error) setError(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') doImport() }}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
                placeholder="The passphrase used at export time"
              />
            </div>

            {error && (
              <motion.div
                initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-rose-950/40 border border-rose-700/50 text-rose-200 rounded-md px-3 py-2 text-xs flex items-start gap-2"
              >
                <AlertCircle size={14} className="text-rose-400 shrink-0 mt-0.5" />
                <span>{error}</span>
              </motion.div>
            )}
          </motion.div>
        )}

        <div className="flex justify-between gap-2 pt-3 border-t border-slate-800">
          {envelope ? (
            <button
              type="button"
              onClick={() => { setEnvelope(null); setPass(''); setError(null) }}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-slate-400 hover:text-slate-200 disabled:opacity-40 transition-colors"
            >
              <ArrowLeft size={14} />
              Pick a different file
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <BigButton
              size="md"
              variant="secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </BigButton>
            {envelope && (
              <BigButton
                size="md"
                variant="primary"
                icon={<Download size={16} />}
                loading={busy}
                disabled={busy || !pass}
                onClick={doImport}
              >
                {busy ? 'Importing…' : 'Import'}
              </BigButton>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
