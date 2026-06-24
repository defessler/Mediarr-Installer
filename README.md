# NAS Media Stack

A self-hosted media automation stack running on a Synology DS1522+. Tell it what you want to watch — it finds, downloads, organises, and serves it to **Plex or Jellyfin** automatically.

> **The wizard does all of this for you.** Download the latest **[Mediarr
> Installer](https://github.com/defessler/Mediarr-Installer/releases/latest)**
> (Windows / macOS / Linux), point it at your NAS, and the eight-screen
> wizard handles SSH, payload upload, `.env`, claim tokens, VPN keys,
> Recyclarr profile picks, post-install validation — everything below.
> The beginner walkthrough is on the **[Installation wiki page](https://github.com/defessler/Mediarr-Installer/wiki/Installation)**
> with a screen-by-screen tour.
>
> The rest of this page exists for two reasons:
> 1. To explain what the wizard is doing on your NAS under the hood
>    (architecture, services, hardlinks, internal hostnames).
> 2. As the manual install path if you want to skip the wizard — the
>    `nas/` directory in this repo is exactly what the wizard uploads,
>    so you can SCP it yourself and run `setup.sh`. See the
>    [Manual install (no wizard)](#manual-install-no-wizard) section.

---

## Table of Contents

- [How it works](#how-it-works)
- [Services](#services)
- [Scripts](#scripts)
- [Day-2 operations](#day-2-operations)
- [Manual install (no wizard)](#manual-install-no-wizard)
- [Troubleshooting](#troubleshooting)
- [Quick Reference](#quick-reference)
- [Migrating from Existing Services](#migrating-from-existing-services)

---

## How it works

```
 Requests          Indexers          Download          Storage          Playback
─────────────────────────────────────────────────────────────────────────────────
                  ┌─────────┐
                  │ Prowlarr│  ← manages all your torrent/usenet indexers
                  └────┬────┘
                       │ syncs indexers to
          ┌────────────┼────────────┐
          ▼            ▼            ▼
┌───────────┐  ┌───────────┐  ┌────────┐
│  Sonarr   │  │  Radarr   │  │ Lidarr │  ← monitor TV / movies / music
└─────┬─────┘  └─────┬─────┘  └───┬────┘
      └───────────────┴────────────┘
                      │ sends download jobs to
             ┌────────┴────────┐
             ▼                 ▼
      ┌────────────┐   ┌──────────┐
      │qBittorrent │   │ SABnzbd  │  ← torrent + usenet download clients
      │ (via VPN)  │   │          │
      └─────┬──────┘   └────┬─────┘
            └───────┬────────┘
                    │ downloads to /data/Downloads/
                    │ Sonarr/Radarr/Lidarr hardlink to /data/Media/
                    ▼
             ┌──────────────────┐
             │ Plex / Jellyfin  │  ← streams your library to any device
             └──────────────────┘
```

> **Media server: Plex or Jellyfin.** Pick one with `MEDIA_SERVER=plex`
> (default) or `MEDIA_SERVER=jellyfin` in `.env` (the wizard's Configure
> screen has a Plex/Jellyfin picker). They're mutually exclusive. Jellyfin
> is free and open-source with no account or claim token; the request
> portal becomes **Jellyseerr** (which also supports Plex), and Plex-only
> **Tautulli** is skipped (Jellyfin has built-in playback stats). For
> Jellyfin, paste a `JELLYFIN_API_KEY` (generated after its first-run web
> setup) so the *arrs* trigger library refreshes on import.

### Services

| Service | Role |
|---------|------|
| **Plex** *or* **Jellyfin** | Media server (pick one via `MEDIA_SERVER`) — streams to phones, TVs, browsers. Jellyfin is free & open-source, no account needed. |
| **Sonarr** | TV show automation — monitors, downloads, imports |
| **Radarr** | Movie automation — same as Sonarr but for movies |
| **Lidarr** | Music automation — same pattern, for albums and tracks |
| **Prowlarr** | Indexer manager — syncs torrent/usenet sources to the *arrs |
| **Bazarr** | Subtitle automation — fetches subtitles for imported content |
| **qBittorrent** | Torrent client — all traffic routes through Gluetun VPN |
| **SABnzbd** | Usenet client |
| **Gluetun** | VPN gateway — qBittorrent's network runs entirely inside it |
| **Seerr** / **Jellyseerr** | Request portal — lets others request movies/shows (Jellyseerr is used when `MEDIA_SERVER=jellyfin`) |
| **Tautulli** | Plex analytics — watch history, stream stats, notifications (Plex only; skipped for Jellyfin, which has built-in stats) |
| **Recyclarr** | Syncs TRaSH Guide quality profiles into Sonarr/Radarr |
| **Unpackerr** | Watches completed downloads and unpacks archives for import |
| **Playlist Sync** | Opt-in — mirrors SiriusXM channels into Plex/Jellyfin playlists (Soulseek-first, yt-dlp fallback) |

### Key concepts

**Hardlinks** — downloads and media share the same `/data` mount. When Sonarr/Radarr import a file they create a hardlink rather than copying it. The file appears in two places but uses disk space only once. qBittorrent keeps seeding the original; Plex reads the media copy.

**VPN kill-switch** — qBittorrent doesn't have its own network interface. It runs inside Gluetun's network namespace, so if the VPN drops qBittorrent loses connectivity rather than falling back to your real IP.

**Internal hostnames** — all containers share a Docker bridge network and talk to each other by service name (`http://sonarr:8989`, `http://radarr:7878`, etc.). No static IPs or port forwarding needed between services.

---

## Scripts

All deployment files live in the `nas/scripts/` folder. Copy that directory to the NAS so it lands at `/volume1/docker/media/scripts/` (the compose root — where `docker-compose.yml` and `.env` live). The optional `nas/migration/` tooling is **not** bundled by the wizard; SCP it separately if you need it (see [Migrating from Existing Services](#migrating-from-existing-services)).

| File | What it does |
|------|-------------|
| `docker-compose.yml` | Full stack definition |
| `.env.example` | Config template — committed to git with all keys documented, no values |
| `.env` | Your actual values — gitignored, never committed; copy from `.env.example` |
| `setup.sh` | Master script — runs all setup steps in order |
| `setup-chmod.sh` | Sets correct permissions on all stack files |
| `setup-folders.sh` | Creates required directories and sets ownership |
| `setup-firewall.sh` | Applies iptables rules and installs them to survive reboots |
| `setup-nordvpn.sh` | Fetches NordVPN WireGuard key and writes it to .env |
| `setup-validate.sh` | Validates configuration before starting the stack |
| `post-deploy-validate.sh` | Validates the stack is working after `docker-compose up` |
| `setup-arr-config.py` | Auto-configures all services via API after first boot |
| `indexers/setup-indexers.py` | Adds torrent/usenet indexers to Prowlarr |
| `indexers/setup-bazarr-providers.py` | Enables subtitle providers in Bazarr |
| `migration/fix-plex-paths.py` | Updates Plex library paths in the database (migration only — repo only; SCP manually for native-Plex migration) |
| `migration/fix-qbit-paths.sh` | Updates qBittorrent torrent save paths via API (migration only — repo only; SCP manually for native-Plex migration) |
| `migration/migrate-plex-app.txt` | Step-by-step notes for migrating from the native Plex package (repo only — not bundled by the wizard) |

---

## Day-2 operations

After install, the stack is mostly self-managing — Sonarr / Radarr / Prowlarr / Recyclarr all run on their own. The few things you might still want to do are surfaced through web UIs rather than the command line:

| Action | Where |
|--------|-------|
| Add a TV show / movie | Sonarr / Radarr, or **Seerr** for the Netflix-style request flow |
| Change TRaSH Guide quality profile | Recyclarr tile on Homepage → pick the new profile in the dropdown → "Save profile & sync". (Or re-run the installer.) The trigger page rewrites `.env` + `recyclarr.yml` + syncs in one click. |
| Re-pull container images | Installer → pick the profile → **Update mode** → "Pull + recreate". No SSH needed. |
| Refresh the Homepage dashboard | Installer Update mode → "Refresh dashboard". Regenerates `services.yaml` from your current enabled-service flags. |
| Re-run a specific setup step | Installer Update mode → "Re-run a step" — picks from the 12-step setup.sh in a dropdown. |
| Migrate a library across NAS | Installer → pick destination profile → **Migrate mode** → paste source URL + API key, click Import. |

Everything above is also achievable from SSH if you prefer — see [Manual install (no wizard)](#manual-install-no-wizard) for the underlying scripts. But the wizard is the supported path.

---

## Manual install (no wizard)

If you'd rather skip the installer (e.g. headless setup, scripted deployment, or you just don't want a desktop app):

1. **Copy `nas/scripts` to the NAS** (it lands at `.../scripts/` — the compose root):
   ```bash
   scp -r nas/scripts user@192.168.1.242:/volume1/docker/media/
   ```
2. **Copy + fill in `.env`** — `.env.example` is the documented template:
   ```bash
   cp /volume1/docker/media/scripts/.env.example /volume1/docker/media/scripts/.env
   nano /volume1/docker/media/scripts/.env
   ```
   Required keys: `PUID`, `PGID`, `TZ`, `LAN_IP`, `QBITTORRENT_PASS`. Optional: `MEDIA_SERVER` (`plex` (default) or `jellyfin`), `PLEX_CLAIM` (Plex only — from https://plex.tv/claim, expires in 4 minutes, paste it right before running `setup.sh`), `JELLYFIN_API_KEY` (Jellyfin only — generate it after Jellyfin's first-run setup at `:8096` → Dashboard → API Keys, then re-run `setup-arr-config.py`), `NORDVPN_ACCESS_TOKEN` (auto-fetches WireGuard key), `ARR_USERNAME` / `ARR_PASSWORD`, `TRASH_SONARR_PROFILE` / `TRASH_RADARR_PROFILE` for the Recyclarr quality bundle.
3. **Run setup.sh**
   ```bash
   cd /volume1/docker/media/scripts
   sudo bash /volume1/docker/media/scripts/setup.sh
   ```
   Handles permissions, folders, firewall, NordVPN key fetch, validation, `docker compose up -d`, then API-configures every arr (root folders, download clients, remote path mappings, hardlinks, auth, indexers, subtitle providers). Safe to re-run — every step is idempotent.

The installer does exactly the same work; it uploads the bundled deployment scripts (`nas/scripts/`) via SFTP and runs `setup.sh` over SSH on your behalf, plus wraps profile management + claim-token freshness + per-step re-run. (The optional `nas/migration/` tooling is **not** part of that payload — SCP it manually if you need it.)

---

## Troubleshooting

> All `docker compose` commands below assume you're in the compose root: `cd /volume1/docker/media/scripts` first (where `docker-compose.yml` and `.env` live).

**Container won't start**
```bash
docker compose logs <service>
```

**Permission denied errors**
```bash
id <your-nas-username>
ls -la /volume1/docker/media/
ls -la /volume1/Data/Downloads/
```
Re-run `setup-folders.sh` to fix ownership.

**Plex doesn't see your media**
Library paths inside the Plex container (via the `/media` mount):
- Movies → `/media/Movies`
- TV Shows → `/media/TV Shows`
- Anime Movies → `/media/Anime/Movies`
- Anime TV Shows → `/media/Anime/TV Shows`
- Music → `/media/Music`

Update under Settings → Libraries → Edit → Manage Folders.

**Plex shows a hash code instead of server name / won't play media**
The server wasn't claimed on first boot. Access it directly at `http://192.168.1.242:32400/web` and sign in — it will prompt you to claim it. Once claimed, rename it under Settings.

**Plex "secure connection" warning in browser**
Access Plex via direct IP (`http://192.168.1.242:32400/web`) rather than through `app.plex.tv`, or set Settings → Network → Secure connections to `Preferred`.

**Sonarr/Radarr says "copied" instead of "hardlinked"**
- Enable "Use Hardlinks instead of Copy" in Settings → Media Management (`setup-arr-config.py` does this for you)
- Verify both downloads and media are under the single `/data` mount
- **Synology-specific:** put Downloads/ and Media/ under the SAME shared folder. Each Synology shared folder is its own btrfs subvolume, and hardlinks across subvolumes fail with `EXDEV`. `setup-validate.sh` includes a hardlink probe that catches this.

**Sonarr/Radarr gets 403 from SABnzbd**
Re-run `setup-arr-config.py` — it merges the required Docker hostnames into SABnzbd's `host_whitelist` which blocks inter-container connections by default.

**Plex doesn't update when new content is imported**
Sonarr/Radarr send a Plex Connect notification on every import (auto-configured by `setup-arr-config.py`). If the connection failed at install time, add it manually:
- Plex Web UI → Settings → Network → ensure "Update my library automatically" is on
- Sonarr → Settings → Connect → Add → Plex Media Server (host=plex, port=32400, your Plex token)
- Same for Radarr

**qBittorrent can't connect / all torrents stalled**
Gluetun is likely not connected:
```bash
docker compose logs gluetun
```

**qBittorrent loses its torrent list after restart**
The init script uses a sentinel file (`/config/.credentials-set`) to avoid resetting the config on subsequent boots. If the sentinel file doesn't exist (e.g. first boot after setup), it runs once and creates it. If torrents are lost anyway, the `.torrent` and `.fastresume` files are preserved at `/volume1/docker/media/qbittorrent/config/qBittorrent/BT_Backup/`.

**Stack restart fails — qBittorrent won't connect**
Always restart the full stack with `down && up`, not `restart`:
```bash
docker compose down && docker compose up -d
```
`restart` brings everything up simultaneously without respecting dependency order — qBittorrent tries to join Gluetun's network before Gluetun is ready.

**qBittorrent stays "Firewalled" — port forwarding doesn't work**
- **NordVPN doesn't support port forwarding via Gluetun** — switch to ProtonVPN/PIA/PrivateVPN if you need PF for seeding ratio.
- For supported providers, set `VPN_PORT_FORWARDING=on` in `.env`. The Gluetun up-command pushes the new port into qBittorrent's listen_port via the WebUI API on every reconnect.

**"Another setup.sh is already running" error**
`setup.sh` holds a `flock` on `.setup.lock` to prevent two parallel installs racing on `.env` writes (installer wizard + manual SSH session is the common trigger). Stale locks from a crashed run are auto-detected via PID check. If the message is wrong, remove `.setup.lock` manually:
```bash
cat /volume1/docker/media/.setup.lock   # shows holding PID
rm /volume1/docker/media/.setup.lock
```

---

## Quick Reference

### Service URLs

| Service      | URL                              |
|--------------|----------------------------------|
| Plex         | http://192.168.1.242:32400/web   |
| Sonarr       | http://192.168.1.242:49152       |
| Radarr       | http://192.168.1.242:49151       |
| Lidarr       | http://192.168.1.242:49154       |
| Prowlarr     | http://192.168.1.242:49150       |
| Bazarr       | http://192.168.1.242:49153       |
| SABnzbd      | http://192.168.1.242:49155       |
| qBittorrent  | http://192.168.1.242:49156       |
| Seerr        | http://192.168.1.242:5056        |
| Tautulli     | http://192.168.1.242:8181        |

### Internal Hostnames

Use these when connecting services to each other inside Docker.
`setup-arr-config.py` handles this automatically — only needed for manual configuration.

> **qBittorrent:** shares Gluetun's network namespace. Use `gluetun` as the hostname and `49156` as the port when adding it as a download client.

| Service      | Hostname  | Port  |
|--------------|-----------|-------|
| Plex         | plex      | 32400 |
| Sonarr       | sonarr    | 8989  |
| Radarr       | radarr    | 7878  |
| Lidarr       | lidarr    | 8686  |
| Prowlarr     | prowlarr  | 9696  |
| Bazarr       | bazarr    | 6767  |
| SABnzbd      | sabnzbd   | 8080  |
| qBittorrent  | gluetun   | 49156 |
| Seerr        | seerr     | 5055  |
| Tautulli     | tautulli  | 8181  |

### Docker Compose Cheatsheet

All commands run from `/volume1/docker/media/scripts/` (the compose root — where `docker-compose.yml` and `.env` live). cd there first: `cd /volume1/docker/media/scripts`.

> Use **Docker Compose v2.20+** (`docker compose`, with a space). Compose v1 (`docker-compose`) silently ignores the `!reset` tag in the VPN-off override and hangs the stack.

**Everyday**
```bash
docker compose ps                                    # container status
docker compose up -d                                 # start all (or start stopped containers)
docker compose down && docker compose up -d          # full restart (respects dependency order)
docker compose restart sonarr                        # restart one container
docker compose stop sonarr && docker compose start sonarr
```

**Updates**
```bash
docker compose pull                  # pull latest images for all services
docker compose pull sonarr           # pull latest for one service
docker compose up -d                 # recreate containers that have a newer image
```

**Logs**
```bash
docker compose logs sonarr           # recent logs
docker compose logs -f sonarr        # live logs (Ctrl+C to stop)
docker compose logs --tail=50 sonarr
docker compose logs -f               # all services
```

**Debugging**
```bash
docker compose exec sonarr bash                        # shell inside container
docker exec gluetun wget -qO- https://ipinfo.io        # check VPN IP
docker stats                                           # live CPU/memory
docker compose config                                  # resolved config with .env applied
docker inspect sonarr                                  # full container details
```

**Cleanup**
```bash
docker image prune                   # remove unused images
docker system prune                  # remove stopped containers, unused networks, dangling images
```

---

## Migrating from Existing Services

### From the native Plex package

If you're running Plex via Synology Package Center and want to move your library to the Docker container without re-scanning everything.

**Step 1 — Stop the native package**
```bash
synopkg stop PlexMediaServer
```

**Step 2 — Find the existing data**
```bash
find /volume1 -maxdepth 4 -name "Preferences.xml" -path "*/Plex*" 2>/dev/null
```

**Step 3 — Copy to the Docker config path**
```bash
mkdir -p "/volume1/docker/media/plex/config/Library/Application Support/"

cp -a "/volume1/PlexMediaServer/AppData/Plex Media Server" \
      "/volume1/docker/media/plex/config/Library/Application Support/"
```

**Step 4 — Fix ownership**
```bash
PUID=$(grep -m1 '^PUID=' /volume1/docker/media/.env | cut -d'=' -f2-)
PGID=$(grep -m1 '^PGID=' /volume1/docker/media/.env | cut -d'=' -f2-)
chown -R ${PUID}:${PGID} /volume1/docker/media/plex/config/
```

**Step 5 — Fix library paths**

The native package stored NAS host paths (e.g. `/volume1/...`) in the database; the Docker container uses `/media` instead. Run the path fixer.

> **Note:** the `migration/` scripts ship only in the git repo — the wizard payload does **not** include them. SCP the file to the NAS first:
> ```bash
> scp nas/migration/fix-plex-paths.py user@192.168.1.242:/volume1/docker/media/migration/
> ```

```bash
# Dry run first to preview changes
python3 /volume1/docker/media/migration/fix-plex-paths.py

# Apply
python3 /volume1/docker/media/migration/fix-plex-paths.py --apply
```

> When migrating from the native package, `PLEX_CLAIM` in `.env` can be left blank — the existing `Preferences.xml` already has your Plex account token.

**Step 6 — Reassign existing media to the new root folders**

After starting the stack, Sonarr/Radarr will still have the old root folder paths. Fix via Mass Editor:

- **Sonarr:** Series → Mass Editor → select all → change root to `/data/Media/TV Shows`
- **Radarr:** Movies → Mass Editor → select all → change root to `/data/Media/Movies`
- Repeat for anime libraries using `/data/Media/Anime/TV Shows` and `/data/Media/Anime/Movies`
- Delete old root folders once empty

**Step 7 — Fix qBittorrent save paths (if needed)**

If your torrents were saved to different paths under the old setup (this script is **repo only** — SCP it to the NAS first, e.g. `scp nas/migration/fix-qbit-paths.sh user@192.168.1.242:/volume1/docker/media/migration/`):
```bash
bash /volume1/docker/media/migration/fix-qbit-paths.sh --dry-run
bash /volume1/docker/media/migration/fix-qbit-paths.sh
```

---

### From Jackett

After adding your indexers in Prowlarr and confirming they work, remove the old Jackett-based indexers from each *arr:

- **Sonarr:** Settings → Indexers → delete Jackett entries
- **Radarr:** Settings → Indexers → delete Jackett entries
- **Lidarr:** Settings → Indexers → delete Jackett entries

Prowlarr will have already pushed its own indexer connections — you can verify under each app's Settings → Indexers that the Prowlarr-sourced ones are present before deleting.

---

### From Overseerr

Seerr is a fork of Overseerr and can import your existing request history:

Settings → Import (in Seerr) → point it at your Overseerr data.
