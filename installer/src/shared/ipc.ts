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

export interface DiskSpace {
  /** Free bytes on /volume1 (the install volume) */
  freeBytes: number
  /** Total bytes on /volume1 */
  totalBytes: number
  /** Convenience: GiB free as an integer */
  freeGiB: number
}

export interface InternetCheck {
  /** docker.io v2 endpoint reachable from the NAS — needed for image pulls */
  dockerHub: boolean
  /** plex.tv reachable — needed for claim token validation by Plex */
  plexTv: boolean
  /** True if `getent hosts registry-1.docker.io` returned an address. DNS
   *  resolution is a much weaker signal than HTTPS-to-200, but it's
   *  useful when curl fails — Synology's stock curl trust store can be
   *  out of date and reject perfectly valid TLS, while the Docker daemon
   *  itself (with its own networking) pulls images just fine. */
  dockerHubDnsResolves: boolean
  /** True if `docker info` returned a server version — Docker daemon is
   *  alive and can talk to its registry config (which by default is
   *  docker.io). Strong signal that pulls will work. */
  dockerDaemonUp: boolean
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
  /** /volume1 free space (null if df failed) */
  disk: DiskSpace | null
  /** Outbound reachability — image pulls + Plex claim need these */
  internet: InternetCheck
  /** Name of the NAS's default-route interface (e.g. eth0, ovs_eth0). */
  defaultIface: string | null
  /** IPv4 of that interface — the NAS's "real" LAN IP for service binding. */
  defaultIp: string | null
  /** Source IP of the current SSH session (the address the user connected from). */
  sshClientIp: string | null
  /** IP the NAS would use to reply to the SSH client. If different from
   *  defaultIp, the SSH session is on a non-LAN network (e.g. Tailscale). */
  replyIp: string | null
  /** Path the data-directory probes targeted on this host. Family-aware:
   *  Synology → /volume1/Data, Unraid → /mnt/user/data, QNAP → /share/
   *  Data, TrueNAS → /mnt/<pool>/data (first pool found). null when no
   *  candidate directory exists (e.g. fresh OMV box with no shared
   *  folders yet). The UI uses this to label messages with the path the
   *  user will actually see, not a misleading hardcoded one. */
  dataSharePath: string | null
  /** Does the data directory at dataSharePath exist? */
  dataShareExists: boolean
  /** Can the SSH user write to dataSharePath right now? null = couldn't
   *  test (dir missing). False on Synology is typically the shared-
   *  folder ACL trap the install used to fail on at step 7. False
   *  elsewhere usually means the dir exists but POSIX perms deny the
   *  SSH user. */
  dataShareWritable: boolean | null
  /** Parsed Synology-ACL ACEs for the data dir (used to show the user
   *  which accounts currently have access). Empty on non-Synology hosts
   *  — synoacltool only exists on DSM and the ACL concept doesn't
   *  apply to plain POSIX filesystems. */
  dataShareAcl: {
    kind: 'user' | 'group'
    name: string
    allow: boolean
    /** Permission bitmask string (synology format), e.g. "rwxpdDaARWcCo". */
    perms: string
    /** Inheritance flags, e.g. "fd--" = file+directory inherit. */
    inherit: string
  }[]
  /** Detected NAS family. Drives sensible defaults for INSTALL_DIR
   *  and DATA_ROOT, and gates family-specific features (Synology ACL
   *  via synoacltool, QNAP qpkg paths, Unraid /mnt/user, etc.). */
  nasFamily: 'synology' | 'qnap' | 'unraid' | 'truenas' | 'omv' | 'linux'
  /** Short OS version string the NAS self-reports (DSM build, Unraid
   *  version, kernel uname). Surfaced on Detect so the user can sanity-
   *  check what they're installing onto. */
  osVersion: string | null
  /** Existing top-level dirs that look like NAS data share roots. We
   *  scan a fixed candidate list at detect time and report only the
   *  ones that exist — the Configure screen offers them as quick-pick
   *  options for DATA_ROOT. */
  dataCandidates: string[]
  /** Family-aware default for INSTALL_DIR (where the wizard installs
   *  its compose stack). User can override on Configure. */
  suggestedInstallDir: string
  /** Family-aware default for DATA_ROOT (where the user's media +
   *  downloads live — bind-mounted as /data inside the arr containers). */
  suggestedDataRoot: string
  /** Family-aware fallback for PUID. Used to seed the Configure form
   *  before the /etc/passwd-driven user dropdown finishes populating;
   *  once that loads, the user picks a real account and PUID/PGID get
   *  overwritten with the chosen UID/GID. Defaults vary by family:
   *  Synology 1026, Unraid 99, TrueNAS 568, QNAP/OMV/Linux 1000. */
  suggestedPuid: string
  /** Family-aware fallback for PGID. See suggestedPuid. */
  suggestedPgid: string
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
  /** Absolute path to electron-log's current log file on this machine. */
  logPath: string
  /** GitHub-releases ping result populated shortly after app launch.
   *  Null = up to date, network unreachable, or fetch still in flight.
   *  When set, the renderer shows the WhatsNew banner on Welcome and
   *  a small "v0.x available" pill in the footer. The wizard does not
   *  auto-apply updates — the user downloads + replaces the folder. */
  updateAvailable: {
    latest: string
    url: string
    /** GitHub release `body` (Markdown). Rendered in the WhatsNew banner. */
    notes: string
    /** Direct URL to a `win-unpacked.zip` release asset if present.
     *  When set, the renderer can offer a one-click "Download zip"
     *  button that saves the zip to the user's Downloads folder and
     *  opens Explorer pointing at it. */
    zipUrl: string | null
  } | null
}

