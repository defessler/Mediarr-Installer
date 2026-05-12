// Electron main entry. Boots the BrowserWindow, wires services, and
// owns the app lifecycle.

import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import log from 'electron-log/main.js'
import { registerIpcHandlers, isMockMode } from './ipc-handlers.js'
import * as ssh from './ssh-service.js'
import * as sftp from './sftp-service.js'
import * as mock from './mock-services.js'
import * as installLog from './install-log.js'

const __dirname_main = dirname(fileURLToPath(import.meta.url))

log.initialize()
log.info('=== Mediarr Installer main process starting ===')
log.info('app.isPackaged:', app.isPackaged)
log.info('app.getAppPath():', app.getAppPath())
log.info('process.resourcesPath:', process.resourcesPath)
log.info('__dirname_main:', __dirname_main)
log.info('Log file:', log.transports.file.getFile().path)

// Catch unhandled errors and surface them to the log + a dialog before the
// process disappears silently.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err)
  try { dialog.showErrorBox('Startup error', String(err.stack || err)) } catch { /* ignore */ }
})

let mainWindow: BrowserWindow | null = null

/** Cached result of the GitHub-releases ping. Populated by
 *  checkForUpdate() shortly after app.whenReady(); null on first
 *  launch until that fetch resolves, and null afterwards if the API
 *  was unreachable, rate-limited, or returned no releases. The
 *  appGetInfo IPC handler reads this lazily so the renderer can show
 *  a small "v0.x available" pill in the footer. We deliberately don't
 *  block app startup on the network — the wizard works offline once
 *  you've reached the Configure screen. */
let updateInfo: { latest: string; url: string } | null = null

export function getCachedUpdateInfo(): { latest: string; url: string } | null {
  return updateInfo
}

/** Compare a GitHub tag like "installer-v0.2.0" / "v0.2.0" / "0.2.0"
 *  against app.getVersion() (always a "X.Y.Z" semver-ish triple).
 *  Returns true when the tag is strictly newer. Avoids pulling in the
 *  full `semver` package — we don't use pre-release identifiers in
 *  this project so a numeric triple compare is enough. */
function isNewerVersion(tag: string, current: string): boolean {
  const stripPrefix = (s: string) => s.replace(/^[a-zA-Z-]*v?/, '')
  const parse = (s: string) =>
    stripPrefix(s).split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0)
  const [ta, tb, tc] = parse(tag)
  const [ca, cb, cc] = parse(current)
  if (ta !== ca) return ta > ca
  if (tb !== cb) return tb > cb
  return tc > cc
}

/** Fire-and-forget GitHub-releases ping. Never throws — any failure
 *  just leaves updateInfo=null and the footer pill stays hidden. */
