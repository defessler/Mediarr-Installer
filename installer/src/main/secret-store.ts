// Encrypt/decrypt small strings using Electron's safeStorage. Uses
// DPAPI on Windows, Keychain on macOS, and libsecret/kwallet on Linux.
//
// Used by profile-store.ts to encrypt SSH passphrases / passwords on
// disk. The .env file uploaded to the NAS contains plaintext secrets
// — but that file lives on the NAS, not on the host machine; only
// host-side persistence goes through here.

import { safeStorage } from 'electron'

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** Returns a base64 string suitable for JSON storage. */
export function encryptToBase64(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level encryption is not available on this machine')
  }
  return safeStorage.encryptString(plaintext).toString('base64')
}

/** Inverse of encryptToBase64. Returns null if the buffer can't be decrypted
 *  (e.g. user moved the profile file to a different machine). */
export function decryptFromBase64(b64: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}
