# Mediarr Stack — Technical Design Document

This document explains how the Mediarr media-server stack is built and **why** every choice was made. It's the read-this-first companion to the source code: anywhere you'd ask "why is it done this way?" the answer is in here.

Audience: engineers reviewing the codebase, contributors looking for the design intent before changing things, and future-me trying to remember what I was thinking.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Goals + non-goals](#2-goals--non-goals)
3. [System architecture](#3-system-architecture)
4. [Layer 1 — Docker Compose stack (the runtime)](#4-layer-1--docker-compose-stack-the-runtime)
5. [Layer 2 — NAS payload (bash + Python automation)](#5-layer-2--nas-payload-bash--python-automation)
6. [Layer 3 — Electron installer (the wizard)](#6-layer-3--electron-installer-the-wizard)
7. [Cross-cutting concerns](#7-cross-cutting-concerns)
8. [Critical design decisions](#8-critical-design-decisions)
9. [Build + release pipeline](#9-build--release-pipeline)
10. [Security boundaries](#10-security-boundaries)
11. [Known trade-offs + future directions](#11-known-trade-offs--future-directions)

---

## 1. Executive summary

Mediarr installs a turnkey "personal Netflix" stack on a Synology NAS: Plex or Jellyfin serves the library (the user picks one), Sonarr/Radarr/Lidarr automate TV/movie/music acquisition, Prowlarr manages indexers, qBittorrent + SABnzbd download through a VPN, Bazarr fetches subtitles, Recyclarr keeps quality rules current, and Homepage is the dashboard.

The stack is implemented as three independent layers:

| Layer | Lives where | What it does |
|---|---|---|
| 1. Compose stack | `nas/docker-compose.yml` (~700 lines) | Declares the 14 containers, their networks, volumes, and start order. This is the *runtime*. |
| 2. NAS payload | `nas/setup.sh`, `nas/setup-arr-config.py` (3500 lines), `nas/setup-*.sh`, `nas/indexers/`, `nas/migration/` | Idempotent bash + Python that prepares the NAS host (folders, permissions, firewall, VPN keys) and then configures every service via its HTTP API once containers are up. |
| 3. Installer | `installer/` (Electron + React) | Desktop wizard (Win/Mac/Linux) that walks a user through profile creation → SSH connect → environment scan → configure → install → done. Wraps Layers 1 + 2 over SSH/SFTP. |

The split is deliberate: each layer can be used or replaced independently. Layer 1 + 2 work on any Synology-class NAS with SSH + Docker, without ever touching Layer 3. Layer 3 wraps Layer 1 + 2 for users who don't want to use SSH.

---

## 2. Goals + non-goals

### Goals
- **Single-NAS, hours-to-install, decades-to-run.** Optimise for the long-tail home user who installs once and wants the result to keep working after DSM updates, container image bumps, indexer site changes, etc.
- **Idempotent everywhere.** Every script can be re-run. Every API call checks "is this already set?" before writing. The installer can be re-run without re-uploading anything.
- **Friendly to non-technical users**, especially via the installer. A child should be able to install with a parent looking over their shoulder.
- **Plain HTTP debuggability.** Every component logs to stdout, exposes a Web UI, has a documented config path. No proprietary protocols, no closed black boxes.
- **Synology-first but not Synology-only.** Targets DSM 7 with explicit auto-detection (BTRFS subvolumes, shared-folder ACLs, /volume1 paths) but degrades cleanly to QNAP / Unraid / TrueNAS / generic Linux.

### Non-goals
- **Multi-NAS clustering / HA.** One NAS, one stack. Out of scope.
- **Kubernetes.** Compose is enough; k8s is overkill for a single-host stack and would alienate the target user.
- **A custom Plex / Sonarr / Radarr UI.** We compose existing tools; we don't reinvent any of them.
- **Cloud-anything.** No telemetry, no auto-updater that calls home (only the GitHub Releases check on Welcome), no remote management.
- **Cross-platform installer parity with native UIs.** The installer ships the same wizard on Win/Mac/Linux. Platform-specific niceties (Synology DSM widgets, macOS Notification Center alerts) are out of scope.

---

## 3. System architecture

```
                ┌──────────────────────────────────────────────────────┐
                │  USER'S PC (Win/Mac/Linux)                           │
                │                                                      │
                │   ┌────────────────────────────────────────────┐    │
                │   │  Mediarr Installer (Electron + React)      │    │
                │   │                                            │    │
                │   │   Renderer (React 19, Tailwind, Motion)    │    │
                │   │      │ contextBridge IPC                   │    │
                │   │   Main (Node) — ssh2, sftp, env-detect     │    │
                │   └──────────────────┬─────────────────────────┘    │
                └──────────────────────┼──────────────────────────────┘
                                       │ SSH (port 22) + SFTP
                                       ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  SYNOLOGY NAS  (DSM 7+)                                     │
       │                                                             │
       │  /volume1/docker/media/                                     │
       │   ├─ docker-compose.yml                                     │
       │   ├─ .env                          ← user values            │
       │   ├─ setup.sh                      ← orchestrator           │
       │   ├─ setup-*.sh                    ← step modules           │
       │   ├─ setup-arr-config.py           ← API configurator       │
       │   ├─ indexers/, migration/                                  │
       │   └─ <service>/config/             ← per-container state    │
       │                                                             │
       │   ┌──────────── docker daemon ───────────────────────────┐  │
       │   │                                                      │  │
       │   │  ┌───────────┐  ┌───────────┐  ┌───────────┐         │  │
       │   │  │  Plex     │  │  Sonarr   │  │  Radarr   │  ...    │  │
       │   │  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘         │  │
       │   │        │              │              │                │  │
       │   │   ┌────┴──────────────┴──────────────┴──────┐         │  │
       │   │   │  Docker bridge network (media)          │         │  │
       │   │   └────┬──────────────────────────┬─────────┘         │  │
       │   │        │                          │                    │  │
       │   │  ┌─────▼──────┐         ┌─────────▼────────┐          │  │
       │   │  │  Gluetun   │         │  qBittorrent     │          │  │
       │   │  │  (VPN)     │◄────────┤  (uses gluetun's │          │  │
       │   │  └─────┬──────┘  net    │   namespace)     │          │  │
       │   │        │  ns             └──────────────────┘          │  │
       │   └────────┼──────────────────────────────────────────────┘  │
       │            ▼                                                 │
       │      WireGuard tunnel out                                    │
       └──────────────────────────────────────────────────────────────┘
                                                  ▼
                                       VPN provider (NordVPN / Proton /
                                       Mullvad / AirVPN / Surfshark)
```

Three things make this picture more than "Docker Compose runs some containers":

1. **The renderer never sees the NAS directly.** Every privileged call (SSH, SFTP, NordVPN API, env detect) is a `contextBridge` IPC into the main process. The renderer can't import `ssh2` even if it wanted to. (See [§10 Security boundaries](#10-security-boundaries).)
2. **qBittorrent shares Gluetun's network namespace.** Not a side-by-side container, not a port-forwarded SOCKS. The container literally has no other network — if Gluetun's WireGuard drops, qBittorrent loses its only path to the outside. This is the kill switch.
3. **The arrs talk to each other by service name, not LAN IP.** `http://sonarr:8989`, not `http://192.168.1.242:49152`. Docker's bridge network does DNS resolution from container names. Makes the stack portable across LAN reconfigurations.

---

## 4. Layer 1 — Docker Compose stack (the runtime)

Lives in [`nas/docker-compose.yml`](nas/docker-compose.yml).

### 4.1 Service inventory

14 containers. Eight are user-facing (have a Web UI); the rest are sidecars or always-on infra.

| Container | Role | Image |
|---|---|---|
| **plex** | Streams the library (when `MEDIA_SERVER=plex`) | `lscr.io/linuxserver/plex` |
| **jellyfin** | Streams the library (when `MEDIA_SERVER=jellyfin`) | `lscr.io/linuxserver/jellyfin` |
| **sonarr** | TV automation | `lscr.io/linuxserver/sonarr` |
| **radarr** | Movie automation | `lscr.io/linuxserver/radarr` |
| **lidarr** | Music automation | `lscr.io/linuxserver/lidarr` |
| **prowlarr** | Indexer hub | `lscr.io/linuxserver/prowlarr` |
| **bazarr** | Subtitle fetcher | `lscr.io/linuxserver/bazarr` |
| **qbittorrent** | Torrent client | `lscr.io/linuxserver/qbittorrent` |
| **sabnzbd** | Usenet client | `lscr.io/linuxserver/sabnzbd` |
| **seerr** | Request portal | `${SEERR_IMAGE}` — Seerr (`ghcr.io/seerr-team/seerr`) for Plex, Jellyseerr (`ghcr.io/fallenbagel/jellyseerr`) for Jellyfin |
| **tautulli** | Plex analytics (Plex only — skipped for Jellyfin) | `lscr.io/linuxserver/tautulli` |
| **homepage** | Dashboard | `ghcr.io/gethomepage/homepage` |
| **gluetun** | VPN gateway | `qmcgaw/gluetun` |
| **flaresolverr** | CloudFlare bypass | `ghcr.io/flaresolverr/flaresolverr` |
| **recyclarr** + **recyclarr-trigger** | TRaSH-Guide sync + tiny web UI | `ghcr.io/recyclarr/recyclarr` + `python:3-alpine` |
| **unpackerr** | Auto-extract archives | `golift/unpackerr` |

### 4.2 Why linuxserver.io for most of them

LSIO images:
- Track upstream releases automatically.
- Use a consistent UID/GID convention (`PUID` / `PGID` env vars). Critical for hardlinks — every container needs to own files as the same user, or the arrs can't link from a download into the media library.
- Bundle s6-overlay for clean shutdown. Plex in particular hates SIGKILL — corrupts its SQLite. LSIO's s6 catches SIGTERM cleanly.
- Have a healthy support community for issues.

Trade-off: LSIO's first-boot init does a `chown -R` over `/config`. For Plex with hundreds of thousands of metadata files this can take 2–5 minutes. We've designed around that (long timeouts in setup.sh; the Run screen budgets 10 minutes for the initial container bring-up).

### 4.3 Networking — the bridge + the namespace trick

All containers join a single user-defined bridge named `media`. Docker provides automatic DNS: `sonarr` resolves to the Sonarr container's IP. This means:

- The arrs don't need to know the host's LAN IP.
- Adding `LAN_IP=` to `.env` is purely for port-publishing — services bind to `${LAN_IP}:<port>` on the host so they're reachable from the rest of the LAN.

**qBittorrent's special case.** It uses `network_mode: "container:gluetun"`, which makes Docker put it into Gluetun's network namespace. Effects:
- qBittorrent has no IP of its own.
- All its outbound traffic leaves through Gluetun's WireGuard tunnel.
- If Gluetun's tunnel drops, qBittorrent's network goes dark — no fallback to the LAN's normal route, no leak.
- The arrs reach qBittorrent at `http://gluetun:49156` (the qBit WebUI binds inside Gluetun's namespace, so from the arr's perspective the host name `gluetun` exposes both Gluetun's healthcheck *and* qBit's WebUI).

This is the cleanest VPN kill switch design Docker supports. Alternatives (a separate VPN sidecar with iptables policy routing, a SOCKS proxy, host-level routing tables) are all leakier under failure conditions.

### 4.4 Volumes — the hardlink-friendly /data tree

```
${INSTALL_DIR}/
  ├─ docker-compose.yml
  ├─ .env
  ├─ <each container>/config/    ← per-container state (DBs, settings)
  └─ ...

${DATA_ROOT}/                    ← typically /volume1/Data
  ├─ Downloads/
  │   ├─ Torrents/{Incomplete,Completed}/<category>/
  │   └─ Usenet/{incomplete,complete}/<category>/
  └─ Media/
      ├─ Movies/
      ├─ TV Shows/
      ├─ Anime/
      └─ Music/
```

Every download/import-capable container (qBit, SABnzbd, Sonarr, Radarr, Lidarr, Bazarr, Plex, Unpackerr) mounts `${DATA_ROOT}` as `/data`. They all see the same paths:

- qBittorrent saves a torrent to `/data/Downloads/Torrents/Completed/tv-sonarr/<show>.mkv`.
- Sonarr sees that exact path and creates a hardlink at `/data/Media/TV Shows/<show>/<show>.S01E01.mkv`.

A hardlink is filesystem-cheap (one inode, two names) and disk-zero (no copy). qBittorrent keeps seeding the original; Plex reads the second name. Delete one — the other survives.

**The catch on Synology:** hardlinks require both paths be on the same filesystem. Each Synology *shared folder* is its own BTRFS subvolume, and BTRFS treats subvolumes as separate filesystems for hardlink purposes. If `Downloads/` and `Media/` are in different shared folders, every import becomes a copy. The wizard's env-detect step probes this and surfaces a clear "put them under one shared folder" warning if it's wrong.

### 4.5 Profiles — opt-out services without yml edits

Every user-facing service has `profiles: [<name>]` in compose. `setup.sh` reads `ENABLE_*` from `.env` and builds `COMPOSE_PROFILES=plex,sonarr,...`. `docker compose up -d` then only starts what's selected. Prowlarr + Flaresolverr have no profile gate — they're cheap and every arr needs them.

The media server is special: `ENABLE_PLEX` is the on/off master for the media-server group, and `MEDIA_SERVER` (`plex`|`jellyfin`) picks which one. The compose profile name IS the `MEDIA_SERVER` value, so `setup.sh` just does `PROFILES+=("$MEDIA_SERVER")`. `plex`/`tautulli` are in the `plex` profile, `jellyfin` is in the `jellyfin` profile, and `seerr` is in BOTH (its image switches to Jellyseerr via `${SEERR_IMAGE}`). Switching `MEDIA_SERVER` reaps the other server's containers in `stop_disabled_services`. The Python configurator branches on `MEDIA_SERVER`: Plex uses a claim-token + `PlexServer` arr notifications + Tautulli; Jellyfin uses a user-supplied `JELLYFIN_API_KEY` + `MediaBrowser` arr notifications and skips Tautulli/remote-access.

This means uninstalling a service is just `ENABLE_X=false` in `.env`. No yml edits, no rebuild.

---

## 5. Layer 2 — NAS payload (bash + Python automation)

Lives in [`nas/`](nas/). The installer SFTP-uploads this directory verbatim to `${INSTALL_DIR}` on the NAS.

### 5.1 Why two languages?

**Bash for the imperative system steps:**
- `setup-chmod.sh` — fix file modes
- `setup-folders.sh` — `mkdir -p`, `chown`, ACL grants
- `setup-firewall.sh` — `iptables` rules, persist to `/etc/iptables/`
- `setup-nordvpn.sh` — `curl` the NordVPN API for a WireGuard key
- `setup-validate.sh` — `df`, `lsof`, hardlink probe
- `post-deploy-validate.sh` — HTTP probes against running services

These are all things bash does well: invoke system tools, check exit codes, exit loudly on failure.

**Python for the API configurators:**
- `setup-arr-config.py` (3500 lines) — every arr's HTTP API
- `indexers/setup-indexers.py` — Prowlarr indexer setup with HMAC-signed cookies for private trackers
- `indexers/setup-bazarr-providers.py` — Bazarr provider config
- `migration/fix-plex-paths.py` — `sqlite3` work on Plex's library DB

Why Python here instead of bash + curl + jq? Because every arr API is JSON-in / JSON-out, requires multi-step state (read current settings → diff → POST update), and we need real error handling. Bash + curl + jq quickly becomes more fragile + more code than Python's `urllib.request` + `json`.

### 5.2 setup.sh — the 13-step orchestrator

```
Step 1   Set file permissions             setup-chmod.sh
Step 2   Create data and config directories  setup-folders.sh
Step 3   Apply firewall rules              setup-firewall.sh
Step 4   Fetch NordVPN WireGuard key       setup-nordvpn.sh
Step 5   Validate configuration            setup-validate.sh
Step 6   Start the stack                   docker compose up -d
Step 7   Configure all services            setup-arr-config.py
Step 8   Add Prowlarr indexers             indexers/setup-indexers.py
Step 9   Enable Bazarr subtitle providers  indexers/setup-bazarr-providers.py
Step 10  Configure Live TV (Dispatcharr)   setup-dispatcharr.py
Step 11  Verify stack health               post-deploy-validate.sh
Step 12  Import any download backlog       fix-imports.sh
Step 13  Auto-confirm manual imports       auto-manual-import.py
```

Each step is a separate script, callable individually. setup.sh prints a numbered banner before each (`│ Step 7: Configure all services`) and `✔` / `✘` after. The installer's StepperRail parses those exact markers from the streaming log to drive the visual progress.

Idempotency is enforced at every step:
- chmod / mkdir / chown are inherently idempotent
- iptables rules are inserted with `-C` first (check-then-insert)
- NordVPN key fetch only runs if `NORDVPN_PRIVATE_KEY=` is empty in .env
- docker compose up only starts containers that aren't already running
- API configurators all do a "read current → compare → only write if different" cycle

A single `flock` on `.setup.lock` prevents two parallel installs from racing.

### 5.3 setup-arr-config.py — the brains

The single biggest file in the repo at ~3500 lines. It does everything that requires talking to a running arr's HTTP API:

| Service | What it configures |
|---|---|
| Sonarr / Radarr / Lidarr | Root folders, download clients (qBit + SAB), remote path mappings, hardlinks, naming, auth, indexer connections |
| Prowlarr | Sonarr/Radarr/Lidarr app sync, Flaresolverr proxy, public indexers, auth |
| Bazarr | Sonarr/Radarr connections, free subtitle providers |
| SABnzbd | Categories (tv/movies/music/anime), download paths, host whitelist (allows arrs to reach it across container hostnames) |
| qBittorrent | Initial admin credentials (writes them to the config file before first boot, since LSIO's qBit otherwise generates a random password and prints it to stdout) |
| Seerr | Sonarr/Radarr connections — but only after the user completes Seerr's own first-run wizard (we detect this and noop until then) |
| Unpackerr | Writes `unpackerr.conf` with API keys pre-filled |
| Recyclarr | Renders `recyclarr.yml` from `TRASH_*_PROFILE` + API keys |
| Homepage | Generates `services.yaml` from enabled-service flags + `settings.yaml` |
| Tautulli | Connects to Plex with the token Plex got from the claim |

It's organised as one large `main()` with section blocks (`section("Sonarr")`, `section("Radarr")`, etc.). The two `--*-only` flags (`--homepage-only`, `--recyclarr-only`) are tiny dispatcher functions that call only the relevant section, used by the installer's "Refresh dashboard" + the Recyclarr trigger's profile-change button.

### 5.4 API-config helpers worth knowing about

- `read_arr_key(config.xml)` — every arr writes an API key to `<container>/config/config.xml` on first boot. We discover it by parsing that file rather than asking the user. Falls back to env override (`SONARR_API_KEY=` in `.env`) if the user wants to pin one.
- `wait_ready(name, url, key, status_path)` — polls `/api/v3/system/status` until 200 or timeout (default 90s, longer for Plex's slow boot). All API config blocks gate on this.
- `put_with_verify(url, key, payload)` — PUT a config change, then immediately GET to confirm it landed. Catches the documented arr quirk where a PUT triggers an internal session cycle that races with the response.

### 5.5 setup-validate.sh — the safety net

Runs after `.env` is loaded and before `docker compose up`. Fails fast if any of:
- `/volume1` doesn't exist (Synology-only — falls back to generic check on other NAS)
- `${DATA_ROOT}` not writable by `PUID:PGID`
- Required ports already bound by another process
- VPN_ENABLED=true but WireGuard key missing
- Plex claim token is older than 4 minutes
- Hardlink probe: `touch /data/Downloads/.t && ln /data/Downloads/.t /data/Media/.t` succeeds. If `EXDEV` (different filesystems), the install would silently do copies instead of hardlinks — abort with a clear "put them under one shared folder" message.

### 5.6 post-deploy-validate.sh — the trust-but-verify

After `docker compose up -d` and a brief wait, this script HTTP-probes every running service:

```
✔ Homepage     (http://192.168.1.242:3000)        — HTTP 200
✔ Plex         (http://192.168.1.242:32400/web)   — HTTP 200
✔ Sonarr       (http://192.168.1.242:49152)       — HTTP 200
...
```

The exact `✔ <Name> (http...)` / `✘ <Name> (http...)` lines are what the Done-screen tile grid parses to colour each service icon green/red. Two parsers, one format.

It also runs the hardlink probe again (with real files this time) and a VPN IP-check (`docker exec gluetun wget -qO- https://ipinfo.io` — fail if the IP matches the user's home public IP).

---

## 6. Layer 3 — Electron installer (the wizard)

Lives in [`installer/`](installer/). Electron + Vite + React 19 + Tailwind + Motion + Lucide.

### 6.1 Why Electron?

Considered alternatives:
- **Web app the user runs locally** — would need the user to install Node, run `npm start`. Defeats the "double-click and go" promise.
- **Tauri** — smaller footprint, but needs Rust toolchain on every build host, and our main process needs `ssh2` (Node-native) for streaming SSH. Tauri's webview-to-Rust IPC would require rewriting `ssh2` glue.
- **Native (Swift/Win32)** — three platforms, three codebases. Out of scope.

Electron lets us ship one TypeScript + React codebase, build on a per-platform CI runner with `electron-builder`, and use any Node lib in the main process. The cost is a ~120MB unpacked bundle, which is acceptable for an installer the user downloads once.

### 6.2 Process model

```
┌─────────────────────────────────────────────┐
│  Renderer process  (Chromium + React)       │
│                                             │
│   Zustand stores: wizard, errors            │
│   Screens: Welcome → Connect → EnvDetect    │
│            → Configure → Run → Done         │
│   Components: BigButton, IndexerCard, ...   │
│                                             │
│   window.installer.* ← contextBridge        │
└─────────────────┬───────────────────────────┘
                  │ IPC (typed via shared/ipc.ts)
┌─────────────────▼───────────────────────────┐
│  Main process  (Node)                       │
│                                             │
│   ssh-service.ts  — ssh2 Client, exec       │
│                     streams, sudo handling  │
│   sftp-service.ts — bulk uploads + progress │
│   env-detector.ts — runs probes over SSH    │
│   vpn-service.ts  — NordVPN API client      │
│   profile-store.ts — encrypted profile JSON │
│   payload-resolver.ts — finds resources/    │
│                          nas-payload at run │
│   ipc-handlers.ts — registers every channel │
└─────────────────────────────────────────────┘
```

The renderer is **fully contextIsolated, nodeIntegration: false**. Its only window into Node is `window.installer.*`, surfaced by `preload/index.ts`. The renderer literally cannot `import 'ssh2'` — Webpack would fail at build time.

### 6.3 The wizard flow

```
            [profiles? n]
                       \
                        v
Welcome → empty state — Create your first profile
   │                       /
   │  [profiles? y]       /
   v                     /
   ──────────────────────
                 │
                 v
            ╔════════╗
            ║ install ║──┐
            ╠════════╣  │
            ║ update  ║──┼──→ Connect
            ╠════════╣  │
            ║ migrate ║──┘
            ╚════════╝         │
                                v
                          (mode === 'install')
                                │
                                v
                          EnvDetect
                                │
                                v
                          Configure
                                │
                                v
                            Run
                                │
                                v
                            Done

                          (mode === 'update')
                                │
                                v
                          UpdateRun  (pull, sync-scripts, refresh-dashboard,
                                │     re-run-a-step — picked from the screen)
                                v
                            Done

                          (mode === 'migrate')
                                │
                                v
                          Migrate  (fetch source arr lists, import to dest)
                                │
                                v
                            Done
```

Three flows share Welcome + Connect, then diverge based on `mode` from the wizard store.

### 6.4 Zustand store

Two stores keep the renderer simple:
- **`wizard`** — current step, mode, active profile, connection details, env config form values, migrate form values, last-run results. Persisted to `localStorage` via `zustand/middleware/persist` so closing mid-install resumes where it was.
- **`errors`** — toast tray. Anything that `reportError(scope, err)`s shows up as a dismissible toast bottom-right.

Why Zustand and not Redux? Two stores, ~500 lines total. Redux would be 3x the boilerplate for the same outcome. Zustand's `set` + `subscribe` is enough for a wizard flow.

### 6.5 SSH service — streaming logs, not buffering

We use `ssh2` (the low-level Node SSH client) instead of `node-ssh` (the friendly wrapper) for one reason: streaming. `node-ssh`'s `exec()` buffers all of stdout/stderr until the command exits, then returns it. That's fine for `ls /tmp` but a disaster for `bash setup.sh` which spends 15 minutes streaming a build log.

With `ssh2.exec()` we get a `ClientChannel` that's a Node Readable stream:

```ts
client.exec('bash setup.sh', (err, stream) => {
  stream.on('data',  (chunk) => onChunk(channelId, chunk.toString()))
  stream.on('close', (code)  => onClose(channelId, code))
})
```

Each chunk emits via IPC `ssh:stream-data` → renderer appends to a `linesRef.current` array → LogPanel renders. The latency from "setup.sh prints a line" to "user sees it" is <100ms.

The same approach handles sudo: we open the exec channel with `pty: true`, write the sudo password to stdin once, then proceed. No reinventing `expect`.

### 6.6 Env-detect — what the wizard learns about your NAS

Before Configure, the wizard runs ~25 probes over SSH:

- NAS family — Synology / QNAP / Unraid / TrueNAS / OMV / generic Linux (heuristics: `/etc/synoinfo.conf`, `/etc/qpkg.conf`, /etc/os-release, etc.)
- DSM/OS version
- Docker version (v2 / v1 / missing)
- /volume1 existence + writability for Synology
- Suggested INSTALL_DIR + DATA_ROOT per family
- `python3` + `iptables` paths
- Disk space on the data root
- Default-route interface + IP (for binding services)
- Detected LAN interfaces (RFC1918 vs CGNAT vs public)
- TZ from `/etc/localtime` symlink
- `/etc/passwd` + `/etc/group` lists (populates the Container user dropdown)
- Sudo strategy (root login? NOPASSWD? password required?)
- Existing install detection (does `${INSTALL_DIR}/docker-compose.yml` exist? Are stack containers running?)
- Port-conflict scan on stack ports
- `/dev/net/tun` presence (gluetun needs it on DSM 7)
- iptables modules loaded
- Install-dir filesystem (SQLite gets confused on network FSes)
- Hardlink probe (Downloads ↔ Media)
- Shared-folder ACL on Synology

Each result becomes a tinted check on the Detect screen. Required failures gate Continue; warnings let you proceed eyes-open.

### 6.7 The Run screen — parsing log lines into UI state

setup.sh emits a small set of markers:

```
│ Step N: <label>
✔ Step N complete.
✘ Step N failed
```

The Run screen has three regexes (`STEP_START_RE`, `STEP_OK_RE`, `STEP_FAIL_RE`) that match those, and a setter that updates the StepperRail's per-step status. Same approach for the Done screen's service health:

```
✔ Sonarr   (http://192.168.1.242:49152) — HTTP 200
✘ qBit     (http://192.168.1.242:49156) — HTTP 000 (not reachable)
```

The renderer never needs to call an API to know what's happening — it just reads the log. This means the same wizard works against a real NAS or our mock-mode fake transcript without any branching in the UI code.

### 6.8 Profile persistence

User-typed values (host, password, sudo password, env config form) are stored as profiles under `%APPDATA%\Mediarr Installer\profiles\<uuid>.json`. They're encrypted with Electron's `safeStorage` API (DPAPI on Windows, Keychain on macOS, libsecret on Linux). Switching profiles loads them; auto-save persists every change after a 600ms debounce.

Export (Welcome → gear → Export) wraps a profile in an AES-256-GCM-encrypted JSON envelope with a user-chosen passphrase, suitable for moving between machines or backing up. PBKDF2 with 100k iterations + per-export random salt.

### 6.9 The visual layer (UX/accessibility focus)

Driven by a strong "this should be installable by a child" goal. Specific choices:

- **Atkinson Hyperlegible** body font + **Lexend Deca** display font — both research-backed for low-vision readers and dyslexic users.
- **16px base size + 1.5 line-height** — research-minimum for child + accessibility.
- **Motion (formerly Framer Motion)** for animations, with `LazyMotion + domAnimation` to keep the bundle small. Every animation respects `prefers-reduced-motion`.
- **Lucide React** for icons — tree-shakes per import.
- **Per-service icon vocabulary**: Sonarr = sky `Tv`, Radarr = yellow `Film`, Plex = amber `PlaySquare`, Lidarr = fuchsia `Music`, etc. The same icon appears on the Configure services checklist and again on the Done service grid, so users learn the vocabulary in one place and apply it elsewhere.
- **BigButton component** with spring-physics press feel for every CTA. Same press behaviour across all screens.
- **PasswordInput component** with eye-toggle so users can confirm what they typed before submitting.
- **Friendly language**: "Install paused" instead of "Install failed" — every retryable state uses softer copy.
- **Accessibility sweep**: every interactive surface has a focus ring; every decorative icon is `aria-hidden="true"`; every live region (autosave chip, progress bar, log panel, status footers) uses `role="status"` / `role="log"` / `role="progressbar"` with `aria-live` and `aria-valuenow` as appropriate; every form input pairs to its label with `htmlFor`/`id`; modals use `role="dialog"` + `aria-modal` + `aria-labelledby`; lists use `role="listbox"` + `role="option"` where they're combobox-like (TimezoneSelect).
- **Inline animated confirm** replaces the system `window.confirm()` for destructive actions (delete profile).

---

## 7. Cross-cutting concerns

### 7.1 Idempotency

Every script can be re-run safely. Every API write checks "is this already correct?" first. Three patterns:

1. **Skip-if-exists** — `write_config_file()` skips when the target file already exists. Right for user-customisable configs (recyclarr.yml, etc.).
2. **Overwrite-from-template** — `overwrite_config_file()` always rewrites. Right for generated files that should track env changes (Homepage's services.yaml).
3. **Compare-then-PUT** — for API state, GET current settings, compare to desired, only PUT if different. Right for everything in setup-arr-config.py.

Re-runs are not just safe — they're encouraged. The Run screen's `Retry` button just re-runs `setup.sh` start to finish. The Update mode's "Re-run a step" picks one of the 10 steps.

### 7.2 Error handling

- **Bash** uses `set -euo pipefail` + a trap that prints a coloured `✘ Step N failed` and exits. The wizard's regex catches it; the user sees the rail step go red.
- **Python** wraps every API call in try/except, calls `warn()` for recoverable issues (e.g. couldn't merge a host into SABnzbd's whitelist — the user can fix in the UI) and `fail()` only for things that block the next step.
- **Electron renderer** has a `useErrors` Zustand store. Anywhere that catches an exception calls `reportError(scope, err)` → toast at bottom-right. The toast tray has severity-tinted icons + `role="alert"` for errors.

### 7.3 Logging

- Every NAS-side step pipes through `tee` to `${INSTALL_DIR}/install.log`. The Run screen reads it directly via SSH, and the wizard's Log Actions component lets the user copy/save the log.
- Electron uses `electron-log` with separate channels for main + renderer, rotated weekly, written to `%APPDATA%\Mediarr Installer\logs\`.

### 7.4 Configuration

`.env` is the single source of truth for everything user-controlled. The wizard's Configure screen is essentially a typed editor for `.env`. The schema is defined once in `shared/env-schema.ts` (Zod) and reused on both sides of the IPC.

### 7.5 Time + timezones

Every container gets `TZ` from `.env`. Plex schedules, Sonarr "next-release" dates, and log timestamps all use this. The wizard picks a sensible default from the NAS's `/etc/localtime` symlink target but lets the user override.

---

## 8. Critical design decisions

### 8.1 SSH + SFTP via `ssh2`, not Docker context

**Considered:** Docker context over SSH would let `docker compose up` work from the user's PC.

**Rejected because:** it only covers step 6 of 10. Steps 1–5 (chmod, mkdir, iptables, NordVPN curl, env writes) and 7–10 (Python configurators that read container `config.xml` files) need shell access to the NAS. Carrying both clients isn't worth the marginal benefit.

### 8.2 Encrypted profiles, not OS keychain entries

**Considered:** Putting passwords in the OS keychain (Keychain Access / Credential Manager).

**Rejected because:** we want profiles to be exportable + portable across machines. A keychain entry is bound to the user's local OS account. Our profile envelopes (AES-256-GCM + PBKDF2) can travel via USB or email.

### 8.3 Bash-and-Python NAS payload, not "everything in Python"

**Considered:** Rewriting the bash scripts as Python.

**Rejected because:**
- chmod / mkdir / iptables / curl are first-class in bash and one-liners. Python would be more code for the same effect.
- The Python configurators benefit from bash NOT trying to do their job — bash + curl + jq for the arr APIs would be ~5x the LOC and 10x the fragility.
- Two languages with clear lane separation (bash = system commands, Python = HTTP + JSON) is easier to reason about than one language doing both.

### 8.4 Compose profiles for opt-out, not separate compose files

**Considered:** Having a `docker-compose.no-vpn.yml` override that drops gluetun.

**Adopted: hybrid.** Compose profiles handle per-service enable/disable; a single `docker-compose.no-vpn.yml` override handles the qBittorrent network mode switch (since `network_mode` can't be conditional in compose syntax). setup.sh decides which compose files to layer based on `VPN_ENABLED`.

### 8.5 Per-service icon vocabulary persists across screens

**Considered:** Just using status icons (check / X / spinner) everywhere.

**Adopted: per-service brand-ish icons** (Sonarr = sky Tv, Plex = amber PlaySquare, etc.) on Configure's services checklist + Done's service grid + Migrate's section headers.

**Why:** child users (and any user scanning a 10-service grid) recognise services by their visual identity faster than by reading labels. A user who learned "Sonarr is the sky-blue TV icon" on Configure recognises it on Done without re-reading.

### 8.6 Plex claim is collected on the Run screen, not Configure

**Why:** Plex claim tokens expire 4 minutes after generation. If we collect on Configure, the user might spend 5+ minutes on VPN setup before clicking Continue, and the token's dead by the time setup.sh tries to use it. The wizard's `PlexClaimRefresh` widget on the Run screen has a live countdown + a one-click "Get fresh token" link to plex.tv/claim, ensuring the token is < 30 seconds old at install time.

### 8.7 The Recyclarr trigger sidecar

**Considered:** Building a Web UI into Recyclarr's own container.

**Rejected:** Recyclarr's image is locked to its CLI entrypoint. Forking it means maintaining a rebase against upstream for ~50 lines of Python. Not worth it.

**Adopted:** A separate `python:3-alpine` container next to Recyclarr, mounting `/var/run/docker.sock` so it can `docker exec recyclarr recyclarr sync`, plus an RW bind mount of `${INSTALL_DIR}` so it can update `.env` + re-run `setup-arr-config.py --recyclarr-only` for profile changes.

### 8.8 Mock mode in the installer

`INSTALLER_MOCK=1` swaps the real ssh/sftp/env-detect/vpn services for in-memory mocks that replay a recorded transcript. Why:
- The wizard's UI is testable without a real NAS.
- Demos work on a plane (no SSH needed).
- The StepperRail marker parser, Done-screen health parser, and toast behaviour can all be exercised against deterministic input.

The mock transcript was recorded once from a real install and lives in `src/main/mock-services.ts`.

---

## 9. Build + release pipeline

### 9.1 Two GitHub Actions workflows

- `installer-ci.yml` — typecheck + electron-vite build on every PR and push to master. Also runs `shellcheck` on every NAS bash script and `py_compile` on every NAS Python file.
- `installer-release.yml` — matrix-builds Windows / macOS-arm64 / macOS-x64 / Linux artifacts when an `installer-v*` tag is pushed. Drafts a GitHub Release with the four artefacts attached.

### 9.2 Cutting a release

```bash
# 1. Bump installer/package.json
# 2. Commit
git tag -a installer-v<X.Y.Z> -m "release notes…"
git push origin master installer-v<X.Y.Z>
# CI runs matrix build, drafts release
# 3. Verify artefacts, then publish + mark Latest:
gh release edit installer-v<X.Y.Z> --draft=false --latest --notes "$(cat <<'EOF'
... release notes ...
EOF
)"
```

### 9.3 What's not signed

Windows SmartScreen + macOS Gatekeeper both warn on first launch because the binary isn't code-signed. Signing certificates cost hundreds of dollars per year and require ongoing management; we document the warning rather than sign. INSTALL.md walks users through "More info → Run anyway" on Windows and right-click → Open on macOS.

### 9.4 Payload sync

The installer needs to ship the NAS payload. `scripts/copy-nas-payload.mjs` runs before every `dev` / `build` / `electron-builder` step, mirroring `../nas/` → `installer/resources/nas-payload/` (minus `.env` and `migration/` which are runtime-only). At runtime `payload-resolver.ts` finds this directory regardless of whether we're in dev (cwd-relative) or packaged (asar-relative).

---

## 10. Security boundaries

### 10.1 Renderer is fully sandboxed

```ts
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration:  false,
    sandbox:          true,
    preload:          path.join(__dirname, '../preload/index.js'),
  }
})
```

The renderer can't `require('fs')`, can't `require('ssh2')`, can't `require('child_process')`. Its only Node-side surface is `window.installer.*`, defined explicitly in `preload/index.ts`. If a renderer-side dependency tries to escape, Electron throws at runtime.

### 10.2 Network egress

The wizard makes outbound HTTP only to:
- `api.github.com` — version + release notes check from Welcome
- `api.nordvpn.com` — WireGuard key fetch (when the user opts in)
- `plex.tv/claim` — opened in the OS browser, not by the wizard

No telemetry. No analytics. No auto-update download (we just point at the release page).

### 10.3 SSH credentials

- Password / passphrase / sudo password live in memory in the wizard process.
- They're persisted to disk only inside a profile, encrypted with `safeStorage`. The plaintext never touches the disk.
- The SSH session itself uses ssh2's standard PFS key exchange. No custom crypto.

### 10.4 The Recyclarr trigger's CSRF check

The trigger sidecar exposes POST endpoints (`/sync`, `/profile`). It does a minimal Origin/Host match to defeat the malicious-tab-on-public-internet scenario. Not a hard auth boundary — anyone on the LAN can still `curl` it — but closes the cross-origin browser vector at zero UX cost. Acceptable for a home-LAN tool.

---

## 11. Known trade-offs + future directions

### 11.1 Trade-offs we live with

- **DSM 7-first.** The wizard auto-detects other NAS families and degrades gracefully, but the "happy path" (Synology root SSH, /volume1, BTRFS) is the most-tested.
- **Single-user.** No multi-tenant model. The arrs have their own auth (ARR_USERNAME / ARR_PASSWORD) but the install itself assumes one trusted admin.
- **No HA.** The stack runs on one host. Backup is "snapshot the volume".
- **Unsigned binaries.** See §9.3.
- **NordVPN no port-forwarding.** Gluetun supports PF on ProtonVPN, PIA, PrivateVPN — but not NordVPN. The wizard surfaces this when the user picks NordVPN.

### 11.2 Future directions worth considering

- **Tauri rewrite** if the install footprint becomes a pain point and `ssh2` gets a Rust equivalent worth depending on.
- **Streaming compose log via Docker API** — would let the Run screen show per-container pull progress, not just setup.sh markers. Requires adding the Docker SDK to the main process.
- **Code signing** when there's a sustained user base.
- **Self-hosted Recyclarr alternative** that takes Bazarr-style provider plugins instead of `recyclarr.yml`. Out of scope today.
- **Migration target == source detection** to refuse self-migrations that would lose data.
- **In-app changelog** — pull GitHub Releases at launch and surface "new since you last ran". Currently we just show "new version available" if the latest tag is greater.

---

## Appendix A — File map

```
NAS/
├─ nas/                          ← Layer 2: NAS payload
│  ├─ docker-compose.yml         ← Layer 1: the stack
│  ├─ docker-compose.no-vpn.yml  ← override when VPN_ENABLED=false
│  ├─ .env.example               ← documented template
│  ├─ setup.sh                   ← 10-step orchestrator
│  ├─ setup-{chmod,folders,firewall,nordvpn,validate}.sh
│  ├─ setup-arr-config.py        ← 3500-line API configurator
│  ├─ post-deploy-validate.sh
│  ├─ recyclarr-trigger.py       ← tiny web UI sidecar
│  ├─ recyclarr-sync.sh          ← CLI sync wrapper
│  ├─ restart-qbit.sh            ← gluetun-aware restart helper
│  ├─ tune-arrs.sh               ← SQLite vacuum + indexer disable
│  ├─ stop-all.sh                ← profile-aware down
│  ├─ boot-orchestrator.sh       ← Synology Task Scheduler boot script
│  ├─ indexers/
│  │  ├─ setup-indexers.py
│  │  └─ setup-bazarr-providers.py
│  └─ migration/
│     ├─ fix-plex-paths.py
│     ├─ fix-qbit-paths.sh
│     └─ migrate-plex-app.txt
│
├─ installer/                    ← Layer 3: Electron wizard
│  ├─ package.json
│  ├─ electron.vite.config.ts
│  ├─ electron-builder.yml
│  ├─ tailwind.config.ts
│  ├─ scripts/copy-nas-payload.mjs
│  ├─ resources/nas-payload/     ← GENERATED (mirror of ../nas/)
│  └─ src/
│     ├─ shared/                 ← types + helpers used by main + renderer
│     │  ├─ ipc.ts               ← single source of truth for IPC channels
│     │  ├─ env-render.ts        ← form values → .env text
│     │  ├─ env-schema.ts        ← Zod schema (used both sides)
│     │  └─ vpn-providers.ts
│     ├─ main/
│     │  ├─ index.ts             ← BrowserWindow setup, mock-mode gate
│     │  ├─ ssh-service.ts
│     │  ├─ sftp-service.ts
│     │  ├─ env-detector.ts
│     │  ├─ vpn-service.ts
│     │  ├─ profile-store.ts
│     │  ├─ payload-resolver.ts
│     │  ├─ mock-services.ts     ← INSTALLER_MOCK=1 replays this
│     │  └─ ipc-handlers.ts
│     ├─ preload/index.ts        ← contextBridge surface
│     └─ renderer/
│        ├─ App.tsx              ← AnimatePresence + stepper rail
│        ├─ main.tsx             ← LazyMotion wrap
│        ├─ store/
│        │  ├─ wizard.ts         ← Zustand
│        │  └─ errors.ts         ← Zustand
│        ├─ hooks/
│        │  ├─ useProfileAutosave.ts
│        │  └─ useFollowScroll.ts
│        ├─ components/          ← BigButton, PasswordInput,
│        │                         AnimatedCheck, ScreenTransition,
│        │                         StepperRail, LogPanel, LogActions,
│        │                         ToastTray, IssuesModal,
│        │                         TroubleshootingModal, WhatsNew,
│        │                         IndexerCard, TimezoneSelect,
│        │                         PlexClaimRefresh, Export/Import
│        │                         dialogs
│        └─ screens/             ← Welcome, Connect, EnvDetect,
│                                  Configure, Run, UpdateRun,
│                                  Migrate, Done
│
├─ .github/workflows/
│  ├─ installer-ci.yml
│  └─ installer-release.yml
│
├─ README.md                     ← architecture + manual install
└─ TDD.md                        ← this file (beginner + teach-yourself guides → GitHub Wiki)
```

---

## Appendix B — Glossary

- **arr / arr stack** — Sonarr / Radarr / Lidarr (and Prowlarr, the indexer hub). Community shorthand for the `*arr` family of automation tools.
- **TRaSH Guides** — community-maintained quality recipes for the arrs. Recyclarr is the tool that syncs them.
- **Hardlink** — a second filesystem name for the same inode. Two paths, one file, no extra disk. Enables qBittorrent to keep seeding while Plex reads from a tidier path.
- **Container namespace sharing** — Docker feature where container B has no network of its own and shares container A's. Used to keep qBittorrent's only network path inside Gluetun's VPN.
- **LSIO** — linuxserver.io. The Docker image publisher for most of our containers.
- **Idempotent** — re-running has the same effect as running once. Every script + every API call in this stack is idempotent.
- **PUID/PGID** — POSIX user/group IDs the containers run as. Need to match the NAS user that owns the data tree, or hardlinks fail with `EPERM`.
