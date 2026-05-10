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
