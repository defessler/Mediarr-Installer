// In-place auto-updater for the portable Windows zip distribution.
//
// Why custom (not electron-updater): we ship as a portable .zip (no
// NSIS, no code signing, no MSI), which rules out electron-updater's
// NSIS / Squirrel update paths. Rather than wrap a portable .exe with
// electron-builder's `portable` target (which itself has rough edges
// around auto-update on Windows), we keep the build dead simple — the
// CI workflow zips electron-builder's `win-unpacked/` folder — and own
// the update logic ourselves. Pattern lifted from defessler's
// WindowLayoutManager updater.js, adapted to TypeScript + this
// project's IPC contract + electron-log.
//
// The flow:
//
//   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
//   │  app starts  │ ──auto─▶│ GitHub poll  │ ──found─▶│  download &  │
//   │              │         │ /releases    │         │  extract zip │
//   └──────────────┘         └──────────────┘         └──────┬───────┘
//                                                            │
//                                       ┌──── download-progress events ───┘
//                                       ▼
//                              ┌──────────────────┐
//                              │ extracted to     │ ──▶ user clicks "Restart"
//                              │ staging dir      │
//                              └──────────────────┘                    │
//                                                                       ▼
//                                                              install():
//                                                              write swap .cmd + .vbs,
//                                                              spawn helper, quit app
//                                                                       │
//                                                       ┌───────────────┴──────┐
//                                                       │ helper waits for     │
//                                                       │ our PID, robocopies  │
//                                                       │ staging → installDir,│
//                                                       │ relaunches new exe   │
//                                                       └───────────────────────┘
//
// Two-phase split (download vs install) preserves the existing UX:
// the WhatsNew banner shows "Install update" → progress bar →
// "Restart & install", letting the user keep working while the zip
// extracts. The single-button alternative would have the app quit
// the moment the user clicked anywhere in the banner.
//
// All update events are mirrored to the renderer via the
// `updater:state` IPC event so the WhatsNew banner can show real-time
// download progress + an install button when ready.
//
// Mock + dev short-circuit early — no GitHub release to update from in
// either environment, and the updater spamming "no publish provider"
// errors in main.log would obscure real issues.

import { app, BrowserWindow, ipcMain } from 'electron'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import log from 'electron-log/main.js'
import type { UpdaterState } from '../shared/ipc.js'

const REPO = 'defessler/Mediarr-Installer'
// Short, not zero: let the window paint + the renderer mount its updater-state
// listener first, then check ~immediately on launch. The check is an async
// main-process fetch (it never blocks the renderer), and the banner reads the
// result via getState() on mount + the updater:state subscription, so this is
// "checks for updates on first launch" without stalling startup.
const STARTUP_DELAY_MS = 2 * 1000
const PERIODIC_INTERVAL_MS = 6 * 60 * 60 * 1000  // 6 hours
const UA = 'Mediarr-Installer-Updater'

interface PendingUpdate {
  version: string
  tagName: string
  downloadUrl: string
  sizeBytes: number
  releaseNotes: string
  htmlUrl: string
  /** Set after download() finishes — absolute path to the extracted
   *  build that install() will robocopy from. Null between check()
   *  and download(). */
  stagingDir: string | null
}

let mainWindow: BrowserWindow | null = null
let lastState: UpdaterState = { kind: 'idle' }
let pendingUpdate: PendingUpdate | null = null
let installInProgress = false
let intervalHandle: NodeJS.Timeout | null = null
let startupTimeoutHandle: NodeJS.Timeout | null = null
/** AbortController for the in-flight download. Non-null only while
 *  downloadUpdate() is between fetch() start and pipeline() end. The
 *  user's "Cancel" button calls cancelDownload(), which signals abort
 *  and triggers the cleanup branch in downloadUpdate(). */
let currentDownloadAbort: AbortController | null = null

/** Persisted "user hit Skip on v0.X.Y; don't pester me about this
 *  exact version again" marker. Cleared when a strictly-newer version
 *  appears (we only compare equality — if v0.X.Y is skipped and v0.X.Z
 *  ships, the skip falls through). Lives in userData so it survives
 *  the in-place file swap on update. */
