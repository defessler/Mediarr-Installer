// All ipcMain.handle registrations. When INSTALLER_MOCK=1 is set in
// the environment, ssh/sftp/env-detect/vpn handlers are swapped for
// mock-services that emit pre-recorded streamed output. The IPC
// channel names are identical so the renderer is unchanged.

import { ipcMain, app, shell } from 'electron'
import log from 'electron-log/main.js'
import { IPC, type ConnectionConfig, type SaveProfileInput } from '../shared/ipc.js'
import * as sshReal from './ssh-service.js'
import * as sftpReal from './sftp-service.js'
import { detectEnv as detectEnvReal } from './env-detector.js'
import { fetchVpnKey as fetchVpnKeyReal } from './vpn-service.js'
import { spotifyConnect } from './spotify-oauth.js'
import * as mock from './mock-services.js'
import * as profiles from './profile-store.js'
import { saveTextToFile, openTextFromFile, chooseSavePath } from './dialog-service.js'
import { payloadSha } from './payload-resolver.js'
import * as installLog from './install-log.js'
import * as qbit from './qbit-migration.js'
import { getMainWindow } from './index.js'

export const isMockMode = (): boolean =>
  process.env.INSTALLER_MOCK === '1' || process.env.INSTALLER_MOCK === 'true'

