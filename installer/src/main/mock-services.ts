// ── Mock services ─────────────────────────────────────────────────────────────
// Replaces ssh-service / sftp-service / env-detector / vpn-service with
// fakes that emit realistic streamed output. Lets the whole installer
// run end-to-end with no NAS at all — useful for UI work, CI, and demos.
//
// Activated by INSTALLER_MOCK=1 in the environment. ipc-handlers.ts
// switches on this flag at registration time.

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import {
  IPC,
  type ConnectionConfig,
  type ConnectResult,
  type EnvDetectResult,
  type ExecResult,
  type SftpProgress,
  type SftpUploadResult,
  type SshStreamData,
  type SshStreamClose,
  type VpnFetchResult,
} from '../shared/ipc.js'

let mainWindow: BrowserWindow | null = null

export function bindMainWindow(win: BrowserWindow) {
  mainWindow = win
}

function send<T>(channel: string, payload: T) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── Fake session bookkeeping ──────────────────────────────────────────────────

interface MockSession {
  config: ConnectionConfig
}

const sessions = new Map<string, MockSession>()

// ── SSH ───────────────────────────────────────────────────────────────────────

export async function testConnect(cfg: ConnectionConfig): Promise<ConnectResult> {
  await sleep(300)
  // Useful for testing the error UI: any host containing "fail" rejects.
  if (/fail/i.test(cfg.host)) {
    return { ok: false, error: { kind: 'auth-failed', message: '[mock] simulated auth failure' } }
  }
  return { ok: true, banner: '[mock] DSM 7.2 - greetings from the mock NAS' }
}

export async function connect(cfg: ConnectionConfig): Promise<{ sessionId: string }> {
  await sleep(150)
  const sessionId = randomUUID()
  sessions.set(sessionId, { config: cfg })
  return { sessionId }
}

export function disconnect(sessionId: string): void {
  sessions.delete(sessionId)
}

export async function exec(args: { sessionId: string; cmd: string }): Promise<ExecResult> {
  await sleep(80)
  // Cover the small one-shot calls that the renderer makes (mkdir -p,
  // env-detect probes that we route through env-detector instead).
  if (args.cmd.startsWith('mkdir -p')) {
    return { exitCode: 0, signal: null, stdout: '', stderr: '' }
  }
  return { exitCode: 0, signal: null, stdout: '[mock] ok\n', stderr: '' }
}

/** Pre-recorded transcript of setup.sh, complete with the step markers
 *  the renderer's StepperRail parses. Tuned for ~6s total run. */
