// ── Environment detector ──────────────────────────────────────────────────────
// One IPC call → many small SSH execs to fingerprint the NAS:
// PUID/PGID, timezone, LAN IPs, Docker version, Python, iptables.

import { exec } from './ssh-service.js'
import type { EnvDetectResult } from '../shared/ipc.js'

async function run(sessionId: string, cmd: string): Promise<{ ok: boolean; out: string }> {
  const r = await exec({ sessionId, cmd })
  return { ok: r.exitCode === 0, out: r.stdout.trim() }
}

export async function detectEnv(sessionId: string): Promise<EnvDetectResult> {
  const [
    dockerV2, dockerV1, volume1, puid, pgid, uname, gname, tzFile, tzLink,
    lanRaw, py3, ipt, sudoNopw, whoami,
  ] = await Promise.all([
    run(sessionId, 'docker compose version'),
    run(sessionId, 'command -v docker-compose'),
    run(sessionId, '[ -d /volume1 ] && echo ok'),
    run(sessionId, 'id -u'),
    run(sessionId, 'id -g'),
    run(sessionId, 'id -un'),
    run(sessionId, 'id -gn'),
    run(sessionId, 'cat /etc/timezone 2>/dev/null'),
    run(sessionId, 'readlink /etc/localtime 2>/dev/null'),
    run(sessionId, "ip -4 addr show 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127' || true"),
    run(sessionId, 'python3 --version 2>&1'),
    run(sessionId, 'iptables --version 2>&1'),
    run(sessionId, 'sudo -n true 2>&1; echo $?'),
    run(sessionId, 'whoami'),
  ])

  // Timezone: prefer /etc/timezone, fall back to symlink target.
  let tz: string | null = tzFile.ok && tzFile.out ? tzFile.out : null
  if (!tz && tzLink.ok) {
    const m = tzLink.out.match(/zoneinfo\/(.+)$/)
    if (m) tz = m[1]
  }

  // LAN IPs come back as "192.168.1.42/24" — strip the CIDR suffix.
  const lanIps = lanRaw.out
    .split('\n')
    .map((l) => l.trim().split('/')[0])
    .filter(Boolean)

  const isRoot = whoami.out === 'root'
  let sudoMode: EnvDetectResult['sudoMode'] = 'password'
  if (isRoot) sudoMode = 'root'
  else if (sudoNopw.out.trim().endsWith('0')) sudoMode = 'nopasswd'

  return {
    docker: dockerV2.ok ? 'v2' : dockerV1.ok ? 'v1-legacy' : 'missing',
    volume1: volume1.ok && volume1.out === 'ok',
    puid: puid.ok ? Number(puid.out) : null,
    pgid: pgid.ok ? Number(pgid.out) : null,
    username: uname.ok ? uname.out : null,
    groupname: gname.ok ? gname.out : null,
    tz,
    lanIps,
    python3: py3.ok ? py3.out : null,
    iptables: ipt.ok ? ipt.out.split('\n')[0] : null,
    sudoMode,
  }
}
