// Saved profiles are the source of truth for every per-NAS setting:
// connection details + full .env config + target directory. Stored
// encrypted (via Electron safeStorage) at userData/profiles.json.
//
// File layout (on disk):
// {
//   "version": 2,
//   "profiles": [
//     {
//       "id": "uuid",
//       "label": "DS1522+",
//       "lastUsedAt": 1731000000000,
//       "encrypted": "<base64 safeStorage blob containing connection + config + targetDir>"
//     }
//   ]
// }
//
// The renderer never sees the encrypted blob. profile:list returns only
// id/label/lastUsedAt + a non-secret summary; profile:load returns the
// fully-decrypted shape (connection + config + targetDir) for the
// currently-active profile.

import { app } from 'electron'
import log from 'electron-log/main.js'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  encryptToBase64,
  decryptFromBase64,
  isEncryptionAvailable,
} from './secret-store.js'
import {
  decryptExport,
  encryptExport,
  EXPORT_FORMAT_VERSION,
  validateEnvelopeShape,
  type ProfileExportEnvelope,
} from './profile-crypto.js'
import type {
  LoadedProfile,
  ProfileConnection,
  SavedProfile,
  SaveProfileInput,
} from '../shared/ipc.js'

interface OnDiskProfile {
  id: string
  label: string
  lastUsedAt: number
  /** Encrypted JSON blob: { connection, targetDir, config } */
  encrypted: string
  /** Plaintext mirror of a few non-secret connection fields so we can
   *  surface them on the picker without decrypting (some users may not
   *  have safeStorage available, in which case we fall back to plain
   *  JSON for everything — see writeFile). */
  summary?: {
    host: string
    port: number
    user: string
    authMethod: 'password' | 'privateKey'
    privateKeyPath?: string
    hasConfig: boolean
    hasSecret: boolean
  }
}

interface OnDiskShape {
  version: 2
  profiles: OnDiskProfile[]
}

const FILE = () => join(app.getPath('userData'), 'profiles.json')

interface ProfileBody {
  connection: ProfileConnection
  targetDir: string
  config: Record<string, string>
  /** Optional MigrateScreen state — source arr/qBit URLs + creds the
   *  user pasted last time so they don't have to re-enter them. v2
   *  profiles written before this field existed simply omit it.
   *  Lives inside the encrypted blob since it contains source-side
   *  API keys / WebUI passwords. */
  migrate?: import('../shared/ipc.js').MigrateState
}

const DEFAULT_TARGET = '/volume1/docker/media'

