// TroubleshootingModal — opens from the footer Help button. Curated
// list of "issue → cause → fix" entries derived from real-world failures
// during multi-NAS testing. Searchable, copy-to-clipboard on every
// command snippet, sections kept tight so the user can scan to their
// symptom quickly.
//
// Why curated text vs. linking to docs / wiki:
//   - Most issues require a SPECIFIC command sequence with the user's
//     install dir in it. Bundling makes the helper text correct for
//     this user's actual setup; a wiki page would have to use a
//     generic path the user has to mentally translate.
//   - Offline-first: the wizard runs on a user's PC controlling a NAS,
//     often through SSH on a flaky home network. Help that needs the
//     internet would fail at the moment it's most needed.

import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  HelpCircle, Search, X, Clipboard, ClipboardCheck, ExternalLink, SearchX,
} from 'lucide-react'
import { BigButton } from './BigButton.js'

interface TItem {
  /** Top-level grouping shown as a section header in the modal. */
  category: string
  /** What the user sees / the error they Googled. Title-cased. */
  symptom: string
  /** Plain-English explanation of why this happens — the "aha" line. */
  cause: string
  /** Plain-English fix; can be empty if the command is self-explanatory. */
  fix?: string
  /** Optional shell command(s) the user can copy. Multi-line ok.
   *  Use `<INSTALL_DIR>` as a literal placeholder — render renders it
   *  as a styled chip so the user knows to substitute their path. */
  command?: string
}

