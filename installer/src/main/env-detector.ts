// ── Environment detector ──────────────────────────────────────────────────────
// One IPC call → many small SSH execs to fingerprint the NAS:
// PUID/PGID, timezone, LAN IPs, Docker version, Python, iptables, plus
// pre-existing install detection and port-conflict scan.

import { exec } from './ssh-service.js'
import type { DiskSpace, EnvDetectResult, InternetCheck, PortConflict } from '../shared/ipc.js'

// Ports the stack binds. Mirrors docker-compose.yml + setup-firewall.sh.
// If a port here is already in use by something else on the NAS, the
// `docker compose up -d` step will fail with "address already in use".
const STACK_PORTS: { port: number; service: string }[] = [
  { port: 32400, service: 'Plex' },
  { port: 49150, service: 'Prowlarr' },
  { port: 49151, service: 'Radarr' },
  { port: 49152, service: 'Sonarr' },
  { port: 49153, service: 'Bazarr' },
  { port: 49154, service: 'Lidarr' },
  { port: 49155, service: 'SABnzbd' },
  { port: 49156, service: 'qBittorrent' },
  { port: 5056,  service: 'Seerr' },
  { port: 8181,  service: 'Tautulli' },
  { port: 3000,  service: 'Homepage' },
  { port: 8191,  service: 'Flaresolverr' },
  { port: 6881,  service: 'qBittorrent (peer)' },
]

// Container names the stack creates. Used to recognize a re-install vs
// a foreign Docker setup.
const STACK_CONTAINERS = new Set([
  'plex', 'tautulli', 'seerr', 'homepage', 'prowlarr', 'flaresolverr',
  'sonarr', 'radarr', 'bazarr', 'lidarr', 'gluetun', 'qbittorrent',
  'sabnzbd', 'recyclarr', 'unpackerr',
])

async function run(sessionId: string, cmd: string): Promise<{ ok: boolean; out: string }> {
  const r = await exec({ sessionId, cmd })
  return { ok: r.exitCode === 0, out: r.stdout.trim() }
}

/** Quote a path for safe inline-bash. Single-quotes the string and
 *  escapes any embedded single-quote. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

async function probePortConflicts(sessionId: string): Promise<PortConflict[]> {
  // BusyBox netstat on Synology supports -lnt (listening, numeric, TCP).
  // The 4th column is "local-address:port" — strip everything up to the
  // last colon. -p adds program/PID where the user has permission to see
  // it; we deliberately don't use sudo here because env-detect runs early.
  const r = await run(
    sessionId,
    "netstat -lnt 2>/dev/null | awk 'NR>2 {n=split($4,a,\":\"); print a[n]}' | sort -un",
  )
  if (!r.ok || !r.out) return []
  const bound = new Set<number>()
  for (const line of r.out.split('\n')) {
    const n = Number(line.trim())
    if (Number.isInteger(n) && n > 0 && n <= 65535) bound.add(n)
  }
  return STACK_PORTS
    .filter((p) => bound.has(p.port))
    .map((p) => ({ port: p.port, service: p.service, process: '' }))
}

async function probeDisk(sessionId: string): Promise<DiskSpace | null> {
  // df -k gives sizes in 1024-byte blocks. BusyBox df on Synology
  // truncates the device column on long filesystem names — using -P
  // forces POSIX output where the columns are always: Filesystem,
  // 1024-blocks, Used, Available, Capacity, Mounted-on.
  const r = await run(
    sessionId,
    "df -kP /volume1 2>/dev/null | tail -n +2 | awk '{print $2, $4}'",
  )
  if (!r.ok || !r.out) return null
  const [totalKBraw, freeKBraw] = r.out.split(/\s+/)
  const totalKB = Number(totalKBraw)
  const freeKB = Number(freeKBraw)
  if (!Number.isFinite(totalKB) || !Number.isFinite(freeKB)) return null
  const totalBytes = totalKB * 1024
  const freeBytes = freeKB * 1024
  return {
    totalBytes,
    freeBytes,
    freeGiB: Math.floor(freeBytes / (1024 ** 3)),
  }
}

async function probeInternet(sessionId: string): Promise<InternetCheck> {
  // curl -sf returns 0 only on a successful 2xx. -m 5 caps the wait.
  // Both endpoints are HEAD-friendly so this is cheap.
  const [dh, plex] = await Promise.all([
    run(sessionId, 'curl -sfm 5 -o /dev/null https://registry-1.docker.io/v2/ ; echo $?'),
    run(sessionId, 'curl -sfm 5 -o /dev/null https://plex.tv ; echo $?'),
  ])
  // The endpoints return 401 (docker.io) or redirects (plex.tv) for an
  // unauthenticated HEAD — we accept the connection succeeding regardless.
  // Re-do without -f so 4xx/3xx don't fail.
  const [dh2, plex2] = await Promise.all([
    run(sessionId, 'curl -sm 5 -o /dev/null -w "%{http_code}" https://registry-1.docker.io/v2/'),
    run(sessionId, 'curl -sm 5 -o /dev/null -w "%{http_code}" https://plex.tv'),
  ])
  // Either the original -f succeeded, or we got *any* HTTP status code.
  const ok = (a: { ok: boolean; out: string }, b: { ok: boolean; out: string }) =>
    (a.out.trim().endsWith('0')) ||
    (b.ok && /^\d{3}$/.test(b.out.trim()) && b.out.trim() !== '000')
  return {
    dockerHub: ok(dh, dh2),
    plexTv: ok(plex, plex2),
  }
}

async function probeExistingInstall(sessionId: string, targetDir: string) {
  const tq = shellQuote(targetDir)
  const [compose, envFile, dockerPs] = await Promise.all([
    run(sessionId, `[ -f ${tq}/docker-compose.yml ] && echo y || true`),
    run(sessionId, `[ -f ${tq}/.env ] && echo y || true`),
    // List running container names; sudo NOT used — the user (root or
    // nopasswd-ssh user) is in the docker group on Synology by default.
    run(sessionId, "docker ps --format '{{.Names}}' 2>/dev/null || true"),
  ])

  const runningSet = new Set(
    (dockerPs.ok ? dockerPs.out.split('\n') : []).map((l) => l.trim()).filter(Boolean),
  )
  const runningContainers = [...STACK_CONTAINERS].filter((c) => runningSet.has(c))

  return {
    hasCompose: compose.out === 'y',
    hasEnv: envFile.out === 'y',
    runningContainers,
  }
}

export async function detectEnv(
  sessionId: string,
  targetDir: string = '/volume1/docker/media',
): Promise<EnvDetectResult> {
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

  // Existing install + port conflict probes only run if Docker is present;
  // they're useless otherwise. Disk + internet probes always run.
  const dockerPresent = dockerV2.ok || dockerV1.ok
  const [existingInstall, portConflicts, disk, internet] = await Promise.all([
    dockerPresent
      ? probeExistingInstall(sessionId, targetDir)
      : Promise.resolve({ hasCompose: false, hasEnv: false, runningContainers: [] }),
    dockerPresent ? probePortConflicts(sessionId) : Promise.resolve([] as PortConflict[]),
    probeDisk(sessionId),
    probeInternet(sessionId),
  ])

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
    existingInstall,
    portConflicts,
    disk,
    internet,
  }
}
