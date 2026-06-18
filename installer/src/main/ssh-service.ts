// ── SSH service ───────────────────────────────────────────────────────────────
// Owns the ssh2 Client lifecycle for one or more "sessions" identified by
// a sessionId. Each session also lazily owns one SFTP subsystem.
//
// Streaming exec is what makes the wizard usable on long-running setup
// scripts — we forward stdout/stderr to the renderer line-by-line via
// IPC events.

import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  IPC,
  type ConnectionConfig,
  type ConnectResult,
  type ExecResult,
  type SshStreamData,
  type SshStreamClose,
} from '../shared/ipc.js'
import { appendInstallLog } from './install-log.js'

interface Session {
  client: Client
  config: ConnectionConfig
  /** lazily created on first sftp call */
  sftp: SFTPWrapper | null
  /** Set by env-detector once it learns the login is uid 0 even though
   *  the account isn't named 'root' (QNAP `admin`, TerraMaster superadmin,
   *  …). When true, wrapSudo skips the `sudo` prefix and exec stops
   *  demanding a sudo password — those boxes have no sudo. */
  effectiveRoot?: boolean
  /** Set by env-detector when the (non-root) login can drive the Docker
   *  daemon WITHOUT sudo (it's in the `docker` group / has socket access —
   *  the unprivileged `docker info` probe returned a server version). This
   *  is a valid install posture: rather than demand a sudo password we
   *  never got, run the steps unprivileged. Docker/compose work; the few
   *  genuinely-root steps (Synology firewall, chown-to-PUID, tun insmod)
   *  degrade with a warning. */
  dockerGroup?: boolean
  /** Which privilege-escalation backend the host has. `sudo` everywhere
   *  except minimalist/BSD-derived firmware (Alpine, some routers) that
   *  ship `doas` instead. Set by env-detector; defaults to sudo. */
  escalation?: 'sudo' | 'doas'
  /** True when the escalation backend runs WITHOUT a password (a NOPASSWD
   *  sudoers rule or a `nopass` doas rule). Lets us wrap with `sudo -n` /
   *  `doas -n` and pipe nothing. */
  escalationNopass?: boolean
  /** Set once we've emitted the "running unprivileged via docker-group"
   *  warning, so the degradation notice appears one time per session
   *  instead of before every privileged step. */
  dockerGroupWarned?: boolean
}

const sessions = new Map<string, Session>()
const activeChannels = new Map<string, ClientChannel>()
let mainWindow: BrowserWindow | null = null

// SSH handshake budget handed to ssh2 as readyTimeout (see buildConnectConfig
// for the full rationale). Shared so connectClient can derive its independent
// wall-clock backstop strictly above it instead of pre-empting it.
const READY_TIMEOUT_MS = 30_000

export function bindMainWindow(win: BrowserWindow) {
  mainWindow = win
}

function send<T>(channel: string, payload: T) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

function buildConnectConfig(cfg: ConnectionConfig): ConnectConfig {
  const base: ConnectConfig = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.user,
    // 30s SSH handshake budget. DSM 7's sshd is fast on a healthy NAS
    // (~1s) but the first connection of a session occasionally takes
    // longer when DSM's auth backend is paging in user data or the NAS
    // is busy with another DSM process (Snapshot Replication, Hyper
    // Backup, etc). 15s was tight; 30s covers every real-world case
    // without making the user wait too long on a truly unreachable host.
    readyTimeout: READY_TIMEOUT_MS,
    // Keepalive: ping every 30s, allow 6 missed before disconnect.
    // Default is 3 missed = 90s tolerance, which fires during long-
    // running setup.sh on flaky WiFi. 6 × 30s = 3min tolerance covers
    // most home network blips without leaving the connection wedged
    // forever on a genuinely-disconnected host.
    keepaliveInterval: 30_000,
    keepaliveCountMax: 6,
  }
  if (cfg.authMethod === 'password') {
    base.password = cfg.password
    // ssh2 may also try keyboard-interactive — we wire that below.
    base.tryKeyboard = true
  } else {
    if (!cfg.privateKeyPath) throw new Error('privateKeyPath is required when authMethod === "privateKey"')
    base.privateKey = readFileSync(cfg.privateKeyPath)
    if (cfg.passphrase) base.passphrase = cfg.passphrase
  }
  return base
}

