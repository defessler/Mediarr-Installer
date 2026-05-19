# Build It Yourself — Teach-Yourself Tutorial

This tutorial teaches you how to build the Mediarr stack from scratch, even if you've **never used Docker, SSH, the command line, or any of the underlying tools**. By the end, you'll understand every layer — and you'll be able to extend, customise, or rebuild any of it from memory.

It's a teaching document. If you just want a working stack, download the installer from [Releases](https://github.com/defessler/Mediarr-Installer/releases/latest) — that's the eight-screen wizard described in [INSTALL.md](./INSTALL.md). The wizard does everything below for you in 20 minutes.

But if you want to **understand**, read on.

---

## What you'll learn

By the end of this tutorial you will:

1. Understand what Docker is, what containers are, and why they're useful here.
2. Write your first `docker-compose.yml` and start a one-container stack.
3. Understand how containers talk to each other (Docker networks).
4. Add a VPN sidecar and route a download client through it.
5. Understand hardlinks and why they save you a terabyte of disk.
6. Configure the *arr stack (Sonarr/Radarr/Prowlarr) via their HTTP APIs.
7. Replace your manual setup with a single `setup.sh` script.
8. Understand how the Mediarr Electron installer wraps all of this.

---

## Table of contents

- [Chapter 0 — Prerequisites](#chapter-0--prerequisites)
- [Chapter 1 — What is a container?](#chapter-1--what-is-a-container)
- [Chapter 2 — Your first container](#chapter-2--your-first-container)
- [Chapter 3 — Docker Compose: declaring a stack](#chapter-3--docker-compose-declaring-a-stack)
- [Chapter 4 — Networks: containers talking to each other](#chapter-4--networks-containers-talking-to-each-other)
- [Chapter 5 — Volumes and the hardlink trick](#chapter-5--volumes-and-the-hardlink-trick)
- [Chapter 6 — Routing through a VPN](#chapter-6--routing-through-a-vpn)
- [Chapter 7 — The arr stack](#chapter-7--the-arr-stack)
- [Chapter 8 — Automating it: a setup.sh](#chapter-8--automating-it-a-setupsh)
- [Chapter 9 — Talking to running services via their HTTP APIs](#chapter-9--talking-to-running-services-via-their-http-apis)
- [Chapter 10 — Wrapping it all in a GUI installer](#chapter-10--wrapping-it-all-in-a-gui-installer)
- [Where to go next](#where-to-go-next)

---

## Chapter 0 — Prerequisites

You need:

- A computer (Windows, Mac, or Linux). For Chapters 1–7, your own laptop works; later chapters assume access to a Linux box, ideally a Synology NAS, but any Linux machine with Docker installed works.
- A web browser.
- Comfort with installing software via your OS's package manager (Homebrew on macOS, Chocolatey/winget on Windows, apt/dnf on Linux).
- About four hours total. Each chapter is ~20–30 minutes.

You **don't** need to know:

- Linux command line — we'll introduce commands as they come up.
- Docker — that's Chapter 1.
- Networking, TCP/IP, ports — we'll explain the bits that matter.
- TypeScript, React, Electron — only Chapter 10 touches those.

---

## Chapter 1 — What is a container?

**A container is a packaged, isolated chunk of software.** Think of it like a zip file containing everything an app needs to run: the app itself, its libraries, its config, and a stripped-down operating system.

When you "run" a container, your computer (specifically a thing called the **Docker daemon**) unpacks that zip into a virtual sandbox, gives it its own filesystem and its own network interface, and starts the app inside. The sandbox is isolated: the app inside can't see your real files, your real network, or anything else on your machine — only what you explicitly let in.

Why is this useful?

- **No "works on my machine"** — the container has the same files, same libraries, same OS bits everywhere it runs. If it worked when the developer built it, it works on your NAS.
- **Easy cleanup** — uninstall = delete the container. No leftover system files, no registry entries, no half-removed services.
- **Isolation** — Plex can't accidentally read Sonarr's database. They live in separate sandboxes.
- **Versioned** — every container image has a tag (`linuxserver/sonarr:latest`, `linuxserver/sonarr:4.0.1`). You can pin a version, upgrade later, or roll back.

### Install Docker

- **Windows**: Download Docker Desktop from https://docker.com/products/docker-desktop and run the installer. Reboot when prompted.
- **macOS**: Same — Docker Desktop, dmg installer.
- **Linux**: Your distro's package manager. On Ubuntu: `sudo apt install docker.io docker-compose-plugin`.

When it's installed, open a terminal (PowerShell on Windows, Terminal on macOS, your shell on Linux) and run:

```bash
docker --version
```

You should see something like `Docker version 25.0.3, build 4debf41`. If you do, Docker is installed.

---

## Chapter 2 — Your first container

Let's run a container. We'll start with the simplest possible thing: a tiny web server that says "Hello, World!".

```bash
docker run -d -p 8080:80 --name hello-world nginx
```

What this means, piece by piece:

| Piece | Meaning |
|---|---|
| `docker run` | Run a container. |
| `-d` | "Detached" — run in the background, don't tie up the terminal. |
| `-p 8080:80` | Publish a port. The container's port 80 (where nginx listens) becomes accessible at your computer's port 8080. |
| `--name hello-world` | Give the running container a friendly name (otherwise Docker generates a random one). |
| `nginx` | The image to run. Docker downloads it from the public registry if you don't have it yet. |

Wait a few seconds for Docker to download the nginx image, then open your browser to **http://localhost:8080**. You should see "Welcome to nginx!". That's a real web server, running in an isolated container, on your machine.

### Inspect what's happening

```bash
docker ps                  # list running containers
docker logs hello-world    # see nginx's logs
docker exec -it hello-world sh   # open a shell INSIDE the container
```

That last command is powerful: you're now inside the container's filesystem. Try `ls`, `whoami`, `cat /etc/os-release`. You'll see this is a tiny Debian-based system that has nothing on it except nginx. Type `exit` to leave.

### Clean up

```bash
docker stop hello-world      # stop the container
docker rm hello-world        # delete it
docker rmi nginx             # delete the downloaded image
```

You now know what a container is and how to run one. **This is the entire foundation of the rest of this tutorial.** Every service in the Mediarr stack — Plex, Sonarr, qBittorrent, all of them — is just one of these.

---

## Chapter 3 — Docker Compose: declaring a stack

Running 14 `docker run` commands by hand would be miserable. Docker Compose lets you describe an entire stack of containers in a single text file, then start or stop the whole thing with one command.

Create a folder called `mediarr-tutorial/` somewhere on your machine. Inside it, create a file called `docker-compose.yml` with this content:

```yaml
services:
  hello:
    image: nginx
    container_name: hello
    ports:
      - "8080:80"
```

That's a compose file describing one service. From inside `mediarr-tutorial/` run:

```bash
docker compose up -d
```

Same nginx, same port 8080, but now declared in a file. Visit http://localhost:8080 — still works. `docker compose down` to stop everything.

### Why YAML?

YAML is the "indentation matters" config format compose uses. Two key rules:
- **Use spaces, never tabs.** Two spaces per indent level is the convention here.
- **Keys end with `:`; lists start with `- `.** That's why `ports:` is followed by `- "8080:80"`.

### Two services, with different roles

Now make it interesting. Replace your `docker-compose.yml` with this:

```yaml
services:
  web:
    image: nginx
    container_name: web
    ports:
      - "8080:80"

  database:
    image: postgres:16
    container_name: database
    environment:
      - POSTGRES_PASSWORD=demo
```

Run `docker compose up -d`. You now have nginx AND a Postgres database both running. `docker ps` will show both.

Notice **`database` has no `ports:`**. By default, Docker Compose creates an internal network shared by all the services in your file. `web` can talk to `database` over that network on the database's default port (5432), but nothing outside Docker can. That's already a sensible security boundary: your database isn't exposed to your LAN at all.

---

## Chapter 4 — Networks: containers talking to each other

When you put multiple services in a compose file, they share a Docker network. Each container is reachable from the others **by its service name**.

Demo this. With your two-service compose still running:

```bash
docker exec web sh -c "apk add curl && curl -sS http://database:5432 -m 2; echo ''"
# (Will fail in a non-HTTP way because Postgres isn't HTTP, but proves "database" resolves.)
```

The interesting bit isn't the output, it's that the DNS name `database` resolved inside the `web` container. Docker's built-in DNS lets every service reach every other service by name.

This is how the Mediarr stack avoids hardcoded IPs everywhere. Sonarr connects to qBittorrent at `http://gluetun:49156`. Bazarr connects to Sonarr at `http://sonarr:8989`. None of those would survive a NAS-IP change if they were IPs — but service names are stable.

### Service-name reachability table (Mediarr stack)

| From | To | URL |
|---|---|---|
| Sonarr | qBittorrent | `http://gluetun:49156` (qBit shares gluetun's net namespace) |
| Sonarr | Prowlarr | `http://prowlarr:9696` |
| Bazarr | Sonarr | `http://sonarr:8989` |
| Recyclarr | Sonarr | `http://sonarr:8989` |
| Tautulli | Plex | `http://plex:32400` |

You'll see these exact URLs in the wizard's "internal hostnames" table and in `setup-arr-config.py`.

---

## Chapter 5 — Volumes and the hardlink trick

Containers have ephemeral filesystems by default — destroy the container, lose its data. **Volumes** are the way to persist data: mount a host directory into the container, and writes to that directory survive container destruction.

### Bind mounts

The simplest volume is a bind mount: "this directory on my host is `/foo` inside the container."

```yaml
services:
  sonarr:
    image: lscr.io/linuxserver/sonarr:latest
    container_name: sonarr
    volumes:
      - ./sonarr/config:/config              # Sonarr's settings live here
      - ./data:/data                         # Where the media + downloads live
    ports:
      - "8989:8989"
```

`./sonarr/config:/config` means "the `sonarr/config` folder under my compose file's directory shows up as `/config` inside Sonarr."

### The single-/data trick

Here's the thing that makes hardlinks work: **every downloader and every arr mounts the same `/data` tree.**

```yaml
services:
  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent
    volumes:
      - ./data:/data         # /data/Downloads/Torrents/...
  sonarr:
    image: lscr.io/linuxserver/sonarr
    volumes:
      - ./data:/data         # /data/Downloads/Torrents/...  +  /data/Media/TV Shows/...
```

Inside qBittorrent, a downloaded TV episode lives at `/data/Downloads/Torrents/Completed/tv-sonarr/MyShow.S01E01.mkv`.

Inside Sonarr (which sees the **same `/data`**), that file is at the same path. So when Sonarr imports it to `/data/Media/TV Shows/MyShow/MyShow.S01E01.mkv`, it can create a **hardlink** instead of copying.

### What's a hardlink?

On Linux/Mac filesystems, a file is two things: an **inode** (the actual data on disk) and a **name** (a label pointing at the inode). A hardlink is just a second name pointing at the same inode.

```
/data/Downloads/Torrents/Completed/tv-sonarr/MyShow.S01E01.mkv ──┐
                                                                  ├─→ inode #123456 (the actual file bytes)
/data/Media/TV Shows/MyShow/MyShow.S01E01.mkv ────────────────────┘
```

Two paths. One file. No copy. Delete one path and the other still works. qBittorrent keeps seeding from its path; Plex reads from the tidier path. **You save the size of every media file you have.**

### The catch

Hardlinks require **both paths to be on the same filesystem**. If `/data/Downloads/` lives on one drive/partition/subvolume and `/data/Media/` on another, the hardlink syscall fails (`EXDEV`) and Sonarr falls back to copying. You doubled your disk use for no reason.

On a Synology NAS, every "shared folder" you create is its own BTRFS subvolume — which Linux treats as a separate filesystem for hardlink purposes. So putting `Downloads/` and `Media/` in separate shared folders silently breaks hardlinks. The Mediarr installer's env-detect step probes this and warns you if it's wrong.

**Lesson:** put your Downloads + Media trees under one shared folder. (`/volume1/Data/Downloads` and `/volume1/Data/Media` both inside the single `Data` shared folder.)

---

## Chapter 6 — Routing through a VPN

For torrent users, hiding your IP from peers is non-optional. The cleanest way: route qBittorrent's network through a VPN container, with **no other network path available** so a VPN failure means no leak.

Add this to your compose file:

```yaml
services:
  gluetun:
    image: qmcgaw/gluetun:latest
    container_name: gluetun
    cap_add: [NET_ADMIN]                # gluetun needs this to manage tunnels
    devices: ['/dev/net/tun']           # ditto
    environment:
      - VPN_SERVICE_PROVIDER=nordvpn
      - VPN_TYPE=wireguard
      - WIREGUARD_PRIVATE_KEY=...your key here...
      - SERVER_COUNTRIES=United States
    ports:
      - "49156:49156"                   # qBit's WebUI, surfaced via gluetun

  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent
    container_name: qbittorrent
    network_mode: "container:gluetun"   # ← the magic line
    depends_on: { gluetun: { condition: service_healthy } }
    volumes:
      - ./qbittorrent/config:/config
      - ./data:/data
    # NO ports: of its own — they're published via gluetun
```

`network_mode: "container:gluetun"` means qBittorrent **has no network of its own**. It uses gluetun's network namespace. Effects:

- qBittorrent has no IP, no DNS, no routing — only what gluetun provides.
- All qBittorrent traffic exits through gluetun's WireGuard tunnel.
- If gluetun's tunnel drops, qBittorrent can't reach anything. **No fallback. No leak.**
- The arrs reach qBittorrent at `http://gluetun:49156` (since qBit binds inside gluetun's namespace).

This is the "VPN kill switch" you want: not a configuration switch, but a structural property of the container layout.

### Getting a WireGuard key

For NordVPN: log in at https://my.nordaccount.com, go to NordVPN → Manual configuration → Generate Key, paste the result. The Mediarr installer (and `setup-nordvpn.sh`) automates this via NordVPN's API — but you can also do it by hand the first time to see what's going on.

---

## Chapter 7 — The arr stack

Now we're ready for the actual media stack. Here's a minimal compose with Plex + Sonarr + Radarr + Prowlarr + qBittorrent (via VPN):

```yaml
services:
  plex:
    image: lscr.io/linuxserver/plex:latest
    container_name: plex
    network_mode: host                  # Plex really wants host networking for discovery
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
      - PLEX_CLAIM=claim-XXXX           # from plex.tv/claim — expires in 4 minutes!
    volumes:
      - ./plex/config:/config
      - ./data:/data

  sonarr:
    image: lscr.io/linuxserver/sonarr:latest
    container_name: sonarr
    environment: { PUID: 1000, PGID: 1000, TZ: America/New_York }
    volumes:
      - ./sonarr/config:/config
      - ./data:/data
    ports: ["8989:8989"]

  radarr:
    image: lscr.io/linuxserver/radarr:latest
    container_name: radarr
    environment: { PUID: 1000, PGID: 1000, TZ: America/New_York }
    volumes:
      - ./radarr/config:/config
      - ./data:/data
    ports: ["7878:7878"]

  prowlarr:
    image: lscr.io/linuxserver/prowlarr:latest
    container_name: prowlarr
    environment: { PUID: 1000, PGID: 1000, TZ: America/New_York }
    volumes:
      - ./prowlarr/config:/config
    ports: ["9696:9696"]

  gluetun:
    image: qmcgaw/gluetun:latest
    container_name: gluetun
    cap_add: [NET_ADMIN]
    devices: ['/dev/net/tun']
    environment:
      - VPN_SERVICE_PROVIDER=nordvpn
      - VPN_TYPE=wireguard
      - WIREGUARD_PRIVATE_KEY=YOUR_KEY_HERE
      - SERVER_COUNTRIES=United States
    ports: ["49156:49156"]

  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    container_name: qbittorrent
    network_mode: "container:gluetun"
    depends_on: { gluetun: { condition: service_healthy } }
    environment: { PUID: 1000, PGID: 1000, TZ: America/New_York, WEBUI_PORT: 49156 }
    volumes:
      - ./qbittorrent/config:/config
      - ./data:/data
```

Save this in your `mediarr-tutorial/` folder. Make the data directory structure:

```bash
mkdir -p data/Downloads/Torrents/{Incomplete,Completed}
mkdir -p data/Media/{Movies,TV\ Shows,Music}
```

Then start the stack:

```bash
docker compose up -d
docker compose logs -f       # watch the logs; Ctrl-C when boot looks calm
```

Visit:

- http://localhost:32400/web — Plex
- http://localhost:8989 — Sonarr
- http://localhost:7878 — Radarr
- http://localhost:9696 — Prowlarr
- http://localhost:49156 — qBittorrent (default login `admin` / `adminadmin` — change in Settings)

At this point everything is running but **nothing is configured yet**. Each service has its own first-run wizard or you need to point them at each other manually.

That's what Chapter 9 will fix. First, let's automate the bring-up itself.

---

## Chapter 8 — Automating it: a setup.sh

Right now your install is "type stuff, click stuff, hope you remember it next time." Let's wrap it in a script.

Create `setup.sh` next to your `docker-compose.yml`:

```bash
#!/usr/bin/env bash
set -euo pipefail   # exit on any error, treat unset vars as errors, fail fast on pipes

echo "── Step 1: Create folders ──"
mkdir -p data/Downloads/Torrents/{Incomplete,Completed}
mkdir -p data/Media/{Movies,TV\ Shows,Music}

echo "── Step 2: Start the stack ──"
docker compose up -d

echo "── Step 3: Wait for services to come up ──"
for url in http://localhost:8989 http://localhost:7878 http://localhost:9696; do
  echo -n "Waiting for $url..."
  until curl -sf -o /dev/null "$url"; do sleep 2; echo -n "."; done
  echo " ready"
done

echo "✔ Stack is up. Open Plex at http://localhost:32400/web"
```

Make it executable and run:

```bash
chmod +x setup.sh
./setup.sh
```

This is the entire premise of `nas/setup.sh` in the real Mediarr stack — just bigger (10 steps instead of 3) and with more careful error handling. Look at `nas/setup.sh` in the repo to see how the real one is structured; it follows this exact pattern.

### Why bash for this?

Bash is right for steps that just run system commands in sequence (`mkdir`, `docker compose`, `curl`, etc.). Each command's exit code becomes the next conditional. `set -euo pipefail` makes the whole script abort on the first failure.

When we need to do real logic (parse JSON, talk to an HTTP API, handle complex state), we move to Python. That's Chapter 9.

---

## Chapter 9 — Talking to running services via their HTTP APIs

Every arr exposes a REST API. The patterns are similar across Sonarr / Radarr / Lidarr / Prowlarr:

- `GET /api/v3/system/status` — health check + version info
- `GET /api/v3/rootfolder` — list configured media root folders
- `POST /api/v3/rootfolder` — add one
- `GET /api/v3/downloadclient` — list download clients (qBit etc.)
- `POST /api/v3/downloadclient` — add one

All requests need an `X-Api-Key` header. The arrs auto-generate that key on first boot — you can find it in each container's `config/config.xml` file:

```bash
grep -oP '<ApiKey>\K[^<]+' sonarr/config/config.xml
```

### A minimal Python configurator

Save this as `configure.py`:

```python
#!/usr/bin/env python3
import json
import sys
import xml.etree.ElementTree as ET
from urllib.request import Request, urlopen


def read_api_key(config_xml):
    """Pull <ApiKey> from a *arr config.xml."""
    return ET.parse(config_xml).find('ApiKey').text


def api(method, url, key, body=None):
    """Tiny REST client: sends JSON, returns JSON (or raises)."""
    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, method=method, headers={
        'X-Api-Key': key,
        'Content-Type': 'application/json',
    })
    return json.loads(urlopen(req).read())


def ensure_root_folder(base, key, path):
    """Idempotent: add a root folder only if it isn't already there."""
    existing = api('GET', f'{base}/api/v3/rootfolder', key)
    if any(r['path'] == path for r in existing):
        print(f'  ✔ root folder already configured: {path}')
        return
    api('POST', f'{base}/api/v3/rootfolder', key, body={'path': path})
    print(f'  ✔ added root folder: {path}')


if __name__ == '__main__':
    sonarr_key = read_api_key('sonarr/config/config.xml')
    radarr_key = read_api_key('radarr/config/config.xml')

    print('Sonarr...')
    ensure_root_folder('http://localhost:8989', sonarr_key, '/data/Media/TV Shows')

    print('Radarr...')
    ensure_root_folder('http://localhost:7878', radarr_key, '/data/Media/Movies')

    print('✔ Done.')
```

Run it after your stack is up:

```bash
python3 configure.py
```

Re-run it. It'll print "already configured" — that's the **idempotent** property. The real `setup-arr-config.py` in the Mediarr repo is 3500 lines because it covers every service + every config knob, but every section follows this same `GET → compare → POST if needed` pattern.

### Why Python and not bash for this?

You could write this in bash + curl + jq. It would be 4x the code and 10x the fragility. JSON is awkward in bash, and any change requires multi-step state (read current config, diff against desired, write back). Python's stdlib `urllib.request` + `json` handles all of this in 20 lines.

---

## Chapter 10 — Wrapping it all in a GUI installer

You now have:
- A `docker-compose.yml` declaring the stack.
- A `setup.sh` bringing it up.
- A `configure.py` configuring each service via API.

To get from there to the Mediarr installer, you add:

1. **A way to upload all of the above to a remote NAS over SSH.**
   The installer uses `ssh2` (a Node library) to open an SSH session + `sftp` (a subsystem of SSH) to bulk-upload files. The renderer kicks off uploads; the main process streams progress back via IPC.

2. **A GUI that walks the user through the inputs.**
   Welcome → Connect (host, user, password) → Env Detect (probes the NAS over SSH) → Configure (a form that fills in `.env`) → Run (streaming `setup.sh` output line by line) → Done (per-service health grid).

3. **State management.**
   Each user has one or more "profiles" — encrypted JSON files on their PC that store their NAS connection + their last-used config values. The wizard's Zustand store keeps the current screen + form state; the auto-save hook debounces every change and writes it back to the profile.

4. **Packaging.**
   Electron + electron-builder turn the renderer (React + Tailwind + Motion) + the main process (TypeScript that imports `ssh2`) into one .exe / .dmg / .AppImage per platform.

You don't need to build the installer to use the stack — `setup.sh` and `configure.py` from the previous chapters are the whole runtime. The installer is just a friendlier wrapper.

### If you want to study the installer code

Start in this order:

1. **`installer/src/shared/ipc.ts`** — defines every IPC channel between renderer and main. Read this first; it's the contract.
2. **`installer/src/main/ssh-service.ts`** — the streaming SSH client. Shows how `exec()` + `data` events drive the wizard's live log.
3. **`installer/src/renderer/screens/RunScreen.tsx`** — the Run screen. See how it parses setup.sh's marker lines into per-step status.
4. **`installer/src/main/env-detector.ts`** — the env-detect probes. Each probe runs over SSH and returns a typed result.
5. **`installer/src/renderer/screens/ConfigureScreen.tsx`** — the form that drives `.env`. Note how it uses a shared `env-schema.ts` for validation on both sides.

The companion [TDD.md](./TDD.md) explains *why* each of those pieces is the shape it is.

---

## Where to go next

You now know enough to:

- **Run the Mediarr stack manually** with your hand-written compose file + setup.sh + configure.py.
- **Modify the real Mediarr stack** — pick the service you want to add or change, find its compose entry + setup-arr-config.py section, edit, re-run.
- **Build a similar stack for a different purpose** — the patterns (compose + bash orchestrator + Python API configurator + optional Electron GUI) work for any "configure-once-then-run" appliance stack: home automation, monitoring, dev environments, etc.

### Suggested next experiments

- **Add Bazarr to the stack you built in Chapter 7.** Wire it to your Sonarr/Radarr in Bazarr's settings, watch it auto-fetch subtitles for an existing episode.
- **Add Tautulli.** Point it at your Plex install, watch a video, see the play event show up in Tautulli's history.
- **Add Recyclarr.** Run `docker exec recyclarr recyclarr sync`. Watch your Sonarr Custom Formats populate.
- **Read the real `setup-arr-config.py`.** It's 3500 lines but every section is self-contained. Pick one (e.g., the SABnzbd block) and follow the GET-compare-POST pattern.
- **Read the real `nas/setup.sh`.** Note how each step is a separate `setup-*.sh` script, and how the orchestrator prints the marker lines the installer's UI parses.

### Reference docs

- [Docker docs](https://docs.docker.com) — `docker run`, `docker compose`, `volumes`, `networks`.
- [TRaSH Guides](https://trash-guides.info) — quality profile + custom format recipes for the arrs.
- [Recyclarr docs](https://recyclarr.dev) — what `recyclarr.yml` can do.
- [Servarr wiki](https://wiki.servarr.com) — official docs for every arr.
- [linuxserver.io docs](https://docs.linuxserver.io) — the docker images we use; their PUID/PGID conventions matter.

### Mediarr-specific deep dives

- **[README.md](./README.md)** — architecture overview + manual install path.
- **[INSTALL.md](./INSTALL.md)** — installer wizard walkthrough.
- **[TDD.md](./TDD.md)** — every design decision explained.

Welcome to running your own stack. The terrifying part — "I don't know what any of this is" — is now behind you.
