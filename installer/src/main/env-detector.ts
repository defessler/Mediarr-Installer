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
    // SSH non-interactive shells often have a narrow PATH (just
    // /usr/bin:/bin:/usr/sbin:/sbin), which on most NAS distros
    // doesn't include where Docker actually installs its binaries.
    // Augment with paths used by every NAS family we support so
    // `docker`, `docker compose`, and `docker-compose` are findable
    // here AND when setup.sh runs later.
    //
    //   Synology DSM: /var/packages/ContainerManager/target/usr/bin
    //                 /var/packages/Docker/target/usr/bin (legacy)
    //   QNAP QTS:     /share/CACHEDEV1_DATA/.qpkg/container-station/bin
    //                 /share/.qpkg/container-station/bin (some setups)
    //   Unraid:       /usr/local/sbin / /usr/local/bin (already covered)
    //   TrueNAS / Linux: /usr/local/bin / /usr/bin (already covered)
    'export PATH="/usr/local/bin:/usr/local/sbin:/var/packages/ContainerManager/target/usr/bin:/var/packages/Docker/target/usr/bin:/share/CACHEDEV1_DATA/.qpkg/container-station/bin:/share/.qpkg/container-station/bin:$PATH"',
    'set +e',
    // NAS family fingerprint. Multiple signals matter — some Synology
    // boxes have /volume1 mirrored on Unraid hosts when users symlink
    // things, so we look at OS-level marker files first. Highest-
    // specificity match wins (Synology's /etc/synoinfo.conf, QNAP's
    // /etc/config/qpkg.conf, Unraid's /etc/unraid-version, TrueNAS's
    // /etc/version content). Generic Linux is the fallback.
    'echo "===nas_synology==="; [ -f /etc/synoinfo.conf ] && echo y',
    'echo "===nas_qnap==="; ( [ -f /etc/config/qpkg.conf ] || [ -d /etc/init.d/QPKG.conf ] || [ -d /share/CACHEDEV1_DATA ] ) && echo y',
    'echo "===nas_unraid==="; [ -f /etc/unraid-version ] && echo y',
    'echo "===nas_truenas==="; ( grep -qiE "truenas|freenas" /etc/version 2>/dev/null || [ -f /etc/truenas_version ] ) && echo y',
    'echo "===nas_omv==="; ( [ -f /etc/openmediavault/config.xml ] || dpkg -l openmediavault 2>/dev/null | grep -q "^ii" ) && echo y',
    // OS version string the NAS reports (helps surface DSM7.2 vs 7.1, etc.)
    'echo "===os_version==="; ' +
      '( [ -f /etc.defaults/VERSION ] && grep -E "^productversion|^buildnumber" /etc.defaults/VERSION ) || ' +
      '( [ -f /etc/unraid-version ] && cat /etc/unraid-version ) || ' +
      '( [ -f /etc/version ] && head -1 /etc/version ) || ' +
      'uname -r',
    // Candidate "data share" roots — directories the user's media most
    // likely lives under. We don't pick one; we surface all that exist
    // so the Detect screen can show the candidates and the user picks
    // (or the wizard auto-picks the first match for their NAS family).
    'echo "===data_candidates==="; ' +
      'for d in /volume1 /volume2 /mnt/user /mnt/cache /share /share/CACHEDEV1_DATA /mnt /srv; do ' +
      '  [ -d "$d" ] && echo "$d"; ' +
      'done',
    // TrueNAS-style pool roots: enumerate top-level dirs under /mnt
    // (each pool gets mounted as /mnt/<poolname>). We skip the
    // /mnt/user and /mnt/cache used by Unraid since those already
    // got picked up by the candidates list above. Lets the family
    // defaults below name the actual pool the user has instead of
    // guessing "tank" — most TrueNAS installs use whatever the user
    // typed during pool creation (storage, main, tank, default, etc).
    'echo "===mnt_children==="; ' +
      'if [ -d /mnt ]; then ' +
      '  for d in /mnt/*; do ' +
      '    [ -d "$d" ] || continue; ' +
      '    name=$(basename "$d"); ' +
      '    case "$name" in user|cache|cache_pool|disks|remotes|rootshare) continue;; esac; ' +
      '    echo "$d"; ' +
      '  done; ' +
      'fi',
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
    // Data-directory probes — the source of the long-running "Sonarr
    // says root folder doesn\'t exist" trap on Synology, but a generic
    // "does the data tree exist + is it writable as my user" check on
    // every NAS family. We do FOUR pieces of output:
    //   1. data_share_path:    the path we ended up probing (so the UI
    //                          can show "Data dir /mnt/user/data" not
    //                          a misleading "/volume1/Data" on Unraid)
    //   2. data_share_exists:  is that dir present at all?
    //   3. data_share_writable: can the SSH user (whose UID typically
    //      matches PUID) write to it? Same probe the wizard\'s install-
    //      time [acl] step does — running it here gives an early
    //      warning instead of failing at install. We deliberately do
    //      NOT require sudo — the SSH user must be able to write under
    //      their own identity, which is what the arr containers will
    //      be doing with PUID set.
    //   4. acl_dump:           Synology-only — synoacltool output for
    //                          the data dir. Empty on every other family
    //                          (the binary doesn\'t exist there).
    //
    // Family-aware path picker: matches the same OS markers we read for
    // nasFamily above, so the probe targets the dir we\'ll actually
    // suggest as DATA_ROOT in pickFamilyDefaults(). The UI maps these
    // back to the family-appropriate fix instructions (DSM Control Panel
    // vs `mkdir -p && chown` vs Unraid Settings → Shares).
    'echo "===data_share_path==="; ' +
      'if [ -f /etc/synoinfo.conf ] && [ -d /volume1 ]; then ' +
      '  echo /volume1/Data; ' +
      'elif [ -d /mnt/user ]; then ' +
      '  echo /mnt/user/data; ' +
      'elif [ -d /share/CACHEDEV1_DATA ]; then ' +
      '  echo /share/Data; ' +
      'elif [ -d /mnt ]; then ' +
      '  for d in /mnt/*; do ' +
      '    [ -d "$d" ] || continue; ' +
      '    name=$(basename "$d"); ' +
      '    case "$name" in user|cache|cache_pool|disks|remotes|rootshare) continue;; esac; ' +
      '    echo "$d/data"; break; ' +
      '  done; ' +
      'fi',
    'echo "===data_share_exists==="; ' +
      'p=$( ' +
      '  if [ -f /etc/synoinfo.conf ] && [ -d /volume1 ]; then echo /volume1/Data; ' +
      '  elif [ -d /mnt/user ]; then echo /mnt/user/data; ' +
      '  elif [ -d /share/CACHEDEV1_DATA ]; then echo /share/Data; ' +
      '  elif [ -d /mnt ]; then for d in /mnt/*; do [ -d "$d" ] || continue; name=$(basename "$d"); case "$name" in user|cache|cache_pool|disks|remotes|rootshare) continue;; esac; echo "$d/data"; break; done; ' +
      '  fi); ' +
      '[ -n "$p" ] && [ -d "$p" ] && echo y || echo n',
    'echo "===data_share_writable==="; ' +
      'p=$( ' +
      '  if [ -f /etc/synoinfo.conf ] && [ -d /volume1 ]; then echo /volume1/Data; ' +
      '  elif [ -d /mnt/user ]; then echo /mnt/user/data; ' +
      '  elif [ -d /share/CACHEDEV1_DATA ]; then echo /share/Data; ' +
      '  elif [ -d /mnt ]; then for d in /mnt/*; do [ -d "$d" ] || continue; name=$(basename "$d"); case "$name" in user|cache|cache_pool|disks|remotes|rootshare) continue;; esac; echo "$d/data"; break; done; ' +
      '  fi); ' +
      'if [ -n "$p" ] && [ -d "$p" ]; then ' +
      '  if touch "$p/.mediarr-detect-probe" 2>/dev/null && rm "$p/.mediarr-detect-probe" 2>/dev/null; then ' +
      '    echo y; ' +
      '  else echo n; fi; ' +
      'else echo skip; fi',
    // Snapshot of the current Synology ACL on the data dir so we can
    // show the user "here\'s who has access right now" if the write
    // probe fails. Synology-only — synoacltool only exists on DSM, and
    // the ACL concept doesn\'t apply on Unraid/TrueNAS/QNAP where
    // POSIX permissions are the whole story. The probe-binary path
    // resolution stays the same since DSM puts synoacltool outside
    // the SSH non-interactive PATH.
    'echo "===acl_dump==="; ' +
      'if [ -f /etc/synoinfo.conf ]; then ' +
      '  for c in /usr/syno/bin/synoacltool /usr/syno/sbin/synoacltool /usr/local/bin/synoacltool /usr/bin/synoacltool; do ' +
      '    if [ -e "$c" ]; then "$c" -get /volume1/Data 2>/dev/null && break; fi; ' +
      '  done; ' +
      'fi',
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

  // NAS family fingerprint. Order matters — Synology DSM, then the
  // distros that mimic Synology paths (none today), then the others.
  // Used to pick sensible defaults for INSTALL_DIR / DATA_ROOT and
  // gate Synology-only features like the `synoacltool` ACL grant.
  let nasFamily: EnvDetectResult['nasFamily']
  if (section(o, 'nas_synology') === 'y')      nasFamily = 'synology'
  else if (section(o, 'nas_qnap')    === 'y')  nasFamily = 'qnap'
  else if (section(o, 'nas_unraid')  === 'y')  nasFamily = 'unraid'
  else if (section(o, 'nas_truenas') === 'y')  nasFamily = 'truenas'
  else if (section(o, 'nas_omv')     === 'y')  nasFamily = 'omv'
  else                                          nasFamily = 'linux'

  // The candidate data-share roots that actually exist on this host,
  // in the order the detection probe walked. The renderer picks one
  // (defaulting to the first that matches family expectations, or
  // letting the user override).
  const dataCandidatesBase = section(o, 'data_candidates')
    .split('\n').map((l) => l.trim()).filter(Boolean)
  const mntChildren = section(o, 'mnt_children')
    .split('\n').map((l) => l.trim()).filter(Boolean)
  // Merge enumerated /mnt pool children into the candidates list so the
  // Detect screen's "Other share roots present" surfaces them as
  // quick-pick options the user can click. Stable order: probed
  // standard dirs first, then the dynamically-found pool mounts.
  const dataCandidates = [
    ...dataCandidatesBase,
    ...mntChildren.filter((p) => !dataCandidatesBase.includes(p)),
  ]

  // Pre-compute the family-appropriate defaults so the renderer doesn't
  // need to know the conventions — single source of truth lives here.
  const familyDefaults = pickFamilyDefaults(nasFamily, dataCandidates, mntChildren)
  const osVersion = section(o, 'os_version').split('\n')[0]?.trim() || null

  // Data-directory check — surfaced on the Detect screen so the user
  // can fix the data dir BEFORE clicking Install (Synology DSM share
  // permissions, or missing dir on Unraid/TrueNAS/QNAP). The wizard's
  // install-time [acl] step + setup-folders.sh still cover this as a
  // backup, but this gives an earlier signal.
  //
  // dataSharePath is the path we actually probed (Synology → /volume1/
  // Data, Unraid → /mnt/user/data, QNAP → /share/Data, TrueNAS →
  // /mnt/<pool>/data) so the UI can name it accurately instead of the
  // misleading hardcoded "/volume1/Data" on non-Synology hosts.
  const dataSharePath = section(o, 'data_share_path').split('\n')[0]?.trim() || null
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
    dataSharePath,
    dataShareExists,
    dataShareWritable,
    dataShareAcl,
    nasFamily,
    osVersion,
    dataCandidates,
    suggestedInstallDir: familyDefaults.installDir,
    suggestedDataRoot:   familyDefaults.dataRoot,
  }
}