async function readFile(): Promise<OnDiskShape> {
  try {
    const raw = await fs.readFile(FILE(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<OnDiskShape> & { profiles?: unknown }
    if (parsed?.version === 2 && Array.isArray(parsed.profiles)) {
      return parsed as OnDiskShape
    }
    // Migrate v1 → v2: v1 had encryptedSecret + plaintext connection;
    // we lose the secret on migration since v2 expects an opaque
    // encrypted body. The user will be re-prompted on first use.
    if (Array.isArray(parsed.profiles)) {
      const migrated: OnDiskProfile[] = (parsed.profiles as unknown as Array<Record<string, unknown>>)
        .map((p) => ({
          id: String(p.id ?? randomUUID()),
          label: String(p.label ?? `${p.user ?? 'root'}@${p.host ?? 'host'}`),
          lastUsedAt: typeof p.lastUsedAt === 'number' ? p.lastUsedAt : Date.now(),
          encrypted: '',
          summary: {
            host: String(p.host ?? ''),
            port: Number(p.port) || 22,
            user: String(p.user ?? 'root'),
            authMethod: (p.authMethod === 'privateKey' ? 'privateKey' : 'password'),
            privateKeyPath: typeof p.privateKeyPath === 'string' ? p.privateKeyPath : undefined,
            hasConfig: false,
            hasSecret: false,
          },
        }))
      return { version: 2, profiles: migrated }
    }
  } catch (e) {
    // A read/parse failure on an EXISTING, non-empty file is corruption (e.g. a
    // half-written profiles.json from a crash mid-write), NOT "no profiles yet".
    // Move the bytes aside so the next writeFile can't overwrite them with an
    // empty store — a manual recovery stays possible.
    await preserveCorruptProfiles(e)
  }
  return { version: 2, profiles: [] }
}

/** If profiles.json exists and is non-empty but unreadable/unparseable, move it to
 *  a .corrupt-<ts> sibling (never delete) so the caller's empty-store fallback can't
 *  silently destroy a recoverable file. No-op when the file is genuinely missing. */
async function preserveCorruptProfiles(cause: unknown): Promise<void> {
  try {
    const st = await fs.stat(FILE())
    if (st.size > 0) {
      const backup = `${FILE()}.corrupt-${Date.now()}`
      await fs.rename(FILE(), backup)
      log.error(`profile-store: profiles.json unreadable (${String(cause)}); moved corrupt copy to ${backup}`)
    }
  } catch { /* genuinely missing, or the move failed — nothing more we can do */ }
}

async function writeFile(data: OnDiskShape): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  // Atomic write. profiles.json is the SOLE source of truth for every NAS's
  // connection details, full config, and safeStorage-encrypted secrets. A bare
  // fs.writeFile opens O_TRUNC — zeroing the good file BEFORE the new bytes flush —
  // so a crash / power-loss / ENOSPC in that window leaves it half-written, and
  // readFile would then read it as "no profiles" and the next write would cement
  // the loss. Write a sibling temp, fsync, then rename(2) (atomic) so a crash always
  // leaves either the whole old or the whole new file. All callers run under
  // withLock(), so the per-pid temp name is never used concurrently.
  const tmp = `${FILE()}.tmp.${process.pid}`
  try {
    const fh = await fs.open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(JSON.stringify(data, null, 2), { encoding: 'utf8' })
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, FILE())
  } catch (e) {
    try { await fs.unlink(tmp) } catch { /* nothing to clean up */ }
    throw e
  }
}

// ── Write serialization ──────────────────────────────────────────────────────
// Every mutation does readFile -> mutate -> writeFile with awaits in between, so
// without serialization a fire-and-forget touchProfile (ConnectScreen / RunScreen /
// WelcomeScreen call it un-awaited) can interleave with an in-flight saveProfile and
// write back a STALE snapshot — permanently dropping the just-saved config/secret.
// Chaining each mutation through a single promise makes it observe the previous
// one's committed result. The exported saveProfile/deleteProfile/touchProfile below
// are thin wrappers over the *Locked implementations. importProfile is deliberately
// NOT wrapped: it delegates its write to the (locked) saveProfile, so wrapping it too
// would re-enter the chain and deadlock.
let writeChain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)   // run after the prior op settles (success OR failure)
  writeChain = run.catch(() => {})      // keep the chain alive; this caller still sees errors via `run`
  return run
}

export function saveProfile(input: SaveProfileInput): Promise<SavedProfile> {
  return withLock(() => saveProfileLocked(input))
}
export function deleteProfile(id: string): Promise<void> {
  return withLock(() => deleteProfileLocked(id))
}
export function touchProfile(id: string): Promise<void> {
  return withLock(() => touchProfileLocked(id))
}

// Each stored blob carries a CODEC TAG so decode always uses the codec the
// blob was WRITTEN with — never a guess from the current (possibly changed)
// safeStorage availability. Without this, an encrypted blob read when
// encryption is unavailable (a copied profiles.json on another machine, a
// keychain reset, a safeStorage flip) was base64-misread into garbage and the
// profile silently lost every saved value but host/port.
const ENC_TAG = 'enc:' // safeStorage-encrypted (DPAPI/Keychain — machine-bound)
const B64_TAG = 'b64:' // plaintext base64 (safeStorage was unavailable at write)

