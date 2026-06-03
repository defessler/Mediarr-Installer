// ── Environment detector ──────────────────────────────────────────────────────
// One IPC call → many small SSH execs to fingerprint the NAS:
// PUID/PGID, timezone, LAN IPs, Docker version, Python, iptables, plus
// pre-existing install detection and port-conflict scan.

import { exec, setSessionEffectiveRoot } from './ssh-service.js'
import type { EnvDetectResult, PortConflict } from '../shared/ipc.js'

// Ports the stack binds. Mirrors docker-compose.yml + setup-firewall.sh.
// If a port here is already in use by something else on the NAS, the
// `docker compose up -d` step will fail with "address already in use".
const STACK_PORTS: { port: number; service: string }[] = [
  { port: 32400, service: 'Plex' },
  { port: 8096,  service: 'Jellyfin' },
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
  'plex', 'jellyfin', 'tautulli', 'seerr', 'homepage', 'prowlarr', 'flaresolverr',
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
    // SSH non-interactive shells often have a narrow PATH, which on most
    // NAS distros doesn't include where Docker (or system tools) actually
    // live. Augment with paths used by every NAS family we support so
    // `docker`, `docker compose`, `docker-compose`, AND `iptables` are
    // findable here AND when setup.sh runs later.
    //
    //   /usr/sbin /sbin: Debian-based UGOS (UGREEN) and most Linux distros
    //                 keep `iptables` (and other admin tools) in sbin, and
    //                 a NON-root non-interactive SSH shell on Debian gets
    //                 PATH=/usr/bin:/bin only — so `iptables --version`
    //                 false-reports "missing" without these. (This is the
    //                 #1 reason the REQUIRED iptables check failed on
    //                 UGREEN DXP-series boxes.)
    //   Synology DSM: /var/packages/ContainerManager/target/usr/bin
    //                 /var/packages/Docker/target/usr/bin (legacy)
    //   QNAP QTS:     /share/CACHEDEV1_DATA/.qpkg/container-station/bin
    //                 /share/.qpkg/container-station/bin (some setups)
    //   Unraid:       /usr/local/sbin / /usr/local/bin (already covered)
    //   TrueNAS / Linux: /usr/local/bin / /usr/bin (already covered)
    'export PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin:/var/packages/ContainerManager/target/usr/bin:/var/packages/Docker/target/usr/bin:/share/CACHEDEV1_DATA/.qpkg/container-station/bin:/share/.qpkg/container-station/bin:$PATH"',
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
    // UGREEN UGOS Pro (Debian 12). No single canonical marker file like
    // Synology's synoinfo.conf is documented, so we look at DMI vendor
    // strings (readable by non-root via /sys/class/dmi/id), os-release,
    // and any ugreen/ugos file under /etc. The TS classifier below ALSO
    // applies a heuristic (Debian + /volume1 + not-Synology) so units
    // whose DMI strings don't carry a recognizable marker still resolve
    // to 'ugreen' instead of falling through to generic Linux (which
    // would hand them /opt + /srv defaults that don't match UGOS's
    // /volume1 storage layout).
    'echo "===nas_ugreen==="; ' +
      'if grep -qiE "ugreen|ugos" /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name /sys/class/dmi/id/board_vendor 2>/dev/null ' +
      '   || grep -qiE "ugreen|ugos" /etc/os-release 2>/dev/null ' +
      '   || ls /etc 2>/dev/null | grep -qiE "ugreen|ugos"; then echo y; fi',
    // Debian-base marker — feeds the UGREEN heuristic above.
    'echo "===is_debian==="; [ -f /etc/debian_version ] && echo y || true',
    // Asustor ADM — /volume0 is its non-volatile system volume (unique to
    // Asustor, alongside the /volume1.. data volumes); /etc/nas.conf is a
    // symlink into /volume0 holding the ADM version. Must be matched before
    // the generic-linux fallback so paths land on /volume1 (the data pool),
    // not /opt + /srv (the small system volume).
    'echo "===nas_asustor==="; ( [ -d /volume0 ] && [ -e /etc/nas.conf ] ) && echo y',
    // TerraMaster TOS 6 (Ubuntu/Debian base) — marker dir /etc/tos. Note
    // its storage volume is /Volume1 (CAPITAL V), so the lowercase /volume1
    // checks elsewhere never match it; without this probe TOS falls through
    // to generic linux + /opt defaults that miss the pool.
    'echo "===nas_terramaster==="; ( [ -d /etc/tos ] || ls /etc 2>/dev/null | grep -qiE "^tos$" ) && echo y',
    // ZimaOS (IceWhale appliance; embeds CasaOS) — data root /DATA + the
    // CasaOS stack + a READ-ONLY root filesystem (the appliance trait that
    // distinguishes it from plain CasaOS on a writable distro). os-release
    // may also brand it 'zima'. The read-only probe: a touch in /etc fails.
    'echo "===nas_zimaos==="; ' +
      'if grep -qi "zima" /etc/os-release 2>/dev/null ' +
      '   || ( [ -d /DATA ] && { [ -e /usr/bin/casaos ] || [ -d /var/lib/casaos ]; } && ! touch /etc/.mr-rwprobe 2>/dev/null ); ' +
      'then echo y; fi; rm -f /etc/.mr-rwprobe 2>/dev/null || true',
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
      'for d in /volume1 /volume2 /Volume1 /DATA /mnt/user /mnt/cache /share /share/CACHEDEV1_DATA /mnt /srv; do ' +
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
    // CPU arch + kernel + RAM — drive the 32-bit-ARM hard-block, the
    // FreeBSD (TrueNAS CORE) reject, the arm64 "no HW transcode" warning,
    // and the low-RAM warning. `uname -m`/`-s` + /proc/meminfo are all
    // non-root-readable on every supported family.
    'echo "===arch==="; uname -m 2>/dev/null',
    'echo "===kernel==="; uname -s 2>/dev/null',
    'echo "===mem==="; grep -m1 MemTotal /proc/meminfo 2>/dev/null | awk \'{print $2}\'',
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
    // Disk space where the stack will actually install. Walk up to the
    // nearest existing ancestor of INSTALL_DIR (same trick as
    // install_dir_fs) instead of hardcoding /volume1 — otherwise a
    // generic Linux / Unraid / TrueNAS host (no /volume1) reports
    // "unknown" free space and trips a false low-disk warning.
    'echo "===df==="; ' +
      'p=' + tq + '; ' +
      'while [ -n "$p" ] && [ "$p" != "/" ] && [ ! -e "$p" ]; do p=$(dirname "$p"); done; ' +
      'df -kP "$p" 2>/dev/null | tail -n +2',
    'echo "===netstat==="; netstat -lnt 2>/dev/null | awk \'NR>2 {n=split($4,a,":"); print a[n]}\' | sort -un',
    'echo "===dockerhub==="; curl -sm 5 -o /dev/null -w "%{http_code}" https://registry-1.docker.io/v2/ 2>/dev/null || echo 000',
    'echo "===plextv==="; curl -sm 5 -o /dev/null -w "%{http_code}" https://plex.tv 2>/dev/null || echo 000',
    // DNS resolution fallback — Synology\'s stock curl sometimes fails
    // outbound HTTPS even when the Docker daemon (which has its own
    // network stack) can pull images fine. If DNS resolves and Docker
    // is up, "no curl reachability" is usually a false negative.
    'echo "===dockerhub_dns==="; getent hosts registry-1.docker.io 2>/dev/null | awk \'{print $1; exit}\' || true',
    'echo "===docker_info==="; docker info --format \'{{.ServerVersion}}\' 2>/dev/null || true',
    // /dev/net/tun availability — required by gluetun's WireGuard
    // tunneling. Synology DSM 7 does NOT auto-load the tun module on
    // boot; gluetun appears to start fine but the tunnel never comes
    // up and the healthcheck silently fails after 120s, cascading
    // into "qBittorrent never starts" because of its depends_on:
    // service_healthy gate. Detect early so the user can be told to
    // run `sudo insmod /lib/modules/tun.ko` (or set up a DSM
    // Triggered Task to load it on every boot).
    'echo "===tun_device==="; [ -c /dev/net/tun ] && echo y || echo n',
    // iptables kernel modules — DSM minor updates routinely wipe
    // these out, and any docker container that needs to publish
    // ports (i.e. all of ours) fails to start with cryptic
    // "Operation not permitted" / iptables errors. This has been
    // observed on virtually every DSM 7.x point release.
    // `lsmod | grep ip_tables` returning non-empty means the
    // modules are loaded — we just check existence. The fix
    // (running install_iptables_modules.sh + reboot) is too risky
    // to auto-apply; surface a clear warning so the user can run
    // it manually.
    'echo "===iptables_loaded==="; lsmod 2>/dev/null | grep -qE \'^ip_tables\\b\' && echo y || echo n',
    // /config dir filesystem type — the wizard puts each arr\'s
    // config under INSTALL_DIR (typically /volume1/docker/media/<arr>
    // /config), which on a healthy Synology setup is local ext4/btrfs.
    // But some users put INSTALL_DIR on an NFS or SMB mount (or
    // remote share rclone-mounted into /volume1) — and the arrs use
    // SQLite for their config DB, which corrupts catastrophically on
    // network filesystems. Surface the FS type so the wizard can
    // hard-reject before install starts.
    // The INSTALL_DIR usually doesn't exist yet at detect time (the wizard
    // creates it during install), so stat'ing it directly returns nothing
    // → "unknown", which used to trip the scary "filesystem unknown —
    // SQLite will corrupt" warning on a perfectly healthy box (observed on
    // UGREEN where the default /volume1/docker/media isn't created yet).
    // Walk up to the nearest EXISTING ancestor and report ITS fstype — the
    // dir we create will inherit that filesystem.
    'echo "===install_dir_fs==="; ' +
      'p=' + tq + '; ' +
      'while [ -n "$p" ] && [ "$p" != "/" ] && [ ! -e "$p" ]; do p=$(dirname "$p"); done; ' +
      'stat -f -c "%T" "$p" 2>/dev/null || echo unknown',
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
      'if [ -d /volume1 ]; then ' +
      '  echo /volume1/Data; ' +
      'elif [ -d /Volume1 ]; then ' +
      '  echo /Volume1/data; ' +
      'elif [ -d /DATA ]; then ' +
      '  echo /DATA/Media; ' +
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
      '  if [ -d /volume1 ]; then echo /volume1/Data; ' +
      '  elif [ -d /Volume1 ]; then echo /Volume1/data; ' +
      '  elif [ -d /DATA ]; then echo /DATA/Media; ' +
      '  elif [ -d /mnt/user ]; then echo /mnt/user/data; ' +
      '  elif [ -d /share/CACHEDEV1_DATA ]; then echo /share/Data; ' +
      '  elif [ -d /mnt ]; then for d in /mnt/*; do [ -d "$d" ] || continue; name=$(basename "$d"); case "$name" in user|cache|cache_pool|disks|remotes|rootshare) continue;; esac; echo "$d/data"; break; done; ' +
      '  fi); ' +
      '[ -n "$p" ] && [ -d "$p" ] && echo y || echo n',
    'echo "===data_share_writable==="; ' +
      'p=$( ' +
      '  if [ -d /volume1 ]; then echo /volume1/Data; ' +
      '  elif [ -d /Volume1 ]; then echo /Volume1/data; ' +
      '  elif [ -d /DATA ]; then echo /DATA/Media; ' +
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
  // Treat uid 0 as root even when the account isn't NAMED 'root'. QNAP's
  // `admin`, TerraMaster's superadmin, and others ARE uid 0 with no sudo
  // — without this they'd be detected as needing a (nonexistent) sudo
  // password and every privileged step would fail. We also mark the SSH
  // session effective-root so wrapSudo skips the `sudo` prefix entirely.
  const isRoot = whoami === 'root' || section(o, 'puid') === '0'
  setSessionEffectiveRoot(sessionId, isRoot)
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

  // Host arch / kernel / RAM. cpuArch drives the 32-bit-ARM hard-block +
  // arm64 warning; kernelOs catches FreeBSD (TrueNAS CORE); ramMB the
  // low-memory warning.
  const cpuArch = section(o, 'arch').trim() || null
  const kernelOs = section(o, 'kernel').trim() || null
  const memKB = Number(section(o, 'mem').trim())
  const ramMB = Number.isFinite(memKB) && memKB > 0 ? Math.round(memKB / 1024) : null

  // NAS family fingerprint. Order matters — Synology DSM, then the
  // distros that mimic Synology paths (none today), then the others.
  // Used to pick sensible defaults for INSTALL_DIR / DATA_ROOT and
  // gate Synology-only features like the `synoacltool` ACL grant.
  let nasFamily: EnvDetectResult['nasFamily']
  // Synology shares the /volume1 layout with UGREEN, so it must be checked
  // first via its definitive /etc/synoinfo.conf marker. UGREEN UGOS is a
  // Debian box with /volume1 but no synoinfo — match its explicit DMI/
  // os-release marker, then fall back to the heuristic "Debian + /volume1
  // + not Synology" for units whose DMI strings don't say "UGREEN".
  const hasVolume1 = volume1Out.startsWith('ok')
  const isDebian = section(o, 'is_debian') === 'y'
  if (section(o, 'nas_synology') === 'y')        nasFamily = 'synology'
  else if (section(o, 'nas_ugreen')  === 'y')    nasFamily = 'ugreen'
  else if (section(o, 'nas_asustor') === 'y')    nasFamily = 'asustor'
  else if (section(o, 'nas_terramaster') === 'y') nasFamily = 'terramaster'
  else if (section(o, 'nas_zimaos')  === 'y')    nasFamily = 'zimaos'
  else if (section(o, 'nas_qnap')    === 'y')    nasFamily = 'qnap'
  else if (section(o, 'nas_unraid')  === 'y')    nasFamily = 'unraid'
  else if (section(o, 'nas_truenas') === 'y')    nasFamily = 'truenas'
  else if (section(o, 'nas_omv')     === 'y')    nasFamily = 'omv'
  else if (isDebian && hasVolume1)               nasFamily = 'ugreen'
  else                                            nasFamily = 'linux'

  // Confidence in that classification: high when a definitive OS marker
  // file matched, low when only the Debian+/volume1 heuristic fired
  // (could be a plain Debian box with a stray /volume1), unknown when
  // nothing matched and we fell through to generic 'linux'. The Detect
  // screen nudges the user to confirm paths when it's not 'high'.
  const markerMatched =
    section(o, 'nas_synology')    === 'y' ||
    section(o, 'nas_ugreen')      === 'y' ||
    section(o, 'nas_asustor')     === 'y' ||
    section(o, 'nas_terramaster') === 'y' ||
    section(o, 'nas_zimaos')      === 'y' ||
    section(o, 'nas_qnap')        === 'y' ||
    section(o, 'nas_unraid')      === 'y' ||
    section(o, 'nas_truenas')     === 'y' ||
    section(o, 'nas_omv')         === 'y'
  const familyConfidence: EnvDetectResult['familyConfidence'] =
    nasFamily === 'linux' ? 'unknown' : markerMatched ? 'high' : 'low'

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

  // ── Platform readiness probes (Synology-DSM-specific gotchas) ────────────
  //
  // Three "host needs attention" conditions that don't surface during the
  // install itself but make the stack quietly broken afterwards:
  //
  //   - tun device missing: gluetun's tunnel never comes up; WireGuard
  //     looks healthy briefly then times out. qBittorrent's
  //     depends_on:service_healthy gate then fails for several minutes
  //     before the wizard's retry budget gives up. On DSM7, /dev/net/
  //     tun doesn't auto-create — module needs explicit insmod.
  //
  //   - iptables modules unloaded: DSM minor updates wipe these
  //     periodically; docker can't program NAT and "Operation not
  //     permitted" errors trip every `docker compose up`. We detect via
  //     `lsmod | grep ip_tables`; recovery is the community
  //     install_iptables_modules.sh script + reboot, which is too
  //     destructive to auto-apply.
  //
  //   - install dir on a network filesystem: SQLite (Sonarr/Radarr/etc
  //     config DBs) corrupts catastrophically on NFS/CIFS/fuse mounts.
  //     `stat -f -c %T` returns 'nfs', 'cifs', 'fuse.X', etc. when
  //     non-local. We reject those and force the user to relocate.
  const tunDevice = section(o, 'tun_device').trim() === 'y'
  const iptablesLoaded = section(o, 'iptables_loaded').trim() === 'y'
  const installDirFs = section(o, 'install_dir_fs').trim() || null

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
    tunDevice,
    iptablesLoaded,
    installDirFs,
    nasFamily,
    osVersion,
    dataCandidates,
    suggestedInstallDir: familyDefaults.installDir,
    suggestedDataRoot:   familyDefaults.dataRoot,
    suggestedPuid:       pickFamilyIdDefaults(nasFamily).puid,
    suggestedPgid:       pickFamilyIdDefaults(nasFamily).pgid,
    cpuArch,
    kernelOs,
    ramMB,
    familyConfidence,
  }
}

