// ── SFTP service ──────────────────────────────────────────────────────────────
// Recursive directory upload + single-file write, with progress events
// emitted to the renderer during long uploads.

import { promises as fs } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { SFTPWrapper } from 'ssh2'
import { IPC, type SftpProgress, type SftpUploadResult } from '../shared/ipc.js'
import { exec, getSftp } from './ssh-service.js'
import { payloadDir } from './payload-resolver.js'

// The renderer can pass "@payload" instead of a real local path to mean
// "the bundled nas-payload directory". Resolved here so the renderer
// never learns absolute filesystem paths.
function resolveLocalDir(localDir: string): string {
  if (localDir === '@payload') return payloadDir()
  return localDir
}

let mainWindow: BrowserWindow | null = null

export function bindMainWindow(win: BrowserWindow) {
  mainWindow = win
}

function send<T>(channel: string, payload: T) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

const toPosix = (p: string) => p.split(sep).join(posix.sep)

async function listFilesRecursive(localDir: string): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = []
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        const stat = await fs.stat(full)
        out.push({ rel: toPosix(relative(localDir, full)), size: stat.size })
      }
    }
  }
  await walk(localDir)
  return out
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<{ exists: boolean; isDir: boolean }> {
  return new Promise((resolve) => {
    sftp.stat(path, (err, stats) => {
      if (err) return resolve({ exists: false, isDir: false })
      resolve({ exists: true, isDir: stats.isDirectory() })
    })
  })
}

async function sftpMkdirP(sftp: SFTPWrapper, remote: string): Promise<void> {
  const parts = remote.split('/').filter(Boolean)
  let cur = remote.startsWith('/') ? '' : '.'
  for (const p of parts) {
    cur = cur === '' ? `/${p}` : `${cur}/${p}`
    const st = await sftpStat(sftp, cur)
    if (st.exists) {
      if (!st.isDir) throw new Error(`SFTP path exists but is not a directory: ${cur}`)
      continue
    }
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(cur, (err) => {
        if (err) {
          // ignore EEXIST race
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'EEXIST' || code === '4') return resolve()
          return reject(err)
        }
        resolve()
      })
    })
  }
}

function sftpUploadFile(
  sftp: SFTPWrapper,
  local: string,
  remote: string,
  mode: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, { mode }, (err) => (err ? reject(err) : resolve()))
  })
}

function sftpWriteString(sftp: SFTPWrapper, remote: string, content: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remote, { mode, flags: 'w' })
    stream.on('error', reject)
    stream.on('close', () => resolve())
    stream.end(content, 'utf8')
  })
}

// ── public API ────────────────────────────────────────────────────────────────

// Per-file SFTP timeout. Each script in nas-payload is small (a few KB
// to ~50KB), so 30s is plenty even on a slow link; if we exceed that
// the connection is wedged and we should bail loudly rather than block
// the UI.
const PER_FILE_TIMEOUT_MS = 30_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ])
}

/** Synology and some hardened sshd configs have the SFTP subsystem
 *  disabled. ssh2 reports this as "Unable to start subsystem: sftp".
 *  We can still write our text-only payload using a plain `exec` with
 *  `base64 -d > file` — slower per file but works on any sshd. */
async function uploadDirViaExec(args: {
  sessionId: string
  localDir: string
  remoteDir: string
}): Promise<SftpUploadResult> {
  const localDir = resolveLocalDir(args.localDir)
  const files = await listFilesRecursive(localDir)
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0)
  let bytesDone = 0
  let uploaded = 0

  send<SftpProgress>(IPC.evtSftpProgress, {
    file: '(SFTP unavailable, falling back to base64-over-exec)',
    bytesDone: 0, bytesTotal: totalBytes, pctOverall: 0,
  })

  // Pre-create directories.
  const dirs = new Set<string>()
  for (const f of files) {
    const parent = posix.dirname(f.rel)
    if (parent !== '.' && parent !== '') dirs.add(parent)
  }
  if (dirs.size > 0) {
    const mkdirs = [...dirs].map((d) => `'${posix.join(args.remoteDir, d).replace(/'/g, `'\\''`)}'`).join(' ')
    await exec({
      sessionId: args.sessionId,
      cmd: `mkdir -p ${mkdirs}`,
      sudo: false,
    })
  }

  for (const f of files) {
    const local = join(localDir, f.rel.split(posix.sep).join(sep))
    const remote = posix.join(args.remoteDir, f.rel)
    let mode = 0o644
    if (f.rel.endsWith('.sh') || f.rel.endsWith('.py')) mode = 0o755

    send<SftpProgress>(IPC.evtSftpProgress, {
      file: f.rel, bytesDone, bytesTotal: totalBytes,
      pctOverall: totalBytes === 0 ? 0 : Math.round((bytesDone / totalBytes) * 100),
    })

    const buf = await fs.readFile(local)
    const b64 = buf.toString('base64')
    const remoteEsc = remote.replace(/'/g, `'\\''`)
    // base64 -d works on Synology busybox AND coreutils. -o is GNU-only,
    // so we use redirection. chmod immediately after.
    const r = await exec({
      sessionId: args.sessionId,
      cmd: `printf %s ${quote(b64)} | base64 -d > '${remoteEsc}' && chmod ${mode.toString(8)} '${remoteEsc}'`,
      sudo: false,
    })
    if (r.exitCode !== 0) {
      throw new Error(`Upload of ${f.rel} failed: ${(r.stderr || r.stdout).slice(0, 200)}`)
    }
    uploaded++
    bytesDone += f.size
  }

  return { uploaded, bytesTotal: totalBytes }
}