export function registerIpcHandlers() {
  const useMock = isMockMode()

  // Pick which implementation backs each channel. Channel names are
  // shared between mock and real; only the function bodies differ.
  const ssh   = useMock ? mock          : sshReal
  const sftp  = useMock ? mock          : sftpReal
  const detectEnv  = useMock ? mock.detectEnv  : detectEnvReal
  const fetchVpnKey = useMock ? mock.fetchVpnKey : fetchVpnKeyReal

  // ── SSH ────────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.sshTestConnect, (_e, cfg: ConnectionConfig) => ssh.testConnect(cfg))
  ipcMain.handle(IPC.sshConnect, (_e, cfg: ConnectionConfig) => ssh.connect(cfg))
  ipcMain.handle(IPC.sshDisconnect, (_e, args: { sessionId: string }) => {
    ssh.disconnect(args.sessionId)
    return undefined
  })
  ipcMain.handle(IPC.sshExec, (_e, args) => ssh.exec(args))
  ipcMain.handle(IPC.sshExecStream, (_e, args) => ssh.execStream(args))
  ipcMain.handle(IPC.sshStreamCancel, (_e, args: { channelId: string }) => {
    ssh.streamCancel(args.channelId)
    return undefined
  })

  // ── SFTP ──────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.sftpUploadDir, (_e, args) => sftp.uploadDir(args))
  ipcMain.handle(IPC.sftpWriteFile, (_e, args) => sftp.writeFile(args))

  // ── Diagnostics bundle ──────────────────────────────────────────────────────
  // Run collect-diagnostics.sh on the NAS, parse the tarball path it prints,
  // let the user pick a save location, then SFTP the (redacted) bundle back.
  ipcMain.handle(IPC.diagCollect, async (_e, args: { sessionId: string; installDir: string }) => {
    try {
      const scriptPath = `${args.installDir.replace(/\/+$/, '')}/scripts/collect-diagnostics.sh`
      const esc = scriptPath.replace(/'/g, `'\\''`)
      // Unprivileged: the script degrades gracefully for root-only data
      // (dmesg/iptables) and the SSH user already has Docker access. 5-min
      // cap covers slow per-container log tails on spinning rust.
      const res = await ssh.exec({
        sessionId: args.sessionId,
        cmd: `bash '${esc}'`,
        sudo: false,
        timeoutMs: 300_000,
      })
      const m = res.stdout.match(/^DIAGNOSTICS_TARBALL=(.+)$/m)
      if (!m) {
        return {
          ok: false,
          path: null,
          error:
            `The diagnostics script didn't produce a bundle. ` +
            (res.stderr || res.stdout || '').slice(-300),
        }
      }
      const remote = m[1].trim()
      const save = await chooseSavePath({
        defaultName: remote.split('/').pop() || 'mediarr-diagnostics.tar.gz',
        title: 'Save diagnostics bundle',
        filters: [
          { name: 'Gzipped tarball', extensions: ['tar.gz', 'tgz'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (!save.saved || !save.path) return { ok: false, path: null, canceled: true }
      await sftp.downloadFile({ sessionId: args.sessionId, remotePath: remote, localPath: save.path })
      // Best-effort: remove the tarball from the NAS now it's been fetched.
      try {
        await ssh.exec({
          sessionId: args.sessionId,
          cmd: `rm -f '${remote.replace(/'/g, `'\\''`)}'`,
          sudo: false,
        })
      } catch { /* leave it — harmless */ }
      return { ok: true, path: save.path }
    } catch (e) {
      log.error('diag:collect failed', e)
      return { ok: false, path: null, error: (e as Error).message }
    }
  })

  // qBittorrent migration — fetch list + per-torrent migrate. Both run
  // in main process to avoid CORS (qBit doesn't send CORS headers) and
  // to handle binary .torrent export bodies cleanly. Not mocked since
  // MigrateScreen isn't part of the install flow's mock path.
  ipcMain.handle(IPC.qbitFetchList,  (_e, args) => qbit.qbitFetchList(args))
  ipcMain.handle(IPC.qbitMigrateOne, (_e, args) => qbit.qbitMigrateOne(args))

  // ── Helpers ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.envDetect, (_e, args: { sessionId: string; targetDir?: string }) =>
    detectEnv(args.sessionId, args.targetDir),
  )
  ipcMain.handle(IPC.vpnFetchKey, (_e, args: { token: string }) => fetchVpnKey(args.token))
  // Spotify OAuth runs in the main process (loopback redirect + token exchange).
  // Always the real flow — there's no useful mock for an interactive browser login.
  ipcMain.handle(IPC.spotifyConnect,
    (_e, args: { clientId: string; clientSecret: string }) => spotifyConnect(args))

  // ── Profiles ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.profileList, () => profiles.listProfiles())
  ipcMain.handle(IPC.profileLoad, (_e, args: { id: string }) => profiles.loadProfile(args.id))
  ipcMain.handle(IPC.profileSave, (_e, args: SaveProfileInput) => profiles.saveProfile(args))
  ipcMain.handle(IPC.profileDelete, (_e, args: { id: string }) => profiles.deleteProfile(args.id))
  ipcMain.handle(IPC.profileGetSecret, (_e, args: { id: string }) => profiles.getSecret(args.id))
  ipcMain.handle(IPC.profileTouch, (_e, args: { id: string }) => profiles.touchProfile(args.id))
  ipcMain.handle(IPC.profileExport, (_e, args: { id: string; passphrase: string }) =>
    profiles.exportProfile(args.id, args.passphrase))
  ipcMain.handle(IPC.profileImport, (_e, args: { envelope: unknown; passphrase: string }) =>
    profiles.importProfile({ envelope: args.envelope, passphrase: args.passphrase }))

  // ── Dialogs ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.dialogSaveText, (_e, args: {
    defaultName: string; content: string; title?: string
    filters?: { name: string; extensions: string[] }[]
    restrictPermissions?: boolean
  }) => saveTextToFile(args))
  ipcMain.handle(IPC.dialogOpenText, (_e, args: {
    title?: string
    filters?: { name: string; extensions: string[] }[]
  }) => openTextFromFile(args ?? {}))

  // ── App info ──────────────────────────────────────────────────────────────
  // updateAvailable used to live here, sourced from a parallel GitHub
  // /releases/latest ping in main/index.ts. v0.4.3 consolidated all
  // update-state behind updater-service.ts — the renderer reads
  // available-update info via the `updater:state` event stream.
  ipcMain.handle(IPC.appGetInfo, () => ({
    mock: useMock,
    version: app.getVersion(),
    payloadSha: payloadSha(),
    logPath: log.transports.file.getFile().path,
  }))
  // Opens the active log file in the user's default text editor.
  // Returns the path so the renderer can show it in a toast.
  ipcMain.handle(IPC.appOpenLog, async () => {
    const path = log.transports.file.getFile().path
    const err = await shell.openPath(path)
    return { path, error: err || null }
  })
  // Reveals the log file in the OS file manager (Explorer / Finder /
  // whichever Linux DE) — useful for grabbing it to attach to a bug
  // report or rotating older log files.
  ipcMain.handle(IPC.appShowLogInFolder, () => {
    const path = log.transports.file.getFile().path
    shell.showItemInFolder(path)
    return { path }
  })

  // Toggle Chromium DevTools. The packaged build doesn't auto-open
  // them anymore, but this lets a user pop them open from the footer
  // when something looks wrong.
  ipcMain.handle(IPC.appOpenDevTools, () => {
    const win = getMainWindow()
    if (!win) return { opened: false }
    if (win.webContents.isDevToolsOpened()) {
      win.webContents.closeDevTools()
      return { opened: false }
    }
    win.webContents.openDevTools({ mode: 'detach' })
    return { opened: true }
  })

  // ── Install log (per-run, separate from electron-log main.log) ────────────
  ipcMain.handle(IPC.installLogStart, (_e, args: { kind?: 'install' | 'update' | 'validate' }) =>
    ({ path: installLog.startInstallLog(args?.kind ?? 'install') }))
  ipcMain.handle(IPC.installLogAppend, (_e, args: { chunk: string }) => {
    installLog.appendInstallLog(args.chunk)
    return undefined
  })
  ipcMain.handle(IPC.installLogClose, () => {
    installLog.closeInstallLog()
    return undefined
  })
  ipcMain.handle(IPC.installLogReveal, () => installLog.revealCurrentInstallLog())
  ipcMain.handle(IPC.installLogPath, () => ({ path: installLog.getCurrentInstallLogPath() }))
}
