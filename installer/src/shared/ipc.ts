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

/** NAS families the environment detector recognizes. Drives default
 *  paths + PUID/PGID and gates family-specific UI and troubleshooting
 *  help (Synology ACL/Task-Scheduler, UGREEN/Debian cron + systemd, …). */
export type NasFamily =
  | 'synology' | 'ugreen' | 'asustor' | 'terramaster' | 'zimaos'
  | 'qnap' | 'unraid' | 'truenas' | 'omv' | 'linux'

export interface EnvDetectResult {
  docker: 'v2' | 'v1-legacy' | 'missing'
  /** Podman is installed (fallback container runtime when Docker is absent). */
  podman: boolean
  /** Podman's compose front-end: 'native' = `podman compose` (v4+),
   *  'external' = the `podman-compose` Python wrapper, 'none' = neither. */
  podmanCompose: 'native' | 'external' | 'none'
  /** Where Podman's API socket lives: 'user' = rootless
   *  ~/.local/share/containers/podman/podman.sock, 'root' =
   *  /run/podman/podman.sock, null = none found. Drives the DOCKER_SOCK /
   *  DOCKER_HOST override so `docker compose` can talk to Podman. */
  podmanSocket: 'user' | 'root' | null
  /** True when Podman runs rootless — host ports <1024 won't bind without
   *  userns remapping. The stack uses high ports, so usually harmless; the
   *  Detect screen warns if the user added a low-port custom service. */
  podmanRootless: boolean
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
  /** True when a NON-root login can drive Docker without sudo (in the
   *  `docker` group / owns the socket). Lets setup proceed even with no
   *  sudo password — Docker/compose work; the few genuinely-root steps
   *  degrade with a warning. */
  dockerGroup: boolean
  /** System vendor from DMI (sysfs sys_vendor / dmidecode), e.g. "UGREEN",
   *  "Synology", "QEMU". null when unreadable. Used as a family tiebreaker
   *  and shown to the user when classification confidence is below high. */
  systemVendor: string | null
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
  /** /dev/net/tun present? Gluetun's WireGuard tunnel requires it.
   *  Synology DSM 7 doesn't load the tun module on boot — on a fresh
   *  install, gluetun comes up but the tunnel silently never connects,
   *  cascading into qBittorrent never starting (depends_on:
   *  service_healthy gate). Fix is `sudo insmod /lib/modules/tun.ko`
   *  plus a Triggered Task to do it on every boot. We surface this on
   *  the Detect screen as a warning when VPN_ENABLED is going to be
   *  used. */
  tunDevice: boolean
  /** iptables kernel modules currently loaded? `lsmod | grep ^ip_tables`
   *  — DSM minor updates wipe these out periodically and every Docker
   *  port-publish then fails with "Operation not permitted." Surface as
   *  a warning; the fix (telnetdoogie's install_iptables_modules.sh +
   *  reboot) is too disruptive to auto-apply. */
  iptablesLoaded: boolean
  /** Filesystem type of the install dir (from `stat -f -c %T`). SQLite
   *  configs (Sonarr/Radarr/Lidarr/Prowlarr/Bazarr) corrupt
   *  catastrophically when stored on NFS/CIFS/fuse mounts. We hard-
   *  reject anything that isn't a local filesystem. Common values:
   *  'ext2/ext3' (Linux ext4), 'btrfs' (Synology SHR/BTRFS),
   *  'nfs', 'cifs', 'fuseblk', 'fuse.mergerfs'. */
  installDirFs: string | null
  /** Detected NAS family. Drives sensible defaults for INSTALL_DIR
   *  and DATA_ROOT, and gates family-specific features (Synology ACL
   *  via synoacltool, QNAP qpkg paths, Unraid /mnt/user, etc.). */
  nasFamily: NasFamily
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
  /** The INSTALL_DIR / DATA_ROOT an EXISTING install is using (read from the
   *  on-NAS .env at the target dir), or null when there's no prior install.
   *  The Detect/Configure screens warn when the user enters a DIFFERENT path,
   *  because relocating an existing stack moves data (setup.sh runs
   *  relocate-stack.sh to do it safely). */
  existingInstallDir: string | null
  existingDataRoot: string | null
  /** Family-aware fallback for PUID. Used to seed the Configure form
   *  before the /etc/passwd-driven user dropdown finishes populating;
   *  once that loads, the user picks a real account and PUID/PGID get
   *  overwritten with the chosen UID/GID. Defaults vary by family:
   *  Synology 1026, Unraid 99, TrueNAS 568, QNAP/OMV/Linux 1000. */
  suggestedPuid: string
  /** Family-aware fallback for PGID. See suggestedPuid. */
  suggestedPgid: string
  /** Raw `uname -m` (e.g. 'x86_64', 'aarch64', 'armv7l'); null if unread.
   *  Drives the 32-bit-ARM hard-block (the media images dropped 32-bit
   *  support) and the arm64 "no hardware transcode" warning. */
  cpuArch: string | null
  /** Raw `uname -s` kernel name ('Linux', 'FreeBSD', …). Non-Linux hosts
   *  (notably TrueNAS CORE = FreeBSD) can't run the Linux Docker stack and
   *  are hard-rejected up front. */
  kernelOs: string | null
  /** Total host RAM in MB (from /proc/meminfo MemTotal). null if unread.
   *  Used to warn when the box is too small (<~2 GB) for the full stack. */
  ramMB: number | null
  /** How confident the family classification is: 'high' = an OS marker
   *  file matched (synoinfo.conf, qpkg.conf, unraid-version, …); 'low' =
   *  only a heuristic matched (Debian + /volume1 → ugreen); 'unknown' =
   *  nothing matched and we fell through to the generic 'linux' family.
   *  The Detect screen asks the user to confirm paths when 'unknown'. */
  familyConfidence: 'high' | 'low' | 'unknown'
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

/** Result of running collect-diagnostics.sh + fetching the tarball back. */
export interface DiagCollectResult {
  /** True when a tarball was produced AND saved to the user's machine. */
  ok: boolean
  /** Local path the bundle was saved to (null if cancelled / failed). */
  path: string | null
  /** True when the user cancelled the save dialog (not an error). */
  canceled?: boolean
  /** Human-readable failure reason when ok is false and not cancelled. */
  error?: string
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
}

/** Lifecycle states the in-place updater can be in. The main side
 *  emits transitions over the `updater:state` event; the renderer's
 *  WhatsNew banner subscribes and renders the matching UI (idle =
 *  hidden; available = "Install" button; downloading = progress bar;
 *  downloaded = "Restart and install" button; error = banner).
 *
 *  Discriminated union — every variant carries exactly the data its
 *  matching UI needs, no more.
 *
 *  `available` / `downloaded` carry the GitHub release page URL so the
 *  renderer can render a "Release page" link + footer pill without
 *  the renderer needing its own GitHub fetch. */
export type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string; htmlUrl?: string }
  | { kind: 'not-available' }
  | { kind: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  // Unpacking the downloaded zip into the staging dir. Emitted between
  // the final 100% download tick and the `downloaded` state so the
  // blocking update overlay can show "Extracting…" instead of a bar
  // frozen at 100% (extraction of the ~200 MB build takes a few seconds).
  | { kind: 'extracting'; version: string }
  | { kind: 'downloaded'; version: string; releaseNotes?: string; htmlUrl?: string }
  // The user clicked "Restart to finish" — the swap helper is spawned
  // and the app is about to quit (~500 ms). Lets the overlay show a
  // terminal "Restarting…" state instead of an interactive button the
  // user could double-click during the quit window.
  | { kind: 'installing'; version: string }
  | { kind: 'error'; message: string }

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
  /** Whether the stored secret blob is OS-encrypted (safeStorage) at rest.
   *  When this is false AND hasSecret is true, the secret was written as
   *  reversible base64 (the machine had no keyring at save time) — the UI
   *  surfaces an at-rest warning instead of the green "secrets saved" lock. */
  encryptedAtRest: boolean
  lastUsedAt: number
}