async function checkForUpdate(): Promise<void> {
  if (isMockMode()) return       // skip in mock — no real version meaning
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 8_000)
    const res = await fetch(
      'https://api.github.com/repos/defessler/Mediarr-Installer/releases/latest',
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Mediarr-Installer/${app.getVersion()}`,
        },
        signal: ac.signal,
      },
    )
    clearTimeout(t)
    if (!res.ok) return            // 404 on a brand-new repo with no releases is fine
    const body = (await res.json()) as { tag_name?: string; html_url?: string }
    const tag = body.tag_name ?? ''
    const url = body.html_url ?? ''
    if (!tag) return
    if (isNewerVersion(tag, app.getVersion())) {
      const stripped = tag.replace(/^[a-zA-Z-]*v?/, '')
      updateInfo = { latest: stripped, url: url || 'https://github.com/defessler/Mediarr-Installer/releases' }
      log.info(`update available: v${stripped} (current v${app.getVersion()})`)
    } else {
      log.info(`up to date — v${app.getVersion()} ≥ tag ${tag}`)
    }
  } catch (e) {
    // Network errors, abort, JSON parse errors — leave updateInfo null.
    log.info('update check failed (non-fatal):', (e as Error).message)
  }
}

function createWindow() {
  const preloadPath = join(__dirname_main, '..', 'preload', 'index.mjs')
  const indexHtml = join(__dirname_main, '..', 'renderer', 'index.html')

  log.info('Preload path:', preloadPath, 'exists:', existsSync(preloadPath))
  log.info('Renderer path:', indexHtml, 'exists:', existsSync(indexHtml))

  // If the renderer file is missing, show a native dialog with the path
  // info — much better than a silent blank window.
  if (app.isPackaged && !existsSync(indexHtml)) {
    dialog.showErrorBox(
      'Mediarr Installer — bundle error',
      `The renderer's index.html was not found.\n\n` +
        `Expected at:\n${indexHtml}\n\n` +
        `__dirname: ${__dirname_main}\n` +
        `resourcesPath: ${process.resourcesPath}\n` +
        `appPath: ${app.getAppPath()}\n\n` +
        `Please report this with the contents of:\n` +
        `${log.transports.file.getFile().path}`,
    )
    app.quit()
    return
  }

  // Theme the title bar to match the dark-slate renderer instead of the
  // default white/grey OS chrome.
  //   - Windows: `titleBarStyle: 'hidden'` strips the native bar, and
  //     `titleBarOverlay` paints the minimize/maximize/close buttons in
  //     our colors over a 36px drag region the renderer reserves.
  //   - macOS: `hiddenInset` keeps the traffic-light buttons but hides
  //     the bar background. The renderer's top drag region fills it in.
  //   - Linux: no equivalent — keep the default frame.
  const titleBarOpts =
    process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#020617',        // slate-950
            symbolColor: '#cbd5e1',  // slate-300
            height: 36,
          },
        }
      : process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 11 } }
        : {}

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    show: true, // show immediately so we don't hide failures behind ready-to-show
    autoHideMenuBar: true,
    backgroundColor: '#020617', // slate-950 — matches the renderer chrome
    ...titleBarOpts,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // ssh2 needs node integration in main only; renderer stays sandboxed via contextIsolation
    },
  })

  ssh.bindMainWindow(mainWindow)
  sftp.bindMainWindow(mainWindow)
  if (isMockMode()) {
    mock.bindMainWindow(mainWindow)
    log.info('Mediarr Installer: MOCK MODE active — services are stubbed')
  }

  // External links open in the user's browser, never inside the wizard.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Diagnostic listeners — anything that goes wrong with the renderer
  // ends up in main.log instead of dying silently.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.error(`did-fail-load: code=${code} desc="${desc}" url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('render-process-gone:', details)
  })
  mainWindow.webContents.on('preload-error', (_e, path, err) => {
    log.error('preload-error:', path, err)
  })
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) log.error(`renderer console: ${source}:${line} ${message}`)
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    log.info('Dev mode — loadURL', process.env.ELECTRON_RENDERER_URL)
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    // Dev: auto-open DevTools so we don't have to click a button every
    // reload. Packaged builds get a manual "DevTools" button next to
    // "Open log" — power users can still get in, but normal users
    // aren't greeted by a console panel they didn't ask for.
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    log.info('Packaged mode — loadFile', indexHtml)
    mainWindow.loadFile(indexHtml).catch((err) => {
      log.error('loadFile failed:', err)
      dialog.showErrorBox('Renderer load failed', String(err))
    })
  }
}

/** Expose the active window so ipc-handlers can open its DevTools. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

app.whenReady().then(() => {
  log.info('app ready, registering IPC handlers')
  registerIpcHandlers()
  createWindow()

  // Fire-and-forget update check. Non-blocking — result lands in
  // `updateInfo` and gets surfaced by appGetInfo on the next IPC call.
  checkForUpdate().catch(() => { /* checkForUpdate already logs */ })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err) => {
  log.error('app.whenReady failed:', err)
  dialog.showErrorBox('Startup failed', String(err.stack || err))
})

// Defensive cleanup: run on every plausible "we're going away" event.
// ssh.shutdown() and installLog.closeInstallLog() are idempotent so
// multiple firings are fine.
function tearDown() {
  try { ssh.shutdown() } catch (e) { log.error('ssh.shutdown failed:', e) }
  try { installLog.closeInstallLog() } catch (e) { log.error('installLog.closeInstallLog failed:', e) }
  if (isMockMode()) try { mock.shutdown() } catch (e) { log.error('mock.shutdown failed:', e) }
}

app.on('window-all-closed', () => {
  tearDown()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', tearDown)
app.on('will-quit', tearDown)
// SIGINT/SIGTERM (Ctrl+C in dev, OS shutdown) — Electron normally
// handles these but signal a shutdown explicitly so the SSH client
// can send DISCONNECT before the socket dies hard.
process.on('SIGINT', () => { tearDown(); app.quit() })
process.on('SIGTERM', () => { tearDown(); app.quit() })