export interface UpdateDownloadResult {
  /** Where the zip landed on disk (typically ~/Downloads/<name>.zip).
   *  Null when the user cancelled or the download failed. */
  path: string | null
  /** Bytes written, for the renderer to show a "x.y MB downloaded" hint. */
  bytes: number
}

// ── Connection profiles ───────────────────────────────────────────────────────
//
// Profiles are the source of truth for every per-NAS setting. The user
// picks one at the start of the wizard; all form fields populate from
// it and write back to it as they edit. Stored encrypted via Electron
// safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux).

export interface ProfileConnection {
  host: string
  port: number
  user: string
  authMethod: AuthMethod
  privateKeyPath?: string
  /** Plaintext; only present when the renderer has loaded the full
   *  decrypted profile via profile:load. */
  password?: string
  passphrase?: string
  sudoPassword?: string
}

/** Public shape returned by profile:list. Hides the secret payload —
 *  the renderer only learns the secrets via profile:load. */
export interface SavedProfile {
  id: string
  label: string
  connection: Pick<ProfileConnection, 'host' | 'port' | 'user' | 'authMethod' | 'privateKeyPath'>
  /** True if any secret fields (password, sudoPassword, etc.) are stored. */
  hasSecret: boolean
  /** Whether config values have been saved against this profile. */
  hasConfig: boolean
  lastUsedAt: number
}

/** The fully-decrypted profile sent to the renderer when the user
 *  selects one. Includes secrets and the saved form state. */
export interface LoadedProfile {
  id: string
  label: string
  connection: ProfileConnection
  targetDir: string
  /** Full EnvFormValues-shaped config. Stored as a record so the IPC
   *  type doesn't depend on the renderer's form types. */
  config: Record<string, string>
  lastUsedAt: number
}

export interface SaveProfileInput {
  /** Provide to overwrite an existing profile */
  id?: string
  label: string
  connection: ProfileConnection
  targetDir: string
  config: Record<string, string>
}

/** Passphrase-protected portable envelope produced by profile-crypto.
 *  The renderer treats this as an opaque blob — pass it to a save
 *  dialog or accept it from an open dialog and round-trip via IPC. */
export interface ProfileExportEnvelope {
  format: 'mediarr-profile/v1'
  label: string
  exportedAt: number
  kdf: { name: string; iters: number; salt: string }
  cipher: { name: string; iv: string; tag: string; ct: string }
}

export interface ProfileImportRequest {
  envelope: ProfileExportEnvelope
  passphrase: string
}

/** Stable error string returned by profile:import when the passphrase
 *  doesn't match. Renderers can pattern-match this instead of
 *  pattern-matching raw OpenSSL strings. */
export const PROFILE_IMPORT_WRONG_PASSPHRASE = 'wrong-passphrase'

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
  profileLoad:     'profile:load',
  profileSave:     'profile:save',
  profileDelete:   'profile:delete',
  profileGetSecret:'profile:get-secret',     // legacy, kept for compatibility
  profileTouch:    'profile:touch',
  profileExport:   'profile:export',
  profileImport:   'profile:import',
  // Native dialogs
  dialogSaveText:  'dialog:save-text',
  dialogOpenText:  'dialog:open-text',
  // App
  appGetInfo:      'app:get-info',
  appOpenLog:      'app:open-log',
  appShowLogInFolder: 'app:show-log-in-folder',
  appOpenDevTools: 'app:open-devtools',
  appDownloadUpdate: 'app:download-update',
  appSkipUpdateVersion: 'app:skip-update-version',
  // Install log (per-run mirror of streamed output to a local file)
  installLogStart:  'install-log:start',
  installLogAppend: 'install-log:append',
  installLogClose:  'install-log:close',
  installLogReveal: 'install-log:reveal',
  installLogPath:   'install-log:path',
  // Events
  evtStreamData:   'ssh:stream:data',
  evtStreamClose:  'ssh:stream:close',
  evtSftpProgress: 'sftp:progress',
} as const
