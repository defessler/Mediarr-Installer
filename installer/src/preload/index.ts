// Preload script — runs in an isolated world that has both Node and DOM
// access. Exposes a narrow, typed surface to the renderer via
// contextBridge. The renderer's `window.installer` is the ONLY way it
// can talk to the main process; raw ipcRenderer is never exposed.

import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppInfo,
  type ConnectionConfig,
  type ConnectResult,
  type EnvDetectResult,
  type ExecResult,
  type LoadedProfile,
  type ProfileExportEnvelope,
  type SavedProfile,
  type SaveProfileInput,
  type SftpProgress,
  type SftpUploadResult,
  type SshStreamClose,
  type SshStreamData,
  type VpnFetchResult,
} from '../shared/ipc.js'

const installer = {
  ssh: {
    testConnect: (cfg: ConnectionConfig): Promise<ConnectResult> =>
      ipcRenderer.invoke(IPC.sshTestConnect, cfg),
    connect: (cfg: ConnectionConfig): Promise<{ sessionId: string }> =>
      ipcRenderer.invoke(IPC.sshConnect, cfg),
    disconnect: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sshDisconnect, { sessionId }),
    exec: (args: { sessionId: string; cmd: string; sudo?: boolean }): Promise<ExecResult> =>
      ipcRenderer.invoke(IPC.sshExec, args),
    execStream: (args: {
      sessionId: string
      cmd: string
      sudo?: boolean
      channelId: string
    }): Promise<void> => ipcRenderer.invoke(IPC.sshExecStream, args),
    streamCancel: (channelId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sshStreamCancel, { channelId }),
    onStreamData: (cb: (data: SshStreamData) => void) => {
      const handler = (_e: unknown, payload: SshStreamData) => cb(payload)
      ipcRenderer.on(IPC.evtStreamData, handler)
      return () => ipcRenderer.off(IPC.evtStreamData, handler)
    },
    onStreamClose: (cb: (data: SshStreamClose) => void) => {
      const handler = (_e: unknown, payload: SshStreamClose) => cb(payload)
      ipcRenderer.on(IPC.evtStreamClose, handler)
      return () => ipcRenderer.off(IPC.evtStreamClose, handler)
    },
  },
  sftp: {
    uploadDir: (args: {
      sessionId: string
      localDir: string
      remoteDir: string
    }): Promise<SftpUploadResult> => ipcRenderer.invoke(IPC.sftpUploadDir, args),
    writeFile: (args: {
      sessionId: string
      remotePath: string
      content: string
      mode?: number
    }): Promise<void> => ipcRenderer.invoke(IPC.sftpWriteFile, args),
    onProgress: (cb: (p: SftpProgress) => void) => {
      const handler = (_e: unknown, payload: SftpProgress) => cb(payload)
      ipcRenderer.on(IPC.evtSftpProgress, handler)
      return () => ipcRenderer.off(IPC.evtSftpProgress, handler)
    },
  },
  env: {
    detect: (sessionId: string, targetDir?: string): Promise<EnvDetectResult> =>
      ipcRenderer.invoke(IPC.envDetect, { sessionId, targetDir }),
  },
  vpn: {
    fetchKey: (token: string): Promise<VpnFetchResult> =>
      ipcRenderer.invoke(IPC.vpnFetchKey, { token }),
  },
  profiles: {
    list:      (): Promise<SavedProfile[]> => ipcRenderer.invoke(IPC.profileList),
    load:      (id: string): Promise<LoadedProfile | null> =>
      ipcRenderer.invoke(IPC.profileLoad, { id }),
    save:      (input: SaveProfileInput): Promise<SavedProfile> =>
      ipcRenderer.invoke(IPC.profileSave, input),
    delete:    (id: string): Promise<void> => ipcRenderer.invoke(IPC.profileDelete, { id }),
    getSecret: (id: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.profileGetSecret, { id }),
    touch:     (id: string): Promise<void> => ipcRenderer.invoke(IPC.profileTouch, { id }),
    exportProfile: (id: string, passphrase: string): Promise<ProfileExportEnvelope> =>
      ipcRenderer.invoke(IPC.profileExport, { id, passphrase }),
    importProfile: (envelope: ProfileExportEnvelope, passphrase: string): Promise<SavedProfile> =>
      ipcRenderer.invoke(IPC.profileImport, { envelope, passphrase }),
  },
  dialog: {
    saveText: (args: {
      defaultName: string; content: string; title?: string
      filters?: { name: string; extensions: string[] }[]
    }): Promise<{ saved: boolean; path: string | null }> =>
      ipcRenderer.invoke(IPC.dialogSaveText, args),
    openText: (args: {
      title?: string
      filters?: { name: string; extensions: string[] }[]
    }): Promise<{ opened: boolean; path: string | null; content: string | null; error?: string }> =>
      ipcRenderer.invoke(IPC.dialogOpenText, args),
  },
  app: {
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appGetInfo),
    openLog: (): Promise<{ path: string; error: string | null }> =>
      ipcRenderer.invoke(IPC.appOpenLog),
    showLogInFolder: (): Promise<{ path: string }> =>
      ipcRenderer.invoke(IPC.appShowLogInFolder),
    openDevTools: (): Promise<{ opened: boolean }> =>
      ipcRenderer.invoke(IPC.appOpenDevTools),
    downloadUpdate: (): Promise<{ path: string | null; bytes: number; error?: string }> =>
      ipcRenderer.invoke(IPC.appDownloadUpdate),
    skipUpdateVersion: (): Promise<void> =>
      ipcRenderer.invoke(IPC.appSkipUpdateVersion),
  },
  installLog: {
    start: (kind?: 'install' | 'update' | 'validate'): Promise<{ path: string }> =>
      ipcRenderer.invoke(IPC.installLogStart, { kind }),
    append: (chunk: string): Promise<void> =>
      ipcRenderer.invoke(IPC.installLogAppend, { chunk }),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.installLogClose),
    reveal: (): Promise<{ path: string | null }> => ipcRenderer.invoke(IPC.installLogReveal),
    path: (): Promise<{ path: string | null }> => ipcRenderer.invoke(IPC.installLogPath),
  },
}

export type InstallerApi = typeof installer

contextBridge.exposeInMainWorld('installer', installer)
