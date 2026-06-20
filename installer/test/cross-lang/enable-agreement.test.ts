import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { BASH, NAS_SCRIPTS, extractShellFunc, runBash, withEnvFile } from '../helpers/shell.js'
import { isEnabled, isOptInEnabled } from '../../src/shared/env-render.js'

// is_enabled / is_optin_enabled are duplicated across four layers (TS
// env-render, env-schema, bash setup.sh, python setup-arr-config.py). This
// pins the bash ↔ TS pair: for the same .env token, both must classify a
// service the same way, or the wizard and the launcher disagree about what is
// actually installed.

const SETUP_SH = join(NAS_SCRIPTS, 'setup.sh')

// Clean tokens a human would hand-type into .env (no quote / comment syntax,
// so env_val returns them ~verbatim and the comparison is apples-to-apples).
const TOKENS = [
  'true', 'false', 'FALSE', 'False', '0', 'no', 'NO', 'off', 'OFF',
  'yes', 'YES', 'on', 'ON', '1', 'enabled', 'x', ' off ', '',
]

function bashClassifies(fn: 'is_enabled' | 'is_optin_enabled', token: string): boolean {
  const program =
    extractShellFunc(SETUP_SH, 'env_val') + '\n' +
    extractShellFunc(SETUP_SH, fn) + '\n' +
    `${fn} ENABLE_FOO && echo 1 || echo 0`
  const { path, cleanup } = withEnvFile(`ENABLE_FOO=${token}`)
  try {
    return runBash(program, { env: { ENV_FILE: path } }).stdout.trim() === '1'
  } finally {
    cleanup()
  }
}

describe.skipIf(!BASH)('is_enabled agreement (bash setup.sh ↔ TS isEnabled)', () => {
  for (const token of TOKENS) {
    it(`agrees on ${JSON.stringify(token)}`, () => {
      expect(bashClassifies('is_enabled', token)).toBe(isEnabled(token))
    })
  }
})

describe.skipIf(!BASH)('is_optin_enabled agreement (bash setup.sh ↔ TS isOptInEnabled)', () => {
  for (const token of TOKENS) {
    it(`agrees on ${JSON.stringify(token)}`, () => {
      expect(bashClassifies('is_optin_enabled', token)).toBe(isOptInEnabled(token))
    })
  }
})