function skippedFilePath(): string {
  return join(app.getPath('userData'), 'skipped-update.txt')
}
function readSkippedVersion(): string | null {
  try { return readFileSync(skippedFilePath(), 'utf8').trim() || null }
  catch { return null }
}
function writeSkippedVersion(v: string): void {
  try { writeFileSync(skippedFilePath(), v, { mode: 0o600 }) }
  catch (e) { log.error('updater: skip-version write failed:', e) }
}

export function getUpdateState(): UpdaterState {
  return lastState
}

function broadcast(state: UpdaterState): void {
  lastState = state
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:state', state)
  }
}

/** Compare two version strings (a, b) — returns negative, zero, or
 *  positive like a-b. Strips optional "v" / "installer-v" prefix, then
 *  numeric triple compare. No pre-release support — Mediarr doesn't
 *  ship pre-release tags. */
function compareVersions(a: string, b: string): number {
  const parse = (s: string): number[] =>
    s.replace(/^[a-zA-Z-]*v?/, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0)
  const [a1, a2, a3] = parse(a)
  const [b1, b2, b3] = parse(b)
  if (a1 !== b1) return a1 - b1
  if (a2 !== b2) return a2 - b2
  return a3 - b3
}

interface GithubAsset { name?: string; browser_download_url?: string; size?: number }
interface GithubRelease {
  tag_name?: string
  html_url?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
  assets?: GithubAsset[]
}

/** Poll GitHub Releases. Returns the newest release strictly newer
 *  than the running version that has a matching win-unpacked zip
 *  asset. Broadcasts state transitions: checking → available |
 *  not-available | error. Silent mode swallows errors (initial check
 *  / periodic poll); non-silent surfaces them via the error state. */
