// Copies ../nas/** → installer/resources/nas-payload/ before each build.
// Excludes .env (secrets) and migration/ (out of scope for v1).
//
// Records the git SHA of the source nas/ tree to .payload-sha for
// support diagnostics — the dashboard screen reads it.

import { mkdir, copyFile, readdir, stat, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..', '..', 'nas')
const DST = join(__dirname, '..', 'resources', 'nas-payload')

const EXCLUDED_NAMES = new Set(['.env', 'migration', 'node_modules'])
const EXCLUDED_GLOBS = [/\.DS_Store$/, /Thumbs\.db$/]

const toPosix = (p) => p.split(sep).join(posix.sep)

async function walk(dir) {
  const out = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (EXCLUDED_NAMES.has(e.name)) continue
    const full = join(dir, e.name)
    const rel = toPosix(relative(SRC, full))
    if (EXCLUDED_GLOBS.some((re) => re.test(rel))) continue
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (e.isFile()) out.push({ full, rel })
  }
  return out
}

async function recordSha() {
  let sha = 'unknown'
  try {
    sha = execSync('git rev-parse HEAD:nas', { cwd: join(__dirname, '..', '..') })
      .toString()
      .trim()
  } catch {
    // Not in a git repo or nas/ not committed — that's fine for dev.
  }
  await writeFile(join(DST, '.payload-sha'), sha + '\n', 'utf8')
}

async function main() {
  if (!existsSync(SRC)) {
    console.error(`[copy-nas-payload] Source not found: ${SRC}`)
    process.exit(1)
  }

  // Wipe and recreate so removed files don't linger.
  await rm(DST, { recursive: true, force: true })
  await mkdir(DST, { recursive: true })

  const files = await walk(SRC)
  for (const f of files) {
    const target = join(DST, f.rel.split(posix.sep).join(sep))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(f.full, target)
  }

  await recordSha()

  let totalBytes = 0
  for (const f of files) {
    const s = await stat(f.full)
    totalBytes += s.size
  }
  const kb = (totalBytes / 1024).toFixed(1)
  console.log(`[copy-nas-payload] Copied ${files.length} files (${kb} KiB) → ${DST}`)
}

main().catch((e) => {
  console.error('[copy-nas-payload] FAILED:', e)
  process.exit(1)
})