function classifyError(err: Error): ConnectResult['error'] {
  const m = err.message?.toLowerCase() ?? ''
  if (m.includes('authentication') || m.includes('all configured authentication methods failed')) {
    return {
      kind: 'auth-failed',
      message:
        `${err.message}\n\n` +
        `Common causes on Synology DSM7:\n` +
        `  • Logging in as 'root'? DSM7 disables root SSH by default.\n` +
        `    Fix: DSM → Control Panel → User & Group → User → root → Edit\n` +
        `         → set a password AND check "User cannot change password" if greyed out.\n` +
        `    OR: use your admin-group user instead of root, and the wizard\n` +
        `        will collect a sudo password on the next field.\n` +
        `  • Password is case-sensitive — verify caps lock and exact spelling.\n` +
        `  • If you set up SSH with key-only auth (PasswordAuthentication no),\n` +
        `    switch to "Private key" auth above and point at your key file.`,
    }
  }
  if (m.includes('etimedout') || m.includes('timeout')) {
    return { kind: 'timeout', message: err.message }
  }
  if (m.includes('econnrefused') || m.includes('ehostunreach') || m.includes('enotfound')) {
    return { kind: 'host-unreachable', message: err.message }
  }
  // ssh2 throws messages like "Protocol mismatch", "Bad protocol version
  // identification", or "Bad packet length" when the remote port responds
  // with something other than the SSH banner — typically because the user
  // pointed us at their DSM web UI (port 5000/5001) instead of SSH (22).
  if (m.includes('protocol') || m.includes('bad packet length') || m.includes('http')) {
    return {
      kind: 'unknown',
      message:
        'Got a non-SSH response from the host. Likely wrong port — SSH is ' +
        'usually 22, but you may have pointed at your DSM web UI (5000/5001). ' +
        '\n\nOriginal error: ' + err.message,
    }
  }
  return { kind: 'unknown', message: err.message }
}

function connectClient(cfg: ConnectionConfig): Promise<{ client: Client; banner?: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let banner: string | undefined
    let settled = false

    // Hard wall-clock timeout. ssh2's readyTimeout is a 30s handshake budget
    // that starts when client.connect() is called and fires its own
    // "Timed out while waiting for handshake" on a host that accepts the TCP
    // connection but stalls the SSH negotiation (busy DSM, auth backend
    // paging). It does NOT cover an OS-level connect hang where the SYN goes
    // into a black hole (NAT/router silently dropping packets, wrong host) —
    // that can outlive readyTimeout. So we keep an independent backstop, but
    // make it STRICTLY LONGER than readyTimeout (40s = 30s + 10s) so it never
    // pre-empts the more specific handshake timeout on a slow-but-healthy NAS
    // that connects at ~22-28s; it only catches the connect-hang case.
    const HARD_TIMEOUT_MS = READY_TIMEOUT_MS + 10_000
    const hardTimer = setTimeout(() => {
      if (settled) return
      settled = true
      try { client.end() } catch { /* ignore */ }
      reject(new Error(
        `Connection timed out after ${HARD_TIMEOUT_MS / 1000}s. ` +
        `Verify the host is reachable and SSH is enabled (DSM ` +
        `Control Panel → Terminal & SNMP → Enable SSH service).`,
      ))
    }, HARD_TIMEOUT_MS)

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      fn()
    }

    client.on('banner', (msg) => { banner = msg })
    client.on('ready', () => settle(() => resolve({ client, banner })))
    client.on('error', (err) => settle(() => reject(err)))

    // Some Synology configurations require keyboard-interactive even
    // when a password is supplied — answer all prompts with the password.
    if (cfg.authMethod === 'password') {
      client.on('keyboard-interactive', (_n, _i, _l, _prompts, finish) => {
        finish([cfg.password ?? ''])
      })
    }

    try {
      client.connect(buildConnectConfig(cfg))
    } catch (err) {
      settle(() => reject(err))
    }
  })
}

// ── public API: invoked by ipc-handlers ───────────────────────────────────────