const SETUP_TRANSCRIPT: { delayMs: number; line: string }[] = [
  { delayMs: 0,   line: '' },
  { delayMs: 0,   line: '=============================================' },
  { delayMs: 0,   line: '  Media Stack Setup' },
  { delayMs: 0,   line: '=============================================' },
  { delayMs: 100, line: '  Using: docker compose' },
  { delayMs: 0,   line: "  This script runs the full first-time install." },
  // Step 1
  { delayMs: 200, line: '' },
  { delayMs: 0,   line: '┌─────────────────────────────────────────────' },
  { delayMs: 0,   line: '│ Step 1: Set file permissions' },
  { delayMs: 0,   line: '└─────────────────────────────────────────────' },
  { delayMs: 250, line: 'Setting permissions on stack directory...' },
  { delayMs: 50,  line: '  [32m✔[0m /volume1/docker/media' },
  { delayMs: 250, line: '' },
  { delayMs: 0,   line: '  [32m✔ Step 1 complete.[0m' },
  // Step 2
  { delayMs: 200, line: '' },
  { delayMs: 0,   line: '┌─────────────────────────────────────────────' },
  { delayMs: 0,   line: '│ Step 2: Create data and config directories' },
  { delayMs: 0,   line: '└─────────────────────────────────────────────' },
  { delayMs: 200, line: 'Using PUID=1026 PGID=100' },
  { delayMs: 100, line: 'Creating config directories...' },
  { delayMs: 100, line: '  Created: /volume1/docker/media/plex/config' },
  { delayMs: 50,  line: '  Created: /volume1/docker/media/sonarr/config' },
  { delayMs: 50,  line: '  Created: /volume1/docker/media/radarr/config' },
  { delayMs: 100, line: 'Creating data directories...' },
  { delayMs: 50,  line: '  Created: /volume1/Data/Media/Movies' },
  { delayMs: 200, line: '  [32m✔ Step 2 complete.[0m' },
  // Step 3
  { delayMs: 200, line: '' },
  { delayMs: 0,   line: '┌─────────────────────────────────────────────' },
  { delayMs: 0,   line: '│ Step 3: Apply firewall rules' },
  { delayMs: 0,   line: '└─────────────────────────────────────────────' },
  { delayMs: 200, line: 'Applying media stack firewall rules...' },
  { delayMs: 100, line: '  [32m✔ Firewall rules applied.[0m' },
  { delayMs: 200, line: '  [32m✔ Step 3 complete.[0m' },
  // Step 4
  { delayMs: 200, line: '' },
  { delayMs: 0,   line: '┌─────────────────────────────────────────────' },
  { delayMs: 0,   line: '│ Step 4: Fetch NordVPN WireGuard key' },
  { delayMs: 0,   line: '└─────────────────────────────────────────────' },
  { delayMs: 250, line: '  [33m⚠[0m PRIVATE_KEY already set in .env, skipping fetch' },
  { delayMs: 200, line: '  [32m✔ Step 4 complete.[0m' },
  // Step 5
  { delayMs: 200, line: '' },
  { delayMs: 0,   line: '┌─────────────────────────────────────────────' },
  { delayMs: 0,   line: '│ Step 5: Validate configuration' },
  { delayMs: 0,   line: '└─────────────────────────────────────────────' },
  { delayMs: 250, line: '  [32m✔[0m All checks passed' },
  { delayMs: 200, line: '  [32m✔ Step 5 complete.[0m' },
  // Step 6
  { delayMs: 250, line: '' },
  { delayMs: 0,   line: '┌─────────────────────────────────────────────' },
  { delayMs: 0,   line: '│ Step 6: Start the stack' },
  { delayMs: 0,   line: '└─────────────────────────────────────────────' },
  { delayMs: 200, line: '[+] Pulling 14/14' },
  { delayMs: 100, line: ' ✔ plex          Image is up to date' },
  { delayMs: 100, line: ' ✔ sonarr        Image is up to date' },
  { delayMs: 100, line: ' ✔ radarr        Image is up to date' },
  { delayMs: 100, line: ' ✔ prowlarr      Image is up to date' },
  { delayMs: 200, line: '[+] Running 14/14' },
  { delayMs: 100, line: ' ✔ Container plex          Running' },
  { delayMs: 50,  line: ' ✔ Container gluetun       Healthy' },
  { delayMs: 50,  line: ' ✔ Container qbittorrent   Running' },
  { delayMs: 200, line: '  [32m✔ Step 6 complete.[0m' },
  // Step 7
  { delayMs: 250, line: '' },
  { delayMs: 0,   line: '┌─────────────────────────────────────────────' },
  { delayMs: 0,   line: '│ Step 7: Configure all services' },
  { delayMs: 0,   line: '└─────────────────────────────────────────────' },
  { delayMs: 200, line: 'Configuring Sonarr...' },
  { delayMs: 100, line: '  [32m✔[0m Sonarr root folder set' },
  { delayMs: 100, line: 'Configuring Radarr...' },
  { delayMs: 100, line: '  [32m✔[0m Radarr root folder set' },
  { delayMs: 200, line: '  [32m✔ Step 7 complete.[0m' },
  // Step 8
  { delayMs: 200, line: '' },
  { delayMs: 0,   line: '┌─────────────────────────────────────────────' },
  { delayMs: 0,   line: '│ Step 8: Add Prowlarr indexers' },
  { delayMs: 0,   line: '└─────────────────────────────────────────────' },
  { delayMs: 200, line: '  [32m✔[0m 1337x added' },
  { delayMs: 100, line: '  [32m✔[0m YTS added' },
  { delayMs: 100, line: '  [32m✔[0m Nyaa added' },
  { delayMs: 200, line: '  [32m✔ Step 8 complete.[0m' },
  // Step 9
  { delayMs: 200, line: '' },
  { delayMs: 0,   line: '┌─────────────────────────────────────────────' },
  { delayMs: 0,   line: '│ Step 9: Enable Bazarr subtitle providers' },
  { delayMs: 0,   line: '└─────────────────────────────────────────────' },
  { delayMs: 200, line: '  [32m✔[0m YIFY enabled' },
  { delayMs: 100, line: '  [32m✔[0m Podnapisi enabled' },
  { delayMs: 200, line: '  [32m✔ Step 9 complete.[0m' },
  // Step 10
  { delayMs: 200, line: '' },
  { delayMs: 0,   line: '┌─────────────────────────────────────────────' },
  { delayMs: 0,   line: '│ Step 10: Verify stack health' },
  { delayMs: 0,   line: '└─────────────────────────────────────────────' },
  { delayMs: 250, line: '  [32m✔[0m All containers healthy' },
  { delayMs: 200, line: '  [32m✔ Step 10 complete.[0m' },
  // Summary
  { delayMs: 250, line: '' },
  { delayMs: 0,   line: '=============================================' },
  { delayMs: 0,   line: '  Results: 10 passed, 0 failed' },
  { delayMs: 0,   line: '=============================================' },
  { delayMs: 100, line: '  [32m✔ Setup complete![0m' },
]