function encodeBody(body: ProfileBody): string {
  const json = JSON.stringify(body)
  if (isEncryptionAvailable()) return ENC_TAG + encryptToBase64(json)
  // safeStorage unavailable (rare) — degrade to base64 (NOT secure, but
  // matches the user's "save passwords" intent at least mechanically).
  return B64_TAG + Buffer.from(json, 'utf8').toString('base64')
}

function decodeBody(blob: string): ProfileBody | null {
  if (!blob) return null
  try {
    let json: string | null
    if (blob.startsWith(ENC_TAG)) {
      // Written encrypted: always attempt DECRYPT. If safeStorage can't
      // decrypt it now (different machine / reset keychain), this throws and
      // we return null cleanly — never a garbage base64 misread.
      json = decryptFromBase64(blob.slice(ENC_TAG.length))
    } else if (blob.startsWith(B64_TAG)) {
      json = Buffer.from(blob.slice(B64_TAG.length), 'base64').toString('utf8')
    } else {
      // Untagged legacy blob (written before tagging) — fall back to live
      // availability, matching how it was written. Re-saved blobs get tagged.
      json = isEncryptionAvailable() ? decryptFromBase64(blob) : Buffer.from(blob, 'base64').toString('utf8')
    }
    if (!json) return null
    const parsed = JSON.parse(json) as ProfileBody
    if (!parsed?.connection) return null
    return parsed
  } catch {
    return null
  }
}

function summary(body: ProfileBody | null,
                 fallback?: OnDiskProfile['summary']): NonNullable<OnDiskProfile['summary']> {
  if (body) {
    const c = body.connection
    return {
      host: c.host,
      port: c.port,
      user: c.user,
      authMethod: c.authMethod,
      privateKeyPath: c.privateKeyPath,
      hasConfig: Object.keys(body.config || {}).length > 0,
      hasSecret: Boolean(c.password || c.passphrase || c.sudoPassword),
    }
  }
  return fallback ?? {
    host: '', port: 22, user: 'root', authMethod: 'password',
    hasConfig: false, hasSecret: false,
  }
}

function toPublic(p: OnDiskProfile): SavedProfile {
  // Prefer the in-blob summary when we can decrypt; fall back to the
  // on-disk summary for picker UX while still letting profile:load
  // populate full state once the user selects.
  const body = decodeBody(p.encrypted)
  const s = summary(body, p.summary)
  // Ground truth for at-rest encryption: the codec tag the blob was WRITTEN
  // with (ENC = safeStorage/DPAPI, B64 = plaintext base64). Untagged legacy
  // blobs fall back to the live availability they were written under. Mirrors
  // isProfileEncryptedAtRest, but computed inline here so it rides the existing
  // profile:list IPC with no extra round-trip.
  const encryptedAtRest =
    p.encrypted.startsWith(ENC_TAG) ? true
    : p.encrypted.startsWith(B64_TAG) ? false
    : p.encrypted ? isEncryptionAvailable() : false
  return {
    id: p.id,
    label: p.label,
    connection: {
      host: s.host,
      port: s.port,
      user: s.user,
      authMethod: s.authMethod,
      privateKeyPath: s.privateKeyPath,
    },
    hasSecret: s.hasSecret,
    hasConfig: s.hasConfig,
    encryptedAtRest,
    lastUsedAt: p.lastUsedAt,
  }
}

// ── public API ────────────────────────────────────────────────────────────────

// WHY: When safeStorage is unavailable (e.g. Linux without libsecret/kwallet)
// the saved SSH/sudo password + key passphrase are written as trivially-
// reversible base64 — only 0600 file perms protect them. SavedProfile exposes
// hasSecret but says nothing about storage QUALITY, so the UI can't warn the
// user. These accessors surface the signal without touching the on-disk format
// or the SavedProfile shape (kept stable to avoid breaking parallel edits): a
// later IPC handler can expose them so a UI change can show an at-rest warning.