export async function testConnect(cfg: ConnectionConfig): Promise<ConnectResult> {
  let client: Client | null = null
  try {
    const result = await connectClient(cfg)
    client = result.client

    // Probe the shell with a few cheap commands. We accept ANY of them
    // succeeding as proof that the SSH user has a working session.
    // Different DSM configurations / chroots / restricted shells make
    // a single canonical probe unreliable, so we fan out:
    //   - `echo ok`           — works on bash/sh/busybox
    //   - `/bin/echo ok`      — works even if `echo` is shadowed
    //   - `printf ok`         — POSIX builtin
    //   - `:`                 — null command, always exits 0
    const probes = ['echo ok', '/bin/echo ok', 'printf ok', ':']
    let lastResult: ExecResult | null = null
    let success = false
    for (const cmd of probes) {
      const p = execOnce(client, cmd)
      const r = await Promise.race([
        p,
        new Promise<ExecResult>((_, rej) =>
          setTimeout(() => rej(new Error(`probe "${cmd}" timed out after 5s`)), 5_000),
        ),
      ]).catch((e) => ({ exitCode: -1, signal: null, stdout: '', stderr: String((e as Error).message) }))
      lastResult = r
      // exitCode === 0 OR stdout containing 'ok' both count.
      if (r.exitCode === 0 || r.stdout.toLowerCase().includes('ok')) {
        success = true
        break
      }
    }

    if (!success) {
      const r = lastResult ?? { exitCode: null, signal: null, stdout: '', stderr: '' }
      const stdoutPrev = r.stdout.slice(0, 200).replace(/\s+/g, ' ').trim() || '<empty>'
      const stderrPrev = r.stderr.slice(0, 200).replace(/\s+/g, ' ').trim() || '<empty>'
      return {
        ok: false,
        error: {
          kind: 'unknown',
          message:
            `Connected but the SSH user can't run shell commands.\n\n` +
            `Last probe exitCode=${r.exitCode} signal=${r.signal}\n` +
            `stdout: ${stdoutPrev}\n` +
            `stderr: ${stderrPrev}\n\n` +
            `Common causes:\n` +
            `  • The user's shell is /sbin/nologin or /usr/bin/false (DSM ` +
            `default for "admin" — log in as root or change the shell).\n` +
            `  • The user's home directory perms block login (chmod 700 ~).\n` +
            `  • The session is restricted by an AllowUsers/Match rule in sshd_config.`,
        },
      }
    }

    return { ok: true, banner: result.banner }
  } catch (err) {
    return { ok: false, error: classifyError(err as Error) }
  } finally {
    if (client) try { client.end() } catch { /* ignore */ }
  }
}

export async function connect(cfg: ConnectionConfig): Promise<{ sessionId: string }> {
  const { client } = await connectClient(cfg)
  const sessionId = randomUUID()
  sessions.set(sessionId, { client, config: cfg, sftp: null })
  client.on('end', () => sessions.delete(sessionId))
  client.on('close', () => sessions.delete(sessionId))
  // CRITICAL: a persistent session that loses its socket mid-install (WiFi
  // blip, NAS sleep) emits 'error' on the ssh2 Client. ssh2's Client is an
  // EventEmitter, so an unhandled 'error' throws and crashes the Electron
  // main process (surfacing as a native "Startup error" dialog). Handle it:
  // drop the dead session so subsequent ops fail cleanly with "no session"
  // instead of taking the whole app down. Any in-flight execStream gets its
  // own stream 'error' + watchdog (below) to unstick the UI.
  client.on('error', (err: Error) => {
    appendInstallLog(`\n[ssh] session ${sessionId} error: ${err?.message ?? String(err)}\n`)
    sessions.delete(sessionId)
  })
  return { sessionId }
}

export function disconnect(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  // Guard each teardown step independently. WHY: a throwing sftp.end() used to
  // skip client.end() AND the map delete — leaking the SSH Client (a real
  // channel/socket on the NAS) and orphaning the session entry. Each step must
  // run even if an earlier one throws, so the client always gets torn down and
  // the session is always forgotten.
  if (s.sftp) try { s.sftp.end() } catch { /* ignore */ }
  try { s.client.end() } catch { /* ignore */ }
  sessions.delete(sessionId)
}

/** Mark a session as effectively-root (uid 0 under a non-'root' name).
 *  Called by env-detector after it reads `id -u`. Safe no-op for unknown
 *  sessions. */
export function setSessionEffectiveRoot(sessionId: string, value: boolean): void {
  const sess = sessions.get(sessionId)
  if (sess) sess.effectiveRoot = value
}

/** Mark a (non-root) session as able to drive Docker without sudo. Called
 *  by env-detector. Safe no-op for unknown sessions. */
export function setSessionDockerGroup(sessionId: string, value: boolean): void {
  const sess = sessions.get(sessionId)
  if (sess) sess.dockerGroup = value
}

/** Record which escalation backend the host has (sudo vs doas) and whether
 *  it runs passwordless. Set by env-detector. Safe no-op for unknown ids. */
