// Single source of truth for IPC channel names + payload shapes.
// Both main and preload import from here. Renderer only sees the
// shape via the preload contextBridge surface (window.installer).

// ── Connection ────────────────────────────────────────────────────────────────

export type AuthMethod = 'password' | 'privateKey'

export interface ConnectionConfig {
  host: string
  port: number
  user: string
  authMethod: AuthMethod
  /** password (when authMethod === 'password') */
  password?: string
  /** absolute path to a private key file (when authMethod === 'privateKey') */
  privateKeyPath?: string
  /** passphrase for the private key, if encrypted */
  passphrase?: string
  /** sudo password, used only when user !== 'root' */
  sudoPassword?: string
}

export interface ConnectResult {
  ok: boolean
  /** present when ok === false */
  error?: {
    kind: 'auth-failed' | 'host-unreachable' | 'timeout' | 'unknown'
    message: string
  }
  /** banner returned by the SSH server, if any */
  banner?: string
}

// ── Exec ──────────────────────────────────────────────────────────────────────

export interface ExecResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
}

// ── Environment detection ─────────────────────────────────────────────────────

export interface ExistingInstall {
  /** True if the targetDir already has a docker-compose.yml — we'd be
   *  overwriting an install. */
  hasCompose: boolean
  /** True if the targetDir already has a .env (don't overwrite secrets). */
  hasEnv: boolean
  /** Names of containers from this stack already running on the host. */
  runningContainers: string[]
}

/** Port that's already bound on the host AND that our stack wants. */
export interface PortConflict {
  port: number
  service: string
  /** PID/program if `ss -p` returned one — empty string otherwise. */
  process: string
}

export interface EnvDetectResult {
  docker: 'v2' | 'v1-legacy' | 'missing'
  volume1: boolean
  puid: number | null
  pgid: number | null
  username: string | null
  groupname: string | null
  tz: string | null
  lanIps: string[]
  python3: string | null
  iptables: string | null
  /** how we should run privileged commands once setup begins */
  sudoMode: 'root' | 'nopasswd' | 'password'
  /** Pre-existing install at targetDir, if any */
  existingInstall: ExistingInstall
  /** Ports our stack wants that are already bound by another process */
  portConflicts: PortConflict[]
}

// ── VPN ──────────────────────────────────────────────────────────────────────

export interface Country {
  id: number
  name: string
  code: string
}

export interface VpnFetchResult {
  privateKey: string
  countries: Country[]
}

// ── SFTP ─────────────────────────────────────────────────────────────────────

export interface SftpProgress {
  file: string
  bytesDone: number
  bytesTotal: number
  pctOverall: number
}

export interface SftpUploadResult {
  uploaded: number
  bytesTotal: number
}

// ── App info ──────────────────────────────────────────────────────────────────

export interface AppInfo {
  /** True when launched with INSTALLER_MOCK=1 — services are stubbed. */
  mock: boolean
  version: string
  /** Git SHA of the bundled nas/ payload, recorded by copy-nas-payload.mjs */
  payloadSha: string | null
}

// ── Connection profiles ───────────────────────────────────────────────────────

export interface SavedProfile {
  id: string
  label: string
  host: string
  port: number
  user: string
  authMethod: AuthMethod
  privateKeyPath?: string
  hasSecret: boolean
  lastUsedAt: number
}

export interface SaveProfileInput {
  label: string
  host: string
  port: number
  user: string
  authMethod: AuthMethod
  privateKeyPath?: string
  /** Plaintext; undefined to skip saving the secret */
  secret?: string
  /** Provide to overwrite an existing profile */
  id?: string
}

// ── Streaming events (main → renderer) ───────────────────────────────────────

export interface SshStreamData {
  channelId: string
  type: 'stdout' | 'stderr'
  chunk: string
}

export interface SshStreamClose {
  channelId: string
  exitCode: number | null
  signal: string | null
}

// ── Channel name constants (use these — no string literals at call sites) ────

export const IPC = {
  // SSH
  sshTestConnect:  'ssh:test-connect',
  sshConnect:      'ssh:connect',
  sshDisconnect:   'ssh:disconnect',
  sshExec:         'ssh:exec',
  sshExecStream:   'ssh:exec-stream',
  sshStreamCancel: 'ssh:stream-cancel',
  // SFTP
  sftpUploadDir:   'sftp:upload-dir',
  sftpWriteFile:   'sftp:write-file',
  // Helpers
  envDetect:       'env:detect',
  vpnFetchKey:     'vpn:fetch-key',
  fsCheckTarget:   'fs:check-target',
  // Profiles
  profileList:     'profile:list',
  profileSave:     'profile:save',
  profileDelete:   'profile:delete',
  profileGetSecret:'profile:get-secret',
  profileTouch:    'profile:touch',
  // Native dialogs
  dialogSaveText:  'dialog:save-text',
  // App
  appGetInfo:      'app:get-info',
  // Events
  evtStreamData:   'ssh:stream:data',
  evtStreamClose:  'ssh:stream:close',
  evtSftpProgress: 'sftp:progress',
} as const
