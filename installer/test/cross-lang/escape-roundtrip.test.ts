import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  BASH,
  PYTHON,
  NAS_SCRIPTS,
  extractShellFunc,
  extractPythonFunc,
  runBash,
  runPython,
  withEnvFile,
} from '../helpers/shell.js'
import { emitField } from '../helpers/render.js'

// The crown-jewel cross-language invariant: a value the TS writer (ESCAPE)
// puts into .env reads back BYTE-IDENTICAL through BOTH shipped NAS-side
// parsers — the bash env_val awk reader (setup.sh) and python
// _parse_env_value (setup-arr-config.py). Drift here is the INVALIDPASS /
// silent-secret-corruption class of bug. We run the REAL functions, extracted
// from the scripts by text, against the REAL renderEnv emission.

const SETUP_SH = join(NAS_SCRIPTS, 'setup.sh')
const ARR_PY = join(NAS_SCRIPTS, 'setup-arr-config.py')

// Each value has, historically, broken a naive parser.
const VALUES: string[] = [
  'hunter2', // plain — emitted unquoted
  'p@ss word', // space → quoted
  'p@ss#word', // '#' → inline-comment truncation bug
  "a'b", // single quote → env_val xargs-abort → secret silently regenerated
  'a"b', // double quote
  'a$b', // '$' → compose ${} expansion
  'a`b', // backtick → command substitution
  'a\\b', // backslash
  'mix $VAR `cmd` "q" \\ #h', // everything at once
  ' leading', // leading space → quoted, preserved
  'trailing ', // trailing space → quoted, preserved
  'a=b=c', // '=' in value — parser must split on the FIRST '=' only
  'no#1 café', // unicode + '#' + space
  '', // empty
]

function bashEnvVal(key: string, envPath: string): string {
  const program = extractShellFunc(SETUP_SH, 'env_val') + '\nenv_val "$1"'
  return runBash(program, { args: [key], env: { ENV_FILE: envPath } }).stdout
}

function pyParse(rhs: string): string {
  const program =
    'import re, sys\n' +
    extractPythonFunc(ARR_PY, '_parse_env_value') +
    '\nraw = sys.stdin.buffer.read().decode("utf-8")' +
    '\nsys.stdout.buffer.write(_parse_env_value(raw).encode("utf-8"))\n'
  return runPython(program, { input: rhs }).stdout
}

describe.skipIf(!BASH)('ESCAPE ↔ bash env_val (setup.sh)', () => {
  for (const value of VALUES) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      const rhs = emitField(value) // production renderEnv line()+ESCAPE
      const { path, cleanup } = withEnvFile(`ARR_PASSWORD=${rhs}`)
      try {
        expect(bashEnvVal('ARR_PASSWORD', path)).toBe(value)
      } finally {
        cleanup()
      }
    })
  }
})

describe.skipIf(!PYTHON)('ESCAPE ↔ python _parse_env_value (setup-arr-config.py)', () => {
  for (const value of VALUES) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      expect(pyParse(emitField(value))).toBe(value)
    })
  }
})

// The "is an interpreter even present?" sentinel lives in its own file
// (_interpreters.test.ts) so it survives edits to this suite.