export function setSessionEscalation(
  sessionId: string,
  backend: 'sudo' | 'doas',
  nopass: boolean,
): void {
  const sess = sessions.get(sessionId)
  if (sess) {
    sess.escalation = backend
    sess.escalationNopass = nopass
  }
}

/** True when no escalation is needed: the SSH user is named root, OR the
 *  login is uid 0 under another name (QNAP admin etc.). */
function sessionIsRoot(sess: Session): boolean {
  return sess.config.user === 'root' || sess.effectiveRoot === true
}

/** How a `sudo: true` command should be privileged:
 *    'none'        — run unwrapped (already root, or a docker-group user
 *                    with no escalation — best we can do; docker works).
 *    'wrap-nopass' — wrap with `sudo -n` / `doas -n`; no password to pipe.
 *    'password'    — wrap with `sudo -S` and pipe the user's sudo password.
 *    'fail'        — no escalation path; exec()/execStream throw clearly.
 *
 *  Order matters: a provided password beats a NOPASS rule (works even when
 *  the rule is command-scoped), and real escalation beats docker-group
 *  (which can't do host-root steps like chown-to-PUID or tun insmod). */
function privMode(sess: Session): 'none' | 'wrap-nopass' | 'password' | 'fail' {
  if (sessionIsRoot(sess)) return 'none'
  if (sess.config.sudoPassword) return 'password'
  if (sess.escalationNopass) return 'wrap-nopass'
  if (sess.dockerGroup) return 'none'
  return 'fail'
}

/** Escalation command prefix for a wrapping mode, honouring the backend. */
function escPrefix(sess: Session, mode: 'wrap-nopass' | 'password'): string {
  const backend = sess.escalation ?? 'sudo'
  if (mode === 'wrap-nopass') return `${backend} -n`
  // 'password': sudo reads the password from stdin via -S (-p '' blanks the
  // prompt so it doesn't echo into the log). doas has no stdin-password
  // flag — it prompts on the tty, which the PTY in execStream answers; in
  // the non-PTY exec() path doas+password can't work, but doas is paired
  // with a nopass rule in practice, so that path is effectively unused.
  return backend === 'doas' ? 'doas' : `sudo -S -p ''`
}

