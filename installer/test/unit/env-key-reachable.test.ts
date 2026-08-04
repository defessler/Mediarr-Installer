import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The gap this closes: a key can exist in .env.example, in env-schema.ts and in
// env-render.ts, pass the key-parity test, and still be UNREACHABLE because no
// input in the wizard is bound to it. Parity only proves the three key lists
// agree with each other. It says nothing about whether a human can set the value.
//
// MYLAR_COMICVINE_KEY shipped in v0.31.0 in exactly that state. Every layer
// carried it and the Python wrote it into Mylar3's config.ini correctly, but
// the Configure screen had no field, so the only way to set it was to hand-edit
// .env on the NAS. Mylar3 without a ComicVine key answers a search with an
// EMPTY page rather than an error (webserve.py returns bare when COMICVINE_API
// is None), so a key nobody could set presented as a broken app, and it took
// two live runs to find.
//
// USER-SETTABLE below is the list of optional keys that are useless unless a
// person can type them in. Adding a key here without a matching input fails.

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..', 'src')

const CONFIGURE = readFileSync(
  join(SRC, 'renderer', 'screens', 'ConfigureScreen.tsx'), 'utf8')
const SCHEMA = readFileSync(join(SRC, 'shared', 'env-schema.ts'), 'utf8')
const RENDER = readFileSync(join(SRC, 'shared', 'env-render.ts'), 'utf8')

/** Keys a user must be able to enter somewhere in the wizard. Service secrets
 *  and metadata keys belong here. Derived or toggle-driven keys do not. */
const USER_SETTABLE = [
  'MYLAR_COMICVINE_KEY',
]

describe('every user-settable env key is reachable from the UI', () => {
  it.each(USER_SETTABLE)('%s is bound to an input on the Configure screen', (key) => {
    // Bound either as <Field k="KEY" /> or through an explicit update('KEY', …).
    // Both are real binding styles in this file, so accept either.
    const asField = new RegExp(`k=["']${key}["']`).test(CONFIGURE)
    const asUpdate = new RegExp(`update\\(\\s*["']${key}["']`).test(CONFIGURE)
    expect(
      asField || asUpdate,
      `${key} exists in the env layers but no Configure input sets it, so the ` +
      `only way to supply it is hand-editing .env on the NAS.`,
    ).toBe(true)
  })

  it.each(USER_SETTABLE)('%s still round-trips through schema and renderer', (key) => {
    // Guards the other direction: a field wired to a key that no longer renders
    // into .env would be a control that silently does nothing.
    expect(SCHEMA).toContain(key)
    expect(RENDER).toContain(key)
  })
})