async function checkForUpdates({ silent = true }: { silent?: boolean } = {}): Promise<PendingUpdate | null> {
  broadcast({ kind: 'checking' })
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 10_000)
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=10`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': UA,
        },
        signal: ac.signal,
      },
    )
    clearTimeout(t)
    if (!res.ok) {
      log.warn(`updater: GitHub releases fetch returned HTTP ${res.status}`)
      if (!silent) broadcast({ kind: 'error', message: `GitHub HTTP ${res.status}` })
      else broadcast({ kind: 'not-available' })
      return null
    }
    const releases = (await res.json()) as GithubRelease[]
    if (!Array.isArray(releases)) {
      if (!silent) broadcast({ kind: 'error', message: 'Unexpected response from GitHub API' })
      else broadcast({ kind: 'not-available' })
      return null
    }
    const current = app.getVersion()
    // Walk in publication order; pick the newest non-draft strictly
    // newer than `current` that has a matching zip asset.
    let best: GithubRelease | null = null
    for (const r of releases) {
      if (r.draft) continue
      const tag = (r.tag_name ?? '').replace(/^[a-zA-Z-]*v?/, '')
      if (!tag) continue
      if (compareVersions(tag, current) <= 0) continue
      if (best && compareVersions(tag, (best.tag_name ?? '').replace(/^[a-zA-Z-]*v?/, '')) <= 0) continue
      best = r
    }
    if (!best) {
      pendingUpdate = null
      broadcast({ kind: 'not-available' })
      return null
    }
    // Match electron-builder's "win-unpacked" zip naming convention.
    const asset = (best.assets ?? []).find((a) =>
      /win-unpacked.*\.zip$/i.test(a.name ?? ''),
    )
    if (!asset || !asset.browser_download_url) {
      pendingUpdate = null
      broadcast({ kind: 'not-available' })
      log.warn(`updater: release ${best.tag_name} found but no matching win-unpacked zip asset`)
      return null
    }
    const version = (best.tag_name ?? '').replace(/^[a-zA-Z-]*v?/, '')
    // Honour the user's "Skip this version" choice. Equality match —
    // a later version of the SAME tag never gets re-skipped, so the
    // user is asked about every distinct release.
    const skipped = readSkippedVersion()
    if (skipped && skipped === version) {
      pendingUpdate = null
      broadcast({ kind: 'not-available' })
      log.info(`updater: v${version} found but user previously skipped it`)
      return null
    }
    pendingUpdate = {
      version,
      tagName: best.tag_name ?? '',
      downloadUrl: asset.browser_download_url,
      sizeBytes: asset.size ?? 0,
      releaseNotes: best.body ?? '',
      htmlUrl: best.html_url ?? '',
      stagingDir: null,
    }
    log.info(`updater: update available v${pendingUpdate.version} (current v${current})`)
    broadcast({
      kind: 'available',
      version: pendingUpdate.version,
      releaseNotes: pendingUpdate.releaseNotes,
      htmlUrl: pendingUpdate.htmlUrl,
    })
    return pendingUpdate
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    if (silent) {
      log.info('updater: check failed (silent):', msg)
      broadcast({ kind: 'not-available' })
    } else {
      log.error('updater: check failed:', msg)
      broadcast({ kind: 'error', message: msg })
    }
    return null
  }
}

/** Phase 1: download the zip into a fresh tmp dir, then extract to a
 *  staging subdir. Sets pendingUpdate.stagingDir on success and
 *  broadcasts the `downloaded` state — the renderer's "Restart &
 *  install" button is gated on that state. Progress events stream the
 *  byte count to the renderer's progress bar.
 *
 *  The zip layout from CI is `win-unpacked/<files>` (the workflow's
 *  `7z a` step zips the win-unpacked folder by name), so after
 *  extraction we resolve down into the single wrapping directory.
 *  We tolerate a flat layout too in case the workflow ever changes. */
async function downloadUpdate(): Promise<void> {
  if (installInProgress) {
    log.warn('updater: download requested while install already in progress')
    return
  }
  if (!pendingUpdate) {
    log.warn('updater: download requested but no pending update')
    broadcast({ kind: 'error', message: 'No update available — check again first.' })
    return
  }
  const update = pendingUpdate

  // Fresh staging root per call — wipe any previous attempt to avoid
  // accumulating ~200 MB extracted builds in %TEMP%.
  const tmpRoot = join(tmpdir(), 'mediarr-update')
  if (existsSync(tmpRoot)) {
    try { rmSync(tmpRoot, { recursive: true, force: true }) }
    catch (e) { log.warn('updater: tmpRoot rm failed (non-fatal):', e) }
  }
  mkdirSync(tmpRoot, { recursive: true })
  const zipPath = join(tmpRoot, `update-${update.version}.zip`)
  const stagingDir = join(tmpRoot, 'staging')

  // ── Download ─────────────────────────────────────────────────────
  currentDownloadAbort = new AbortController()
  try {
    log.info(`updater: downloading ${update.downloadUrl}`)
    const res = await fetch(update.downloadUrl, {
      headers: { 'User-Agent': UA, Accept: 'application/octet-stream' },
      redirect: 'follow',
      signal: currentDownloadAbort.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: HTTP ${res.status}`)
    }
    const total = update.sizeBytes
      || parseInt(res.headers.get('content-length') ?? '0', 10)
    let received = 0
    let lastBroadcastAt = Date.now()
    const startedAt = Date.now()

    const out = createWriteStream(zipPath)
    const reader = Readable.fromWeb(
      res.body as unknown as import('stream/web').ReadableStream,
    )
    // Count bytes + emit progress INSIDE the pipeline (an async-generator
    // stage) rather than via a separate reader.on('data') listener. A raw
    // 'data' listener flips the stream into flowing mode before pipeline()
    // attaches its writer, which can drop the first chunk(s) — i.e. the zip's
    // PK header — leaving a file that fails extraction with the cryptic
    // "Found invalid data while decoding". Threading every chunk through the
    // generator guarantees it reaches `out` exactly once, in order, with
    // backpressure intact.
    await pipeline(
      reader,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          received += chunk.length
          // Throttle progress broadcasts to ~6/s (every 150ms) — more just
          // floods IPC and the renderer's easing can't keep up anyway.
          const now = Date.now()
          if (now - lastBroadcastAt >= 150) {
            const elapsed = (now - startedAt) / 1000
            const bps = elapsed > 0 ? received / elapsed : 0
            broadcast({
              kind: 'downloading',
              percent: total > 0 ? Math.round((received / total) * 100) : 0,
              bytesPerSecond: Math.round(bps),
              transferred: received,
              total,
            })
            lastBroadcastAt = now
          }
          yield chunk
        }
      },
      out,
    )

    // Integrity gate. A truncated download or a wrong-content body (a GitHub
    // error page / un-followed redirect) must NOT proceed to extraction — that
    // surfaces as the cryptic "PowerShell extract exited 1: Found invalid data
    // while decoding". Verify the file matches the asset's known size and
    // starts with the zip magic (PK\x03\x04). Compare against the GitHub API
    // asset size (the true zip size), NOT Content-Length, which can be the
    // gzip transfer size if the CDN compressed the response.
    const onDisk = statSync(zipPath).size
    if (update.sizeBytes > 0 && onDisk !== update.sizeBytes) {
      throw new Error(
        `download incomplete (${onDisk} of ${update.sizeBytes} bytes) — please try the update again`,
      )
    }
    const magic = Buffer.alloc(4)
    const fd = openSync(zipPath, 'r')
    try { readSync(fd, magic, 0, 4, 0) } finally { closeSync(fd) }
    if (!(magic[0] === 0x50 && magic[1] === 0x4b)) {
      throw new Error('downloaded file is not a valid .zip (got an error page?) — please try the update again')
    }

    // One final 100% tick so the bar visibly fills before we flip to
    // the extracting state.
    broadcast({
      kind: 'downloading',
      percent: 100,
      bytesPerSecond: 0,
      transferred: received,
      total: total || received,
    })
  } catch (e) {
    // AbortError = user cancelled. Don't broadcast 'error' (that would
    // pin a red banner in the WhatsNew section and require an
    // explicit dismissal); reset to 'available' so the user can hit
    // Install again later. fetch() + pipeline() both surface aborts
    // as e.name === 'AbortError', but Node 20's undici throws errors
    // whose `name` is 'AbortError' OR whose `code` is 'ABORT_ERR'
    // depending on whether the abort lands in fetch vs the pipeline
    // (the writable stream is the latter). Accept either signal.
    const err = e as Error & { code?: string }
    const aborted = err.name === 'AbortError' || err.code === 'ABORT_ERR'
    if (aborted) {
      log.info('updater: download cancelled by user')
      // Wipe the partial zip + any prior extraction so retrying gets a
      // clean slate. We catch+swallow because a half-written file may
      // still be locked by the OS for a few ms after the pipeline
      // errors out — best-effort cleanup is fine, %TEMP% gets reaped.
      try { rmSync(tmpRoot, { recursive: true, force: true }) }
      catch (cleanupErr) { log.warn('updater: cleanup after cancel failed (non-fatal):', cleanupErr) }
      broadcast({
        kind: 'available',
        version: update.version,
        releaseNotes: update.releaseNotes,
        htmlUrl: update.htmlUrl,
      })
      return
    }
    const msg = err.message ?? String(err)
    log.error('updater: download failed:', msg)
    broadcast({ kind: 'error', message: `Download failed: ${msg}` })
    return
  } finally {
    currentDownloadAbort = null
  }

  // ── Extract ──────────────────────────────────────────────────────
  // Flip to the dedicated `extracting` state so the renderer's blocking
  // overlay shows progress instead of a download bar pinned at 100%.
  // Unpacking the ~200 MB build is a few CPU-bound seconds with no byte
  // counter to drive a bar, hence an indeterminate state.
  broadcast({ kind: 'extracting', version: update.version })
  try {
    log.info(`updater: extracting to ${stagingDir}`)
    await extractZip(zipPath, stagingDir)
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    log.error('updater: extract failed:', msg)
    broadcast({ kind: 'error', message: `Extract failed: ${msg}` })
    return
  }

  // The workflow zips the `win-unpacked` directory by name, so the
  // staging dir contains exactly one wrapping folder. Resolve into
  // it so robocopy points at the actual app files, not at a parent
  // folder that would create `installDir/win-unpacked/Mediarr Installer.exe`
  // instead of overwriting in place.
  let resolved = stagingDir
  try {
    const entries = readdirSync(stagingDir)
    if (entries.length === 1) {
      const inner = join(stagingDir, entries[0])
      if (statSync(inner).isDirectory()) resolved = inner
    }
  } catch (e) {
    log.warn('updater: staging dir resolve failed (using flat layout):', e)
  }
  pendingUpdate = { ...update, stagingDir: resolved }
  log.info(`updater: download complete, staging=${resolved}`)
  broadcast({
    kind: 'downloaded',
    version: update.version,
    releaseNotes: update.releaseNotes,
    htmlUrl: update.htmlUrl,
  })
}

