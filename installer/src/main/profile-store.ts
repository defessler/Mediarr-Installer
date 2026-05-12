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
  } catch { /* file missing or unparseable — start fresh */ }
  return { version: 2, profiles: [] }
}

async function writeFile(data: OnDiskShape): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(FILE(), JSON.stringify(data, null, 2), { mode: 0o600 })
}

function encodeBody(body: ProfileBody): string {
  if (isEncryptionAvailable()) return encryptToBase64(JSON.stringify(body))
  // safeStorage unavailable (rare) — degrade to base64 (NOT secure, but
  // matches the user's "save passwords" intent at least mechanically).
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
}

function decodeBody(blob: string): ProfileBody | null {
  if (!blob) return null
  try {
    const json = isEncryptionAvailable()
      ? decryptFromBase64(blob)
      : Buffer.from(blob, 'base64').toString('utf8')
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
    lastUsedAt: p.lastUsedAt,
  }
}

// ── public API ────────────────────────────────────────────────────────────────

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
    lastUsedAt: p.lastUsedAt,
  }
}

export async function saveProfile(input: SaveProfileInput): Promise<SavedProfile> {
  const data = await readFile()
  const id = input.id ?? randomUUID()
  const body: ProfileBody = {
    connection: input.connection,
    targetDir: input.targetDir,
    config: input.config,
  }
  const next: OnDiskProfile = {
    id,
    label: input.label,
    lastUsedAt: Date.now(),
    encrypted: encodeBody(body),
    summary: summary(body),
  }
  const idx = data.profiles.findIndex((p) => p.id === id)
  if (idx >= 0) data.profiles[idx] = next
  else data.profiles.push(next)
  await writeFile(data)
  return toPublic(next)
}

export async function deleteProfile(id: string): Promise<void> {
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

export async function touchProfile(id: string): Promise<void> {
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
  }
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Decrypted payload was not valid JSON — file may be corrupted.')
  }
  if (!parsed?.connection || !parsed?.label) {
    throw new Error('Export file is missing required fields (connection / label).')
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
  })
  return saved
}