// Order chosen so the most common / most painful issues come first.
// Each entry was a real bug we hit during the install hardening passes.
const ITEMS: TItem[] = [
  // ── Walkthrough pointer ─────────────────────────────────────────────
  // First entry shows up as the very top of the modal when no search is
  // active. Mirrors the green-banner pointer in the header so a beginner
  // who scans the entry list still finds the tutorial.
  {
    category: 'New to this? Start here',
    symptom: 'I\'ve never installed Docker / SSH\'d into a NAS / used the command line',
    cause:
      'You don\'t need to — the wizard handles all of that. There\'s a full beginner\'s walkthrough in INSTALL.md on GitHub that covers everything from enabling SSH on your NAS through adding your first show in Sonarr/Radarr.',
    fix:
      'Open https://github.com/defessler/NAS-Arr-Stack/blob/master/INSTALL.md in your browser. It walks through the whole install with ASCII mockups of each wizard screen, what to type in each field, and what to do once each service is running.',
  },

  // ── Install failures ────────────────────────────────────────────────
  {
    category: 'Install failed or timed out',
    symptom: 'Remote command timed out after 60s — sudo password error',
    cause:
      'The prep step\'s recursive chown was walking the full install tree (Plex metadata = hundreds of thousands of files on spinning rust). The 60s timeout fired before chown finished, and the wizard\'s catch-all error message blamed sudo.',
    fix:
      'Update to the latest wizard build. The prep step now skips the recursive chown when ownership is already correct, and the timeout for first runs is 10 minutes.',
  },
  {
    category: 'Install failed or timed out',
    symptom: '"Path does not exist" on Sonarr/Radarr root folders',
    cause:
      'On Synology DSM, shared folders have a separate ACL layer on top of POSIX permissions. The containers run as PUID 1026 and can\'t see writeability through the shared-folder ACL even though POSIX says yes.',
    fix:
      'The wizard applies the ACL automatically via synoacltool. If it still trips, grant your SSH user Read/Write on the Data share in DSM → Control Panel → Shared Folder → Data → Edit → Permissions.',
  },
  {
    category: 'Install failed or timed out',
    symptom: 'Sonarr port 49152 already in use',
    cause:
      'Synology\'s Media Server package binds 49152 for DLNA/UPnP. The wizard\'s arr ports overlap the IANA dynamic range, which DLNA also uses.',
    fix:
      'DSM → Package Center → Media Server → Stop (or uninstall). Then re-run setup.sh. The wizard\'s pre-flight port check will catch this on the next run.',
  },

  // ── qBittorrent ─────────────────────────────────────────────────────
  {
    category: 'qBittorrent',
    symptom: 'WebUI HTTP 000 (not reachable) — container is running',
    cause:
      'qBit logs "WebUI will be started shortly after internal preparations. Please wait..." then spends time on those preparations (loading BT_backup/, verifying torrent integrity, BT session init) BEFORE binding the WebUI port. On Synology spinning rust with a sizeable resume set, this can take 3-5 minutes — much longer than the wizard\'s install-time retry budget. Less common but real: corrupted resume data from prior partial installs locks the process up entirely.',
    fix:
      'Wait 3-5 minutes from container start and retry. The bundled restart-qbit.sh helper does an orderly recreate that gives qBit time to initialize cleanly. If it\'s STILL not binding after 5 minutes, the state\'s corrupted — reset the config dir (commands below).',
    command:
      `# First try a clean restart (gluetun-aware, gives qBit time to init):
bash <INSTALL_DIR>/restart-qbit.sh
sleep 60
curl -sf -o /dev/null -w "qBit HTTP: %{http_code}\\n" http://localhost:49156

# Still 000? Nuclear option — reset qBit's config (preserves downloads):
cd <INSTALL_DIR>
docker compose stop qbittorrent
mv qbittorrent/config qbittorrent/config.broken-$(date +%Y%m%d-%H%M%S)
mkdir -p qbittorrent/config
chown 1026:100 qbittorrent/config
bash setup.sh`,
  },
  {
    category: 'qBittorrent',
    symptom: 'qBit downloads complete on disk but arrs don\'t see them',
    cause:
      'qBit\'s download engine and its WebUI server are two separate things. The engine can keep downloading torrents perfectly while the WebUI is unresponsive. Sonarr/Radarr/Lidarr poll qBit\'s WebUI for download status — if the WebUI is dead, the arrs see an empty queue and never trigger imports, even though the files are sitting on disk.',
    fix:
      'Two-step recovery: (1) get qBit\'s WebUI back up with restart-qbit.sh — Sonarr/Radarr will resume polling within 60s. (2) For the backlog of already-completed-but-never-imported downloads, kick a manual scan at each arr\'s API. The commands below do both.',
    command:
      `# 1. Fix qBit's WebUI:
bash <INSTALL_DIR>/restart-qbit.sh

# 2. Tell each arr to scan its completed-downloads folder:
SONARR_KEY=$(grep '^SONARR_API_KEY=' <INSTALL_DIR>/.env | cut -d= -f2)
RADARR_KEY=$(grep '^RADARR_API_KEY=' <INSTALL_DIR>/.env | cut -d= -f2)
LIDARR_KEY=$(grep '^LIDARR_API_KEY=' <INSTALL_DIR>/.env | cut -d= -f2)

curl -X POST -H "X-Api-Key: $SONARR_KEY" -H "Content-Type: application/json" \\
  "http://localhost:49152/api/v3/command" \\
  -d '{"name": "DownloadedEpisodesScan", "path": "/data/Downloads/Torrents/Completed/tv-sonarr"}'

curl -X POST -H "X-Api-Key: $RADARR_KEY" -H "Content-Type: application/json" \\
  "http://localhost:49151/api/v3/command" \\
  -d '{"name": "DownloadedMoviesScan", "path": "/data/Downloads/Torrents/Completed/radarr"}'

curl -X POST -H "X-Api-Key: $LIDARR_KEY" -H "Content-Type: application/json" \\
  "http://localhost:49154/api/v1/command" \\
  -d '{"name": "DownloadedAlbumsScan", "path": "/data/Downloads/Torrents/Completed/lidarr"}'`,
  },
  {
    category: 'qBittorrent',
    symptom: '"container must join at least one network" on restart',
    cause:
      'When VPN_ENABLED=true, qBittorrent shares gluetun\'s network namespace (network_mode: container:gluetun, switched from service:gluetun in the latest build to dodge a startup race where qBit booted before gluetun had finished setting up its namespace). Docker enforces this hard either way: if gluetun is down or its namespace has been recreated, restarting qBit fails with this exact error.',
    fix:
      'Use the bundled helper script — it brings gluetun up first, waits for its healthcheck, then recreates qBit against the live namespace.',
    command: `bash <INSTALL_DIR>/restart-qbit.sh`,
  },
  {
    category: 'qBittorrent',
    symptom: 'qBit broken every time the NAS reboots (must run restart-qbit.sh manually)',
    cause:
      'On NAS reboot, Docker auto-restarts containers in arbitrary order. qBit (network_mode: container:gluetun) often tries to start BEFORE gluetun\'s namespace exists, fails with "must join at least one network," then enters Docker\'s exponential restart backoff (100ms → 200ms → 400ms → ... → minutes between retries). Even after gluetun is up, qBit can stay stuck for 10+ min before its backoff timer elapses. `depends_on` in compose doesn\'t help here because the docker daemon\'s restart-policy path doesn\'t honor compose semantics — only `docker compose up` does.',
    fix:
      'Wire boot-orchestrator.sh as a Synology Task Scheduler triggered task. It waits for the Docker daemon, then runs `docker compose up -d` with the right profile flags — compose respects depends_on, so gluetun starts first and qBit comes up cleanly. Set this once; future reboots are hands-off.',
    command:
      `# Synology DSM:
#   Control Panel → Task Scheduler → Create → Triggered Task →
#     User-defined script (run as root)
#   Task name:  Mediarr stack — boot orchestrator
#   Event:      Boot-up
#   Run command:
#     bash <INSTALL_DIR>/boot-orchestrator.sh

# Verify it works without rebooting:
sudo bash <INSTALL_DIR>/boot-orchestrator.sh
tail -20 <INSTALL_DIR>/boot-orchestrator.log`,
  },
  {
    category: 'Sonarr / Radarr / Lidarr / Prowlarr',
    symptom: 'Lots of [Warn] entries in Sonarr/Radarr/Lidarr logs about Torznab / HTTP errors',
    cause:
      'Most "warning" entries in the arrs\' logs are normal indexer background noise — public indexers rate-limit aggressively ("API Request Limit reached for Knaben — Disabled for 00:01:00"), occasionally go down ("Knaben server is currently unavailable"), or have RSS sync gaps ("rss sync didn\'t cover the period between..."). The arrs log these at Warn but they auto-recover; nothing is actually broken. Not actionable from the wizard.',
    fix:
      'Filter the noise — three actually-actionable patterns: (1) "API Request Limit reached for AvistaZ — Disabled for 01:00:00" = creds wrong or quota exhausted (verify AVISTAZ_USER/PASS/PID in .env). (2) "Indexer X disabled due to failures" persistent = run tune-arrs.sh which auto-disables broken indexers. (3) "rss sync didn\'t cover the period" = your RSS interval is shorter than indexer rate limits allow — bump Sonarr → Settings → General → RSS Sync Interval from 15 → 30 min.',
    command:
      `# Auto-disable broken indexers (handles cause #2):
sudo bash <INSTALL_DIR>/tune-arrs.sh

# Verify AvistaZ creds (cause #1) — if these are blank or invalid, drop
# them from .env so the wizard stops trying to add the indexer:
grep -E '^AVISTAZ_(USER|PASS|PID)=' <INSTALL_DIR>/.env`,
  },
  {
    category: 'qBittorrent',
    symptom: 'qBittorrent login rejected (qBit replied "Fails.")',
    cause:
      'The WebUI password in your .env doesn\'t match qBit\'s qBittorrent.conf. Usually happens when you changed the password manually in the qBit UI after a previous install.',
    fix:
      'Either change the .env QBITTORRENT_PASS to match what\'s in qBit\'s UI, or wipe qBit\'s conf so the next setup.sh re-applies the .env value.',
    command:
      `rm <INSTALL_DIR>/qbittorrent/config/qBittorrent/qBittorrent.conf
docker compose restart qbittorrent
sudo bash <INSTALL_DIR>/setup.sh`,
  },
  {
    category: 'qBittorrent',
    symptom: 'WebUI is up but the Mediarr Installer can\'t reach it',
    cause:
      'qBit\'s WebUI subnet whitelist excludes your PC\'s IP, AND the password our wizard sends doesn\'t match qBit\'s actual hash. Without the whitelist match, qBit checks the password. Without a matching password, it returns "Fails."',
    fix:
      'Make sure your PC is on the 192.168.x / 10.x / 172.16-31.x range that\'s in qBit\'s default whitelist. If you\'re on a different subnet, add it via the qBit UI → Tools → Options → WebUI → Bypass authentication for clients in subnets.',
  },

  // ── Tautulli ────────────────────────────────────────────────────────
  {
    category: 'Tautulli',
    symptom: '"Unable to initialize Tautulli due to a corrupted config file"',
    cause:
      'A previous version of the wizard wrote Tautulli\'s config.ini with Python\'s ConfigParser using the default percent-sign interpolation. Tautulli\'s config has literal % characters in values, which the parser mangled on round-trip.',
    fix:
      'The latest wizard build uses interpolation=None and won\'t corrupt it. To recover: backup and delete the broken file — Tautulli regenerates a fresh one on next start, then re-run setup.sh to wire it to Plex.',
    command:
      `cd <INSTALL_DIR>
docker compose stop tautulli
mv tautulli/config/config.ini tautulli/config/config.ini.broken-$(date +%Y%m%d-%H%M%S)
docker compose up -d tautulli
sleep 60
sudo bash setup.sh`,
  },
  {
    category: 'Tautulli',
    symptom: 'Tautulli container is exited (status=exited, exit=0)',
    cause:
      'Old wizard builds ran "docker compose stop tautulli" + "up -d" which created a fresh container instance and retriggered LSIO\'s first-boot init path — the container would sometimes exit during slow-disk init and the unless-stopped policy got confused by the prior user-stop and didn\'t bring it back. Latest build uses "docker compose restart" + a 30s readiness poll so this should no longer recur; if it does, restart manually.',
    fix:
      'Just bring it back up. The wizard auto-detects this on its next run and surfaces a specific recovery hint.',
    command: `docker start tautulli`,
  },

  // ── Arr auth ────────────────────────────────────────────────────────
  {
    category: 'Sonarr / Radarr / Lidarr / Prowlarr',
    symptom: '"Auth: couldn\'t auto-apply credentials" warning',
    cause:
      'When the wizard PUTs an auth config change, the arr immediately cycles its API session, and the response packet races with the cycle. urllib reports ConnectionResetError → our PUT helper returns None. The verify-after-PUT loop confirms the change actually landed in most cases now; this warning means the verify also timed out (rare on the latest build).',
    fix:
      'Set it manually in the UI. Each arr → Settings → General → Security. Set Authentication = Forms, Authentication Required = Disabled for Local Addresses, Username/Password = whatever you put in the wizard.',
  },
  {
    category: 'Sonarr / Radarr / Lidarr / Prowlarr',
    symptom: 'BULK FIX: backlog of "Completed" downloads not importing',
    cause:
      'Whatever the underlying cause (qBit/SAB polling drift, paths not being walked, fresh install with pre-existing files in /data/Downloads, post-restart re-discovery lag), the fix is to tell each arr "scan your completed-downloads folder right now" via its API. This bypasses the download-client polling chain entirely.',
    fix:
      'Run the bundled fix-imports.sh helper. It (1) fires DownloadedEpisodesScan / DownloadedMoviesScan / DownloadedAlbumsScan against all six known completed-download paths (torrent + usenet roots for each arr), (2) waits 30s for the arrs to process, (3) dumps any items still stuck along with their exact statusMessages, (4) reports library + backlog file counts so you can see whether imports actually landed. This same script auto-runs as Step 11 of every install now, so the symptom shouldn\'t recur on fresh installs.',
    command: `bash <INSTALL_DIR>/fix-imports.sh`,
  },
  {
    category: 'Sonarr / Radarr / Lidarr / Prowlarr',
    symptom: 'Downloads complete in qBit but never move into the media folder',
    cause:
      'The arrs aren\'t importing them. Five common causes, in order of frequency: (1) qBit categories don\'t match — torrents have no category or the wrong one, so the arr filters them out. (2) Path mapping is off — qBit says the file is at /downloads/X, the arr looks at /data/Downloads/Torrents/X and finds nothing. (3) Permission denied on the destination — the arr can\'t write to /data/Media. (4) /data/Downloads and /data/Media are on different filesystems, so hardlinks fail and the copy fallback fails too. (5) The arr never grabbed the torrent itself — it was added manually to qBit, which the arr can\'t monitor.',
    fix:
      'Open Sonarr/Radarr → Activity → Queue. If items are listed, hover the row for the warning text. If empty: open Activity → History, look for "Grabbed" events without a matching "Imported" — that\'s the broken pair. Most fixes come down to: (a) make sure qBit categories match (tv-sonarr / radarr / lidarr); (b) reconnect the download client (Settings → Download Clients → qBittorrent → Test); (c) check hardlink feasibility. The diagnostic block below dumps the full picture.',
    command:
      `# qBit's view of every torrent — categories + state + path
docker exec gluetun wget -qO- "http://localhost:49156/api/v2/torrents/info" | head -c 4000

# Sonarr queue — anything stuck?
SONARR_KEY=$(grep '^SONARR_API_KEY=' <INSTALL_DIR>/.env | cut -d= -f2)
curl -s -H "X-Api-Key: $SONARR_KEY" "http://localhost:49152/api/v3/queue?pageSize=50"

# Hardlink possible? (must say "same fs")
docker exec sonarr sh -c 'touch /data/Downloads/.t && ln /data/Downloads/.t "/data/Media/.t" 2>&1 && echo "same fs OK" || echo "DIFFERENT fs — copy fallback only"; rm -f /data/Downloads/.t "/data/Media/.t"'`,
  },
  {
    category: 'Sonarr / Radarr / Lidarr / Prowlarr',
    symptom: 'Sonarr / Radarr / Seerr feel slow on every page navigation',
    cause:
      'Two persistent-slowness causes, often together: (a) SQLite databases get fragmented after months of inserts (every queue item, history row, blocklist entry adds rows) — queries get slower and slower. (b) Broken indexers add 10s timeouts to every UI status call — Sonarr/Radarr ping their indexer list on each status check, and a single CloudFlare-bounded indexer (1337x is the classic offender) freezes the UI for 10s while it times out. Seerr piggybacks on the arrs\' API responses, so slow arrs = slow Seerr too.',
    fix:
      'The bundled tune-arrs.sh helper fixes both in one shot: stops each arr one at a time, vacuums + reindexes its SQLite DB (typical 2-10× query speedup), then tests every Prowlarr indexer and disables the failing ones (Prowlarr\'s app-sync propagates the disable to Sonarr/Radarr automatically within ~30s). Safe + reversible — backs up each DB before vacuuming. Plex / qBit / SAB are not touched.',
    command:
      `# Dry-run first to see what WOULD change:
bash <INSTALL_DIR>/tune-arrs.sh --dry-run

# Apply:
sudo bash <INSTALL_DIR>/tune-arrs.sh

# Only one piece if you don't want the full pass:
sudo bash <INSTALL_DIR>/tune-arrs.sh --skip-vacuum     # just disable broken indexers
sudo bash <INSTALL_DIR>/tune-arrs.sh --skip-indexers   # just vacuum DBs`,
  },
  {
    category: 'Sonarr / Radarr / Lidarr / Prowlarr',
    symptom: 'Arr says "No files found" or "Folder did not contain video files"',
    cause:
      'Either the file path the arr is looking at is wrong (path mapping mismatch — qBit says /downloads/foo but the arr only sees /data/Downloads/Torrents/foo) or the file extension isn\'t one the arr recognizes (uncommon — Sonarr handles .mkv/.mp4/.avi/.ts/.m4v).',
    fix:
      'In the arr → Settings → Download Clients → click qBittorrent → Remote Path Mappings. Confirm the row says: Remote Path = qBit\'s view (/downloads), Local Path = the arr\'s view (/data/Downloads/Torrents). The wizard sets this; if it got corrupted, fix it here.',
  },
  {
    category: 'Sonarr / Radarr / Lidarr / Prowlarr',
    symptom: 'Imports succeed but Plex doesn\'t show the new content',
    cause:
      'Plex\'s library scan hasn\'t run, OR Plex\'s library is pointing at a different path than the arrs are writing to. The wizard doesn\'t auto-configure Plex libraries — you point those at /data/Media/Movies, /data/Media/TV Shows, etc. in Plex\'s setup wizard.',
    fix:
      'In Plex Web → Settings → Manage → Libraries → click your library → Folders. Should list /data/Media/Movies (for Movies) etc. After confirming, click the library tile in the main view → "Scan Library Files". Sonarr can also notify Plex automatically: Sonarr → Settings → Connect → + → Plex Media Server.',
  },

  // ── Plex ────────────────────────────────────────────────────────────
  {
    category: 'Plex',
    symptom: 'Plex Remote Access shows "Indirect connection"',
    cause:
      'Plex couldn\'t auto-configure NAT-PMP / UPnP to forward port 32400. Without manual port mapping, Plex falls back to its relay server (8 Mbps cap, indirect routing).',
    fix:
      'In Plex Web UI → Settings → Remote Access → Manually specify public port = 32400, save. Forward TCP 32400 on your router to the NAS LAN IP. The wizard\'s post-deploy validator confirms external reachability if this is set up correctly.',
  },
  {
    category: 'Plex',
    symptom: 'Plex prefs PUT returned HTTP 503',
    cause:
      'Plex was still initializing when the wizard tried to set Manual Port Mapping. Plex returns 503 (service unavailable) for the first 30-180 seconds of boot. Latest build retries on 503 with a 180s budget for the first call (configure_plex_remote_access), so this should only surface on truly stuck Plex instances.',
    fix:
      'If the wizard finished and the warning still appeared in the log, set Manual Port Mapping manually in the Plex Web UI → Settings → Remote Access → Manually specify public port = 32400. Re-running setup.sh also works once Plex is fully up.',
  },

  // ── Seerr ───────────────────────────────────────────────────────────
  {
    category: 'Seerr',
    symptom: 'Seerr HTTP 000 — port not bound after install',
    cause:
      'Seerr (Overseerr/Jellyseerr) doesn\'t bind its HTTP port until you complete the first-run wizard in your browser.',
    fix:
      'Open http://<NAS>:5056 in a browser. Step through the wizard: sign in with your Plex account, pick your library, confirm. Once done, Seerr binds its port and post-deploy-validate.sh will show green.',
  },

  // ── docker compose ──────────────────────────────────────────────────
  {
    category: 'docker compose',
    symptom: '"docker compose down" only stops 2 containers',
    cause:
      'Every user-facing service in docker-compose.yml has a profiles: key for service selection. docker compose down only acts on services in the default (no-profile) set — just prowlarr + flaresolverr here. The rest get ignored.',
    fix: 'Use the bundled helper that sets COMPOSE_PROFILES to cover every service.',
    command: `bash <INSTALL_DIR>/stop-all.sh`,
  },
  {
    category: 'docker compose',
    symptom: 'setup.sh refuses to start: "Another setup.sh is already running"',
    cause:
      'The wizard now holds a flock on .setup.lock while running to prevent two parallel installs from racing on .env writes (e.g. installer wizard + manual SSH session). Stale locks from a crashed run are auto-detected via PID check.',
    fix:
      'Check if another install is actually in flight (`ps auxw | grep setup.sh`). If not — it\'s a stale lock. Remove it:',
    command:
      `cat <INSTALL_DIR>/.setup.lock   # shows holding PID
rm -f <INSTALL_DIR>/.setup.lock`,
  },

  // ── Filesystem / Hardlinks ──────────────────────────────────────────
  {
    category: 'Hardlinks',
    symptom: 'post-deploy-validate.sh: "Hardlink probe FAILED: invalid cross-device link"',
    cause:
      'You put Downloads/ and Media/ in SEPARATE Synology shared folders. Each shared folder is its own btrfs subvolume, and Linux treats subvolumes as separate devices for hardlink purposes. Sonarr/Radarr fall back to copy + delete, doubling disk usage and breaking qBit seeding.',
    fix:
      'Move both trees under a SINGLE shared folder so they share a subvolume. The typical fix:',
    command:
      `# 1. Stop the stack
bash <INSTALL_DIR>/stop-all.sh

# 2. Move existing media INTO the Downloads parent's shared folder.
#    Example: if Downloads is at /volume1/Data/Downloads/ and you
#    have a separate /volume1/Media/ shared folder, move it:
rsync -avP /volume1/Media/ /volume1/Data/Media/

# 3. Update DATA_ROOT in .env to point at the parent (/volume1/Data)
nano <INSTALL_DIR>/.env

# 4. Re-run setup.sh — Sonarr/Radarr will detect existing files in
#    /data/Media/* and pick them up without re-downloading.
bash <INSTALL_DIR>/setup.sh`,
  },
  {
    category: 'Hardlinks',
    symptom: 'Sonarr/Radarr says "Copied" instead of "Hardlinked" in activity log',
    cause:
      'Hardlinks need three things to work: (a) Downloads + Media on the same filesystem, (b) same Docker mount inside the container (so the arr sees one /data tree, not two volumes), (c) "Use Hardlinks instead of Copy" enabled in Settings → Media Management.',
    fix:
      'The wizard sets (b) + (c) automatically — only (a) is the user-controlled piece. Run the hardlink probe to confirm:',
    command:
      `bash <INSTALL_DIR>/setup-validate.sh
# Look for: "✔ Hardlinks work between Downloads and Media"`,
  },

  // ── Indexers ────────────────────────────────────────────────────────
  {
    category: 'Indexers',
    symptom: 'TorrentGalaxy add failed (Redirected from indexer request)',
    cause:
      'The TorrentGalaxy URL bundled with Prowlarr is stale — the site moved to a new mirror.',
    fix:
      'In Prowlarr → Indexers → Add Indexer → search for TorrentGalaxy. The Prowlarr-bundled list may have a fresher mirror than the wizard\'s built-in defaults.',
  },
  {
    category: 'Indexers',
    symptom: 'Indexers fail with Flaresolverr / CloudFlare blocks',
    cause:
      'The Flaresolverr proxy tag isn\'t applied to that indexer. CloudFlare-protected sites need the request routed through Flaresolverr to solve the JS challenge.',
    fix:
      'In Prowlarr → Indexers → click the indexer → Tags → add "flaresolverr". Or re-run setup.sh — the wizard applies this tag to every public torrent indexer.',
  },

  // ── VPN ─────────────────────────────────────────────────────────────
  {
    category: 'VPN (gluetun)',
    symptom: 'qBittorrent + gluetun both not running, install left wedged',
    cause:
      'gluetun\'s WireGuard tunnel failed to establish — usually a wrong/expired key, wrong country code, or an upstream NordVPN/provider outage. qBittorrent depends on gluetun being healthy, so it never starts.',
    fix:
      'Check gluetun\'s logs first to confirm the cause, then use the restart helper.',
    command:
      `docker compose logs gluetun --tail 50
bash <INSTALL_DIR>/restart-qbit.sh`,
  },
  {
    category: 'VPN (gluetun)',
    symptom: 'VPN IP matches public IP (wizard reports leak)',
    cause:
      'gluetun says healthy but isn\'t actually tunneling traffic — your real public IP is leaking. Means the VPN config is wrong despite the handshake succeeding (rare but real).',
    fix:
      'Restart the full stack. If it persists, regenerate your VPN credentials in NordVPN\'s dashboard and re-run setup.sh.',
    command:
      `bash <INSTALL_DIR>/restart-qbit.sh
bash <INSTALL_DIR>/post-deploy-validate.sh`,
  },
  {
    category: 'VPN (gluetun)',
    symptom: 'qBittorrent stays "Firewalled" forever, listen-port never updates',
    cause:
      'NordVPN does NOT support port forwarding via gluetun (no third-party PF API). Only ProtonVPN, PIA, PrivateVPN and Perfect Privacy support PF natively. With NordVPN, your seed ratio is capped by peer reachability — incoming connections never reach qBit through the VPN tunnel.',
    fix:
      'Either accept the limitation (downloading still works, seeding is just slower) or switch providers. Set VPN_PROVIDER=protonvpn (or pia/privatevpn) in .env, paste the corresponding WIREGUARD_PRIVATE_KEY/WIREGUARD_ADDRESSES, then VPN_PORT_FORWARDING=on and re-run setup.sh.',
  },
  {
    category: 'VPN (gluetun)',
    symptom: 'PF up-command silently 403s on every reconnect (ProtonVPN/PIA)',
    cause:
      'qBit\'s AuthSubnetWhitelist used to omit 127.0.0.0/8, so gluetun\'s wget call to qBit\'s WebUI from inside the shared namespace got rejected — meaning listen_port never updated after VPN reconnects and qBit stayed "Firewalled". Fixed in installer v0.2.0+.',
    fix:
      'Update to wizard v0.2.0+, then delete qBittorrent.conf and re-run setup.sh so the new whitelist (with 127.0.0.0/8) gets written.',
    command:
      `cd <INSTALL_DIR>
docker compose stop qbittorrent
rm qbittorrent/config/qBittorrent/qBittorrent.conf
bash setup.sh`,
  },

  // ── Migration ───────────────────────────────────────────────────────
  {
    category: 'Migration screen',
    symptom: '"Unexpected token \'<\', \'<!doctype\'..." in arr fetch',
    cause:
      'Your source Sonarr/Radarr URL has a trailing slash OR has a URL Base set (Settings → General → Host → URL Base). The wizard hit the SPA fallback page instead of the API and got HTML where JSON was expected.',
    fix:
      'Remove the trailing slash from the URL. If your arr has a URL Base, include it (e.g. http://nas:8989/sonarr). The wizard now normalizes the URL automatically and shows specific error messages instead.',
  },
  {
    category: 'Migration screen',
    symptom: 'qBit migration: "Destination qBit login failed" for every torrent',
    cause:
      'Destination qBittorrent has the WebUI subnet whitelist enabled (which setup-folders.sh configures for LAN bypass), and qBit returns either "Ok." with no SID cookie OR an empty 200 body — meaning auth was bypassed. The wizard\'s old client expected a SID cookie and treated the no-cookie case as failure.',
    fix:
      'Updated wizard handles both response shapes correctly. If still failing, override the destination qBit credentials in the Migrate screen\'s "Destination qBittorrent" section.',
  },
  {
    category: 'Migration screen',
    symptom: 'Import button greyed out (Sonarr/Radarr)',
    cause:
      'The wizard reads destination arr API keys from your local .env. If keys aren\'t there yet (partial install, fresh wizard, or your stack is behind a reverse proxy), the import button stays disabled.',
    fix:
      'Paste the destination arr\'s URL + API key in the "Destination credentials" override fields on the Migrate screen. The button enables once at least one arr has both URL and key.',
  },

  // ── SABnzbd ─────────────────────────────────────────────────────────
  {
    category: 'SABnzbd',
    symptom: 'SABnzbd usenet provider: "[SSL: WRONG_VERSION_NUMBER]"',
    cause:
      'The SSL port doesn\'t actually speak TLS. Common case: FrugalUsenet :9000 is the plain port despite being labeled SSL in some docs.',
    fix:
      'The wizard now auto-detects this and falls back to a plain connection. To check your provider\'s actual SSL port: open SABnzbd → Config → Servers, switch between 9000/563/443/119 (the common usenet ports).',
  },
  {
    category: 'SABnzbd',
    symptom: 'SAB downloads complete but Sonarr/Radarr/Lidarr never import them',
    cause:
      'In a healthy setup, the arrs poll SAB\'s history API every ~minute and pick up new completions. If the arrs\' "Completed Download Handling" toggle is off, or the connection to SAB drops, completed downloads stack up in /data/Downloads/Usenet/complete/ forever. The wizard configures SAB categories (tv/movies/music) and the arrs\' SAB download client — but a flaky connection or a config drift can break the polling.',
    fix:
      'Kick a manual scan at each arr to clear the backlog. Then verify polling is healthy: in each arr → Settings → Download Clients → SABnzbd → Test. Should return green. If red, paste the SAB URL/API key into the arr\'s config (URL = http://sabnzbd:8080, API key from <INSTALL_DIR>/sabnzbd/config/sabnzbd.ini).',
    command:
      `SONARR_KEY=$(grep '^SONARR_API_KEY=' <INSTALL_DIR>/.env | cut -d= -f2)
RADARR_KEY=$(grep '^RADARR_API_KEY=' <INSTALL_DIR>/.env | cut -d= -f2)
LIDARR_KEY=$(grep '^LIDARR_API_KEY=' <INSTALL_DIR>/.env | cut -d= -f2)

curl -X POST -H "X-Api-Key: $SONARR_KEY" -H "Content-Type: application/json" \\
  "http://localhost:49152/api/v3/command" \\
  -d '{"name": "DownloadedEpisodesScan", "path": "/data/Downloads/Usenet/complete/tv"}'

curl -X POST -H "X-Api-Key: $RADARR_KEY" -H "Content-Type: application/json" \\
  "http://localhost:49151/api/v3/command" \\
  -d '{"name": "DownloadedMoviesScan", "path": "/data/Downloads/Usenet/complete/movies"}'

curl -X POST -H "X-Api-Key: $LIDARR_KEY" -H "Content-Type: application/json" \\
  "http://localhost:49154/api/v1/command" \\
  -d '{"name": "DownloadedAlbumsScan", "path": "/data/Downloads/Usenet/complete/music"}'`,
  },

  // ── Homepage ────────────────────────────────────────────────────────
  {
    category: 'Homepage dashboard',
    symptom: 'Homepage shows "Host validation failed. See logs for more details."',
    cause:
      'Homepage v1.0+ enforces strict Host-header validation. Older wizard builds defaulted HOMEPAGE_ALLOWED_HOSTS to a narrow list (LAN_IP + localhost + nas.local), so accessing the dashboard via the Synology\'s hostname, a custom DNS name, or any host not in that list got rejected.',
    fix:
      'Easiest: open the installer → Update → Pull + recreate. The current wizard build defaults HOMEPAGE_ALLOWED_HOSTS to `*` (any Host accepted) since this is a home-LAN tool. Or manually patch your .env on the NAS:',
    command:
      `# Either edit .env to set HOMEPAGE_ALLOWED_HOSTS=*  (simplest)
# or list the exact hostnames you access from, comma-separated, no ports:
#   HOMEPAGE_ALLOWED_HOSTS=dashboard.home,192.168.1.10,my-nas.local
cd <INSTALL_DIR>
sudo nano .env
sudo docker compose up -d homepage   # apply the .env change`,
  },
  {
    category: 'Homepage dashboard',
    symptom: 'Service tile is missing from the Homepage dashboard',
    cause:
      'Older wizard builds used a skip-if-exists writer for services.yaml, so once the file existed from a prior install, the dashboard layout was frozen — enabling a service later, or upgrading the wizard to add a new section (like Recyclarr Maintenance), wouldn\'t reflect on the dashboard. Fixed in the current build, which overwrites services.yaml every install, but a NAS upgraded from the old build needs a one-time refresh.',
    fix:
      'Easiest: open the installer → "Update existing stack" → "Refresh dashboard." That syncs the latest setup-arr-config.py and regenerates services.yaml + settings.yaml in <1s, no container restart needed. Or run the equivalent manually on the NAS:',
    command:
      `cd <INSTALL_DIR>
sudo rm -f homepage/config/services.yaml homepage/config/settings.yaml
sudo python3 setup-arr-config.py --homepage-only`,
  },

  // ── Recyclarr ───────────────────────────────────────────────────────
  {
    category: 'Recyclarr',
    symptom: 'Recyclarr: "Connection failed - check your base_url"',
    cause:
      'Your recyclarr.yml has localhost or 127.0.0.1 URLs left over from a hand-edited install or older wizard version. Recyclarr runs inside its own container so it can\'t reach localhost.',
    fix:
      'The wizard now detects stale yml and refreshes it to use container DNS names (sonarr:8989, radarr:7878). To force a rewrite, delete it and re-run setup.sh.',
    command:
      `rm <INSTALL_DIR>/recyclarr/config/recyclarr.yml
sudo bash <INSTALL_DIR>/setup.sh`,
  },
  {
    category: 'Recyclarr',
    symptom: 'I picked a TRaSH profile but my existing library still uses the old quality profile',
    cause:
      'Recyclarr creates / updates the quality profile in Sonarr / Radarr, but does NOT reassign existing series / movies to use it. The new profile is sitting unused next to your old one until you tell the arr to use it.',
    fix:
      'In Sonarr / Radarr, mass-edit your library to switch every series / movie to the new profile, then trigger a search if you want upgrades.',
    command:
      `Sonarr → Series tab → top-left ✎ Mass Edit
  → select all → Quality Profile dropdown → pick the new profile → Apply

Radarr → Movies tab → ✎ Edit (or "X selected" toolbar)
  → Quality Profile → new profile → Apply`,
  },
  {
    category: 'Recyclarr',
    symptom: 'How do I re-run Recyclarr after TRaSH publishes guide updates?',
    cause:
      'The wizard only runs `recyclarr sync` once at install time. TRaSH publishes Custom Format updates roughly weekly; to pick them up you need to re-run the sync.',
    fix:
      'Three options, in order of friendliness: (1) click the Recyclarr tile on the Homepage dashboard — opens a one-page UI with a "Sync Now" button. (2) Use the bundled recyclarr-sync.sh helper from SSH (writes a .last-sync stamp + appends sync.log). (3) Schedule (2) weekly via Synology Task Scheduler so you don\'t have to remember.',
    command:
      `# Option 1 — browser button (easiest):
#   Open http://<NAS>:8889 (or click the Recyclarr tile on Homepage)
#   → "Sync Now" → done

# Option 2 — SSH one-liner with logging:
bash <INSTALL_DIR>/recyclarr-sync.sh

# Option 3 — schedule weekly (Synology):
#   Control Panel → Task Scheduler → Create → Scheduled Task →
#   User-defined script  (run as root)
#   Run command:  bash <INSTALL_DIR>/recyclarr-sync.sh
#   Schedule: Weekly, Sunday 04:00`,
  },
  {
    category: 'Recyclarr',
    symptom: 'How do I change which TRaSH profile is applied?',
    cause:
      'The wizard\'s Configure screen sets TRASH_SONARR_PROFILE / TRASH_RADARR_PROFILE in .env. setup-arr-config.py reads those to render recyclarr.yml. Changing the picks AFTER install needs a re-run so the YAML gets regenerated.',
    fix:
      'Re-run the wizard, change the picks on Configure, finish. The recyclarr.yml will be regenerated and the next sync applies the new profile. (You can also hand-edit recyclarr.yml directly — the wizard preserves hand-edits unless your picks have changed.)',
    command:
      `# Or edit .env directly and re-run setup.sh (skips the wizard):
sed -i 's/TRASH_SONARR_PROFILE=.*/TRASH_SONARR_PROFILE=bluray-1080p/' <INSTALL_DIR>/.env
sudo bash <INSTALL_DIR>/setup.sh`,
  },
  {
    category: 'Recyclarr',
    symptom: 'Recyclarr container won\'t start — "depends_on: sonarr radarr — no such service"',
    cause:
      'Recyclarr\'s compose entry depends on sonarr + radarr. If you disabled ENABLE_SONARR or ENABLE_RADARR (so they\'re not in COMPOSE_PROFILES) but left ENABLE_RECYCLARR=true, compose can\'t resolve the dependency.',
    fix:
      'Either enable both arrs, OR disable Recyclarr — it has nothing to sync into without Sonarr and Radarr running. The Configure screen surfaces this with a "needs Sonarr or Radarr" hint.',
    command:
      `# Disable recyclarr in .env if you really don't want the arrs:
sed -i 's/ENABLE_RECYCLARR=true/ENABLE_RECYCLARR=false/' <INSTALL_DIR>/.env
sudo bash <INSTALL_DIR>/setup.sh`,
  },
  {
    category: 'Recyclarr',
    symptom: 'Lidarr quality profiles — does Recyclarr support Lidarr?',
    cause:
      'No. Recyclarr supports only Sonarr and Radarr. Music arrs (Lidarr, Readarr) don\'t have the same Custom Format release-scoring ecosystem as the video arrs, so there\'s no TRaSH Guide Custom Format bundle to sync.',
    fix:
      'For Lidarr, set the quality definitions by hand using TRaSH\'s published per-quality size ranges. Open Lidarr → Settings → Profiles → Quality Definitions and enter the megabytes-per-minute min/max from the TRaSH Lidarr page.',
    command:
      `# Reference page (open in a browser):
# https://trash-guides.info/Lidarr/lidarr-setup-quality-profiles/`,
  },
]