function wrapSudo(sessionId: string, cmd: string, sudo: boolean): string {
  if (!sudo) return cmd
  const sess = sessions.get(sessionId)
  if (!sess) return cmd
  const mode = privMode(sess)
  // 'none' runs as-is; 'fail' also returns as-is but the caller throws first.
  if (mode !== 'wrap-nopass' && mode !== 'password') return cmd
  const escaped = cmd.replace(/'/g, `'\\''`)
  return `${escPrefix(sess, mode)} bash -c '${escaped}'`
}

/** True when a `sudo: true` command will run UNPRIVILEGED via the
 *  docker-group fallback (privMode 'none', but the session isn't actually
 *  root). Used to surface a one-time degradation warning. */
function isDockerGroupFallback(sess: Session, sudo: boolean): boolean {
  return !!sudo && !sessionIsRoot(sess) && privMode(sess) === 'none'
}

/** Emit (once per session) a clear notice that privileged steps are running
 *  unprivileged because the login only has docker-group access. Mirrors to
 *  the on-disk install log and, when a stream channel is supplied, the live
 *  UI log — so the "degrade with a warning" contract is honoured instead of
 *  silently running root-only steps without privilege. */
function noteDockerGroupDegradation(sess: Session, channelId?: string): void {
  if (sess.dockerGroupWarned) return
  sess.dockerGroupWarned = true
  const msg =
    '\n[mediarr] No root or sudo available — running privileged steps via the ' +
    'docker group (unprivileged). Docker and Compose work normally, but a few ' +
    'host-level operations that genuinely need root (chown to a different UID, ' +
    'firewall rules, kernel modules such as tun for the VPN) may be skipped or ' +
    'fail. This is expected on docker-group-only logins.\n'
  appendInstallLog(msg)
  if (channelId) {
    send<SshStreamData>(IPC.evtStreamData, { channelId, type: 'stderr', chunk: msg })
  }
}

/** One-shot exec; buffers stdout/stderr. For UI streaming use execStream. */
function execOnce(
  client: Client,
  cmd: string,
  opts?: { stdinPassword?: string; stdinBytes?: Buffer; timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    // Held so the timeout handler can tear down the channel. WHY: a bare
    // reject here used to ORPHAN the ClientChannel — a wedged remote command
    // (stuck `sudo -S`, hung chown) kept its channel open on the server. On
    // DSM (MaxSessions=10) a few orphans exhaust the channel budget and break
    // later exec/SFTP. Mirror execStream's watchdog: TERM → close before we
    // reject so the remote process dies and the channel is freed.
    let activeStream: ClientChannel | null = null
    const timeoutMs = opts?.timeoutMs ?? 60_000
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // Signal the remote process to die; fall back to closing the channel
      // if the server rejects signals (some SSH servers don't support them).
      if (activeStream) {
        try { activeStream.signal('TERM') } catch { /* server may not support signals */ }
        try { activeStream.close() } catch { /* already closing */ }
      }
      reject(new Error(
        `Remote command timed out after ${timeoutMs / 1000}s.\n` +
        `Command: ${cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd}\n` +
        `Most common causes:\n` +
        `  • The command is genuinely slow on this NAS (e.g. recursive ` +
        `chown over a large Plex config dir — bump the caller's timeoutMs).\n` +
        `  • Wrong sudo password (or no password supplied for a non-root SSH user).\n` +
        `  • Docker daemon is wedged (try: docker ps).`,
      ))
    }, timeoutMs)
    const finish = (val: ExecResult | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (val instanceof Error) reject(val)
      else resolve(val)
    }

    // No PTY: `sudo -S` is happy reading from a plain stdin pipe.
    // (pty:true would echo the password into stdout, which we'd then
    // have to filter out. Without a pty we just write the password,
    // sudo consumes it from fd 0, and stdout stays clean.)
    client.exec(cmd, (err, stream) => {
      if (err) return finish(err)
      // Expose the channel to the timeout handler so a wedged command can be
      // TERM'd/closed instead of leaking. If the timer already fired during
      // the (async) exec callback, tear this freshly-opened channel down too.
      if (settled) {
        try { stream.signal('TERM') } catch { /* server may not support signals */ }
        try { stream.close() } catch { /* already closing */ }
        return
      }
      activeStream = stream
      let stdout = ''
      let stderr = ''
      stream.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      stream.on('error', (e: Error) => finish(e))
      stream.on('close', (code: number, signal: string) =>
        // Strip benign sudo-chdir noise from stderr before returning —
        // it appears on every command run as a non-root user when
        // Synology's User Home Service is disabled, and the wizard
        // doesn't actually need a home directory. The opts password
        // never echoes here (no PTY) but pass it through the same
        // redaction helper so we have one place to maintain.
        finish({
          exitCode: code,
          signal: signal ?? null,
          stdout: redactStreamChunk(stdout, opts?.stdinPassword ? [opts.stdinPassword] : []),
          stderr: redactStreamChunk(stderr, opts?.stdinPassword ? [opts.stdinPassword] : []),
        }),
      )

      // Pipe sudo password if the caller supplied one. Without this,
      // `sudo -S` hangs waiting for stdin we never write — that's the
      // bug that made `mkdir -p /volume1/docker/media` silently fail
      // and leave the directory missing for the SFTP step.
      // The ssh2 ClientChannel IS the stdin pipe (Duplex), so writing
      // to it sends to the remote process's stdin. End the writable
      // side after so sudo doesn't keep waiting for more input.
      if (opts?.stdinPassword !== undefined) {
        stream.write(opts.stdinPassword + '\n')
        stream.end()
      } else if (opts?.stdinBytes !== undefined) {
        // Raw-bytes path for the SFTP-disabled upload fallback —
        // piping the file body via stdin to a remote `cat > file`
        // avoids the ARG_MAX trap that the previous "base64 in argv"
        // approach hit on big files (Synology DSM's busybox /bin/sh
        // refuses argvs >~80KB with "Argument list too long"). Honor
        // backpressure with a drain handler so a 1MB+ payload doesn't
        // OOM the local Node side or starve the SSH channel.
        const buf = opts.stdinBytes
        if (!stream.write(buf)) {
          stream.once('drain', () => stream.end())
        } else {
          stream.end()
        }
      } else {
        // Nothing to pipe (wrap-nopass / docker-group / plain commands).
        // Close the writable half so the remote process sees EOF on stdin
        // instead of us leaving it half-open until 'close'.
        stream.end()
      }
    })
  })
}