/** Whether OS-level encryption is available right now. When false, newly
 *  saved profiles will degrade to plaintext base64 (see encodeBody). */
export function isProfileStorageEncrypted(): boolean {
  return isEncryptionAvailable()
}

/** Ground truth for a SINGLE stored profile: whether its on-disk blob is
 *  actually safeStorage-encrypted. This can differ from the global flag — a
 *  profile written while encryption was unavailable stays base64 even if
 *  libsecret/kwallet later appears. Unknown ids report false (no secret to
 *  protect). */
export async function isProfileEncryptedAtRest(id: string): Promise<boolean> {
  const data = await readFile()
  const p = data.profiles.find((x) => x.id === id)
  if (!p) return false
  // ENC_TAG = safeStorage; B64_TAG = plaintext base64. Untagged legacy blobs
  // were written using the live availability at write time, so fall back to it.
  if (p.encrypted.startsWith(ENC_TAG)) return true
  if (p.encrypted.startsWith(B64_TAG)) return false
  return p.encrypted ? isEncryptionAvailable() : false
}

export async function listProfiles(): Promise<SavedProfile[]> {
  const data = await readFile()
  return data.profiles
    .map(toPublic)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export async function loadProfile(id: string): Promise<LoadedProfile | null> {
  const data = await readFile()
  const p = data.profiles.find((x) => x.id === id)
  if (!p) return null
  const body = decodeBody(p.encrypted)
  if (!body) {
    // Encrypted blob can't be decrypted on this machine (e.g. file
    // copied from another OS). Return the public summary so the user
    // can at least see / re-enter values.
    const s = p.summary ?? summary(null)
    return {
      id: p.id,
      label: p.label,
      connection: {
        host: s.host,
        port: s.port,
        user: s.user,
        authMethod: s.authMethod,
        privateKeyPath: s.privateKeyPath,
      },
      targetDir: DEFAULT_TARGET,
      config: {},
      lastUsedAt: p.lastUsedAt,
    }
  }
  return {
    id: p.id,
    label: p.label,
    connection: body.connection,
    targetDir: body.targetDir || DEFAULT_TARGET,
    config: body.config || {},
    migrate: body.migrate,
    lastUsedAt: p.lastUsedAt,
  }
}

async function saveProfileLocked(input: SaveProfileInput): Promise<SavedProfile> {
  const data = await readFile()
  const id = input.id ?? randomUUID()
  const idx = data.profiles.findIndex((p) => p.id === id)

  // Data-loss guard. If we're UPDATING an existing profile whose stored blob is
  // encrypted-but-currently-undecryptable (the OS keyring wasn't unlocked yet
  // at launch, or profiles.json was copied from another machine) AND the
  // incoming values carry no secret/config of their own — i.e. a pure rename,
  // or an edit made against the secret-less stub loadProfile returns in that
  // state — do NOT overwrite the still-recoverable blob. Keep it and update
  // only the label/lastUsedAt; the real secrets come back intact once the
  // keyring is available. Re-entering a secret here (incomingHasSecret) is
  // treated as a deliberate fresh save and bypasses this guard.
  if (idx >= 0) {
    const existing = data.profiles[idx]
    const incomingHasSecret = Boolean(
      input.connection?.password ||
      input.connection?.passphrase ||
      input.connection?.sudoPassword,
    )
    const incomingHasConfig = Object.keys(input.config || {}).length > 0
    if (
      existing.encrypted.startsWith(ENC_TAG) &&
      decodeBody(existing.encrypted) === null &&
      !incomingHasSecret &&
      !incomingHasConfig
    ) {
      const preserved: OnDiskProfile = { ...existing, label: input.label, lastUsedAt: Date.now() }
      data.profiles[idx] = preserved
      await writeFile(data)
      return toPublic(preserved)
    }
  }

  const body: ProfileBody = {
    connection: input.connection,
    targetDir: input.targetDir,
    config: input.config,
    migrate: input.migrate,
  }
  const next: OnDiskProfile = {
    id,
    label: input.label,
    lastUsedAt: Date.now(),
    encrypted: encodeBody(body),
    summary: summary(body),
  }
  if (idx >= 0) data.profiles[idx] = next
  else data.profiles.push(next)
  await writeFile(data)
  return toPublic(next)
}

async function deleteProfileLocked(id: string): Promise<void> {
  const data = await readFile()
  data.profiles = data.profiles.filter((p) => p.id !== id)
  await writeFile(data)
}

/** Legacy v1 API — retrieves a profile's secret. v2 profiles store the
 *  full body under `encrypted`; we return the password from there for
 *  backward compatibility with code that hasn't been updated. */
export async function getSecret(id: string): Promise<string | null> {
  const p = await loadProfile(id)
  return p?.connection.password ?? null
}

async function touchProfileLocked(id: string): Promise<void> {
  const data = await readFile()
  const p = data.profiles.find((x) => x.id === id)
  if (!p) return
  p.lastUsedAt = Date.now()
  await writeFile(data)
}

// ── Export / Import (portable, passphrase-protected) ─────────────────────────
//
// The in-app profile store encrypts secrets via Electron safeStorage, which
// is machine-bound (DPAPI / Keychain / libsecret). That's the right call
// for resting data on this device, but useless if you want to carry a
// profile to a different NAS-management workstation. The export flow
// re-encrypts under a user-chosen passphrase (PBKDF2 + AES-GCM in
// profile-crypto.ts) so the file is portable.
//
// We deliberately strip the machine-local id during export and the stale
// Plex claim from the config block on import (Plex claim tokens expire 4
// minutes after issuance — restoring one from a file is always wrong).

/** Build the export envelope for a profile. Caller is expected to
 *  prompt for the passphrase before invoking this. */
export async function exportProfile(id: string, passphrase: string): Promise<ProfileExportEnvelope> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Passphrase is required.')
  }
  // Refuse to export a profile whose secrets can't be decrypted on THIS
  // machine. Otherwise loadProfile returns a secret-less stub (no password /
  // passphrase / sudo, empty config) and we'd emit a structurally-valid but
  // EMPTY backup that silently "succeeds" — the user would believe they have a
  // real backup. Reachable when profiles.json was copied from another machine,
  // the OS keychain was reset, or the Linux keyring isn't unlocked yet.
  const onDisk = (await readFile()).profiles.find((x) => x.id === id)
  if (onDisk && onDisk.encrypted.startsWith(ENC_TAG) && decodeBody(onDisk.encrypted) === null) {
    throw new Error(
      "This profile's secrets are encrypted on its original machine and can't be read " +
      'here, so there is nothing to export. Re-enter the profile on this machine first.',
    )
  }
  const p = await loadProfile(id)
  if (!p) throw new Error(`profile ${id} not found`)
  // Payload shape mirrors LoadedProfile minus the machine-local id and
  // lastUsedAt — both regenerated on import. Plex claim DOES round-trip
  // intentionally; we only strip it on the IMPORT side, since a user
  // exporting and importing on the same day might still have a valid one.
  const payload = {
    label: p.label,
    connection: p.connection,
    targetDir: p.targetDir,
    config: p.config,
    migrate: p.migrate,
  }
  return encryptExport({ payload, passphrase, label: p.label })
}

