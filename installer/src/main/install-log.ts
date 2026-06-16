// Persistent per-run install log on the local machine.
//
// The streaming UI is great while the wizard is open, but if the user
// quits, switches profiles, or the install panel scrolls past, the
// history is gone. We mirror everything that flows through the
// setup-sh-main / setup-sh-rerun-* channels (plus any wizard-internal
// "[wizard]" lines) to a file under userData/install-logs/ so the
// user can:
//
//   1. Re-read what happened after the fact
//   2. Attach the file to a bug report
//
// Format: one file per run, named install-<ISO timestamp>.log, with a
// short header recording app version + start time. Plain text; we
// strip ANSI escapes on the way in so the file is grep-friendly.

import { app, shell } from 'electron'
import log from 'electron-log/main.js'
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs'
import { join } from 'node:path'

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g

let currentStream: WriteStream | null = null
let currentPath: string | null = null
let bytesWritten = 0

function logsDir(): string {
  const dir = join(app.getPath('userData'), 'install-logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Open a new log file for this install run and return its path. Any
 *  previously-open log is closed first (we never have two open at once). */
export function startInstallLog(kind: 'install' | 'update' | 'validate' = 'install'): string {
  closeInstallLog()
  const dir = logsDir()
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `${kind}-${ts}.log`)
  currentStream = createWriteStream(path, { flags: 'a', encoding: 'utf8' })
  // A WriteStream is an EventEmitter; an 'error' emitted with no listener is
  // re-thrown as a main-process uncaughtException — which index.ts turns into a
  // misleading "Startup error" dialog mid-install. On any IO error, drop the
  // stream: this avoids the unhandled-error throw AND makes the (!currentStream)
  // guards in append/close short-circuit, so the install proceeds untouched and
  // the only consequence is a missing transcript (logged once).
  currentStream.on('error', (e) => {
    log.error('installLog: write stream error, disabling log for this run:', e)
    try { currentStream?.destroy() } catch { /* already torn down */ }
    currentStream = null
  })
  currentPath = path
  bytesWritten = 0
  const header =
    `# Mediarr Installer — ${kind} log\n` +
    `# started: ${new Date().toISOString()}\n` +
    `# app version: ${app.getVersion()}\n` +
    `# user data: ${app.getPath('userData')}\n` +
    `# ─────────────────────────────────────────────\n`
  currentStream.write(header)
  bytesWritten += Buffer.byteLength(header)
  log.info(`installLog: opened ${path}`)
  pruneOldLogs(dir)
  return path
}

/** Append a chunk of streaming output. ANSI escapes are stripped so the
 *  file is readable in any text editor. No-op if no log is open. */
export function appendInstallLog(chunk: string): void {
  if (!currentStream) return
  const clean = chunk.replace(ANSI_RE, '')
  currentStream.write(clean)
  bytesWritten += Buffer.byteLength(clean)
}

/** Flush and close the current log. Safe to call when nothing is open. */
export function closeInstallLog(): void {
  if (!currentStream) return
  try {
    currentStream.write(
      `\n# ─────────────────────────────────────────────\n` +
      `# closed: ${new Date().toISOString()}\n` +
      `# bytes: ${bytesWritten}\n`,
    )
    currentStream.end()
  } catch (e) {
    log.error('installLog.close failed:', e)
  }
  currentStream = null
  // currentPath stays set so the renderer can still ask "where's the
  // log?" after a finished install.
}

export function getCurrentInstallLogPath(): string | null {
  return currentPath
}

export function revealCurrentInstallLog(): { path: string | null } {
  if (currentPath) {
    shell.showItemInFolder(currentPath)
  } else {
    // Nothing recent — just open the folder so the user can pick one.
    shell.openPath(logsDir())
  }
  return { path: currentPath }
}

/** Keep at most 10 most-recent log files. Avoids unbounded growth in
 *  userData if someone uses the wizard a lot — 10 is enough to walk
 *  back through a session of "tried, tweaked, retried" attempts
 *  without filling the disk. */
function pruneOldLogs(dir: string, keep = 10): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(keep)) {
      try { unlinkSync(f.path) } catch { /* ignore */ }
    }
  } catch (e) {
    log.error('installLog.prune failed:', e)
  }
}