export async function exec(args: {
  sessionId: string
  cmd: string
  sudo?: boolean
  /** Raw bytes to write to the remote process's stdin. Mutually exclusive
   *  with sudo:true on non-root sessions (sudo -S would gobble the bytes
   *  thinking they're the password). Used by the SFTP fallback uploader
   *  to pipe file contents into `cat > remote` instead of cramming them
   *  through argv. */
  stdinBytes?: Buffer
  /** Override the default 60s exec timeout. Callers can supply this
   *  for commands that legitimately take longer than 60s on slow NAS
   *  hardware — typically recursive chown/chmod on huge config trees
   *  (Plex metadata can be hundreds of thousands of files). */
  timeoutMs?: number
}): Promise<ExecResult> {
  const sess = sessions.get(args.sessionId)
  if (!sess) throw new Error(`unknown sessionId ${args.sessionId}`)
  const wrapped = wrapSudo(args.sessionId, args.cmd, !!args.sudo)
  const mode = privMode(sess)
  // No escalation path at all → fail fast with a clear, actionable message
  // instead of silently running unprivileged and corrupting state.
  if (args.sudo && mode === 'fail') {
    throw new Error(
      `This step needs root (user=${sess.config.user}), but there's no way ` +
      `to escalate: not root, no "Sudo password" provided on Connect, and the ` +
      `account can't reach Docker without sudo. Log in as root, fill in the ` +
      `Sudo password field, or add your user to the "docker" group.`,
    )
  }
  // doas can't accept a password on stdin (no -S equivalent) and this is the
  // NON-PTY path, so a doas password prompt here would hang forever waiting
  // on a tty. Fail fast with a fix instead. (The PTY execStream path can
  // answer the prompt, so this guard is exec()-only.)
  if (args.sudo && mode === 'password' && (sess.escalation ?? 'sudo') === 'doas') {
    throw new Error(
      `This host uses doas, which can't take a password non-interactively. ` +
      `Add a passwordless rule for your user to /etc/doas.conf (e.g. ` +
      `"permit nopass <user>"), or log in as root.`,
    )
  }
  // Surface (once) that we're running root-only steps unprivileged because
  // the login only has docker-group access.
  if (isDockerGroupFallback(sess, !!args.sudo)) noteDockerGroupDegradation(sess)
  // 'password' mode: sudo -S reads the password from stdin. If the user has
  // NOPASSWD for this command, the empty line is accepted; either way we
  // don't hang.
  const needsSudoPassword = !!args.sudo && mode === 'password'
  if (args.stdinBytes !== undefined && needsSudoPassword) {
    throw new Error(
      'exec: stdinBytes + sudo on a non-root session conflict — sudo -S ' +
      'reads its password from the same stdin we want to feed the payload to.',
    )
  }
  return execOnce(sess.client, wrapped, {
    stdinPassword: needsSudoPassword ? (sess.config.sudoPassword ?? '') : undefined,
    stdinBytes: args.stdinBytes,
    timeoutMs: args.timeoutMs,
  })
}

/** Fixed-width replacement token for any redacted secret. Constant width so
 *  the log never reveals how long the password was. */
const REDACTED_MASK = '••••••'

/** Redact sensitive content (the user's sudo password) from a stream
 *  chunk before it's forwarded to the renderer's log panel or the
 *  on-disk install log. We allocate a PTY for streaming commands so
 *  child processes use line-buffered output; the cost is that the
 *  PTY's line discipline ECHOES anything we write to stdin — including
 *  the sudo password. Without this filter that echo lands verbatim in
 *  both the UI log AND the per-run log file on the user's machine. */
function redactStreamChunk(chunk: string, secrets: string[]): string {
  let out = chunk
  for (const s of secrets) {
    if (!s) continue
    // Replace verbatim. Sudo passwords don't contain regex metachars
    // typically, but we use split/join so we don't care if they do.
    // WHY a FIXED-WIDTH mask: a variable-width mask leaked the secret's
    // (clamped) LENGTH into the log. A constant token reveals nothing about
    // how long the password is.
    out = out.split(s).join(REDACTED_MASK)
  }
  // Drop benign noise lines that have no actionable content and just
  // bloat the log. So far only one offender: sudo's stderr complaint
  // when the target user's home directory doesn't exist (Synology
  // with User Home Service disabled — common on DSM7). The wizard
  // doesn't need a home directory for any operation it performs.
  out = out.replace(
    /Could not chdir to home directory [^\n]*: No such file or directory\r?\n?/g,
    '',
  )
  return out
}

