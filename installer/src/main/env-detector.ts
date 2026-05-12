// ── Environment detector ──────────────────────────────────────────────────────
// One IPC call → many small SSH execs to fingerprint the NAS:
// PUID/PGID, timezone, LAN IPs, Docker version, Python, iptables, plus
// pre-existing install detection and port-conflict scan.

import { exec } from './ssh-service.js'
import type { EnvDetectResult, PortConflict } from '../shared/ipc.js'

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

// (Earlier versions ran probePortConflicts/probeDisk/probeInternet/
// probeExistingInstall as separate parallel SSH execs. Synology DSM7's
// MaxSessions=10 caused the back half to fail with "Channel open
// failure". Everything below is now batched into one bash invocation
// in detectEnv() — see the `===KEY===` section markers.)

/** Pull a labelled section out of the batched probe stdout. Each section
 *  is bracketed by `===KEY===` markers so we can split a single multi-
 *  command bash output cleanly. */
function section(out: string, key: string): string {
  const re = new RegExp(`===${key}===\\n([\\s\\S]*?)(?=\\n===|$)`)
  const m = out.match(re)
  return m ? m[1].trim() : ''
}

export async function detectEnv(
  sessionId: string,
  targetDir: string = '/volume1/docker/media',
): Promise<EnvDetectResult> {
  // Synology DSM7's sshd has MaxSessions=10 by default, so firing 14+
  // parallel exec channels here gets the back half rejected with
  // "Channel open failure: open failed". We batch every probe into a
  // single bash invocation that prints labelled sections, parsed below.
  const tq = shellQuote(targetDir)
  const batch = [
    // SSH non-interactive shells on Synology typically have PATH=
    // /usr/bin:/bin:/usr/sbin:/sbin, which doesn't include where Docker
    // and Container Manager actually install their binaries. Augment up
    // front so `docker`, `docker compose`, and `docker-compose` are
    // findable here AND when setup.sh runs later.
    'export PATH="/usr/local/bin:/usr/local/sbin:/var/packages/ContainerManager/target/usr/bin:/var/packages/Docker/target/usr/bin:$PATH"',
    'set +e',
    'echo "===docker_v2==="; docker compose version 2>&1; echo "RC=$?"',
    'echo "===docker_v1==="; command -v docker-compose 2>&1; echo "RC=$?"',
    'echo "===volume1==="; [ -d /volume1 ] && echo ok; echo "RC=$?"',
    'echo "===puid==="; id -u',
    'echo "===pgid==="; id -g',
    'echo "===uname==="; id -un',
    'echo "===gname==="; id -gn',
    'echo "===tz_file==="; cat /etc/timezone 2>/dev/null',
    'echo "===tz_link==="; readlink /etc/localtime 2>/dev/null',
    'echo "===lan==="; ip -4 addr show 2>/dev/null | awk \'/inet /{print $2}\' | grep -v \'^127\' || true',
    // The IP of the interface that owns the default route. This is the
    // "real" LAN IP we want for binding services — even if the user
    // SSH'd in via a Tailscale/VPN/hostname/alternate route.
    'echo "===default_iface==="; ip route show default 2>/dev/null | awk \'/default/{print $5; exit}\'',
    'echo "===default_ip==="; iface=$(ip route show default 2>/dev/null | awk \'/default/{print $5; exit}\'); [ -n "$iface" ] && ip -4 addr show "$iface" 2>/dev/null | awk \'/inet /{print $2}\' | head -1 | cut -d/ -f1',
    // SSH_CLIENT is "<src-ip> <src-port> <dst-port>" — surface the src IP
    // so the renderer can hint when the user's connect address differs
    // from the NAS's actual LAN IP.
    'echo "===ssh_client==="; echo "$SSH_CLIENT" | awk \'{print $1}\'',
    // The NAS's reply-path IP to the user's PC. Differs from default_ip
    // when the user connected via a non-default-route network (Tailscale).
    'echo "===reply_ip==="; src=$(echo "$SSH_CLIENT" | awk \'{print $1}\'); [ -n "$src" ] && ip route get "$src" 2>/dev/null | awk \'/src/{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}\' | head -1',
    'echo "===py3==="; python3 --version 2>&1; echo "RC=$?"',
    'echo "===ipt==="; iptables --version 2>&1; echo "RC=$?"',
    'echo "===sudo_nopw==="; sudo -n true 2>/dev/null; echo $?',
    'echo "===whoami==="; whoami',
    'echo "===has_compose==="; [ -f ' + tq + '/docker-compose.yml ] && echo y || true',
    'echo "===has_env==="; [ -f ' + tq + '/.env ] && echo y || true',
    'echo "===running==="; docker ps --format "{{.Names}}" 2>/dev/null || true',
    // Map of currently-bound ports to the docker container that owns
    // each. We use this to suppress "port conflict" warnings for ports
    // bound by our own stack — the previous install's containers don't
    // count as a conflict; we'll restart them as part of the install.
    'echo "===docker_ports==="; docker ps --format "{{.Names}}|{{.Ports}}" 2>/dev/null || true',
    'echo "===df==="; df -kP /volume1 2>/dev/null | tail -n +2',
    'echo "===netstat==="; netstat -lnt 2>/dev/null | awk \'NR>2 {n=split($4,a,":"); print a[n]}\' | sort -un',
    'echo "===dockerhub==="; curl -sm 5 -o /dev/null -w "%{http_code}" https://registry-1.docker.io/v2/ 2>/dev/null || echo 000',
    'echo "===plextv==="; curl -sm 5 -o /dev/null -w "%{http_code}" https://plex.tv 2>/dev/null || echo 000',
    // DNS resolution fallback — Synology\'s stock curl sometimes fails
    // outbound HTTPS even when the Docker daemon (which has its own
    // network stack) can pull images fine. If DNS resolves and Docker
    // is up, "no curl reachability" is usually a false negative.
    'echo "===dockerhub_dns==="; getent hosts registry-1.docker.io 2>/dev/null | awk \'{print $1; exit}\' || true',
    'echo "===docker_info==="; docker info --format \'{{.ServerVersion}}\' 2>/dev/null || true',
    // Synology shared-folder ACL on /volume1/Data — the source of the
    // long-running "Sonarr says root folder doesn\'t exist" trap. We
    // do TWO probes:
    //   1. data_share_exists: is the /volume1/Data dir present at all?
    //      (If not, the user hasn\'t made the shared folder yet —
    //      different problem to surface than ACL.)
    //   2. data_share_writable: can the SSH user (whose UID typically
    //      matches PUID) write to that share? This is the same probe
    //      the wizard\'s install-time [acl] step does — running it
    //      during detect lets us warn EARLY instead of at install.
    //      We deliberately do NOT require sudo here — the SSH user
    //      must be able to write under their own identity, which is
    //      what the arr containers will be doing with PUID set.
    'echo "===data_share_exists==="; [ -d /volume1/Data ] && echo y || echo n',
    'echo "===data_share_writable==="; ' +
      'if [ -d /volume1/Data ]; then ' +
      '  if touch /volume1/Data/.mediarr-detect-probe 2>/dev/null && rm /volume1/Data/.mediarr-detect-probe 2>/dev/null; then ' +
      '    echo y; ' +
      '  else echo n; fi; ' +
      'else echo skip; fi',
    // Snapshot of the current ACL on /volume1/Data so we can show the
    // user "here\'s who has access right now" if the write probe fails.
    // synoacltool lives at known-stable paths on DSM (we resolve them
    // explicitly because the SSH non-interactive PATH doesn\'t include
    // /usr/syno/bin by default).
    'echo "===acl_dump==="; ' +
      'for c in /usr/syno/bin/synoacltool /usr/syno/sbin/synoacltool /usr/local/bin/synoacltool /usr/bin/synoacltool; do ' +
      '  if [ -e "$c" ]; then "$c" -get /volume1/Data 2>/dev/null && break; fi; ' +
      'done',
  ].join('\n')

  const r = await run(sessionId, `bash -c ${shellQuote(batch)}`)
  const o = r.out

  const dockerV2OK = /RC=0$/m.test(section(o, 'docker_v2'))
  const dockerV1OK = /RC=0$/m.test(section(o, 'docker_v1'))
  const volume1Out = section(o, 'volume1')
  const py3Section = section(o, 'py3')
  const iptSection = section(o, 'ipt')

  // Timezone: prefer /etc/timezone, fall back to symlink target.
  const tzFile = section(o, 'tz_file')
  const tzLink = section(o, 'tz_link')
  let tz: string | null = tzFile || null
  if (!tz && tzLink) {
    const m = tzLink.match(/zoneinfo\/(.+)$/)
    if (m) tz = m[1]
  }

  // LAN IPs come back as "192.168.1.42/24" — strip the CIDR suffix.
  const lanIps = section(o, 'lan')
    .split('\n')
    .map((l) => l.trim().split('/')[0])
    .filter(Boolean)

  const whoami = section(o, 'whoami')
  const isRoot = whoami === 'root'
  const sudoNopw = section(o, 'sudo_nopw')
  let sudoMode: EnvDetectResult['sudoMode'] = 'password'
  if (isRoot) sudoMode = 'root'
  else if (sudoNopw.trim().endsWith('0')) sudoMode = 'nopasswd'

  // Existing install + port conflict from the batched output.
  const dockerPresent = dockerV2OK || dockerV1OK
  const runningSet = new Set(section(o, 'running').split('\n').map((l) => l.trim()).filter(Boolean))
  const runningContainers = dockerPresent
    ? [...STACK_CONTAINERS].filter((c) => runningSet.has(c))
    : []
  const existingInstall = {
    hasCompose: dockerPresent && section(o, 'has_compose') === 'y',
    hasEnv: dockerPresent && section(o, 'has_env') === 'y',
    runningContainers,
  }

  const boundPorts = new Set<number>()
  for (const line of section(o, 'netstat').split('\n')) {
    const n = Number(line.trim())
    if (Number.isInteger(n) && n > 0 && n <= 65535) boundPorts.add(n)
  }

  // Build a set of ports already published by one of OUR stack
  // containers. `docker ps --format "{{.Names}}|{{.Ports}}"` emits one
  // line per container like:
  //   plex|192.168.1.10:32400->32400/tcp, 192.168.1.10:1900->1900/udp
  //   sonarr|192.168.1.10:49152->8989/tcp
  // We parse out the host-side port of every published mapping and, if
  // the owning container is in STACK_CONTAINERS, mark that port as
  // "ours, not a conflict". Re-running the install gracefully handles
  // restarting those containers.
  const ownedByStack = new Set<number>()
  for (const line of section(o, 'docker_ports').split('\n')) {
    const sep = line.indexOf('|')
    if (sep < 0) continue
    const name = line.slice(0, sep).trim()
    if (!STACK_CONTAINERS.has(name)) continue
    const portsField = line.slice(sep + 1)
    for (const m of portsField.matchAll(/:(\d+)->\d+\/(?:tcp|udp)/g)) {
      const port = Number(m[1])
      if (Number.isInteger(port)) ownedByStack.add(port)
    }
  }

  const portConflicts: PortConflict[] = dockerPresent
    ? STACK_PORTS
        .filter((p) => boundPorts.has(p.port) && !ownedByStack.has(p.port))
        .map((p) => ({ port: p.port, service: p.service, process: '' }))
    : []

  // df -kP output: "Filesystem 1024-blocks Used Available Capacity Mounted-on"
  const dfLine = section(o, 'df').split('\n')[0]?.trim() ?? ''
  const dfFields = dfLine.split(/\s+/)
  const totalKB = Number(dfFields[1])
  const freeKB = Number(dfFields[3])
  const disk = (Number.isFinite(totalKB) && Number.isFinite(freeKB)) ? {
    totalBytes: totalKB * 1024,
    freeBytes: freeKB * 1024,
    freeGiB: Math.floor((freeKB * 1024) / (1024 ** 3)),
  } : null

  const httpOK = (s: string) => /^[0-9]{3}$/.test(s.trim()) && s.trim() !== '000'
  const internet = {
    dockerHub: httpOK(section(o, 'dockerhub')),
    plexTv: httpOK(section(o, 'plextv')),
    dockerHubDnsResolves: /^\d+\.\d+\.\d+\.\d+/.test(section(o, 'dockerhub_dns').trim()),
    dockerDaemonUp: section(o, 'docker_info').trim().length > 0,
  }

  const puidStr = section(o, 'puid')
  const pgidStr = section(o, 'pgid')
  const uname = section(o, 'uname')
  const gname = section(o, 'gname')
  const py3OK = /RC=0$/m.test(py3Section)
  const iptOK = /RC=0$/m.test(iptSection)

  const defaultIface = section(o, 'default_iface') || null
  const defaultIp = section(o, 'default_ip') || null
  const sshClientIp = section(o, 'ssh_client') || null
  const replyIp = section(o, 'reply_ip') || null

  // /volume1/Data ACL state — surfaced as a check on the Detect screen
  // so the user can fix DSM share permissions before the install
  // bothers to upload anything. The wizard's install-time [acl] step
  // still runs as a backup, but this gives an earlier signal.
  const dataShareExists = section(o, 'data_share_exists') === 'y'
  const dataShareWritableRaw = section(o, 'data_share_writable')
  let dataShareWritable: boolean | null
  if (dataShareWritableRaw === 'y') dataShareWritable = true
  else if (dataShareWritableRaw === 'n') dataShareWritable = false
  else dataShareWritable = null    // 'skip' (share missing) → unknown
  // Parse the synoacltool -get dump into a tiny structured list so the
  // UI can render "user heoki: rwx,inherited / user admin: rwx,inherited
  // / group users: r-x,inherited" without re-parsing in the renderer.
  // Lines look like:
  //   [0] user:admin:allow:rwxpdDaARWc--:fd-- (level:0)
  const aclDump = section(o, 'acl_dump')
  const dataShareAcl: { kind: 'user' | 'group'; name: string; allow: boolean; perms: string; inherit: string }[] = []
  for (const raw of aclDump.split('\n')) {
    const m = raw.match(/^\s*\[\d+\]\s*(user|group):([^:]+):(allow|deny):([^:\s]+):([^\s]+)/)
    if (!m) continue
    dataShareAcl.push({
      kind: m[1] as 'user' | 'group',
      name: m[2],
      allow: m[3] === 'allow',
      perms: m[4],
      inherit: m[5],
    })
  }

  return {
    docker: dockerV2OK ? 'v2' : dockerV1OK ? 'v1-legacy' : 'missing',
    volume1: volume1Out.startsWith('ok'),
    puid: /^\d+$/.test(puidStr) ? Number(puidStr) : null,
    pgid: /^\d+$/.test(pgidStr) ? Number(pgidStr) : null,
    username: uname || null,
    groupname: gname || null,
    tz,
    lanIps,
    python3: py3OK ? py3Section.replace(/\nRC=0$/, '') : null,
    iptables: iptOK ? iptSection.replace(/\nRC=0$/, '').split('\n')[0] : null,
    sudoMode,
    existingInstall,
    portConflicts,
    disk,
    internet,
    defaultIface,
    defaultIp,
    sshClientIp,
    replyIp,
    dataShareExists,
    dataShareWritable,
    dataShareAcl,
  }
}
