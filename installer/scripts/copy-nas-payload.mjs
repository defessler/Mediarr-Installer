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

// Directories / filenames excluded by exact name (matched against the
// dirent's name regardless of depth). __pycache__ catches Python bytecode
// from local syntax-check runs — those would otherwise bloat the payload
// and end up uploaded to /volume1/docker/media/scripts/ on every install.
// node_modules guards against an accidental cross-tree leak; migration/
// stays out of v1 because its tooling isn't release-ready.
const EXCLUDED_NAMES = new Set(['.env', 'migration', 'node_modules', '__pycache__'])
// File globs (matched against the relative posix path). .pyc files are
// excluded both for size and because they're CPython-major-tied — a
// 3.10 .pyc would be ignored on a NAS running 3.12 anyway.
// .log / .lock catch runtime artifacts the helper scripts (boot-orchestrator,
// qbit-guardian) write into scripts/ during local testing — they must never be
// bundled + uploaded over a live NAS's logs.
const EXCLUDED_GLOBS = [/\.DS_Store$/, /Thumbs\.db$/, /\.pyc$/, /\.log$/, /\.lock$/]

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
  // v0.3.23+: .payload-sha lives under scripts/ alongside everything
  // else the wizard ships. Was at payload root for pre-v0.3.23 builds.
  // The dashboard's payload-sha display reads from app data so the
  // path change is transparent to the renderer.
  const scriptsDir = join(DST, 'scripts')
  await mkdir(scriptsDir, { recursive: true })
  await writeFile(join(scriptsDir, '.payload-sha'), sha + '\n', 'utf8')
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