/** Abort the in-flight download (if any). Safe to call when no
 *  download is running — it's just a no-op. The actual cleanup
 *  (partial zip removal + state reset to `available`) happens inside
 *  downloadUpdate's catch block when the abort lands. */
function cancelDownload(): void {
  if (currentDownloadAbort) {
    log.info('updater: cancel requested')
    currentDownloadAbort.abort()
  } else {
    log.info('updater: cancel requested but no download in flight')
  }
}

/** Mark the current pending version as "skipped" — the WhatsNew banner
 *  hides for this exact release, and stays hidden across launches
 *  until a strictly different version ships (equality compare, so
 *  v0.5.0 skip doesn't suppress v0.5.1). Also reset state to
 *  not-available so the banner clears immediately. */
function skipCurrentVersion(): void {
  if (!pendingUpdate) {
    log.warn('updater: skip requested but no pending update')
    return
  }
  log.info(`updater: user skipped v${pendingUpdate.version}`)
  writeSkippedVersion(pendingUpdate.version)
  pendingUpdate = null
  broadcast({ kind: 'not-available' })
}

/** Phase 2: write a hidden swap helper that waits for our PID + exe
 *  name combination to exit, robocopies staging over the install dir,
 *  and relaunches the new exe. Spawn it detached, then quit ourselves
 *  ~500ms later so the helper has time to fire before we release the
 *  file locks on our own binary.
 *
 *  Why we filter on PID *and* exe name in the wait loop: Windows
 *  recycles PIDs quickly. A recycled PID landing on, say, chrome.exe
 *  would hang the loop forever. Filtering on IMAGENAME too means a
 *  recycled PID for any other process correctly signals "Mediarr
 *  Installer is gone, swap now." */