export async function execStream(args: {
  sessionId: string
  cmd: string
  sudo?: boolean
  channelId: string
}): Promise<void> {
  const sess = sessions.get(args.sessionId)
  if (!sess) throw new Error(`unknown sessionId ${args.sessionId}`)

  // Don't launch a SECOND stream over a channelId that's already live. WHY:
  // the install uses one fixed channelId (setup-sh-main). If a Cancel was
  // swallowed (the remote process tree ignored TERM) the old channel is still
  // open and setup.sh is still converging on the NAS; a Retry that reuses the
  // same channelId would start a SECOND setup.sh racing the first (caught by
  // .setup.lock, but a confusing lock-conflict on top of a "failed" that
  // wasn't). Reject clearly instead so the renderer keeps offering "Reconnect
  // & resume" rather than stacking runs.
  if (activeChannels.has(args.channelId)) {
    throw new Error(
      `channel ${args.channelId} is already running — a previous run hasn't ` +
      `released it yet (its Cancel may still be taking effect on the NAS). ` +
      `Wait a moment, or use Reconnect & resume.`,
    )
  }

  // Same fail-fast as exec(): if a streamed step needs root and there's no
  // escalation path, surface a clear error rather than running it unprivileged.
  if (args.sudo && privMode(sess) === 'fail') {
    throw new Error(
      `This step needs root (user=${sess.config.user}), but there's no way ` +
      `to escalate: not root, no "Sudo password" provided on Connect, and the ` +
      `account can't reach Docker without sudo. Log in as root, fill in the ` +
      `Sudo password field, or add your user to the "docker" group.`,
    )
  }

  const fullCmd = wrapSudo(args.sessionId, args.cmd, !!args.sudo)
  const channelId = args.channelId
  // Surface (once) that root-only steps are running unprivileged via the
  // docker group — mirrored to both the live UI log and the on-disk log.
  if (isDockerGroupFallback(sess, !!args.sudo)) {
    noteDockerGroupDegradation(sess, channelId)
  }
  // Secrets to scrub from every outbound chunk. The sudo password is
  // the one that PTY-echoes; we also redact the SSH password defensively
  // in case a future code path writes it through a PTY too.
  const secrets = [sess.config.sudoPassword, sess.config.password]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)

  return new Promise((resolve, reject) => {
    sess.client.exec(fullCmd, { pty: true }, (err, stream) => {
      if (err) return reject(err)
      activeChannels.set(channelId, stream)

      // Finish exactly once — emit the close event + resolve. Shared by the
      // normal 'close', a stream 'error', and the inactivity watchdog, so
      // none of those can leave the renderer stuck in "running" forever.
      let settled = false
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const finishClose = (code: number | null, signal: string | null, note: string) => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        activeChannels.delete(channelId)
        appendInstallLog(note)
        // Tag with the owning session so the renderer can ignore a late close
        // from a SUPERSEDED session after a reconnect-and-resume (the new run
        // reuses the same channelId on a fresh session).
        send<SshStreamClose>(IPC.evtStreamClose, { channelId, exitCode: code, signal, sessionId: args.sessionId })
        resolve()
      }
      // Inactivity watchdog: a live install streams progress continuously,
      // so a long stretch of ZERO output means a dead socket or a wedged
      // step. Abort (TERM → close) and report a non-zero finish so the UI
      // can recover instead of ticking its heartbeat indefinitely. Window
      // is generous — setup.sh is idempotent + resumable, so a rare false
      // abort just means "re-run / --resume".
      const STALL_MS = 30 * 60 * 1000
      const bumpWatchdog = () => {
        if (settled) return
        if (watchdog) clearTimeout(watchdog)
        watchdog = setTimeout(() => {
          try { stream.signal('TERM') } catch { try { stream.close() } catch { /* ignore */ } }
          finishClose(null, 'STALL', `\n[ssh] channel ${channelId} aborted — no output for ${STALL_MS / 60000} min (dead connection or wedged step). The stack may still be converging on the NAS; re-run or use --resume.\n`)
        }, STALL_MS)
      }
      bumpWatchdog()

      // Pipe sudo password to stdin only in 'password' mode (matches
      // wrapSudo, which only `sudo -S`-wraps in that mode).
      if (args.sudo && privMode(sess) === 'password' && sess.config.sudoPassword) {
        stream.write(sess.config.sudoPassword + '\n')
      }

      stream.on('data', (d: Buffer) => {
        bumpWatchdog()
        const chunk = redactStreamChunk(d.toString('utf8'), secrets)
        if (!chunk) return
        send<SshStreamData>(IPC.evtStreamData, { channelId, type: 'stdout', chunk, sessionId: args.sessionId })
        // Mirror to the on-disk install log so the user has a permanent
        // record. install-log no-ops if no log file is open.
        appendInstallLog(chunk)
      })
      stream.stderr.on('data', (d: Buffer) => {
        bumpWatchdog()
        const chunk = redactStreamChunk(d.toString('utf8'), secrets)
        if (!chunk) return
        send<SshStreamData>(IPC.evtStreamData, { channelId, type: 'stderr', chunk, sessionId: args.sessionId })
        appendInstallLog(chunk)
      })
      // A socket error on the channel (NAS dropped, network blip) would
      // otherwise leave this Promise unresolved forever — the renderer hangs
      // in 'running'. Surface it as a null-exit close so the UI moves to failed.
      stream.on('error', (e: Error) => {
        finishClose(null, null, `\n[ssh] channel ${channelId} stream error: ${e?.message ?? String(e)}\n`)
      })
      stream.on('close', (code: number, signal: string) => {
        finishClose(code ?? null, signal ?? null, `\n[ssh] channel ${channelId} closed (exit=${code ?? 'null'} signal=${signal ?? 'none'})\n`)
      })
    })
  })
}

