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
}

const sessions = new Map<string, Session>()
const activeChannels = new Map<string, ClientChannel>()
let mainWindow: BrowserWindow | null = null

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
    readyTimeout: 15_000,
    keepaliveInterval: 30_000,
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

    // Hard wall-clock timeout. ssh2's readyTimeout only fires after the
    // underlying TCP connect completes; if the OS itself hangs the
    // connect (NAT black hole, router silently dropping packets,
    // wrong host) we'd wait indefinitely otherwise.
    const HARD_TIMEOUT_MS = 20_000
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
  return { sessionId }
}

export function disconnect(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  if (s.sftp) s.sftp.end()
  s.client.end()
  sessions.delete(sessionId)
}

function wrapSudo(sessionId: string, cmd: string, sudo: boolean): string {
  if (!sudo) return cmd
  const sess = sessions.get(sessionId)
  if (!sess) return cmd
  if (sess.config.user === 'root') return cmd
  // -S reads the password from stdin; -p '' blanks the prompt so the
  // password write doesn't appear in the log.
  const escaped = cmd.replace(/'/g, `'\\''`)
  return `sudo -S -p '' bash -c '${escaped}'`
}

/** One-shot exec; buffers stdout/stderr. For UI streaming use execStream. */
function execOnce(
  client: Client,
  cmd: string,
  opts?: { stdinPassword?: string; timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeoutMs = opts?.timeoutMs ?? 60_000
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(
        `Remote command timed out after ${timeoutMs / 1000}s.\n` +
        `Command: ${cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd}\n` +
        `If this used sudo, the most likely cause is a wrong sudo password ` +
        `(or no password supplied for a non-root SSH user).`,
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
      let stdout = ''
      let stderr = ''
      stream.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      stream.on('error', (e: Error) => finish(e))
      stream.on('close', (code: number, signal: string) =>
        finish({ exitCode: code, signal: signal ?? null, stdout, stderr }),
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
      }
    })
  })
}

export async function exec(args: { sessionId: string; cmd: string; sudo?: boolean }): Promise<ExecResult> {
  const sess = sessions.get(args.sessionId)
  if (!sess) throw new Error(`unknown sessionId ${args.sessionId}`)
  const wrapped = wrapSudo(args.sessionId, args.cmd, !!args.sudo)
  // If we're wrapping with sudo and the user is non-root, we MUST pipe
  // a password — sudo -S reads stdin. If it's empty and the user has
  // NOPASSWD configured for this command, sudo accepts the empty line
  // and proceeds; if not, sudo rejects and execOnce sees a non-zero
  // exit. Either way we don't hang.
  const needsSudoPassword =
    !!args.sudo && sess.config.user !== 'root'
  if (needsSudoPassword && !sess.config.sudoPassword) {
    throw new Error(
      `This command needs sudo (user=${sess.config.user}), but no sudo ` +
      `password was provided on the Connect screen. Either log in as ` +
      `root or fill in the "Sudo password" field.`,
    )
  }
  return execOnce(sess.client, wrapped, {
    stdinPassword: needsSudoPassword ? (sess.config.sudoPassword ?? '') : undefined,
  })
}

export async function execStream(args: {
  sessionId: string
  cmd: string
  sudo?: boolean
  channelId: string
}): Promise<void> {
  const sess = sessions.get(args.sessionId)
  if (!sess) throw new Error(`unknown sessionId ${args.sessionId}`)

  const fullCmd = wrapSudo(args.sessionId, args.cmd, !!args.sudo)
  const channelId = args.channelId

  return new Promise((resolve, reject) => {
    sess.client.exec(fullCmd, { pty: true }, (err, stream) => {
      if (err) return reject(err)
      activeChannels.set(channelId, stream)

      // Pipe sudo password to stdin if needed.
      if (args.sudo && sess.config.user !== 'root' && sess.config.sudoPassword) {
        stream.write(sess.config.sudoPassword + '\n')
      }

      stream.on('data', (d: Buffer) => {
        const chunk = d.toString('utf8')
        send<SshStreamData>(IPC.evtStreamData, { channelId, type: 'stdout', chunk })
        // Mirror to the on-disk install log so the user has a permanent
        // record. install-log no-ops if no log file is open.
        appendInstallLog(chunk)
      })
      stream.stderr.on('data', (d: Buffer) => {
        const chunk = d.toString('utf8')
        send<SshStreamData>(IPC.evtStreamData, { channelId, type: 'stderr', chunk })
        appendInstallLog(chunk)
      })
      stream.on('close', (code: number, signal: string) => {
        activeChannels.delete(channelId)
        const closeNote = `\n[ssh] channel ${channelId} closed (exit=${code ?? 'null'} signal=${signal ?? 'none'})\n`
        appendInstallLog(closeNote)
        send<SshStreamClose>(IPC.evtStreamClose, {
          channelId,
          exitCode: code ?? null,
          signal: signal ?? null,
        })
        resolve()
      })
    })
  })
}

export function streamCancel(channelId: string): void {
  const ch = activeChannels.get(channelId)
  if (!ch) return
  try {
    ch.signal('TERM')
  } catch {
    // ssh2 throws if the server doesn't support signals — fall back to close.
    ch.close()
  }
  activeChannels.delete(channelId)
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
  for (const id of [...sessions.keys()]) disconnect(id)
}
