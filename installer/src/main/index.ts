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

const __dirname_main = dirname(fileURLToPath(import.meta.url))

log.initialize()
log.info('=== NAS Arr Installer main process starting ===')
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

function createWindow() {
  const preloadPath = join(__dirname_main, '..', 'preload', 'index.mjs')
  const indexHtml = join(__dirname_main, '..', 'renderer', 'index.html')

  log.info('Preload path:', preloadPath, 'exists:', existsSync(preloadPath))
  log.info('Renderer path:', indexHtml, 'exists:', existsSync(indexHtml))

  // If the renderer file is missing, show a native dialog with the path
  // info — much better than a silent blank window.
  if (app.isPackaged && !existsSync(indexHtml)) {
    dialog.showErrorBox(
      'NAS Arr Installer — bundle error',
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

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    show: true, // show immediately so we don't hide failures behind ready-to-show
    autoHideMenuBar: true,
    backgroundColor: '#020617', // slate-950 — matches the renderer chrome
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
    log.info('NAS Arr Installer: MOCK MODE active — services are stubbed')
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
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    log.info('Packaged mode — loadFile', indexHtml)
    mainWindow.loadFile(indexHtml).catch((err) => {
      log.error('loadFile failed:', err)
      dialog.showErrorBox('Renderer load failed', String(err))
    })
    // Open DevTools in production until v0.1 is verified — comment out
    // once the packaged build is confirmed working in the wild.
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

app.whenReady().then(() => {
  log.info('app ready, registering IPC handlers')
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err) => {
  log.error('app.whenReady failed:', err)
  dialog.showErrorBox('Startup failed', String(err.stack || err))
})

app.on('window-all-closed', () => {
  ssh.shutdown()
  if (isMockMode()) mock.shutdown()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ssh.shutdown()
  if (isMockMode()) mock.shutdown()
})