const VALIDATE_TRANSCRIPT: { delayMs: number; line: string }[] = [
  { delayMs: 0,   line: '=============================================' },
  { delayMs: 0,   line: '  Post-Deploy Validation' },
  { delayMs: 0,   line: '=============================================' },
  { delayMs: 100, line: '── Containers ──────────────────────────────────' },
  { delayMs: 50,  line: '  [32m✔[0m plex is running' },
  { delayMs: 50,  line: '  [32m✔[0m sonarr is running' },
  { delayMs: 50,  line: '  [32m✔[0m radarr is running' },
  { delayMs: 100, line: '── Dashboard Pages ─────────────────────────────' },
  { delayMs: 80,  line: '  [32m✔[0m Homepage (http://192.168.1.10:3000) — HTTP 200' },
  { delayMs: 80,  line: '  [32m✔[0m Plex (http://192.168.1.10:32400/web) — HTTP 200' },
  { delayMs: 80,  line: '  [32m✔[0m Sonarr (http://192.168.1.10:49152) — HTTP 200' },
  { delayMs: 80,  line: '  [32m✔[0m Radarr (http://192.168.1.10:49151) — HTTP 200' },
  { delayMs: 80,  line: '  [32m✔[0m Prowlarr (http://192.168.1.10:49150) — HTTP 200' },
  { delayMs: 80,  line: '  [32m✔[0m Bazarr (http://192.168.1.10:49153) — HTTP 200' },
  { delayMs: 80,  line: '  [32m✔[0m Lidarr (http://192.168.1.10:49154) — HTTP 200' },
  { delayMs: 80,  line: '  [32m✔[0m SABnzbd (http://192.168.1.10:49155) — HTTP 200' },
  { delayMs: 80,  line: '  [32m✔[0m qBittorrent (http://192.168.1.10:49156) — HTTP 401' },
  { delayMs: 80,  line: '  [31m✘[0m Seerr (http://192.168.1.10:5056) — HTTP 000 (not reachable)' },
  { delayMs: 80,  line: '  [32m✔[0m Tautulli (http://192.168.1.10:8181) — HTTP 200' },
  { delayMs: 80,  line: '  [32m✔[0m Flaresolverr (http://192.168.1.10:8191) — HTTP 200' },
  { delayMs: 200, line: '' },
  { delayMs: 0,   line: '=============================================' },
  { delayMs: 0,   line: '  Results: 14 passed, 0 warnings, 1 failed' },
  { delayMs: 0,   line: '=============================================' },
]

const UPDATE_TRANSCRIPT: { delayMs: number; line: string }[] = [
  { delayMs: 0,   line: '[+] Pulling 14/14' },
  { delayMs: 200, line: ' ✔ plex          Image is up to date' },
  { delayMs: 100, line: ' ✔ sonarr        Pulled 0.4s' },
  { delayMs: 200, line: ' ✔ radarr        Pulled 0.6s' },
  { delayMs: 200, line: ' ✔ prowlarr      Image is up to date' },
  { delayMs: 200, line: ' ✔ bazarr        Pulled 0.5s' },
  { delayMs: 200, line: '[+] Running 14/14' },
  { delayMs: 100, line: ' ✔ Container sonarr        Started' },
  { delayMs: 50,  line: ' ✔ Container radarr        Started' },
  { delayMs: 50,  line: ' ✔ Container bazarr        Started' },
  { delayMs: 200, line: 'Stack updated.' },
]

