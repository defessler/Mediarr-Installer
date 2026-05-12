import { useEffect, useState } from 'react'
import { reportError } from '../store/errors.js'

interface Props {
  profileId: string
  profileLabel: string
  onClose: () => void
}

// Tiny passphrase-strength heuristic — mirror of the main-process
// `passphraseStrength` in profile-crypto.ts. Kept duplicated rather
// than IPC'd because it has to run on every keystroke for the meter.
function strength(p: string): 0 | 1 | 2 | 3 | 4 {
  if (!p) return 0
  let classes = 0
  if (/[a-z]/.test(p)) classes++
  if (/[A-Z]/.test(p)) classes++
  if (/\d/.test(p))    classes++
  if (/[^A-Za-z0-9]/.test(p)) classes++
  const longEnough = p.length >= 12
  const veryLong   = p.length >= 18
  if (!longEnough && classes <= 1) return 0
  if (!longEnough && classes <= 2) return 1
  if (longEnough  && classes <= 2) return 2
  if (longEnough  && classes >= 3) return 3
  if (veryLong    && classes >= 3) return 4
  return 2
}

const STRENGTH_LABELS = ['Too weak', 'Weak', 'OK', 'Strong', 'Very strong'] as const
const STRENGTH_COLORS = [
  'bg-rose-500',
  'bg-amber-500',
  'bg-yellow-400',
  'bg-emerald-500',
  'bg-emerald-400',
] as const

export function ExportProfileDialog({ profileId, profileLabel, onClose }: Props) {
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [showWhat, setShowWhat] = useState(false)

  const score = strength(pass)
  const confirmsMatch = pass.length > 0 && pass === confirm
  const tooWeak = score === 0
  const canExport = !busy && !!pass && confirmsMatch && !tooWeak

  // ESC closes the dialog (unless we're mid-export — the user almost
  // certainly didn't mean to abandon their PBKDF2 work).
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

  async function doExport() {
    if (!canExport) return
    setBusy(true)
    try {
      const envelope = await window.installer.profiles.exportProfile(profileId, pass)
      const json = JSON.stringify(envelope, null, 2)
      const defaultName = `${profileLabel.replace(/[^\w.-]+/g, '_')}.mediarr-profile.json`
      const r = await window.installer.dialog.saveText({
        defaultName,
        content: json,
        title: `Export ${profileLabel}`,
        // Electron filter extensions must be single segments; the
        // double-dot ".mediarr-profile.json" we ship in defaultName
        // stays in the filename but the file picker filters on just
        // ".json" so users can still see it when browsing.
        filters: [
          { name: 'Mediarr profile (.json)', extensions: ['json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (r.saved) onClose()
    } catch (e) {
      reportError('Export profile', e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 shadow-xl shadow-black/40 p-5 space-y-4">
        <div>
          <h2 id="export-dialog-title" className="text-lg font-semibold">Export profile</h2>
          <p className="text-sm text-slate-400 mt-1">
            Saves <span className="font-medium text-slate-200">{profileLabel}</span> to a
            passphrase-protected file you can carry to another machine. The file is
            useless without the passphrase — pick something you can re-type.
          </p>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium">Passphrase</label>
          <input
            type="password"
            autoFocus
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm"
            placeholder="At least 12 characters; mix letters, numbers, symbols"
          />
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1.5 bg-slate-800 rounded overflow-hidden flex gap-0.5">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={`flex-1 ${i < score ? STRENGTH_COLORS[score] : 'bg-slate-800'}`}
                />
              ))}
            </div>
            <span className={`text-xs tabular-nums ${
              score >= 3 ? 'text-emerald-400'
              : score === 2 ? 'text-yellow-300'
              : score === 1 ? 'text-amber-300'
              : 'text-rose-400'
            }`}>
              {pass ? STRENGTH_LABELS[score] : ' '}
            </span>
          </div>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium">Confirm passphrase</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doExport() }}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm"
            placeholder="Re-type (Enter to export)"
          />
          {confirm && !confirmsMatch && (
            <p className="text-xs text-rose-300 mt-1">Doesn't match the passphrase above.</p>
          )}
        </div>

        <details
          open={showWhat}
          onToggle={(e) => setShowWhat((e.target as HTMLDetailsElement).open)}
          className="rounded-md border border-slate-800 bg-slate-900/40 text-xs"
        >
          <summary className="cursor-pointer px-3 py-2 select-none text-slate-300">
            What's included in the export?
          </summary>
          <ul className="px-3 pb-3 space-y-1 text-slate-400 list-disc list-inside">
            <li>Connection settings (host, port, user, auth method, key path)</li>
            <li>SSH password, key passphrase, and sudo password (all encrypted)</li>
            <li>Target install directory</li>
            <li>Every value from the Configure screen (LAN IP, PUID, VPN keys, indexer
              credentials, qBittorrent/arr usernames + passwords, etc.)</li>
            <li className="text-emerald-300">Plex claim token round-trips, but is auto-discarded on import (4-min expiry)</li>
          </ul>
        </details>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={doExport}
            disabled={!canExport}
            title={
              !pass ? 'Enter a passphrase'
              : tooWeak ? 'Passphrase is too weak'
              : !confirmsMatch ? 'Confirm the passphrase'
              : 'Save to a file'
            }
            className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-40 font-medium"
          >
            {busy ? 'Exporting…' : 'Export to file'}
          </button>
        </div>
      </div>
    </div>
  )
}