/** Family-aware path defaults. Single source of truth for "where does
 *  this NAS family conventionally put media + appdata?" — used by the
 *  Detect screen to populate Configure's INSTALL_DIR / DATA_ROOT fields
 *  with values the user can keep or override.
 *
 *  We bias toward the EXISTING candidate dirs we found at detect time
 *  so the suggestion isn't a phantom path that doesn't exist. */
function pickFamilyDefaults(
  family: EnvDetectResult['nasFamily'],
  candidates: string[],
  mntChildren: string[] = [],
): { installDir: string; dataRoot: string } {
  const has = (p: string) => candidates.includes(p)
  switch (family) {
    case 'synology':
      // DSM convention: /volume1 (or /volume2 if user picked that for
      // Docker). The "Docker" shared folder on Synology DSM is the
      // canonical home for compose stacks. /volume1 is overwhelmingly
      // the default; the ~3% of users on /volume2 just edit the
      // Configure-screen field to point at the right volume.
      return {
        installDir: '/volume1/docker/media',
        dataRoot:   '/volume1/Data',
      }
    case 'qnap':
      // QNAP exposes Container Station's working dir under /share/Container.
      // Shared folders are under /share/<name>/ (symlinks to /share/
      // CACHEDEV*_DATA/<name>). The wizard's compose tree fits under
      // /share/Container/mediarr.
      return {
        installDir: '/share/Container/mediarr',
        dataRoot:   has('/share/Data') ? '/share/Data' : '/share/Multimedia',
      }
    case 'unraid':
      // Unraid: /mnt/user/appdata for service configs (cache pool moves
      // it to /mnt/cache/appdata for fast SSD I/O), /mnt/user for shares.
      return {
        installDir: '/mnt/user/appdata/mediarr',
        dataRoot:   '/mnt/user/data',
      }
    case 'truenas': {
      // TrueNAS SCALE: ZFS datasets at /mnt/<pool>/<dataset>. Pool
      // names vary wildly (tank, storage, main, default, anything the
      // user typed during pool creation). Use the first pool we
      // actually found at /mnt/*; only fall back to /mnt/tank when
      // nothing exists yet (fresh box / no pool created yet — the
      // user would obviously need to fix that before installing).
      const pool = mntChildren[0] ?? '/mnt/tank'
      return {
        installDir: `${pool}/apps/mediarr`,
        dataRoot:   `${pool}/data`,
      }
    }
    case 'omv':
      // OpenMediaVault: shared folders typically under /srv/<uuid>/<name>
      // OR /export/<name> via symlink. Hard to guess without listing.
      return {
        installDir: '/srv/mediarr',
        dataRoot:   '/srv/data',
      }
    default:
      // Generic Linux server — go with FHS conventions.
      return {
        installDir: '/opt/mediarr',
        dataRoot:   '/srv/data',
      }
  }
}
