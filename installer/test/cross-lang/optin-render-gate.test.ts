import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  BASH, PYTHON, NAS_SCRIPTS, extractShellFunc, runBash, runPython, withEnvFile,
} from '../helpers/shell.js'
import {
  renderEnv, isEnabled, isOptInEnabled, type EnvFormValues,
} from '../../src/shared/env-render.js'
import { BASE_ENV } from '../helpers/render.js'

// enable-agreement.test.ts pins the bash ↔ TS classifiers against raw .env
// TOKENS. This pins the seam one step earlier: the wizard's own RENDERER ↔
// those classifiers, per opt-in flag.
//
// The bug it guards is specific. An opt-in service is off unless its key is
// explicitly true, so adding one means touching env-render's type, its emitted
// line, AND the bash profile gate. Miss the emit and renderEnv silently drops
// the key — every downstream is_optin_enabled then reads an ABSENT key, which
// is indistinguishable from a deliberate false, and the service just never
// installs with no error anywhere. key-parity catches a key missing from
// .env.example; nothing caught a key missing from the rendered output.
//
// Asserting `false` for the undefined case is the other half: someone loading
// a saved profile from before the feature existed must not have the service
// switch itself on.

const SETUP_SH = join(NAS_SCRIPTS, 'setup.sh')

/** Every ENABLE_* flag whose semantics are explicit-true, with the compose
 *  profile setup.sh maps it to. Keep in step with the PROFILES block in
 *  setup.sh and OPT_IN_SERVICES in ConfigureScreen. */
const OPT_IN_FLAGS: { key: keyof EnvFormValues; profile: string }[] = [
  { key: 'ENABLE_SOULSEEK', profile: 'soulseek' },
  { key: 'ENABLE_PLAYLIST_SYNC', profile: 'playlists' },
  { key: 'ENABLE_DISPATCHARR', profile: 'livetv' },
  { key: 'ENABLE_LIBRARIAN', profile: 'librarian' },
  // LIBRARIAN_ALLOW_ACTIONS used to be in this list. It's now LibrARRian's
  // write mode and DEFAULT-ON, so it has the opposite semantics and gets its
  // own block below.
]

/** Render a full .env with `key` set to `value`, then read the emitted line. */
function emittedValue(key: keyof EnvFormValues, value: string | undefined): string | null {
  const rendered = renderEnv({ ...BASE_ENV, [key]: value })
  const line = rendered.split('\n').find((l) => l.startsWith(`${key}=`))
  return line === undefined ? null : line.slice(`${key}=`.length)
}

/** Run the REAL is_optin_enabled from setup.sh against a rendered .env. */
function bashGate(key: string, rendered: string): boolean {
  const program =
    extractShellFunc(SETUP_SH, 'env_val') + '\n' +
    extractShellFunc(SETUP_SH, 'is_optin_enabled') + '\n' +
    `is_optin_enabled ${key} && echo 1 || echo 0`
  const { path, cleanup } = withEnvFile(rendered)
  try {
    return runBash(program, { env: { ENV_FILE: path } }).stdout.trim() === '1'
  } finally {
    cleanup()
  }
}

describe('opt-in flags survive the renderer', () => {
  for (const { key } of OPT_IN_FLAGS) {
    it(`${key} is emitted for true, false, and undefined`, () => {
      expect(emittedValue(key, 'true'), `${key} not emitted when true`).toBe('true')
      expect(emittedValue(key, 'false'), `${key} not emitted when false`).toBe('false')
      // A pre-feature saved profile has no value at all. It must render an
      // explicit false, never vanish and never default on.
      expect(emittedValue(key, undefined), `${key} not emitted when unset`).toBe('false')
    })
  }
})

/** Run the REAL actions_enabled() out of librarian.py against one value, so
 *  this is an oracle rather than a reimplementation that could drift. */
function pyActionsEnabled(value: string): boolean {
  const program = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location('lib', ${
      JSON.stringify(join(NAS_SCRIPTS, 'librarian.py'))})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    "print(json.dumps(m.actions_enabled({'LIBRARIAN_ALLOW_ACTIONS': sys.argv[1]})))",
  ].join('\n')
  return JSON.parse(runPython(program, { args: [value] }).stdout.trim())
}

// LibrARRian's write mode is DEFAULT-ON (isEnabled), the opposite of every
// flag above, so the undefined case must render `true`. Pinned on its own
// because it gates deleting media: if the renderer and librarian.py ever
// disagree about the default, the user either loses buttons the wizard
// promised them or gains ones they explicitly turned off.
describe('LIBRARIAN_ALLOW_ACTIONS renders as default-on write mode', () => {
  it('is true when unset, and false only for an explicit off value', () => {
    expect(emittedValue('LIBRARIAN_ALLOW_ACTIONS', undefined)).toBe('true')
    expect(emittedValue('LIBRARIAN_ALLOW_ACTIONS', '')).toBe('true')
    expect(emittedValue('LIBRARIAN_ALLOW_ACTIONS', 'true')).toBe('true')
    for (const off of ['false', '0', 'no', 'off', 'OFF', ' False ']) {
      expect(emittedValue('LIBRARIAN_ALLOW_ACTIONS', off), `"${off}" should render false`)
        .toBe('false')
    }
  })
})

describe.skipIf(!PYTHON)('rendered .env ↔ librarian.py actions_enabled', () => {
  it('the page and the wizard agree on write mode, default included', () => {
    for (const value of ['true', 'false', '0', 'off', 'NO', '', undefined]) {
      const emitted = emittedValue('LIBRARIAN_ALLOW_ACTIONS', value) ?? ''
      expect(
        pyActionsEnabled(emitted),
        `LIBRARIAN_ALLOW_ACTIONS=${String(value)} rendered "${emitted}"`,
      ).toBe(isEnabled(emitted))
    }
  })
})

describe.skipIf(!BASH)('rendered .env ↔ bash is_optin_enabled', () => {
  for (const { key } of OPT_IN_FLAGS) {
    it(`${key} round-trips through renderEnv into the real bash gate`, () => {
      for (const value of ['true', 'false', undefined]) {
        const rendered = renderEnv({ ...BASE_ENV, [key]: value })
        const fromBash = bashGate(key, rendered)
        const fromTs = isOptInEnabled(emittedValue(key, value) ?? undefined)
        expect(fromBash, `${key}=${String(value)}: bash and TS disagree`).toBe(fromTs)
        expect(fromBash, `${key}=${String(value)}: expected ${value === 'true'}`)
          .toBe(value === 'true')
      }
    })
  }
})
