// Portable, passphrase-protected encryption for profile EXPORT files.
//
// In the live profile-store we use Electron safeStorage which talks to
// DPAPI / Keychain / libsecret. That gives us a machine-bound encrypted
// blob: secure on this device, useless if the file is copied off.
//
// For the export/import flow the file IS supposed to travel between
// machines, so we re-encrypt with a passphrase chosen by the user.
// Standard, boring crypto: PBKDF2-SHA256 with 200k iterations to
// derive a 32-byte key, then AES-256-GCM with a fresh 12-byte IV.
// The auth tag verifies the passphrase implicitly on decrypt — a
// wrong passphrase raises a tag-mismatch error which we surface as
// "wrong passphrase" instead of leaking decrypted gibberish.
//
// File envelope is JSON for easy inspection / debugging:
// {
//   "format": "mediarr-profile/v1",
//   "label": "DS1522+",
//   "exportedAt": 1731000000000,
//   "kdf":    { "name": "PBKDF2-SHA256", "iters": 200000, "salt": "<b64>" },
//   "cipher": { "name": "AES-256-GCM",   "iv":    "<b64>", "tag": "<b64>", "ct": "<b64>" }
// }
//
// Backwards-compatible additions go into a new "format" version; the
// loader will refuse anything it doesn't know.

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  randomBytes,
} from 'node:crypto'
import { promisify } from 'node:util'

// Async pbkdf2 so the 200k SHA-256 rounds (≈100–300ms) don't block the
// main process. Each call is rare (once per export click / per import
// attempt) so the work itself isn't the concern — but blocking the
// Electron event loop freezes the UI for that span, which is jarring.
const pbkdf2Async = promisify(pbkdf2)

export const EXPORT_FORMAT_VERSION = 'mediarr-profile/v1'
const KDF_NAME = 'PBKDF2-SHA256'
const KDF_ITERS = 200_000
const KDF_SALT_LEN = 16
const KDF_KEY_LEN = 32
const CIPHER_NAME = 'AES-256-GCM'
const CIPHER_IV_LEN = 12
const CIPHER_TAG_LEN = 16

export interface ProfileExportEnvelope {
  format: typeof EXPORT_FORMAT_VERSION
  label: string
  exportedAt: number
  kdf: { name: string; iters: number; salt: string }   // salt is base64
  cipher: { name: string; iv: string; tag: string; ct: string }  // all base64
}

/** Validate that an arbitrary value looks like a ProfileExportEnvelope.
 *  Used at IPC boundaries so a malformed import file can't sneak past
 *  the type system. Returns null when valid; a human-readable error
 *  string otherwise. */
export function validateEnvelopeShape(v: unknown): string | null {
  if (!v || typeof v !== 'object') return 'Not an object.'
  const e = v as Partial<ProfileExportEnvelope>
  if (e.format !== EXPORT_FORMAT_VERSION) {
    return `Wrong format tag (got "${String(e.format)}", expected "${EXPORT_FORMAT_VERSION}").`
  }
  if (typeof e.label !== 'string') return 'Missing label.'
  if (typeof e.exportedAt !== 'number') return 'Missing exportedAt timestamp.'
  if (!e.kdf || typeof e.kdf !== 'object') return 'Missing kdf block.'
  if (typeof e.kdf.name !== 'string' || typeof e.kdf.salt !== 'string'
      || typeof e.kdf.iters !== 'number') {
    return 'Malformed kdf block.'
  }
  if (!e.cipher || typeof e.cipher !== 'object') return 'Missing cipher block.'
  if (typeof e.cipher.name !== 'string' || typeof e.cipher.iv !== 'string'
      || typeof e.cipher.tag !== 'string' || typeof e.cipher.ct !== 'string') {
    return 'Malformed cipher block.'
  }
  return null
}

/** Wrap a plaintext payload (will be JSON.stringify'd if not already a
 *  string) in a passphrase-protected envelope. */