/** Decrypt an envelope and persist as a brand-new profile. Returns
 *  the new SavedProfile (with a fresh id) so the renderer can route
 *  the user straight into it. Throws "wrong-passphrase" on tag-mismatch. */
export async function importProfile(args: {
  envelope: unknown
  passphrase: string
}): Promise<SavedProfile> {
  if (typeof args.passphrase !== 'string' || args.passphrase.length === 0) {
    throw new Error('Passphrase is required.')
  }
  // Defensive shape-check at the IPC boundary — the renderer is
  // trusted code but a corrupt or hand-edited .mediarr-profile.json
  // could still reach here with garbage data.
  const shapeError = validateEnvelopeShape(args.envelope)
  if (shapeError) {
    throw new Error(`Export file is malformed: ${shapeError}`)
  }
  const envelope = args.envelope as ProfileExportEnvelope
  if (envelope.format !== EXPORT_FORMAT_VERSION) {
    throw new Error(`Unsupported export format "${envelope.format}".`)
  }
  const plaintext = await decryptExport({ envelope, passphrase: args.passphrase })
  let parsed: {
    label?: string
    connection?: ProfileConnection
    targetDir?: string
    config?: Record<string, string>
    migrate?: import('../shared/ipc.js').MigrateState
  }
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Decrypted payload was not valid JSON — file may be corrupted.')
  }
  if (!parsed?.connection || !parsed?.label) {
    throw new Error('Export file is missing required fields (connection / label).')
  }

  // WHY: a corrupt-but-decryptable export (empty connection object, a string
  // port, an unknown authMethod) would otherwise be saved verbatim and only
  // fail — confusingly — at connect time. Validate the connection field TYPES
  // here so the user gets a clear "malformed export" error up front instead of
  // an opaque SSH failure later. (We intentionally don't validate optional
  // secret fields — those are legitimately absent for key-only profiles.)
  // We read through an `unknown`-valued view because JSON.parse can produce any
  // runtime shape despite the static ProfileConnection annotation — without
  // this, the literal authMethod check would be flagged as a no-overlap
  // comparison and the typeof guards reduced to dead branches.
  const conn = parsed.connection as unknown as Record<string, unknown>
  // Type-only check on host: an EMPTY host is VALID, not malformed. A profile
  // created but not yet filled in is persisted with host:'' (WelcomeScreen
  // seeds it, autosave writes it), and Export is reachable on such a profile —
  // so an un-configured export round-tripped fine before this validation
  // existed, and the app tolerates an empty host at runtime (the user types it
  // on the Connect screen). Rejecting empty here regressed that path; only a
  // non-string host is genuinely corrupt.
  if (typeof conn.host !== 'string') {
    throw new Error('Export file is malformed: connection host is not a string.')
  }
  if (typeof conn.port !== 'number' || !Number.isInteger(conn.port) || conn.port < 1 || conn.port > 65535) {
    throw new Error('Export file is malformed: connection port is not a valid port number.')
  }
  if (typeof conn.user !== 'string' || conn.user.length === 0) {
    throw new Error('Export file is malformed: connection user is missing.')
  }
  if (conn.authMethod !== 'password' && conn.authMethod !== 'privateKey') {
    throw new Error('Export file is malformed: connection authMethod is unknown.')
  }

  // De-conflict the label: if a profile with the same name already
  // exists, suffix " (imported)" so the user doesn't get two cards
  // labelled identically. Repeat the suffix as needed.
  const existing = await readFile()
  let label = parsed.label
  const taken = new Set(existing.profiles.map((p) => p.label))
  if (taken.has(label)) {
    let n = 1
    while (taken.has(`${parsed.label} (imported${n === 1 ? '' : ' ' + n})`)) n++
    label = `${parsed.label} (imported${n === 1 ? '' : ' ' + n})`
  }

  // Strip Plex claim tokens — they expire in 4 minutes and a restored
  // one from any meaningful-aged export is always dead. The user will
  // re-paste a fresh one on the Run screen.
  const cleanConfig = { ...(parsed.config ?? {}) }
  delete cleanConfig.PLEX_CLAIM

  const saved = await saveProfile({
    label,
    connection: parsed.connection,
    targetDir: parsed.targetDir || DEFAULT_TARGET,
    config: cleanConfig,
    migrate: parsed.migrate,
  })
  return saved
}
