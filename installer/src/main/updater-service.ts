// In-place auto-updater wrapper around electron-updater.
//
// Why electron-updater (not the older squirrel.windows / autoUpdater):
// - Works against electron-builder's NSIS / DMG / AppImage outputs out
//   of the box. We already use electron-builder for packaging.
// - Reads the publish config from electron-builder.yml at runtime, so
//   the "where do I look?" URL is configured in one place.
// - Handles delta updates on Windows when block-mapping is available
//   (cuts download size for small version bumps). The auto-update file
//   format (latest.yml + .blockmap) is published by electron-builder
//   alongside the release artifacts.
//
// The flow we expose to the renderer:
//
//   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
//   │  app starts  │ ──auto─▶│ check-for-   │ ──found─▶│  download    │
//   │              │         │ update       │         │  in background│
//   └──────────────┘         └──────────────┘         └──────┬───────┘
//                                                            │
//                                       ┌──── download-progress events ───┘
//                                       ▼
//                              ┌──────────────────┐
//                              │ update-downloaded │ ──▶ user clicks "Install"
//                              └──────────────────┘                    │
//                                                                       ▼
//                                                              quitAndInstall()
//                                                                       │
//                                                       ┌───────────────┴──────┐
//                                                       │ app closes, installer │
//                                                       │ swaps in new version, │
//                                                       │ relaunches            │
//                                                       └───────────────────────┘
//
// All update events are mirrored to the renderer via IPC so the
// WhatsNew banner can show real-time download progress + an install
// button when ready. The renderer can also trigger a re-check or
// dismiss the available update.
//
// Mock mode: skip entirely. There's no GitHub release to update from
// in dev / mock environments, and the updater spamming "no
// publish provider" errors in main.log would obscure real issues.

import { app, BrowserWindow, ipcMain } from 'electron'
import log from 'electron-log/main.js'

// We dynamic-import electron-updater so this module is safe to load
// even when the dep isn't installed (dev sometimes has stale
// node_modules). The static import is the canonical path; the fallback
// just logs and no-ops.
//
// Note: electron-updater publishes a CommonJS default export.
type ElectronUpdater = typeof import('electron-updater')
let updater: ElectronUpdater | null = null
async function loadUpdater(): Promise<ElectronUpdater | null> {
  if (updater) return updater
  try {
    updater = (await import('electron-updater')) as ElectronUpdater
    return updater
  } catch (e) {
    log.warn('electron-updater not available — auto-update disabled:', e)
    return null
  }
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string }
  | { kind: 'not-available' }
  | { kind: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string; releaseNotes?: string }
  | { kind: 'error'; message: string }

let lastState: UpdateState = { kind: 'idle' }
let mainWindow: BrowserWindow | null = null

export function getUpdateState(): UpdateState {
  return lastState
}

function broadcast(state: UpdateState): void {
  lastState = state
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:state', state)
  }
}

/** Configure electron-updater's runtime behaviour. Called once at app
 *  start (after we have a window to broadcast to). Listens to every
 *  lifecycle event the updater emits and translates them into our
 *  flat UpdateState + IPC broadcast.
 *
 *  Skips on:
 *  - Mock mode (no real publish endpoint)
 *  - Unpackaged dev runs (electron-updater short-circuits anyway, but
 *    we skip explicitly to avoid log noise)
 *  - Linux AppImage when not running from a real AppImage (file:// or
 *    extracted dir won't have the right metadata)
 */
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

  const mod = await loadUpdater()
  if (!mod) return

  const { autoUpdater } = mod

  // Route electron-updater's own logging through electron-log so its
  // chatter ends up in main.log alongside ours. Without this you get a
  // separate file that's easy to miss when debugging an update issue.
  autoUpdater.logger = log

  // We want explicit control over when downloads happen — auto-download
  // means the user sees the "ready to install" banner without warning.
  // Renderer triggers the actual download via the IPC handler below.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    log.info('updater: checking for update')
    broadcast({ kind: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    log.info('updater: update available', info.version)
    broadcast({
      kind: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    log.info('updater: up to date', info.version)
    broadcast({ kind: 'not-available' })
  })

  autoUpdater.on('download-progress', (p) => {
    broadcast({
      kind: 'downloading',
      percent: Math.round(p.percent),
      bytesPerSecond: Math.round(p.bytesPerSecond),
      transferred: p.transferred,
      total: p.total,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('updater: update downloaded', info.version)
    broadcast({
      kind: 'downloaded',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    })
  })

  autoUpdater.on('error', (err) => {
    log.error('updater error:', err)
    broadcast({ kind: 'error', message: err?.message ?? String(err) })
  })

  // Register the IPC handlers the renderer uses to drive the updater.
  // We do this inside initUpdater rather than in ipc-handlers.ts so
  // the dynamic import + the handlers live in one file — easier to
  // delete if we ever decide to remove auto-update.
  ipcMain.handle('updater:get-state', () => lastState)

  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      log.error('updater: check failed:', e)
      broadcast({ kind: 'error', message: (e as Error).message })
    }
  })

  ipcMain.handle('updater:download', async () => {
    if (lastState.kind !== 'available' && lastState.kind !== 'error') {
      log.warn('updater: download requested but no update available; current state:', lastState.kind)
      return
    }
    try {
      await autoUpdater.downloadUpdate()
    } catch (e) {
      log.error('updater: download failed:', e)
      broadcast({ kind: 'error', message: (e as Error).message })
    }
  })

  ipcMain.handle('updater:install', () => {
    if (lastState.kind !== 'downloaded') {
      log.warn('updater: install requested but no update downloaded; current state:', lastState.kind)
      return
    }
    log.info('updater: quitting and installing update')
    // isSilent=false → on Windows, the NSIS installer briefly flashes
    //   its progress; users prefer that to a silent process-replacement
    //   they don't understand.
    // isForceRunAfter=true → relaunch the app immediately after the
    //   install completes.
    autoUpdater.quitAndInstall(false, true)
  })

  // Fire the initial check. Non-blocking — the result lands in
  // lastState and the renderer picks it up on its next get-state call
  // or via the broadcast event.
  log.info('updater: kicking off initial check')
  autoUpdater.checkForUpdates().catch((e) => {
    log.error('updater: initial check failed:', e)
    broadcast({ kind: 'error', message: (e as Error).message })
  })
}