/** Family-aware PUID/PGID fallback. The Configure screen prefers the
 *  user dropdown (driven by reading /etc/passwd over SSH), but when that
 *  hasn't loaded yet — or the user types in INSTALL_DIR before connecting
 *  — these defaults seed the form with a value that's at least valid for
 *  the detected NAS family.
 *
 *  The historical baseline was '1026'/'100' (Synology convention: PUID
 *  starts at 1026 because DSM reserves 1000-1025 for system services).
 *  That breaks on every other family:
 *    - Unraid: nobody=99 / users=100 — the linuxserver/* images
 *      explicitly look for these and chown -R on every boot.
 *    - TrueNAS SCALE: apps=568 / apps=568 — k3s creates this user.
 *    - QNAP / OMV / generic Linux: 1000/100 is the convention for the
 *      first interactive user.
 *
 *  Used as a fallback only — the user dropdown overrides this once it
 *  populates from the real /etc/passwd. */
function pickFamilyIdDefaults(
  family: EnvDetectResult['nasFamily'],
): { puid: string; pgid: string } {
  switch (family) {
    case 'synology': return { puid: '1026', pgid: '100' }
    // UGOS first admin user is uid 1000, primary group `admin` = gid 10.
    case 'ugreen':   return { puid: '1000', pgid: '10'  }
    // Asustor admin / TerraMaster first user / generic NAS: 1000 + group
    // `users`(100). (Asustor's admin is sometimes uid 999, TerraMaster's is
    // uid 0 — the /etc/passwd dropdown corrects either.)
    case 'asustor':     return { puid: '1000', pgid: '100' }
    case 'terramaster': return { puid: '1000', pgid: '100' }
    // ZimaOS/CasaOS run containers as 1000/1000 by convention.
    case 'zimaos':      return { puid: '1000', pgid: '1000' }
    case 'unraid':   return { puid: '99',   pgid: '100' }
    case 'truenas':  return { puid: '568',  pgid: '568' }
    case 'qnap':     return { puid: '1000', pgid: '100' }
    case 'omv':      return { puid: '1000', pgid: '100' }
    default:         return { puid: '1000', pgid: '1000' }
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
    case 'ugreen':
      // UGOS Pro mounts its storage pool at /volume1 (a real btrfs mount,
      // same convention as DSM — minus Synology's shared-folder ACL
      // layer). Installing the UGOS Docker app auto-creates the `docker`
      // shared folder at /volume1/docker, so the compose tree fits under
      // /volume1/docker/media and user media under /volume1/Data, exactly
      // like Synology. (Falling through to the generic-Linux /opt + /srv
      // defaults would point at paths that aren't on the storage pool.)
      return {
        installDir: '/volume1/docker/media',
        dataRoot:   '/volume1/Data',
      }
    case 'asustor':
      // Asustor ADM: data pools at /volume1.. (the /volume0 system volume
      // is off-limits). App Central's Docker app stores under /volume1; a
      // user-created "Docker" share is the conventional home for compose.
      return {
        installDir: '/volume1/Docker/mediarr',
        dataRoot:   '/volume1/Data',
      }
    case 'terramaster':
      // TerraMaster TOS mounts its volume at /Volume1 (capital V), with an
      // `appdata` share convention. (Not /volume1 — that's Synology/UGREEN.)
      return {
        installDir: '/Volume1/docker/media',
        dataRoot:   '/Volume1/data',
      }
    case 'zimaos':
      // ZimaOS root FS is READ-ONLY — only /DATA is writable, so both the
      // compose tree and media MUST live there (the generic /opt + /srv
      // defaults would fail to write). /DATA/AppData/<app> is the CasaOS
      // convention ZimaOS inherits.
      return {
        installDir: '/DATA/AppData/mediarr',
        dataRoot:   '/DATA/Media',
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
