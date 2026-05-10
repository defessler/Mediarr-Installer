// Electron main entry. Boots the BrowserWindow, wires services, and
// owns the app lifecycle.

import { app, BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import log from 'electron-log/main.js'
import { registerIpcHandlers, isMockMode } from './ipc-handlers.js'
import * as ssh from './ssh-service.js'
import * as sftp from './sftp-service.js'
import * as mock from './mock-services.js'

const __dirname_main = dirname(fileURLToPath(import.meta.url))

log.initialize()
log.info('NAS Arr Installer main process starting')

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#020617', // slate-950 — matches the renderer chrome
    webPreferences: {
      // out/preload/index.js after build; resolved relative to out/main/index.js
      preload: join(__dirname_main, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // ssh2 needs node integration in main only; renderer stays sandboxed via contextIsolation
    },
  })

  ssh.bindMainWindow(mainWindow)
  sftp.bindMainWindow(mainWindow)
  // Mock services share the same event-emit machinery so they can push
  // ssh:stream:data / sftp:progress events on the right channel.
  if (isMockMode()) {
    mock.bindMainWindow(mainWindow)
    log.info('NAS Arr Installer: MOCK MODE active — services are stubbed')
  }

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // External links open in the user's browser, never inside the wizard.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    const indexHtml = join(__dirname_main, '..', 'renderer', 'index.html')
    log.info(`Loading renderer from ${indexHtml}`)
    mainWindow.loadFile(indexHtml).catch((err) => {
      log.error('Failed to load renderer index.html:', err)
    })
    // Surface any renderer load failures to the log file (electron-log
    // writes to %APPDATA%\nas-arr-installer\logs\main.log on Windows).
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log.error(`did-fail-load: code=${code} desc=${desc} url=${url}`)
    })
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      log.error('render-process-gone:', details)
    })
    // Open DevTools in production until v0.1 is verified — comment out
    // once the packaged build is confirmed working in the wild.
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
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