export async function encryptExport(args: {
  payload: string | object
  passphrase: string
  label: string
}): Promise<ProfileExportEnvelope> {
  const plaintext = typeof args.payload === 'string'
    ? args.payload
    : JSON.stringify(args.payload)
  const salt = randomBytes(KDF_SALT_LEN)
  const key  = await pbkdf2Async(args.passphrase, salt, KDF_ITERS, KDF_KEY_LEN, 'sha256')
  const iv   = randomBytes(CIPHER_IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    format: EXPORT_FORMAT_VERSION,
    label: args.label,
    exportedAt: Date.now(),
    kdf:    { name: KDF_NAME,    iters: KDF_ITERS, salt: salt.toString('base64') },
    cipher: { name: CIPHER_NAME, iv: iv.toString('base64'),
              tag: tag.toString('base64'), ct: ct.toString('base64') },
  }
}

/** Unwrap an envelope. Throws on:
 *  - malformed envelope (caller surfaces "this file isn't a profile export")
 *  - wrong passphrase / tampered ciphertext (AES-GCM tag mismatch — caller
 *    surfaces "the passphrase didn't match"). */
export async function decryptExport(args: {
  envelope: ProfileExportEnvelope
  passphrase: string
}): Promise<string> {
  const e = args.envelope
  if (e.format !== EXPORT_FORMAT_VERSION) {
    throw new Error(`Unsupported export format "${e.format}" (expected ${EXPORT_FORMAT_VERSION}).`)
  }
  if (e.kdf?.name !== KDF_NAME) {
    throw new Error(`Unsupported KDF "${e.kdf?.name}".`)
  }
  if (e.cipher?.name !== CIPHER_NAME) {
    throw new Error(`Unsupported cipher "${e.cipher?.name}".`)
  }
  const salt = Buffer.from(e.kdf.salt, 'base64')
  const iv   = Buffer.from(e.cipher.iv,  'base64')
  const tag  = Buffer.from(e.cipher.tag, 'base64')
  const ct   = Buffer.from(e.cipher.ct,  'base64')
  if (salt.length !== KDF_SALT_LEN) {
    throw new Error(`Bad salt length (${salt.length}, expected ${KDF_SALT_LEN}).`)
  }
  if (iv.length !== CIPHER_IV_LEN) {
    throw new Error(`Bad IV length (${iv.length}, expected ${CIPHER_IV_LEN}).`)
  }
  if (tag.length !== CIPHER_TAG_LEN) {
    throw new Error(`Bad auth tag length (${tag.length}, expected ${CIPHER_TAG_LEN}).`)
  }
  if (ct.length === 0) {
    throw new Error('Empty ciphertext.')
  }
  const iters = Number(e.kdf.iters)
  if (!Number.isInteger(iters) || iters < 50_000 || iters > 5_000_000) {
    throw new Error(`KDF iteration count out of safe range (${e.kdf.iters}).`)
  }
  const key = await pbkdf2Async(args.passphrase, salt, iters, KDF_KEY_LEN, 'sha256')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  // Past this point, the only realistic failure is GCM auth tag
  // verification — which fires when either the passphrase is wrong
  // OR the ciphertext has been tampered with. Both surface to the
  // user as "wrong passphrase" since they can't distinguish. We
  // deliberately don't pattern-match on the OpenSSL error string;
  // any failure during this final block IS the auth check.
  try {
    const out = Buffer.concat([decipher.update(ct), decipher.final()])
    return out.toString('utf8')
  } catch {
    throw new Error('wrong-passphrase')
  }
}

/** Lightweight strength heuristic for the passphrase-strength meter.
 *  Returns 0..4 where 0 = "too weak", 4 = "strong". No external deps;
 *  intentionally rough (avoid lulling the user into thinking we're
 *  doing rigorous entropy analysis).
 *
 *  NB: ExportProfileDialog.tsx duplicates this for live-meter feedback
 *  on every keystroke (avoids an IPC round-trip per character). If you
 *  change the rules here, mirror them there. */
export function passphraseStrength(p: string): 0 | 1 | 2 | 3 | 4 {
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
