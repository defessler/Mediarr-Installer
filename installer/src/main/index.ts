// Electron main entry. Boots the BrowserWindow, wires services, and
// owns the app lifecycle.

import { app, BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import log from 'electron-log/main.js'
import { registerIpcHandlers } from './ipc-handlers.js'
import * as ssh from './ssh-service.js'
import * as sftp from './sftp-service.js'

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
    mainWindow.loadFile(join(__dirname_main, '..', 'renderer', 'index.html'))
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
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ssh.shutdown()
})
