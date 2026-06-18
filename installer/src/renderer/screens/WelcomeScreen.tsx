import { useEffect, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import {
  Plus, Download, Upload, Play, RefreshCw, ArrowRightLeft, Settings,
  Trash2, Edit3, AlertTriangle, Server, CheckCircle2,
  Terminal, Boxes, UserCircle, Sparkles, Lock,
} from 'lucide-react'
import { useWizard } from '../store/wizard.js'
import { reportError } from '../store/errors.js'
import type { AppInfo, SavedProfile } from '../../shared/ipc.js'
import { ExportProfileDialog } from '../components/ExportProfileDialog.js'
import { ImportProfileDialog } from '../components/ImportProfileDialog.js'
import { WhatsNew } from '../components/WhatsNew.js'
import { BigButton } from '../components/BigButton.js'

/** Friendly "5 min ago" / "2 hours ago" / "3 days ago". Cheap +
 *  good-enough for last-run timestamps on the Welcome screen; no
 *  Intl.RelativeTimeFormat dance, no date-fns dependency. */
function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60)        return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60)        return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48)        return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

export function WelcomeScreen() {
  const { setMode, setStep, loadFromProfile, activeProfileId, setActiveProfileLabel, lastRuns, clearRunResult } = useWizard()
  const [profiles, setProfiles] = useState<SavedProfile[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  /** id of the profile currently being label-edited inline */
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null)
  const [editingLabelText, setEditingLabelText] = useState('')
  /** Which profile (if any) is open in the export dialog. */
  const [exportingFor, setExportingFor] = useState<SavedProfile | null>(null)
  /** True when the import dialog is open. */
  const [importing, setImporting] = useState(false)
  /** App version + update info for the WhatsNew banner. */
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  /** Which profile-card has its actions overflow open (overflow holds
   *  the secondary actions — Update / Migrate / Edit — so the primary
   *  Install action is the visually-dominant one on each row). */
  const [overflowOpenId, setOverflowOpenId] = useState<string | null>(null)
  /** Which profile (if any) is awaiting in-place delete confirmation.
   *  Inline confirm beats window.confirm() because it doesn't yank
   *  focus out of the wizard, plays a Motion entrance, and gives the
   *  user clearer label context — they see WHICH profile they're
   *  about to delete, not a generic OS dialog. */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const reduced = useReducedMotion()

  // Normalize the wizard mode back to 'install' whenever we land on
  // Welcome. Returning here from an Update or Migrate run (Done, Back-to-
  // start, the header switch, ConnectScreen's switch, a deleted-profile
  // bounce) otherwise leaves mode='update'/'migrate', so the home screen
  // renders the reduced Update/Migrate rail with the wrong accent over the
  // generic "Welcome back" content. Doing it on mount fixes every entry
  // path in one place and matches the merge() rehydrate intent (which also
  // forces mode='install'). pickProfile() re-sets the real mode immediately
  // after this, so an Install/Update/Migrate click is unaffected.
  useEffect(() => { useWizard.getState().setMode('install') }, [])

  async function refreshAppInfo() {
    try {
      const info = await window.installer.app.getInfo()
      setAppInfo(info)
    } catch (e) {
      reportError('App info', e)
    }
  }
  useEffect(() => { refreshAppInfo() }, [])

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

  // Global Escape handler — bails out of whichever transient panel is
  // currently open (delete confirm, label edit, create-profile form).
  // Without this, a kid hits Escape expecting "nope, never mind" and
  // nothing happens because the panel is inline (not a focus-trapped
  // modal). Priority order is "most destructive first" so a single
  // Escape always cancels the riskiest thing on screen.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (confirmDeleteId !== null) {
        setConfirmDeleteId(null)
        e.preventDefault()
        return
      }
      if (editingLabelId !== null) {
        setEditingLabelId(null)
        setEditingLabelText('')
        e.preventDefault()
        return
      }
      if (creating) {
        setCreating(false)
        setNewLabel('')
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDeleteId, editingLabelId, creating])

  async function pickProfile(id: string, target: 'install' | 'update' | 'edit' | 'migrate') {
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
        migrate: p.migrate,
      })
      if (target === 'edit') {
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
      const p = await window.installer.profiles.load(id)
      if (!p) throw new Error('Profile not found')
      await window.installer.profiles.save({
        id,
        label,
        connection: p.connection,
        targetDir: p.targetDir,
        config: p.config as Record<string, string>,
        migrate: p.migrate,
      })
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

  async function deleteProfile(id: string) {
    try {
      await window.installer.profiles.delete(id)
      clearRunResult(id)
      setConfirmDeleteId(null)
      await refresh()
    } catch (e) {
      reportError('Delete profile', e)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10 space-y-8">
        {/* Hero header with a server icon — gives the screen a
            recognisable visual anchor without a custom illustration.
            Lucide's Server icon stands in for "the NAS we're going to
            set up." Bouncy entrance to feel welcoming, not corporate. */}
        <header className="text-center">
          <motion.div
            initial={reduced ? { scale: 1, opacity: 1 } : { scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.05 }}
            className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-emerald-700/30 border border-emerald-500/30 mb-4"
          >
            <Server size={40} className="text-emerald-300" strokeWidth={1.5} aria-hidden="true" />
          </motion.div>
          <h1 className="text-4xl font-bold tracking-tight">Welcome back</h1>
          <p className="text-slate-400 mt-3 text-base">
            Pick a NAS to set up — or start fresh.
          </p>
        </header>

        {appInfo && <WhatsNew info={appInfo} />}

        {profiles === null ? (
          <ProfilesLoading />
        ) : profiles.length === 0 ? (
          <EmptyState onCreate={() => setCreating(true)} onImport={() => setImporting(true)} />
        ) : (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
                Your NAS profiles
              </h2>
              <div className="flex items-center gap-3 text-sm">
                <button
                  onClick={() => setCreating(true)}
                  className="flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded px-1"
                >
                  <Plus size={18} strokeWidth={2.5} aria-hidden="true" />
                  New profile
                </button>
                <span className="text-slate-700" aria-hidden="true">·</span>
                <button
                  onClick={() => setImporting(true)}
                  className="flex items-center gap-1.5 text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded px-1"
                  title="Import a passphrase-protected .mediarr-profile.json file"
                >
                  <Download size={18} strokeWidth={2.5} aria-hidden="true" />
                  Import
                </button>
              </div>
            </div>
            <ul className="space-y-3">
              {profiles.map((p, i) => (
                <motion.li
                  key={p.id}
                  initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.04 * i, duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  whileHover={reduced ? {} : { y: -1 }}
                  className="group rounded-xl border border-slate-700/80 bg-slate-800/40 hover:bg-slate-800/70 hover:border-slate-600 hover:shadow-lg hover:shadow-black/20 transition-all p-4"
                >
                  <div className="flex items-center gap-4">
                    {/* Avatar with first-letter monogram. Reads as a
                        "profile" the same way contact lists do. */}
                    <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-600/20 to-emerald-800/30 border border-emerald-600/30 flex items-center justify-center text-emerald-200 text-lg font-bold uppercase">
                      {p.label.slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      {editingLabelId === p.id ? (
                        <input
                          autoFocus
                          type="text"
                          aria-label={`Rename profile (originally ${p.label})`}
                          className="w-full px-2 py-1 text-base bg-slate-900 border border-emerald-600 rounded font-semibold focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
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
                          className="font-semibold text-base truncate text-left hover:text-emerald-300 transition-colors"
                          title="Click to rename"
                        >
                          {p.label}
                        </button>
                      )}
                      <div className="text-xs text-slate-400 truncate font-mono mt-0.5">
                        {p.connection.user}@{p.connection.host || '<not set>'}:{p.connection.port}
                      </div>
                      {/* Per-profile status chips: config saved (config
                          file exists), secrets saved (encrypted creds
                          exist), and the last-run outcome. Differentiated
                          icons (Settings, Lock, Sparkles, AlertTriangle)
                          give each chip a visually distinct meaning
                          beyond colour. */}
                      <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1 text-xs">
                        {p.hasConfig && (
                          <span className="inline-flex items-center gap-1 text-emerald-400/90">
                            <Settings size={13} aria-hidden="true" /> config saved
                          </span>
                        )}
                        {p.hasSecret && (
                          p.encryptedAtRest ? (
                            <span className="inline-flex items-center gap-1 text-emerald-400/90">
                              <Lock size={13} aria-hidden="true" /> secrets saved
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 text-amber-400/90"
                              title="This machine has no OS keyring (e.g. Linux without libsecret/kwallet), so the saved password is stored as reversible base64 protected only by file permissions. Re-save it on a machine with a keyring for real at-rest encryption."
                            >
                              <AlertTriangle size={13} aria-hidden="true" /> secrets unencrypted
                            </span>
                          )
                        )}
                        {lastRuns[p.id]?.phase === 'done' && (
                          <span className="inline-flex items-center gap-1 text-emerald-300">
                            <Sparkles size={13} aria-hidden="true" />
                            last install ok
                            <span className="text-slate-500"> · {timeAgo(lastRuns[p.id].finishedAt)}</span>
                          </span>
                        )}
                        {lastRuns[p.id]?.phase === 'failed' && (
                          <span className="inline-flex items-center gap-1 text-amber-300/90">
                            <AlertTriangle size={13} aria-hidden="true" /> last install paused
                            {lastRuns[p.id].failedStep != null && <span> at step {lastRuns[p.id].failedStep}</span>}
                            <span className="text-slate-500"> · {timeAgo(lastRuns[p.id].finishedAt)}</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Primary actions — Install + Update side by side so
                        the two modes are equally discoverable. "Install"
                        is the full first-time setup; "Update" pulls new
                        images + re-applies fixes to an already-installed
                        stack. The visual hierarchy (filled green vs.
                        outlined) signals which is the first-run default
                        without hiding Update behind a menu. Edit / Migrate
                        / Export stay in the gear overflow. */}
                    <div className="flex items-center gap-2">
                      <BigButton
                        size="md"
                        variant="primary"
                        icon={<Play size={18} fill="currentColor" />}
                        loading={busy === p.id}
                        disabled={busy !== null}
                        onClick={() => pickProfile(p.id, 'install')}
                        title={`Full install / re-install of the stack on ${p.label}`}
                      >
                        Install
                      </BigButton>
                      <BigButton
                        size="md"
                        variant="secondary"
                        icon={<RefreshCw size={17} />}
                        disabled={busy !== null}
                        onClick={() => pickProfile(p.id, 'update')}
                        title={`Update the already-installed stack on ${p.label} — pull new images and re-apply fixes`}
                      >
                        Update
                      </BigButton>
                      <button
                        onClick={() => setOverflowOpenId(overflowOpenId === p.id ? null : p.id)}
                        disabled={busy !== null}
                        className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
                        title={`More actions for ${p.label}`}
                        aria-label={`More actions for profile ${p.label}`}
                        aria-expanded={overflowOpenId === p.id}
                        aria-haspopup="menu"
                      >
                        <Settings size={18} aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  {/* Overflow menu — slides down when the gear icon is
                      clicked. Houses the secondary actions that aren't
                      part of the "happy path" for a first-time user. */}
                  <AnimatePresence>
                    {overflowOpenId === p.id && (
                      <motion.div
                        initial={reduced ? { height: 'auto', opacity: 1 } : { height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                        role="menu"
                        aria-label={`Actions for ${p.label}`}
                      >
                        <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-slate-700/60">
                          <BigButton
                            size="sm" variant="ghost"
                            icon={<Edit3 size={16} />}
                            disabled={busy !== null}
                            onClick={() => pickProfile(p.id, 'edit')}
                          >
                            Edit
                          </BigButton>
                          <BigButton
                            size="sm" variant="ghost"
                            icon={<ArrowRightLeft size={16} />}
                            disabled={busy !== null}
                            onClick={() => pickProfile(p.id, 'migrate')}
                          >
                            Migrate
                          </BigButton>
                          <BigButton
                            size="sm" variant="ghost"
                            icon={<Upload size={16} />}
                            disabled={busy !== null}
                            onClick={() => setExportingFor(p)}
                          >
                            Export
                          </BigButton>
                          <div className="col-span-3 mt-1">
                            <AnimatePresence mode="wait" initial={false}>
                              {confirmDeleteId === p.id ? (
                                <motion.div
                                  key="confirm"
                                  initial={reduced ? { opacity: 1 } : { opacity: 0, y: -4 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
                                  transition={{ duration: 0.14 }}
                                  className="flex items-center justify-center gap-3 rounded-md border border-rose-700/40 bg-rose-950/30 px-3 py-2 text-xs"
                                >
                                  <span className="text-rose-200 inline-flex items-center gap-1.5">
                                    <AlertTriangle size={14} aria-hidden="true" />
                                    Really delete <span className="font-medium text-rose-100 truncate max-w-[12em]">{p.label}</span>?
                                  </span>
                                  <BigButton
                                    size="sm"
                                    variant="danger"
                                    icon={<Trash2 size={14} />}
                                    disabled={busy !== null}
                                    onClick={() => deleteProfile(p.id)}
                                  >
                                    Yes, delete
                                  </BigButton>
                                  <BigButton
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setConfirmDeleteId(null)}
                                  >
                                    Cancel
                                  </BigButton>
                                </motion.div>
                              ) : (
                                <motion.button
                                  key="trigger"
                                  onClick={() => setConfirmDeleteId(p.id)}
                                  disabled={busy !== null}
                                  initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  exit={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
                                  transition={{ duration: 0.14 }}
                                  className="w-full inline-flex items-center justify-center gap-1.5 text-xs text-rose-400 hover:text-rose-300 disabled:opacity-40 transition-colors rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
                                >
                                  <Trash2 size={14} aria-hidden="true" />
                                  Delete this profile
                                </motion.button>
                              )}
                            </AnimatePresence>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.li>
              ))}
            </ul>
          </section>
        )}

        {creating && (
          <motion.section
            initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="rounded-xl border border-emerald-700/40 bg-emerald-950/20 p-5 space-y-3"
          >
            <h2 className="font-semibold text-lg flex items-center gap-2" id="new-profile-heading">
              <Plus size={20} className="text-emerald-400" strokeWidth={2.5} aria-hidden="true" />
              New profile
            </h2>
            <input
              id="new-profile-label"
              aria-labelledby="new-profile-heading"
              type="text"
              placeholder="Name it — e.g. DS1522+, Home NAS, Office"
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-600 rounded-md text-base focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createProfile() }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <BigButton
                size="md" variant="secondary"
                onClick={() => { setCreating(false); setNewLabel('') }}
              >
                Cancel
              </BigButton>
              <BigButton
                size="md" variant="primary"
                loading={busy === 'new'}
                onClick={createProfile}
              >
                Create and continue
              </BigButton>
            </div>
          </motion.section>
        )}

        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3 text-sm">
          <h2 className="font-semibold flex items-center gap-2">
            <CheckCircle2 size={18} className="text-emerald-400" aria-hidden="true" />
            Before you begin
          </h2>
          {/* Icon-prefixed checklist. Each item has its own Lucide
              glyph so the list reads as "three concrete things" — much
              easier to skim than a bullet block when you're new to NAS
              setup. Icons sit in a tinted square so they feel like
              little tags rather than decoration. */}
          <ul className="space-y-2 text-slate-300">
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-md bg-slate-800/80 border border-slate-700/60">
                <Terminal size={16} className="text-slate-300" strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span>
                SSH is enabled on your NAS (on Synology: Control Panel &rarr; Terminal &amp; SNMP).
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-md bg-sky-900/30 border border-sky-700/40">
                <Boxes size={16} className="text-sky-300" strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span>
                Docker is installed (on Synology it&rsquo;s &ldquo;Container Manager&rdquo; in Package Center; UGREEN, QNAP, and Unraid have their own app store).
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-md bg-emerald-900/30 border border-emerald-700/40">
                <UserCircle size={16} className="text-emerald-300" strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span>
                For fresh installs that include Plex: an account at plex.tv.
              </span>
            </li>
          </ul>
        </section>
      </div>

      {exportingFor && (
        <ExportProfileDialog
          profileId={exportingFor.id}
          profileLabel={exportingFor.label}
          onClose={() => setExportingFor(null)}
        />
      )}
      {importing && (
        <ImportProfileDialog
          onClose={() => setImporting(false)}
          onImported={(p) => {
            refresh()
            // Make the just-imported profile active and jump straight to
            // Connect — reuses pickProfile (the same path as choosing a profile
            // from the list), so the user isn't dropped back onto the list to
            // hunt for the new card. Defaults to install mode (the common case
            // for a freshly imported NAS config); they can switch to Update
            // from Connect if they're re-pointing at an already-installed stack.
            pickProfile(p.id, 'install')
          }}
        />
      )}
    </div>
  )
}

// ── Helper subcomponents ─────────────────────────────────────────────

/** Loading skeleton for the profile list. Three placeholder rows that
 *  shimmer until profiles load. Better than a "Loading..." string for
 *  perceived speed — the user sees the right LAYOUT immediately. */
function ProfilesLoading() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 flex items-center gap-4 animate-pulse"
        >
          <div className="w-12 h-12 rounded-xl bg-slate-800" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-32 bg-slate-800 rounded" />
            <div className="h-3 w-48 bg-slate-800/60 rounded" />
          </div>
          <div className="h-9 w-24 bg-slate-800 rounded-md" />
        </div>
      ))}
    </div>
  )
}

/** Empty state — what new users see on their first launch. Big
 *  friendly hero with two equal-weight options (create vs. import). */
function EmptyState({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  const reduced = useReducedMotion()
  return (
    <motion.section
      initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900/60 to-slate-950/60 p-8 text-center space-y-5"
    >
      {/* Hero glyph for the empty state — a Server icon with a gentle
          rocking animation so the empty profile list doesn't feel
          stagnant. ~3s sway loop, suppressed under reduced-motion. */}
      <motion.div
        animate={reduced ? {} : { y: [0, -2, 0] }}
        transition={reduced ? {} : { duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/15 to-emerald-700/20 border border-emerald-500/25 mx-auto"
      >
        <Server size={36} className="text-emerald-300" strokeWidth={1.5} aria-hidden="true" />
      </motion.div>
      <div>
        <div className="text-slate-200 text-xl font-semibold">Let's set up your first NAS</div>
        <p className="text-slate-400 text-sm max-w-md mx-auto mt-2">
          A profile remembers your NAS connection and every setting so you don't
          re-type them next time. You can have one for each NAS.
        </p>
      </div>
      <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
        <BigButton
          variant="primary"
          icon={<Plus size={22} strokeWidth={2.5} />}
          onClick={onCreate}
        >
          Create your first profile
        </BigButton>
        <BigButton
          variant="secondary"
          icon={<Download size={22} strokeWidth={2.5} />}
          onClick={onImport}
        >
          Import from file
        </BigButton>
      </div>
    </motion.section>
  )
}
