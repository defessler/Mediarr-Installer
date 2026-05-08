// Saved SSH connection profiles. Stored as a single JSON file in the
// app's userData directory. Sensitive fields (password, key passphrase)
// are encrypted with safeStorage; everything else is plaintext.
//
// File shape:
// {
//   version: 1,
//   profiles: [
//     {
//       id: "uuid",
//       label: "DS1522+",
//       host: "192.168.1.10",
//       port: 22,
//       user: "root",
//       authMethod: "password" | "privateKey",
//       privateKeyPath?: "C:\\Users\\me\\.ssh\\id_ed25519",
//       /** safeStorage-encrypted, base64. May be omitted if the user
//        *  declined to save the secret. */
//       encryptedSecret?: "...",
//       lastUsedAt: 1731000000000
//     }
//   ]
// }

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  encryptToBase64,
  decryptFromBase64,
  isEncryptionAvailable,
} from './secret-store.js'

export interface SavedProfile {
  id: string
  label: string
  host: string
  port: number
  user: string
  authMethod: 'password' | 'privateKey'
  privateKeyPath?: string
  /** True if a secret is on file. The actual secret is never sent to the
   *  renderer; the renderer asks for it on demand. */
  hasSecret: boolean
  lastUsedAt: number
}

interface OnDiskProfile extends Omit<SavedProfile, 'hasSecret'> {
  encryptedSecret?: string
}

interface OnDiskShape {
  version: 1
  profiles: OnDiskProfile[]
}

const FILE = () => join(app.getPath('userData'), 'profiles.json')

async function readFile(): Promise<OnDiskShape> {
  try {
    const raw = await fs.readFile(FILE(), 'utf8')
    const parsed = JSON.parse(raw) as OnDiskShape
    if (parsed?.version === 1 && Array.isArray(parsed.profiles)) return parsed
  } catch {
    /* file doesn't exist or is corrupt — start fresh */
  }
  return { version: 1, profiles: [] }
}

async function writeFile(data: OnDiskShape): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(FILE(), JSON.stringify(data, null, 2), { mode: 0o600 })
}

function toPublic(p: OnDiskProfile): SavedProfile {
  const { encryptedSecret, ...rest } = p
  return { ...rest, hasSecret: !!encryptedSecret }
}

// ── public API ────────────────────────────────────────────────────────────────

export async function listProfiles(): Promise<SavedProfile[]> {
  const data = await readFile()
  return data.profiles
    .map(toPublic)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export interface SaveProfileInput {
  label: string
  host: string
  port: number
  user: string
  authMethod: 'password' | 'privateKey'
  privateKeyPath?: string
  /** Plaintext secret. If undefined we don't store one; the user will be
   *  prompted again next time. */
  secret?: string
  /** If provided, update an existing profile instead of creating one. */
  id?: string
}

export async function saveProfile(input: SaveProfileInput): Promise<SavedProfile> {
  const data = await readFile()
  const id = input.id ?? randomUUID()
  let encryptedSecret: string | undefined
  if (input.secret) {
    if (!isEncryptionAvailable()) {
      throw new Error('Cannot save secret — OS encryption unavailable on this machine')
    }
    encryptedSecret = encryptToBase64(input.secret)
  }

  const next: OnDiskProfile = {
    id,
    label: input.label,
    host: input.host,
    port: input.port,
    user: input.user,
    authMethod: input.authMethod,
    privateKeyPath: input.privateKeyPath,
    encryptedSecret,
    lastUsedAt: Date.now(),
  }

  const idx = data.profiles.findIndex((p) => p.id === id)
  if (idx >= 0) {
    // Preserve existing encryptedSecret if the new save didn't include one
    // (e.g. user re-saved without retyping the password).
    if (!encryptedSecret && data.profiles[idx].encryptedSecret) {
      next.encryptedSecret = data.profiles[idx].encryptedSecret
    }
    data.profiles[idx] = next
  } else {
    data.profiles.push(next)
  }

  await writeFile(data)
  return toPublic(next)
}

export async function deleteProfile(id: string): Promise<void> {
  const data = await readFile()
  data.profiles = data.profiles.filter((p) => p.id !== id)
  await writeFile(data)
}

/** Returns the decrypted secret for a given profile, or null if there isn't
 *  one stored or it can't be decrypted on this machine. */
export async function getSecret(id: string): Promise<string | null> {
  const data = await readFile()
  const p = data.profiles.find((x) => x.id === id)
  if (!p?.encryptedSecret) return null
  return decryptFromBase64(p.encryptedSecret)
}

/** Update only the lastUsedAt timestamp — called after a successful connect. */
export async function touchProfile(id: string): Promise<void> {
  const data = await readFile()
  const p = data.profiles.find((x) => x.id === id)
  if (!p) return
  p.lastUsedAt = Date.now()
  await writeFile(data)
}
