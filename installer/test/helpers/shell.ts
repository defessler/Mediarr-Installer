// Test infrastructure for the cross-language oracle suites: locate the real
// nas-payload scripts, detect whether bash / python are runnable, extract a
// real shell function from a script (so we test the SHIPPED parser, not a
// copy that could drift), and run bash programs with a temp .env.

import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // installer/test/helpers
export const REPO_ROOT = resolve(HERE, '..', '..', '..') // → repo root
export const NAS_SCRIPTS = resolve(REPO_ROOT, 'nas', 'scripts')

function cmdWorks(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8' }).status === 0
  } catch {
    return false
  }
}

/** bash interpreter name if runnable, else null (Windows dev box without git-
 *  bash on PATH). The bash oracle suites `describe.skipIf(!BASH)`. */
export const BASH: string | null = cmdWorks('bash', ['-c', 'exit 0']) ? 'bash' : null

/** python interpreter name (python3 then python) if runnable, else null. */
export const PYTHON: string | null = (() => {
  for (const c of ['python3', 'python']) {
    if (cmdWorks(c, ['-c', 'import sys'])) return c
  }
  return null
})()

/** Extract a top-level shell function `name() { … }` from a script file by
 *  text, so the test executes the REAL shipped function body (an oracle, not
 *  a reimplementation that could silently drift from production). These
 *  functions close with a `}` at column 0 and contain no other column-0 `}`
 *  (awk/case braces are all indented). Throws if it can't be located. */
export function extractShellFunc(scriptPath: string, name: string): string {
  const lines = readFileSync(scriptPath, 'utf8').split(/\r?\n/)
  const startRe = new RegExp(`^${name}\\(\\)\\s*\\{`)
  const start = lines.findIndex((l) => startRe.test(l))
  if (start === -1) throw new Error(`function ${name}() not found in ${scriptPath}`)
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}\s*$/.test(lines[i])) return lines.slice(start, i + 1).join('\n')
  }
  throw new Error(`no column-0 closing brace for ${name}() in ${scriptPath}`)
}

/** Run a bash program (piped via stdin so embedded quotes/awk survive
 *  verbatim) and return its stdout + exit status. Positional args become
 *  $1.. via `bash -s --`. */
export function runBash(
  program: string,
  opts: { args?: string[]; env?: Record<string, string> } = {},
): { stdout: string; status: number } {
  if (!BASH) throw new Error('bash not available')
  const r = spawnSync(BASH, ['-s', '--', ...(opts.args ?? [])], {
    input: program,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Byte-deterministic across CI (Linux glibc/mawk) and a local git-bash
      // (MSYS gawk): force the C locale so the env_val awk reader handles input
      // as raw single bytes (a UTF-8 LANG can flip gawk into multibyte char
      // mode and diverge from CI), and stop MSYS from rewriting our '/'-rooted
      // argv (the absolute paths clean() is fed) into Windows paths before bash
      // sees them. opts.env is spread last so a caller's ENV_FILE still wins.
      LC_ALL: 'C',
      MSYS_NO_PATHCONV: '1',
      ARG_CONV_EXCL: '*',
      ...(opts.env ?? {}),
    },
  })
  return { stdout: r.stdout ?? '', status: r.status ?? -1 }
}

/** Extract a top-level `def name(…):` and its indented body from a Python
 *  script by text (up to the next column-0 statement), so the test runs the
 *  REAL shipped parser rather than a copy that could drift. Throws if absent. */
export function extractPythonFunc(scriptPath: string, name: string): string {
  const lines = readFileSync(scriptPath, 'utf8').split(/\r?\n/)
  const startRe = new RegExp(`^def ${name}\\(`)
  const start = lines.findIndex((l) => startRe.test(l))
  if (start === -1) throw new Error(`def ${name}() not found in ${scriptPath}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { end = i; break } // next top-level statement
  }
  return lines.slice(start, end).join('\n')
}

/** Run a Python program. The program is written to a temp .py file (not passed
 *  via `-c`) so embedded quotes/newlines survive Windows argv escaping. `input`
 *  is fed to stdin (read it via sys.stdin.buffer to dodge newline translation).
 *  Returns stdout + status. */
export function runPython(
  program: string,
  opts: { args?: string[]; input?: string } = {},
): { stdout: string; status: number } {
  if (!PYTHON) throw new Error('python not available')
  const dir = mkdtempSync(join(tmpdir(), 'mediarr-py-'))
  const file = join(dir, 'prog.py')
  writeFileSync(file, program, 'utf8')
  try {
    const r = spawnSync(PYTHON, [file, ...(opts.args ?? [])], {
      input: opts.input,
      encoding: 'utf8',
    })
    return { stdout: r.stdout ?? '', status: r.status ?? -1 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Write a temp .env holding exactly one verbatim line (already escaped by the
 *  writer under test). Returns its path + a cleanup fn. */
export function withEnvFile(line: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mediarr-test-'))
  const path = join(dir, '.env')
  writeFileSync(path, line + '\n', 'utf8')
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