async function streamTranscript(channelId: string, transcript: { delayMs: number; line: string }[]) {
  for (const { delayMs, line } of transcript) {
    if (delayMs > 0) await sleep(delayMs)
    send<SshStreamData>(IPC.evtStreamData, {
      channelId, type: 'stdout', chunk: line + '\n',
    })
  }
  send<SshStreamClose>(IPC.evtStreamClose, {
    channelId, exitCode: 0, signal: null,
  })
}

export async function execStream(args: {
  sessionId: string
  cmd: string
  channelId: string
}): Promise<void> {
  // Pick the transcript based on what the renderer asked us to run.
  const cmd = args.cmd
  let transcript = SETUP_TRANSCRIPT
  if (cmd.includes('post-deploy-validate')) transcript = VALIDATE_TRANSCRIPT
  else if (cmd.includes('compose pull') || cmd.includes('docker compose pull')) transcript = UPDATE_TRANSCRIPT

  // Fire-and-forget — stream the transcript in the background so the
  // IPC promise resolves immediately (matches real ssh-service contract).
  streamTranscript(args.channelId, transcript).catch((e) => {
    send<SshStreamData>(IPC.evtStreamData, {
      channelId: args.channelId, type: 'stderr',
      chunk: `[mock] transcript failed: ${(e as Error).message}\n`,
    })
    send<SshStreamClose>(IPC.evtStreamClose, {
      channelId: args.channelId, exitCode: 1, signal: null,
    })
  })
}

export function streamCancel(_channelId: string): void {
  // No-op for v1 mock. Could be wired to abort the in-flight transcript.
}

// ── SFTP ──────────────────────────────────────────────────────────────────────

const FAKE_FILES = [
  'docker-compose.yml', 'setup.sh', 'setup-folders.sh', 'setup-firewall.sh',
  'setup-nordvpn.sh', 'setup-validate.sh', 'setup-arr-config.py',
  'post-deploy-validate.sh', 'indexers/setup-indexers.py',
  'indexers/setup-bazarr-providers.py',
]

export async function uploadDir(args: {
  sessionId: string
  localDir: string
  remoteDir: string
}): Promise<SftpUploadResult> {
  // Simulate a small upload with realistic progress events.
  const totalBytes = FAKE_FILES.length * 4096
  let bytesDone = 0
  for (const f of FAKE_FILES) {
    await sleep(60)
    bytesDone += 4096
    send<SftpProgress>(IPC.evtSftpProgress, {
      file: f,
      bytesDone,
      bytesTotal: totalBytes,
      pctOverall: Math.round((bytesDone / totalBytes) * 100),
    })
  }
  return { uploaded: FAKE_FILES.length, bytesTotal: totalBytes }
}

export async function writeFile(_args: {
  sessionId: string
  remotePath: string
  content: string
}): Promise<void> {
  await sleep(50)
  // Pretend we wrote .env successfully.
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function detectEnv(_sessionId: string): Promise<EnvDetectResult> {
  await sleep(400)
  return {
    docker: 'v2',
    volume1: true,
    puid: 1026,
    pgid: 100,
    username: 'root',
    groupname: 'root',
    tz: 'America/New_York',
    lanIps: ['192.168.1.10', '192.168.1.42'],
    python3: 'Python 3.11.4',
    iptables: 'iptables v1.8.9',
    sudoMode: 'root',
  }
}

export async function fetchVpnKey(token: string): Promise<VpnFetchResult> {
  await sleep(300)
  if (token.length < 16) {
    throw new Error('[mock] token must be at least 16 characters')
  }
  return {
    privateKey: 'mockmockmockmockmockmockmockmockmockmockmoc=',
    countries: [
      { id: 21, name: 'Canada', code: 'CA' },
      { id: 64, name: 'Germany', code: 'DE' },
      { id: 41, name: 'Japan', code: 'JP' },
      { id: 113, name: 'Netherlands', code: 'NL' },
      { id: 220, name: 'United States', code: 'US' },
    ],
  }
}

export function shutdown() {
  sessions.clear()
}
