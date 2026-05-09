// All ipcMain.handle registrations. When INSTALLER_MOCK=1 is set in
// the environment, ssh/sftp/env-detect/vpn handlers are swapped for
// mock-services that emit pre-recorded streamed output. The IPC
// channel names are identical so the renderer is unchanged.

import { ipcMain, app } from 'electron'
import { IPC, type ConnectionConfig, type SaveProfileInput } from '../shared/ipc.js'
import * as sshReal from './ssh-service.js'
import * as sftpReal from './sftp-service.js'
import { detectEnv as detectEnvReal } from './env-detector.js'
import { fetchVpnKey as fetchVpnKeyReal } from './vpn-service.js'
import * as mock from './mock-services.js'
import * as profiles from './profile-store.js'
import { saveTextToFile } from './dialog-service.js'
import { payloadSha } from './payload-resolver.js'

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

  // ── Helpers ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.envDetect, (_e, args: { sessionId: string; targetDir?: string }) =>
    detectEnv(args.sessionId, args.targetDir),
  )
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

  // ── App info ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.appGetInfo, () => ({
    mock: useMock,
    version: app.getVersion(),
    payloadSha: payloadSha(),
  }))
}
