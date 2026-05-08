// All ipcMain.handle registrations in one place. Keeps src/main/index.ts
// short and makes the wire surface easy to audit.

import { ipcMain } from 'electron'
import { IPC, type ConnectionConfig, type SaveProfileInput } from '../shared/ipc.js'
import * as ssh from './ssh-service.js'
import * as sftp from './sftp-service.js'
import { detectEnv } from './env-detector.js'
import { fetchVpnKey } from './vpn-service.js'
import * as profiles from './profile-store.js'
import { saveTextToFile } from './dialog-service.js'

export function registerIpcHandlers() {
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

  // ── Helpers ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.envDetect, (_e, args: { sessionId: string }) => detectEnv(args.sessionId))
  ipcMain.handle(IPC.vpnFetchKey, (_e, args: { token: string }) => fetchVpnKey(args.token))

  // ── Profiles ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.profileList, () => profiles.listProfiles())
  ipcMain.handle(IPC.profileSave, (_e, args: SaveProfileInput) => profiles.saveProfile(args))
  ipcMain.handle(IPC.profileDelete, (_e, args: { id: string }) => profiles.deleteProfile(args.id))
  ipcMain.handle(IPC.profileGetSecret, (_e, args: { id: string }) => profiles.getSecret(args.id))
  ipcMain.handle(IPC.profileTouch, (_e, args: { id: string }) => profiles.touchProfile(args.id))

  // ── Dialogs ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.dialogSaveText, (_e, args: { defaultName: string; content: string; title?: string }) =>
    saveTextToFile(args),
  )
}