/** Form state for the MigrateScreen — source URLs / credentials for
 *  pulling a library across from an EXISTING arr install. Lives on the
 *  profile so the user doesn't have to re-type four URLs + four
 *  credentials every time they re-open the wizard. Encrypted at rest
 *  with the rest of the profile body (DPAPI on Windows, Keychain on
 *  macOS, libsecret on Linux). Fields are all optional — the
 *  MigrateScreen lets the user populate either arr, qBit, or both.
 *  Empty / undefined fields just leave the input blank. */
export interface MigrateState {
  sourceSonarrUrl?: string
  sourceSonarrKey?: string
  sourceRadarrUrl?: string
  sourceRadarrKey?: string
  sourceQbitUrl?: string
  sourceQbitUser?: string
  sourceQbitPass?: string
  /** Path-prefix remap for qBit save-paths. e.g. /downloads → /data/Downloads */
  qbitRemapFrom?: string
  qbitRemapTo?: string
  /** Destination overrides. The MigrateScreen normally auto-discovers
   *  the local arr URLs (from LAN_IP + the stack's standard ports) and
   *  the API keys / qBit creds (from the NAS .env). These fields let
   *  the user override any of those — useful when:
   *    - the install is partial and .env doesn't have keys yet
   *    - qBit's WebUI password drifted from .env's QBITTORRENT_PASS
   *    - the user is migrating to an arr that's behind a reverse proxy
   *      on a non-standard port / URL base
   *    - the user wants to migrate into an existing arr stack the wizard
   *      didn't install
   *  When set, these override the auto-discovered values.
   */
  destSonarrUrl?: string
  destSonarrKey?: string
  destRadarrUrl?: string
  destRadarrKey?: string
  destQbitUrl?: string
  destQbitUser?: string
  destQbitPass?: string
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
  /** Optional saved state from the MigrateScreen — source connection
   *  info the user previously entered. Missing on profiles created
   *  before this field existed. */
  migrate?: MigrateState
  lastUsedAt: number
}

