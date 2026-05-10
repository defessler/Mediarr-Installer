import { useEffect, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import { reportError } from '../store/errors.js'
import type { SavedProfile } from '../../shared/ipc.js'

export function WelcomeScreen() {
  const { setMode, setStep, loadFromProfile, activeProfileId, setActiveProfileLabel } = useWizard()
  const [profiles, setProfiles] = useState<SavedProfile[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  /** id of the profile currently being label-edited inline */
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null)
  const [editingLabelText, setEditingLabelText] = useState('')

  async function refresh() {
    try {
      const list = await window.installer.profiles.list()
      setProfiles(list)
    } catch (e) {
      reportError('List profiles', e)
      setProfiles([])
    }
  }
  useEffect(() => { refresh() }, [])

  async function pickProfile(id: string, target: 'install' | 'update' | 'edit') {
    setBusy(id)
    try {
      const p = await window.installer.profiles.load(id)
      if (!p) throw new Error('Profile not found')
      loadFromProfile({
        id: p.id,
        label: p.label,
        connection: p.connection,
        config: p.config as Record<string, string>,
        targetDir: p.targetDir,
      })
      if (target === 'edit') {
        // "Edit settings" — drop the user straight into Configure.
        // No SSH session is needed; the screen renders all fields with
        // the existing profile values and auto-saves on edit. Mode
        // stays 'install' so the stepper rail looks normal.
        setMode('install')
        setStep('configure')
      } else {
        setMode(target)
        setStep('connect')
      }
      window.installer.profiles.touch(id).catch(() => {})
    } catch (e) {
      reportError('Load profile', e)
    } finally {
      setBusy(null)
    }
  }

  async function commitLabel(id: string) {
    const label = editingLabelText.trim()
    if (!label) {
      setEditingLabelId(null)
      return
    }
    try {
      // Load the full profile, save back with the new label only.
      const p = await window.installer.profiles.load(id)
      if (!p) throw new Error('Profile not found')
      await window.installer.profiles.save({
        id,
        label,
        connection: p.connection,
        targetDir: p.targetDir,
        config: p.config as Record<string, string>,
      })
      // Keep the header label in sync if we renamed the active profile.
      if (id === activeProfileId) setActiveProfileLabel(label)
      setEditingLabelId(null)
      setEditingLabelText('')
      await refresh()
    } catch (e) {
      reportError('Rename profile', e)
    }
  }

  async function createProfile() {
    const label = newLabel.trim() || `Profile ${(profiles?.length ?? 0) + 1}`
    setBusy('new')
    try {
      const saved = await window.installer.profiles.save({
        label,
        connection: { host: '', port: 22, user: 'root', authMethod: 'password' },
        targetDir: '/volume1/docker/media',
        config: {},
      })
      loadFromProfile({
        id: saved.id,
        label: saved.label,
        connection: { ...saved.connection },
        config: {},
        targetDir: '/volume1/docker/media',
      })
      setMode('install')
      setStep('connect')
    } catch (e) {
      reportError('Create profile', e)
    } finally {
      setBusy(null)
      setCreating(false)
      setNewLabel('')
    }
  }

  async function deleteProfile(id: string, label: string) {
    if (!window.confirm(`Delete profile "${label}"?`)) return
    try {
      await window.installer.profiles.delete(id)
      await refresh()
    } catch (e) {
      reportError('Delete profile', e)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-8 space-y-6">
        <header>
          <h1 className="text-3xl font-semibold">Mediarr Installer</h1>
          <p className="text-slate-400 mt-2">
            Pick a saved profile to continue, or create a new one. Each
            profile holds the SSH connection, install path, and every
            field you fill in — so you can install onto multiple NASes
            and switch between them without re-typing.
          </p>
        </header>

        {profiles === null ? (
          <div className="text-slate-400 text-sm">Loading profiles...</div>
        ) : profiles.length === 0 ? (
          <section className="rounded-md border border-slate-800 bg-slate-900/40 p-6 text-center space-y-3">
            <div className="text-slate-300">No profiles yet.</div>
            <button
              onClick={() => setCreating(true)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md"
            >
              Create your first profile
            </button>
          </section>
        ) : (
          <section className="space-y-2">
            <h2 className="text-sm uppercase tracking-wide text-slate-400">
              Saved profiles
            </h2>
            {profiles.map((p) => (
              <div
                key={p.id}
                className="rounded-md border border-slate-700 bg-slate-800/40 hover:bg-slate-800/70 p-3 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  {editingLabelId === p.id ? (
                    <input
                      autoFocus
                      type="text"
                      className="w-full px-2 py-1 text-sm bg-slate-900 border border-slate-600 rounded font-medium"
                      value={editingLabelText}
                      onChange={(e) => setEditingLabelText(e.target.value)}
                      onBlur={() => commitLabel(p.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitLabel(p.id)
                        if (e.key === 'Escape') {
                          setEditingLabelId(null); setEditingLabelText('')
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingLabelId(p.id)
                        setEditingLabelText(p.label)
                      }}
                      className="font-medium truncate text-left hover:text-emerald-300"
                      title="Click to rename"
                    >
                      {p.label}
                    </button>
                  )}
                  <div className="text-xs text-slate-400 truncate">
                    {p.connection.user}@{p.connection.host || '<no host>'}:{p.connection.port}
                    {p.hasConfig && <span className="text-emerald-500/80 ml-2">· config saved</span>}
                    {p.hasSecret && <span className="text-emerald-500/80 ml-2">· secrets saved</span>}
                  </div>
                </div>
                <button
                  onClick={() => pickProfile(p.id, 'edit')}
                  disabled={busy !== null}
                  className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
                  title="Edit all settings without connecting"
                >
                  Edit
                </button>
                <button
                  onClick={() => pickProfile(p.id, 'install')}
                  disabled={busy !== null}
                  className="px-3 py-1.5 text-sm bg-emerald-700/60 hover:bg-emerald-600 rounded-md disabled:opacity-40"
                >
                  Install
                </button>
                <button
                  onClick={() => pickProfile(p.id, 'update')}
                  disabled={busy !== null}
                  className="px-3 py-1.5 text-sm bg-sky-700/60 hover:bg-sky-600 rounded-md disabled:opacity-40"
                >
                  Update
                </button>
                <button
                  onClick={() => deleteProfile(p.id, p.label)}
                  disabled={busy !== null}
                  className="px-2 py-1.5 text-sm text-rose-400 hover:text-rose-300 disabled:opacity-40"
                  title="Delete profile"
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="pt-2">
              <button
                onClick={() => setCreating(true)}
                className="text-sm text-emerald-400 hover:underline"
              >
                + New profile
              </button>
            </div>
          </section>
        )}

        {creating && (
          <section className="rounded-md border border-slate-700 bg-slate-900/40 p-4 space-y-3">
            <h2 className="font-medium">New profile</h2>
            <input
              type="text"
              placeholder="Profile name (e.g. DS1522+, Home, Office)"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createProfile() }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setCreating(false); setNewLabel('') }}
                className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={createProfile}
                disabled={busy === 'new'}
                className="px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-40"
              >
                {busy === 'new' ? 'Creating...' : 'Create and continue'}
              </button>
            </div>
          </section>
        )}

        <section className="rounded-md border border-slate-800 bg-slate-900/40 p-4 space-y-2 text-sm">
          <h2 className="font-medium">Before you begin</h2>
          <ul className="space-y-1.5 text-slate-300 list-disc list-inside">
            <li>SSH is enabled on the NAS (Control Panel &rarr; Terminal &amp; SNMP).</li>
            <li>Docker (Container Manager) is installed via Synology Package Center.</li>
            <li>For fresh installs that include Plex: an account at plex.tv.</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