export function streamCancel(channelId: string): void {
  const ch = activeChannels.get(channelId)
  if (!ch) return
  // Send a graceful TERM first and KEEP the channel handle. WHY: deleting it
  // here used to discard our only escalation path — if the remote process tree
  // swallowed the TERM (a long `compose pull`/`up` whose child ignores it),
  // setup.sh kept running on the NAS while the wizard had no way to force it
  // down. Leave the channel in activeChannels (its 'close' handler in
  // execStream removes it) and, if it's still alive after a grace period,
  // escalate to KILL + close so the remote process actually dies and the
  // channel is freed. Idempotent: a second Cancel on an already-TERM'd channel
  // just re-arms the same escalation, which is harmless.
  try {
    ch.signal('TERM')
  } catch {
    // ssh2 throws if the server doesn't support signals — fall back to close
    // immediately (no escalation possible) and drop the handle.
    try { ch.close() } catch { /* already closing */ }
    activeChannels.delete(channelId)
    return
  }
  // ~8s for an orderly TERM (and setup.sh's INT/TERM trap tearing the stack
  // down in order) before we force it. If the channel already closed, the map
  // no longer holds THIS handle and we leave it alone.
  setTimeout(() => {
    if (activeChannels.get(channelId) !== ch) return
    try { ch.signal('KILL') } catch { /* server may not support signals */ }
    try { ch.close() } catch { /* already closing */ }
    // Leave the map delete to the channel's own 'close' handler so we don't
    // race execStream's finishClose; close() above triggers it.
  }, 8_000)
}

// ── SFTP accessors (used by sftp-service.ts) ─────────────────────────────────

export function getClient(sessionId: string): Client {
  const s = sessions.get(sessionId)
  if (!s) throw new Error(`unknown sessionId ${sessionId}`)
  return s.client
}

export function getSftp(sessionId: string): Promise<SFTPWrapper> {
  const s = sessions.get(sessionId)
  if (!s) throw new Error(`unknown sessionId ${sessionId}`)
  if (s.sftp) return Promise.resolve(s.sftp)
  return new Promise((resolve, reject) => {
    s.client.sftp((err, sftp) => {
      if (err) return reject(err)
      s.sftp = sftp
      resolve(sftp)
    })
  })
}

export function shutdown() {
  // First: send TERM to every active exec channel so the remote
  // processes (setup.sh, docker compose pull, etc.) get a chance to
  // die cleanly instead of being orphaned by the disconnect. Some
  // SSH servers reject the "signal" message; fall back to close().
  for (const [id, ch] of activeChannels.entries()) {
    try { ch.signal('TERM') } catch { /* server may not support signals */ }
    try { ch.close() } catch { /* already closed */ }
    activeChannels.delete(id)
  }
  // Then drop each Client. ssh2's .end() sends SSH_MSG_DISCONNECT and
  // closes the underlying socket; the server tears down whatever was
  // still attached to the connection.
  // WHY the per-session guard: this runs at app quit. If one disconnect ever
  // throws, an unguarded loop would abort and leave every remaining session
  // (and its socket) un-torn-down. Isolate each so one failure can't strand
  // the rest.
  for (const id of [...sessions.keys()]) {
    try { disconnect(id) } catch { /* ignore — keep tearing down the rest */ }
  }
}