export interface SaveProfileInput {
  /** Provide to overwrite an existing profile */
  id?: string
  label: string
  connection: ProfileConnection
  targetDir: string
  config: Record<string, string>
  /** Optional MigrateScreen form state. Round-trips encrypted. */
  migrate?: MigrateState
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

// ── qBittorrent migration types ─────────────────────────────────────────────

/** Subset of a qBittorrent torrent we surface to the renderer for
 *  preview + migration. The qBit API returns ~30 fields per torrent;
 *  we only forward what the user actually sees + what we need to
 *  re-add the torrent on the destination. */
export interface QbitTorrent {
  hash: string
  name: string
  /** Source-side absolute path where the data sits. The renderer's
   *  remap-prefix logic translates this for the destination add. */
  save_path: string
  category: string
  tags: string                  // comma-separated, qBit's native format
  /** qBit's state — paused / uploading / downloading / etc. We re-add
   *  paused vs running based on this. */
  state: string
  /** Bytes completed; if the torrent is 100% the renderer can show a
   *  "ready to seed" badge in the preview. */
  completed: number
  size: number
}

export interface QbitFetchListRequest {
  url: string          // e.g. "http://old-nas:49156"
  username: string
  password: string
}
export interface QbitFetchListResult {
  ok: boolean
  error?: string
  torrents?: QbitTorrent[]
}

export interface QbitMigrateOneRequest {
  /** Source — the OLD qBittorrent we're pulling FROM. */
  sourceUrl: string
  sourceUsername: string
  sourcePassword: string
  sourceHash: string

  /** Destination — the local install's qBittorrent (read from .env). */
  destUrl: string
  destUsername: string
  destPassword: string
  /** Where on the dest filesystem the data lives. The wizard derives
   *  this by applying the user's remap prefix to the source save_path. */
  destSavePath: string

  /** Tag list to preserve on the dest torrent (qBit-native comma-
   *  separated string format). Forwarded verbatim — qBit creates the
   *  tags on its side if they don't already exist. */
  destTags: string
  destCategory: string

  /** Add the torrent paused so the user can verify save-path mapping
   *  before seeding starts. Defaults to true for safety. */
  paused: boolean
}
export interface QbitMigrateOneResult {
  ok: boolean
  /** Optional error from the source export step (couldn't get .torrent
   *  file) or the dest add step (qBit refused). */
  error?: string
  /** Step where it failed, useful for diagnosis. */
  stage?: 'login-source' | 'export' | 'login-dest' | 'add'
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

// ── Spotify Connect (OAuth) — main process lists the user's playlists ────────
export interface SpotifyPlaylist {
  name: string
  /** open.spotify.com playlist URL — written into SPOTIFY_PLAYLISTS as Name|URL. */
  url: string
  isPublic: boolean
  owner: string
  trackCount: number
}
export interface SpotifyConnectResult {
  playlists: SpotifyPlaylist[]
  /** Long-lived refresh token so the downloader (sockseek --spotify-refresh)
   *  can read PRIVATE playlists non-interactively at sync time. */
  refreshToken: string
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
  // Diagnostics (run collect-diagnostics.sh on the NAS, fetch the tarball back)
  diagCollect:     'diag:collect',
  // Helpers
  envDetect:       'env:detect',
  vpnFetchKey:     'vpn:fetch-key',
  spotifyConnect:  'spotify:connect',
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
  // qBittorrent migration (renderer → main, main fetches over HTTP)
  qbitFetchList:    'qbit:fetch-list',
  qbitMigrateOne:   'qbit:migrate-one',
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
