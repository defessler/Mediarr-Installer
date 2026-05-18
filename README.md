# NAS Media Stack

A self-hosted media automation stack running on a Synology DS1522+. Tell it what you want to watch — it finds, downloads, organises, and serves it to Plex automatically.

> **New to this?** There's a step-by-step beginner's tutorial that uses the GUI
> installer (no command line required): **[INSTALL.md](./INSTALL.md)**.
> This page is the technical / power-user docs for the manual install path.

---

## Table of Contents

- [How it works](#how-it-works)
- [Scripts](#scripts)
- [Setup](#setup)
  - [Step 1: Copy files to the NAS](#step-1-copy-files-to-the-nas)
  - [Step 2: Fill in .env](#step-2-fill-in-env)
  - [Step 3: Run setup.sh](#step-3-run-setupsh)
  - [Step 4: Manual configuration](#step-4-manual-configuration)
  - [Step 5: Verify end-to-end](#step-5-verify-end-to-end)
- [Troubleshooting](#troubleshooting)
- [Quick Reference](#quick-reference)
  - [Service URLs](#service-urls)
  - [Internal Hostnames](#internal-hostnames)
  - [Docker Compose Cheatsheet](#docker-compose-cheatsheet)
- [Migrating from Existing Services](#migrating-from-existing-services)
  - [From the native Plex package](#from-the-native-plex-package)
  - [From Jackett](#from-jackett)
  - [From Overseerr](#from-overseerr)

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
             ┌────────────┐
             │    Plex    │  ← streams your library to any device
             └────────────┘
```

### Services

| Service | Role |
|---------|------|
| **Plex** | Media server — streams to phones, TVs, browsers |
| **Sonarr** | TV show automation — monitors, downloads, imports |
| **Radarr** | Movie automation — same as Sonarr but for movies |
| **Lidarr** | Music automation — same pattern, for albums and tracks |
| **Prowlarr** | Indexer manager — syncs torrent/usenet sources to the *arrs |
| **Bazarr** | Subtitle automation — fetches subtitles for imported content |
| **qBittorrent** | Torrent client — all traffic routes through Gluetun VPN |
| **SABnzbd** | Usenet client |
| **Gluetun** | VPN gateway — qBittorrent's network runs entirely inside it |
| **Seerr** | Request portal — lets others request movies/shows |
| **Tautulli** | Plex analytics — watch history, stream stats, notifications |
| **Recyclarr** | Syncs TRaSH Guide quality profiles into Sonarr/Radarr |
| **Unpackerr** | Watches completed downloads and unpacks archives for import |

### Key concepts

**Hardlinks** — downloads and media share the same `/data` mount. When Sonarr/Radarr import a file they create a hardlink rather than copying it. The file appears in two places but uses disk space only once. qBittorrent keeps seeding the original; Plex reads the media copy.

**VPN kill-switch** — qBittorrent doesn't have its own network interface. It runs inside Gluetun's network namespace, so if the VPN drops qBittorrent loses connectivity rather than falling back to your real IP.

**Internal hostnames** — all containers share a Docker bridge network and talk to each other by service name (`http://sonarr:8989`, `http://radarr:7878`, etc.). No static IPs or port forwarding needed between services.

---

## Scripts

All deployment files live in the `nas/` folder. Copy the entire `nas/` directory to `/volume1/docker/media/` on the NAS.

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
| `migration/fix-plex-paths.py` | Updates Plex library paths in the database (migration only) |
| `migration/fix-qbit-paths.sh` | Updates qBittorrent torrent save paths via API (migration only) |
| `migration/migrate-plex-app.txt` | Step-by-step notes for migrating from the native Plex package |

---

## Setup

### Step 1: Copy files to the NAS

Copy the contents of `nas/` to `/volume1/docker/media/` on the NAS.

Via SMB — open `\\192.168.1.242` in File Explorer, navigate to `docker/media`, drag in the contents of `nas/`.

Or via SCP:
```bash
scp -r nas/ user@192.168.1.242:/volume1/docker/media/
```

---

### Step 2: Fill in .env

Copy the template and fill in your values:
```bash
cp /volume1/docker/media/.env.example /volume1/docker/media/.env
nano /volume1/docker/media/.env
```

`.env.example` is the committed template with all keys documented. `.env` holds your real values and is gitignored — never committed. Docker Compose reads `.env` automatically.

```env
PUID=1034
PGID=100
TZ=America/New_York           # your timezone
LAN_IP=192.168.1.242          # your NAS LAN IP
LAN_SUBNET=                   # optional — auto-derived from LAN_IP as /24
                              #   override only if your LAN isn't a /24
                              #   (e.g. LAN_SUBNET=10.0.0.0/16)

PLEX_CLAIM=                   # from https://plex.tv/claim (expires in 4 min — fill in right before Step 4)

SONARR_API_KEY=               # from Sonarr → Settings → General (fill in after first boot)
RADARR_API_KEY=               # from Radarr → Settings → General (fill in after first boot)

QBITTORRENT_USER=admin
QBITTORRENT_PASS=             # choose any password

ARR_USERNAME=                 # optional — sets login on Sonarr/Radarr/Lidarr/Prowlarr/SABnzbd/Bazarr
ARR_PASSWORD=                 # leave blank to skip auth setup

NORDVPN_ACCESS_TOKEN=         # from my.nordaccount.com → NordVPN → Access Tokens
VPN_PROVIDER=nordvpn          # nordvpn | protonvpn | mullvad | airvpn | surfshark | custom
VPN_TYPE=wireguard
NORDVPN_PRIVATE_KEY=          # leave blank — setup-nordvpn.sh fills this in
VPN_COUNTRIES=                # e.g. United States, Netherlands
VPN_PORT_FORWARDING=off       # set to "on" for ProtonVPN/PIA/PrivateVPN
                              # — NOT supported on NordVPN (silently no-ops)
```

**Getting your NordVPN access token:**
1. Log in at https://my.nordaccount.com
2. Go to **NordVPN → Manual configuration → Access Tokens**
3. Generate a new token and copy it into `NORDVPN_ACCESS_TOKEN`

`setup-nordvpn.sh` (called by `setup.sh`) uses this token to fetch the WireGuard private key automatically and writes it into `.env`.

---

### Step 3: Run setup.sh

Get a fresh Plex claim token right before running this (it expires in 4 minutes):
1. Go to https://plex.tv/claim
2. Copy the token and set `PLEX_CLAIM=claim-...` in `.env`

Then run:
```bash
sudo bash /volume1/docker/media/setup.sh
```

This handles everything in one command:
1. Sets correct permissions on all scripts and config files
2. Creates all required directories with correct ownership
3. Applies iptables firewall rules and installs them to survive reboots
4. Fetches your NordVPN WireGuard key and writes it to `.env`
5. Validates the full configuration
6. Starts the stack with `docker-compose up -d`
7. Waits for all services to come up (first run downloads images — may take a few minutes)
8. Configures all services automatically via API (root folders, download clients, indexer connections, auth)
9. Adds torrent and usenet indexers to Prowlarr
10. Enables subtitle providers in Bazarr

What gets configured automatically:

| Service | What gets set up |
|---------|-----------------|
| SABnzbd | Download directories, tv/movies/music categories |
| Sonarr | Root folders, qBittorrent + SABnzbd clients, remote path mapping, hardlinks |
| Radarr | Same with movie categories and roots |
| Lidarr | Same with music category and root |
| Prowlarr | Sonarr, Radarr, and Lidarr app connections; public torrent + usenet indexers |
| Bazarr | Sonarr and Radarr connections; free subtitle providers |
| Seerr | Sonarr and Radarr connections *(after wizard — see Step 4)* |
| Unpackerr | Generates `unpackerr.conf` with API keys pre-filled |
| Recyclarr | Generates starter `recyclarr.yml` with API keys pre-filled |

Safe to re-run — all steps skip anything already configured.

---

### Step 4: Manual configuration

The script handles everything it can via API. The following require manual action:

#### qBittorrent (http://192.168.1.242:49156)

**Watched folder** — Settings → Downloads → Automatically add torrents from: `/downloads/ToFetch`

**Seeding limits** — Settings → BitTorrent → set your preferred ratio (e.g. 2.0) or time limit.

#### Sonarr / Radarr / Lidarr

Set up your quality profiles and then add the series/movies/artists you want to monitor.

#### Prowlarr (http://192.168.1.242:49150)

`setup.sh` already connected Prowlarr to Sonarr, Radarr, and Lidarr and added public indexers. Add any additional indexers manually: Indexers → **+ Add Indexer**.

#### Seerr (http://192.168.1.242:5056)

Seerr needs its wizard completed before it can be wired up:
1. Complete the setup wizard
2. Connect Plex during the wizard: `http://plex:32400`
3. Re-run `setup-arr-config.py` — it will wire up Sonarr and Radarr automatically:
   ```bash
   python3 /volume1/docker/media/setup-arr-config.py
   ```

#### Tautulli (http://192.168.1.242:8181)

Connect to Plex: `http://plex:32400` and your Plex token
(find it in Plex → Settings → Troubleshooting → Get your X-Plex-Token)

#### Recyclarr

The script generated a starter config at `/volume1/docker/media/recyclarr/config/recyclarr.yml` with your API keys pre-filled. Customise it with the TRaSH Guide quality profiles you want — see https://recyclarr.dev/wiki.

To trigger a manual sync:
```bash
docker exec recyclarr recyclarr sync
```

---

### Step 5: Verify end-to-end

1. Confirm Gluetun is connected — the IP should be your VPN's, not your home IP:
   ```bash
   docker exec gluetun wget -qO- https://ipinfo.io
   ```
2. Search for something in Sonarr or Radarr and trigger a manual download
3. Verify qBittorrent downloads to `/downloads/Completed/` (via `/downloads/InProgress/` while active)
4. Verify Sonarr/Radarr activity log says **hardlinked** (not copied)
5. Verify qBittorrent keeps seeding after import
6. Check Plex sees the newly imported media
7. Try requesting something through Seerr

---

## Troubleshooting

**Container won't start**
```bash
docker-compose logs <service>
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
docker-compose logs gluetun
```

**qBittorrent loses its torrent list after restart**
The init script uses a sentinel file (`/config/.credentials-set`) to avoid resetting the config on subsequent boots. If the sentinel file doesn't exist (e.g. first boot after setup), it runs once and creates it. If torrents are lost anyway, the `.torrent` and `.fastresume` files are preserved at `/volume1/docker/media/qbittorrent/config/qBittorrent/BT_Backup/`.

**Stack restart fails — qBittorrent won't connect**
Always restart the full stack with `down && up`, not `restart`:
```bash
docker-compose down && docker-compose up -d
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

All commands run from `/volume1/docker/media/`.

**Everyday**
```bash
docker-compose ps                                    # container status
docker-compose up -d                                 # start all (or start stopped containers)
docker-compose down && docker-compose up -d          # full restart (respects dependency order)
docker-compose restart sonarr                        # restart one container
docker-compose stop sonarr && docker-compose start sonarr
```

**Updates**
```bash
docker-compose pull                  # pull latest images for all services
docker-compose pull sonarr           # pull latest for one service
docker-compose up -d                 # recreate containers that have a newer image
```

**Logs**
```bash
docker-compose logs sonarr           # recent logs
docker-compose logs -f sonarr        # live logs (Ctrl+C to stop)
docker-compose logs --tail=50 sonarr
docker-compose logs -f               # all services
```

**Debugging**
```bash
docker-compose exec sonarr bash                        # shell inside container
docker exec gluetun wget -qO- https://ipinfo.io        # check VPN IP
docker stats                                           # live CPU/memory
docker-compose config                                  # resolved config with .env applied
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

The native package stored NAS host paths (e.g. `/volume1/...`) in the database; the Docker container uses `/media` instead. Run the path fixer:
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

If your torrents were saved to different paths under the old setup:
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
