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
    return { kind: 'auth-failed', message: err.message }
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
    // Sanity check: run a trivial command. Wrap in a 10s timeout so a
    // wedged SSH channel doesn't hang the whole UI.
    const echoPromise = execOnce(client, 'echo ok')
    const exit = await Promise.race([
      echoPromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('Server connected but did not respond to a basic echo within 10s')), 10_000),
      ),
    ])
    if (exit.exitCode !== 0 || !exit.stdout.includes('ok')) {
      return { ok: false, error: { kind: 'unknown', message: 'connected but echo failed' } }
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
function execOnce(client: Client, cmd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      stream.on('error', (e: Error) => reject(e))
      stream.on('close', (code: number, signal: string) =>
        resolve({ exitCode: code, signal: signal ?? null, stdout, stderr }),
      )
    })
  })
}

export async function exec(args: { sessionId: string; cmd: string; sudo?: boolean }): Promise<ExecResult> {
  const sess = sessions.get(args.sessionId)
  if (!sess) throw new Error(`unknown sessionId ${args.sessionId}`)
  return execOnce(sess.client, wrapSudo(args.sessionId, args.cmd, !!args.sudo))
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
        send<SshStreamData>(IPC.evtStreamData, {
          channelId,
          type: 'stdout',
          chunk: d.toString('utf8'),
        })
      })
      stream.stderr.on('data', (d: Buffer) => {
        send<SshStreamData>(IPC.evtStreamData, {
          channelId,
          type: 'stderr',
          chunk: d.toString('utf8'),
        })
      })
      stream.on('close', (code: number, signal: string) => {
        activeChannels.delete(channelId)
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
  for (const id of [...sessions.keys()]) disconnect(id)
}