const CATEGORIES = [
  'New to this? Start here',
  'Install failed or timed out',
  'qBittorrent',
  'Tautulli',
  'Sonarr / Radarr / Lidarr / Prowlarr',
  'Plex',
  'Seerr',
  'docker compose',
  'Indexers',
  'VPN (gluetun)',
  'Migration screen',
  'SABnzbd',
  'Homepage dashboard',
  'Recyclarr',
]

interface Props {
  installDir: string
  onClose: () => void
}

export function TroubleshootingModal({ installDir, onClose }: Props) {
  const [query, setQuery] = useState('')
  const reduced = useReducedMotion()

  // ESC closes — standard modal hygiene matching IssuesModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Filter items by query — checks symptom + cause + fix + category so
  // a user looking for "tautulli" finds everything tagged it, but also
  // a user searching for the exact error text "must join at least one"
  // finds the qBit/gluetun entry.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ITEMS
    return ITEMS.filter((i) =>
      i.symptom.toLowerCase().includes(q) ||
      i.cause.toLowerCase().includes(q) ||
      (i.fix ?? '').toLowerCase().includes(q) ||
      i.category.toLowerCase().includes(q) ||
      (i.command ?? '').toLowerCase().includes(q),
    )
  }, [query])

  // Group filtered items by category, preserving the CATEGORIES order
  // (which is human-curated for ergonomic browsing — most-common first).
  const grouped = useMemo(() => {
    const out: { category: string; items: TItem[] }[] = []
    for (const cat of CATEGORIES) {
      const items = filtered.filter((i) => i.category === cat)
      if (items.length > 0) out.push({ category: cat, items })
    }
    return out
  }, [filtered])

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      initial={reduced ? { opacity: 1 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <motion.div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
        initial={reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
        transition={{ type: 'spring', stiffness: 360, damping: 30 }}
      >
        <header className="px-5 pt-4 pb-3 border-b border-slate-800">
          <div className="flex items-center justify-between gap-3">
            <h2 id="help-modal-title" className="text-lg font-semibold inline-flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30" aria-hidden="true">
                <HelpCircle size={18} className="text-emerald-300" strokeWidth={1.75} aria-hidden="true" />
              </span>
              Help &amp; troubleshooting
            </h2>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 rounded-md p-1 hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              aria-label="Close help modal"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Common issues + the exact fix for each. Search by symptom,
            category, or error text. Commands are filled in for your
            install dir ({installDir || 'set on the Configure screen'}) —
            copy with the button next to each block.
          </p>
          {/* Beginner-friendly walkthrough — split out from the
              issue/cause/fix entries below because it's narrative,
              not a troubleshooting lookup. The setWindowOpenHandler
              registered in main/index.ts routes target="_blank" through
              shell.openExternal so this opens in the user's browser
              rather than navigating the wizard window. */}
          <div className="mt-2 rounded-md border border-emerald-700/40 bg-emerald-900/15 px-3 py-2 text-xs">
            <span className="font-semibold text-emerald-300">New to this?</span>{' '}
            <span className="text-slate-300">
              Step-by-step beginner&apos;s walkthrough →{' '}
            </span>
            <a
              className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2 inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded"
              href="https://github.com/defessler/NAS-Arr-Stack/blob/master/INSTALL.md"
              target="_blank"
              rel="noreferrer"
              aria-label="Open the beginner's INSTALL.md walkthrough on GitHub in a new tab"
            >
              INSTALL.md on GitHub
              <ExternalLink size={11} aria-hidden="true" />
            </a>
            <span className="text-slate-400">
              {' '}— covers everything from enabling SSH on your NAS to adding your
              first show.
            </span>
          </div>
          <div className="relative mt-3">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search… try "tautulli", "HTTP 000", "compose down", "wedged"'
              className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-500/40 transition-colors"
              autoFocus
            />
          </div>
        </header>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
          {grouped.length === 0 ? (
            <div className="text-sm text-slate-400 flex flex-col items-center gap-2 py-6">
              <SearchX size={28} className="text-slate-600" strokeWidth={1.5} aria-hidden="true" />
              <p className="italic text-center">
                No matches for <span className="font-mono text-slate-300">{query}</span>.
                <br />
                Try a shorter search term, or browse by category by clearing the search.
              </p>
            </div>
          ) : (
            grouped.map((g) => (
              <section key={g.category}>
                <h3 className="text-sm font-semibold text-emerald-300 mb-2 sticky top-0 bg-slate-900 py-1">
                  {g.category}
                </h3>
                <div className="space-y-3">
                  {g.items.map((item, i) => (
                    <Entry key={`${g.category}-${i}`} item={item} installDir={installDir} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        <footer className="px-5 py-3 border-t border-slate-800 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            {filtered.length} item{filtered.length === 1 ? '' : 's'} shown · ESC to close
          </span>
          <BigButton size="md" variant="secondary" onClick={onClose}>
            Close
          </BigButton>
        </footer>
      </motion.div>
    </motion.div>
  )
}

function Entry({ item, installDir }: { item: TItem; installDir: string }) {
  const [copied, setCopied] = useState(false)
  // Substitute the user's actual install dir into command snippets.
  // Falls back to a clearly-fake path when the wizard hasn't been
  // configured yet, so the user sees they need to substitute.
  const dir = installDir || '/volume1/docker/media'
  const cmd = item.command?.replace(/<INSTALL_DIR>/g, dir)

  async function copyCmd() {
    if (!cmd) return
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write can reject in some Electron contexts (e.g.
      // when window isn't focused). Silent fail — the user can still
      // select-and-Ctrl-C from the visible <pre>.
    }
  }

  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/60 p-3">
      <div className="text-sm font-medium text-slate-100">
        {item.symptom}
      </div>
      <div className="text-xs text-slate-400 mt-1">
        <span className="font-medium text-slate-300">Why:</span>{' '}
        {item.cause}
      </div>
      {item.fix && (
        <div className="text-xs text-slate-400 mt-1">
          <span className="font-medium text-slate-300">Fix:</span>{' '}
          {item.fix}
        </div>
      )}
      {cmd && (
        <div className="relative mt-2">
          <pre className="text-xs font-mono bg-black/60 border border-slate-800 rounded p-2 overflow-x-auto whitespace-pre">
{cmd}
          </pre>
          <button
            onClick={copyCmd}
            className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            title="Copy command to clipboard"
          >
            <AnimatePresence mode="wait" initial={false}>
              {copied ? (
                <motion.span
                  key="check"
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  transition={{ duration: 0.12 }}
                  className="inline-flex items-center gap-1 text-emerald-300"
                >
                  <ClipboardCheck size={11} aria-hidden="true" />
                  copied
                </motion.span>
              ) : (
                <motion.span
                  key="clip"
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  transition={{ duration: 0.12 }}
                  className="inline-flex items-center gap-1"
                >
                  <Clipboard size={11} aria-hidden="true" />
                  copy
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </div>
      )}
    </div>
  )
}