function quote(s: string): string {
  // Single-quote for safe inline insertion. base64 has no single quotes
  // so this is a degenerate case — but be defensive anyway.
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export async function uploadDir(args: {
  sessionId: string
  localDir: string
  remoteDir: string
}): Promise<SftpUploadResult> {
  let sftp: SFTPWrapper
  try {
    sftp = await getSftp(args.sessionId)
  } catch (e) {
    const msg = (e as Error).message || ''
    if (/subsystem.*sftp/i.test(msg) || /Unable to start subsystem/i.test(msg)) {
      send<SftpProgress>(IPC.evtSftpProgress, {
        file: '(SFTP not enabled on the NAS — using exec fallback)',
        bytesDone: 0, bytesTotal: 0, pctOverall: 0,
      })
      return uploadDirViaExec(args)
    }
    throw e
  }

  const localDir = resolveLocalDir(args.localDir)
  const files = await listFilesRecursive(localDir)
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0)
  let bytesDone = 0
  let uploaded = 0

  // Emit an immediate 0% event so the UI shows movement before any file
  // actually completes — the previous behavior was "stuck at 0%" if the
  // first mkdir or fastPut took a few seconds.
  send<SftpProgress>(IPC.evtSftpProgress, {
    file: '(preparing remote directories)',
    bytesDone: 0,
    bytesTotal: totalBytes,
    pctOverall: 0,
  })

  await withTimeout(
    sftpMkdirP(sftp, args.remoteDir),
    PER_FILE_TIMEOUT_MS,
    `mkdir ${args.remoteDir}`,
  )

  // Pre-create all sub-directories first so fastPut never fails on a missing parent.
  const dirs = new Set<string>()
  for (const f of files) {
    const parent = posix.dirname(f.rel)
    if (parent !== '.' && parent !== '') dirs.add(parent)
  }
  for (const d of dirs) {
    await withTimeout(
      sftpMkdirP(sftp, posix.join(args.remoteDir, d)),
      PER_FILE_TIMEOUT_MS,
      `mkdir ${args.remoteDir}/${d}`,
    )
  }

  for (const f of files) {
    const local = join(localDir, f.rel.split(posix.sep).join(sep))
    const remote = posix.join(args.remoteDir, f.rel)
    // Default to 0o644; setup-chmod.sh on the NAS fixes script perms post-upload.
    let mode = 0o644
    if (f.rel.endsWith('.sh') || f.rel.endsWith('.py')) mode = 0o755

    // Surface the file we're about to upload BEFORE we start, so the
    // user sees what we're working on if any individual fastPut hangs.
    send<SftpProgress>(IPC.evtSftpProgress, {
      file: f.rel,
      bytesDone,
      bytesTotal: totalBytes,
      pctOverall: totalBytes === 0 ? 0 : Math.round((bytesDone / totalBytes) * 100),
    })

    await withTimeout(
      sftpUploadFile(sftp, local, remote, mode),
      PER_FILE_TIMEOUT_MS,
      `upload ${f.rel}`,
    )
    uploaded += 1
    bytesDone += f.size

    send<SftpProgress>(IPC.evtSftpProgress, {
      file: f.rel,
      bytesDone,
      bytesTotal: totalBytes,
      pctOverall: totalBytes === 0 ? 100 : Math.round((bytesDone / totalBytes) * 100),
    })
  }

  return { uploaded, bytesTotal: totalBytes }
}

export async function writeFile(args: {
  sessionId: string
  remotePath: string
  content: string
  mode?: number
}): Promise<void> {
  const mode = args.mode ?? 0o600
  try {
    const sftp = await getSftp(args.sessionId)
    const parent = posix.dirname(args.remotePath)
    if (parent && parent !== '/' && parent !== '.') {
      await sftpMkdirP(sftp, parent)
    }
    await sftpWriteString(sftp, args.remotePath, args.content, mode)
  } catch (e) {
    const msg = (e as Error).message || ''
    if (/subsystem.*sftp/i.test(msg) || /Unable to start subsystem/i.test(msg)) {
      // Fallback: write via exec + base64.
      const b64 = Buffer.from(args.content, 'utf8').toString('base64')
      const remoteEsc = args.remotePath.replace(/'/g, `'\\''`)
      const r = await exec({
        sessionId: args.sessionId,
        cmd: `printf %s ${quote(b64)} | base64 -d > '${remoteEsc}' && chmod ${mode.toString(8)} '${remoteEsc}'`,
        sudo: false,
      })
      if (r.exitCode !== 0) {
        throw new Error(`writeFile fallback failed: ${(r.stderr || r.stdout).slice(0, 200)}`)
      }
      return
    }
    throw e
  }
}