async function installUpdate(): Promise<void> {
  if (installInProgress) {
    log.warn('updater: install requested but already in progress')
    return
  }
  if (!pendingUpdate?.stagingDir) {
    log.warn('updater: install requested without a downloaded update')
    broadcast({ kind: 'error', message: 'Download an update first.' })
    return
  }
  installInProgress = true
  // Tell the renderer we're committing to the restart so the overlay
  // swaps its "Restart now" button for a terminal "Restarting…" message
  // — the app quits ~500 ms after the helper spawns, so an interactive
  // button here would just invite a confusing double-click.
  broadcast({ kind: 'installing', version: pendingUpdate.version })
  try {
    const exePath = app.getPath('exe')
    const installDir = dirname(exePath)
    const exeName = basename(exePath)
    const { vbsPath } = writeSwapScript({
      pid: process.pid,
      stagingDir: pendingUpdate.stagingDir,
      installDir,
      exeName,
    })
    log.info(`updater: spawning swap helper ${vbsPath}`)
    const child = spawn('wscript.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    // Give the OS a beat to actually spawn the helper before we exit
    // and release the file lock on our binary — the helper's
    // tasklist-based wait loop tolerates a slow exit, but the spawn
    // itself needs to land first.
    setTimeout(() => app.exit(0), 500)
  } catch (e) {
    installInProgress = false
    const msg = (e as Error).message ?? String(e)
    log.error('updater: install failed:', msg)
    broadcast({ kind: 'error', message: `Install failed: ${msg}` })
  }
}

/** Extract a .zip via PowerShell's System.IO.Compression.FileSystem
 *  — present on every Win10/11 host, no external deps. Faster than
 *  Expand-Archive for the ~200 MB Electron build (Expand-Archive
 *  parses the zip in PowerShell space and is noticeably slower). */
function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    // PowerShell single-quoted strings need '' for an embedded apostrophe.
    const psZip = zipPath.replace(/'/g, "''")
    const psDest = destDir.replace(/'/g, "''")
    const script =
      `$ErrorActionPreference='Stop';` +
      `Add-Type -Assembly System.IO.Compression.FileSystem;` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${psZip}', '${psDest}')`
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true })
    let stderr = ''
    ps.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    ps.on('error', reject)
    ps.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`PowerShell extract exited ${code}: ${stderr.trim() || 'no error output'}`))
    })
  })
}

/** Write the swap helper as two files:
 *    - `<tmp>/mediarr-swap-<pid>.cmd`  — the swap logic (wait for our
 *      PID + image name to exit, robocopy staging into installDir,
 *      relaunch new build).
 *    - `<tmp>/mediarr-swap-<pid>.vbs`  — a tiny wscript wrapper that
 *      runs the .cmd hidden.
 *
 *  Why the .vbs wrapper: spawning cmd.exe with windowsHide=true works
 *  when the user's default terminal is the legacy conhost.exe but
 *  breaks when Windows Terminal is the default (Win11 default for
 *  fresh installs) — WT honours its own visibility, not the spawn
 *  flag. wscript.exe is a non-console process, so its WshShell.Run
 *  with intWindowStyle=0 reliably hides the launched cmd.exe
 *  regardless of the user's terminal default.
 *
 *  Both files use CRLF line endings — cmd.exe is finicky about lone
 *  \n in batch files. */
function writeSwapScript(opts: {
  pid: number
  stagingDir: string
  installDir: string
  exeName: string
}): { cmdPath: string; vbsPath: string } {
  const { pid, stagingDir, installDir, exeName } = opts
  const swapPath = join(tmpdir(), `mediarr-swap-${pid}.cmd`)
  const vbsPath  = join(tmpdir(), `mediarr-swap-${pid}.vbs`)
  const logPath  = join(tmpdir(), 'mediarr-update.log')

  const cmdLines = [
    '@echo off',
    'setlocal',
    `>>"${logPath}" echo [%date% %time%] swap start pid=${pid} exe=${exeName}`,
    `set TARGET_PID=${pid}`,
    `set TARGET_EXE=${exeName}`,
    ':wait',
    // Filter on PID *and* image name — Windows recycles PIDs quickly
    // and a recycled PID hitting, say, chrome.exe would spin this
    // loop forever. /FI flags are AND-combined.
    'tasklist /FI "PID eq %TARGET_PID%" /FI "IMAGENAME eq %TARGET_EXE%" /NH 2>NUL | find /I "%TARGET_EXE%" >NUL',
    'if not errorlevel 1 (',
    '    timeout /t 1 /nobreak >NUL',
    '    goto wait',
    ')',
    `>>"${logPath}" echo [%date% %time%] target gone, copying`,
    // robocopy exit codes: 0..7 = success (various flavors of "copied
    // some / nothing / mismatch but ok"), 8+ = actual failure. So we
    // test `LSS 8`.
    `robocopy "${stagingDir}" "${installDir}" /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >>"${logPath}"`,
    'set RC=%ERRORLEVEL%',
    `>>"${logPath}" echo [%date% %time%] robocopy rc=%RC%`,
    'if %RC% LSS 8 (',
    `    >>"${logPath}" echo [%date% %time%] launching new build`,
    `    start "" "${installDir}\\${exeName}"`,
    `    rmdir /S /Q "${stagingDir}" 2>NUL`,
    ') else (',
    `    >>"${logPath}" echo [%date% %time%] robocopy failed - leaving staging in place at ${stagingDir}`,
    ')',
    // Tidy up: delete the .vbs (wscript has already exited; it's just
    // a leftover file at this point) and self-delete the .cmd via the
    // classic `(goto) 2>nul & del "%~f0"` trick.
    `del "${vbsPath}" 2>NUL`,
    '(goto) 2>nul & del "%~f0"',
  ]
  writeFileSync(swapPath, cmdLines.join('\r\n') + '\r\n', 'utf8')

  // intWindowStyle=0 = hidden, bWaitOnReturn=False = fire-and-forget.
  // wscript itself has no console, so nothing flashes onscreen.
  // Escaping: cmd.exe needs the .cmd path quoted (it contains a space
  // when %TEMP% lives under a path with one); VBScript escapes a "
  // inside a "-string by doubling it ("").
  const vbsLines = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "cmd.exe /c """ & "${swapPath.replace(/"/g, '""')}" & """", 0, False`,
  ]
  writeFileSync(vbsPath, vbsLines.join('\r\n') + '\r\n', 'utf8')

  return { cmdPath: swapPath, vbsPath }
}

/** Configure the updater. Called once at app start (after we have a
 *  window to broadcast to). Skips on:
 *  - Mock mode (no real publish endpoint)
 *  - Unpackaged dev runs (the staging swap would clobber the running
 *    `npm run dev` install)
 *  - Non-Windows platforms (the swap script is Windows-only — the
 *    project is Windows-only as of v0.4.0). */
export async function initUpdater(win: BrowserWindow, isMock: boolean): Promise<void> {
  mainWindow = win

  if (isMock) {
    log.info('updater: mock mode — auto-update disabled')
    return
  }
  if (!app.isPackaged) {
    log.info('updater: dev mode — auto-update disabled')
    return
  }
  if (process.platform !== 'win32') {
    log.info('updater: non-Windows platform — auto-update disabled')
    return
  }

  // IPC handlers — registered inside initUpdater so the entire updater
  // surface is in one file (easy to delete if the strategy ever
  // changes again).
  ipcMain.handle('updater:get-state', () => lastState)
  ipcMain.handle('updater:check',    async () => { await checkForUpdates({ silent: false }) })
  ipcMain.handle('updater:download', async () => { await downloadUpdate() })
  ipcMain.handle('updater:install',  async () => { await installUpdate() })
  ipcMain.handle('updater:cancel',   () => { cancelDownload() })
  ipcMain.handle('updater:skip',     () => { skipCurrentVersion() })

  // Check for updates on first launch. A tiny delay lets the Welcome
  // screen paint + the renderer register its updater-state listener first;
  // then we hit GitHub. Silent so a failed check (offline / rate-limited)
  // never pins an error banner at startup — only an actual update surfaces.
  startupTimeoutHandle = setTimeout(() => {
    log.info('updater: running first-launch update check')
    checkForUpdates({ silent: true }).catch((e) => {
      log.error('updater: startup check failed:', e)
    })
  }, STARTUP_DELAY_MS)

  // Periodic re-check — covers the long-install scenario where the
  // wizard is open for an hour+ while a fresh release ships.
  intervalHandle = setInterval(() => {
    checkForUpdates({ silent: true }).catch((e) => {
      log.error('updater: periodic check failed:', e)
    })
  }, PERIODIC_INTERVAL_MS)

  log.info('updater: initialised (startup check scheduled, periodic 6h)')
}

/** Stop timers — called from main's tearDown so the periodic interval
 *  doesn't keep a Node event loop reference alive past app.quit(). */
export function stopUpdater(): void {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null }
  if (startupTimeoutHandle) { clearTimeout(startupTimeoutHandle); startupTimeoutHandle = null }
}
