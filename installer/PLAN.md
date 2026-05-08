# installer/PLAN.md — Electron NAS Installer

Architecture & implementation plan for a desktop wizard that walks a user through
installing the Arr stack onto a Synology NAS over SSH.

## Status & resolved decisions (2026-05)

- Branch `electron-installer` is created.
- `nas/docker-compose.yml` already includes **Homepage** and **Flaresolverr** —
  no service-set work needed before the installer.
- Sudo strategy: **root SSH login is the v1 default** (Synology supports it; we
  document how to enable it on the prerequisites screen). Phase 2 will add a
  password-prompt-and-pipe fallback for non-root accounts.
- NordVPN key fetch: **the host machine calls `api.nordvpn.com` directly** in
  Phase 2. Phase 1 keeps the existing `setup-nordvpn.sh` flow on the NAS.
- `.env` is git-ignored and excluded from packaged resources.

---

## 1. Connection layer — Decision: SSH + SFTP via `ssh2`

**Options weighed**

- **SSH + SFTP (`ssh2` / `node-ssh`)** — Synology has SSH built in. Zero agent
  install. Same channel handles upload (SFTP subsystem) and arbitrary command
  exec. The `ssh2` library exposes a `ClientChannel` stream for `exec()`;
  stdout/stderr are Node `Readable` streams, perfect for live UI piping.
- **Synology DSM API** — *Refuted.* No general-purpose `exec` endpoint;
  TaskScheduler scripts can run as root but persist as scheduled tasks with no
  live stdout. Doesn't run `docker compose`.
- **Local agent on NAS** — Highest capability ceiling, lowest practical value.
  Bootstrapping needs SSH anyway; if SSH is already there, we may as well stay
  on it. Re-evaluate if the wizard ever becomes a continuous management tool.
- **Docker context over SSH** — Elegant for `docker compose up -d` but only
  covers step 6 of 10. Steps 1–5 (chmod, mkdir, iptables, NordVPN curl, .env
  writes) and 7–10 (Python configurators that read container `config.xml`)
  need shell access. Carrying both clients isn't worth the marginal benefit.

**Decision: `ssh2` (low-level), one shared `Client` per session handling both
`exec` and `sftp`.** `node-ssh`'s exec wrapper buffers stdout and throws away
the streaming model — we need streaming.

### Sudo strategy

Three viable approaches, ranked:

1. **v1 default — log in as `root` directly.** Synology root SSH is off by
   default but trivial to enable: System → Terminal → Enable SSH; Control
   Panel → User → admin/root password. Then SSH `root@nas`. The wizard tells
   the user how on the prerequisites screen. No sudo prompts, no sudoers
   edits, no password piping.
2. **Phase 2 fallback — admin user + sudo with a prompted password piped to
   stdin.** Wizard collects the sudo password once, runs each command as
   `sudo -S -p '' bash -c '<cmd>'` and writes `password\n` on each new exec
   channel. In-memory only; never written to disk or keychain.
3. **Reject — NOPASSWD sudoers entry.** Editing `/etc/sudoers.d/` from a
   wizard is a bad install footprint. The whole point of the app is a one-shot
   install, not a permanent system change.

---

## 2. Tech stack

| Area | Choice | Justification |
|---|---|---|
| Renderer framework | **React 19** | Solo-dev velocity, every UI lib targets it first. |
| Build/dev tool | **electron-vite** | Single config, fast HMR for both main and renderer, ESM-native. |
| Packaging | **electron-builder** (via electron-vite) | Best Windows NSIS installer + macOS dmg output. |
| Language | **TypeScript** | IPC channel typing alone earns it back. |
| UI library | **shadcn/ui + Tailwind v4** | Copy-paste components you own outright; no runtime UI vendor dep. |
| Forms | **react-hook-form + zod** | Schema-driven validation; same zod schemas validate the persisted `.env` payload. |
| State | **Zustand** | Sufficient. One store for wizard step + form values, another for the live SSH log. Persist via `persist` middleware so closing mid-run resumes. |
| SSH lib | **`ssh2`** | `node-ssh` buffers and kills streaming. |
| Secret storage | **Electron `safeStorage`** | DPAPI on Windows, Keychain on macOS, libsecret on Linux. No native compile, no electron-rebuild. (Modern replacement for `keytar`.) |
| Logging | **electron-log** | Rotation, separate main/renderer channels. |
| Testing | **vitest** + **Playwright** | Phase 3. |

---

## 3. Wizard flow — concrete screens

Each screen: **inputs · client validation · IPC calls · success/failure UX**.

1. **Welcome / Prerequisites** — info checklist (SSH enabled, Docker installed,
   NordVPN account, Plex account). Each links out via `shell.openExternal`.
2. **SSH Connection Setup** — host, port, user (default `root` with banner),
   authMethod (password | private key), credential. zod validates host/port.
   IPC: `ssh:test-connect`. Failure → structured error
   (auth-failed | host-unreachable | timeout | unknown) with remediation tip.
3. **Environment Detection** — auto-runs on entry. Server-side over SSH:
   `command -v docker`, `docker compose version`, `[ -d /volume1 ]`,
   `id -u`/`id -g`/`id -un`/`id -gn`, `cat /etc/timezone`,
   `ip -4 addr show`, `python3 --version`, `iptables --version`. Result
   dashboard with green/red checks; "Next" only if Docker + /volume1 +
   python3 + iptables all present.
4. **Target Directory** — default `/volume1/docker/media`. Server-checks
   `[ ! -e $TARGET ] || [ -d $TARGET ]` (refuse to clobber a file).
   Surfaces "directory not empty — overwrite?" if non-empty.
5. **Base Config** — PUID, PGID, TZ, LAN_IP, PLEX_CLAIM, ARR_USERNAME,
   ARR_PASSWORD. Pre-filled from screen 3. LAN_IP is a `<select>` of
   detected interfaces with manual override. Plex claim has a "Get token"
   button that opens plex.tv/claim with a 4-min countdown.
6. **VPN** — VPN_PROVIDER, NORDVPN_ACCESS_TOKEN, VPN_COUNTRIES (multi-select
   chips). IPC: `vpn:fetch-key {token}` runs from the **host machine**, not
   over SSH. Validates 43/44-char base64 (pads if 43, like
   `setup-nordvpn.sh`). Country list endpoint populates the chip selector.
7. **qBittorrent** — QBITTORRENT_USER (default `admin`), QBITTORRENT_PASS
   with show/hide eye, copy-to-clipboard, "generate strong password" button.
8. **Optional Indexers** (skippable) — toggle-card per indexer
   (NZBGEEK, NZBFINDER, NZBPLANET, AVISTAZ, ANIMEBYTES, ANIMETORRENTS, …).
9. **Optional Bazarr Providers** (skippable) — cards for OPENSUBTITLES,
   OPENSUBTITLESCOM, ADDIC7ED.
10. **Review** — read-only `.env` preview with secrets masked behind eye
    toggles. "Edit" buttons jump to the relevant screen.
11. **Upload** — IPC: `sftp:upload-dir`. Streams `nas-payload/` to NAS;
    progress events `sftp:progress` push per-file bars. Then
    `sftp:write-file` for the final `.env`.
12. **Run setup.sh** — split pane. Left = the numbered steps from setup.sh as
    a vertical stepper. Right = live ANSI-aware terminal log. IPC:
    `ssh:exec-stream`. Log is parsed for `┌── Step N` and `✔ Step N complete`
    markers to advance the stepper UI in real time.
13. **Configure Services** — same UI, runs `setup-arr-config.py`,
    `indexers/setup-indexers.py`, `indexers/setup-bazarr-providers.py` in
    sequence. ANSI rendering for the colored output.
14. **Final Dashboard** — runs `post-deploy-validate.sh` once at entry.
    Each service as a card with name, clickable URL, copy-link button, and
    a status dot. Plex/Tautulli/Seerr cards show their inline manual-setup
    reminders.

---

## 4. IPC architecture

Strict 3-layer model: **renderer → preload (contextBridge) → main**. Renderer
never imports `ssh2`, `fs`, `child_process`, or `crypto`.

### Channels (`installer/src/shared/ipc.ts`)

```ts
export type IpcInvoke = {
  // SSH
  'ssh:test-connect':  [ConnectionConfig, ConnectResult]
  'ssh:connect':       [ConnectionConfig, { sessionId: string }]
  'ssh:disconnect':    [{ sessionId: string }, void]
  'ssh:exec':          [{ sessionId: string; cmd: string; sudo?: boolean }, ExecResult]
  'ssh:exec-stream':   [{ sessionId: string; cmd: string; sudo?: boolean; channelId: string }, void]
  'ssh:stream-cancel': [{ channelId: string }, void]
  // SFTP
  'sftp:upload-dir':   [{ sessionId: string; localDir: string; remoteDir: string }, { uploaded: number }]
  'sftp:write-file':   [{ sessionId: string; remotePath: string; content: string; mode?: number }, void]
  // Helpers
  'env:detect':        [{ sessionId: string }, EnvDetectResult]
  'vpn:fetch-key':     [{ token: string }, { privateKey: string; countries: Country[] }]
  'fs:check-target':   [{ sessionId: string; path: string }, { exists: boolean; isDir: boolean; hasContent: boolean }]
}

// One-way main → renderer events
export type IpcEvent = {
  'ssh:stream:data':   { channelId: string; type: 'stdout'|'stderr'; chunk: string }
  'ssh:stream:close':  { channelId: string; exitCode: number | null; signal: string | null }
  'sftp:progress':     { file: string; bytesDone: number; bytesTotal: number; pctOverall: number }
}
```

### Streaming exec — main side sketch

```ts
ipcMain.handle('ssh:exec-stream', async (_e, { sessionId, cmd, sudo, channelId }) => {
  const session = sessions.get(sessionId)!
  const fullCmd = sudo ? `sudo -S -p '' bash -c ${escape(cmd)}` : cmd

  session.client.exec(fullCmd, { pty: true }, (err, stream) => {
    if (err) {
      win.webContents.send('ssh:stream:close', { channelId, exitCode: -1, signal: null })
      return
    }
    if (sudo && session.sudoPassword) stream.write(session.sudoPassword + '\n')

    stream.on('data',  (d: Buffer) =>
      win.webContents.send('ssh:stream:data', { channelId, type: 'stdout', chunk: d.toString('utf8') }))
    stream.stderr.on('data', (d: Buffer) =>
      win.webContents.send('ssh:stream:data', { channelId, type: 'stderr', chunk: d.toString('utf8') }))
    stream.on('close', (code: number, signal: string) =>
      win.webContents.send('ssh:stream:close', { channelId, exitCode: code, signal: signal ?? null }))

    activeChannels.set(channelId, stream)
  })
})
```

`pty: true` is essential — without it the Python configurators detect non-tty
and buffer stdout, so the UI gets nothing until the script ends.

`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` for the
renderer.

---

## 5. Project layout

```
NAS/                                  (repo root)
├── nas/                              (existing — shipped to NAS, untouched)
│   ├── docker-compose.yml
│   ├── .env.example
│   ├── setup.sh
│   ├── setup-*.sh
│   ├── setup-arr-config.py
│   ├── post-deploy-validate.sh
│   ├── indexers/
│   └── migration/
├── installer/                        (NEW — Electron app)
│   ├── PLAN.md                       (this document)
│   ├── package.json
│   ├── electron.vite.config.ts
│   ├── electron-builder.yml
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── index.html
│   ├── tailwind.config.ts
│   ├── postcss.config.js
│   ├── components.json               (shadcn)
│   ├── resources/
│   │   ├── icon.{ico,icns,png}
│   │   └── nas-payload/              (BUILT — copy of ../nas/, .env-excluded)
│   ├── src/
│   │   ├── shared/
│   │   │   ├── ipc.ts                (channel typings)
│   │   │   ├── env-schema.ts         (zod schema for the .env)
│   │   │   └── env-render.ts         (form values → .env text)
│   │   ├── main/
│   │   │   ├── index.ts              (BrowserWindow, app.whenReady)
│   │   │   ├── ssh-service.ts        (ssh2 client + per-session state)
│   │   │   ├── sftp-service.ts       (recursive upload with progress)
│   │   │   ├── env-detector.ts       (env:detect impl)
│   │   │   ├── vpn-service.ts        (NordVPN API client)
│   │   │   ├── secret-store.ts       (safeStorage wrapper)
│   │   │   ├── payload-resolver.ts   (locates nas-payload/ at runtime)
│   │   │   └── ipc-handlers.ts       (registers ipcMain handlers)
│   │   ├── preload/
│   │   │   └── index.ts              (contextBridge)
│   │   └── renderer/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── router.tsx
│   │       ├── store/{wizard,log}.ts
│   │       ├── components/{ui,LogPanel,StepperRail,ServiceCard}
│   │       ├── screens/01-Welcome.tsx … 14-Dashboard.tsx
│   │       ├── hooks/{useSshStream,useEnvDetect}.ts
│   │       └── styles/globals.css
│   └── scripts/
│       └── copy-nas-payload.mjs      (pre-build hook)
└── README.md
```

`installer/` is its own npm workspace. Does not affect existing `nas/`
scripts.

`.gitignore` additions:

```
installer/node_modules/
installer/out/
installer/dist/
installer/resources/nas-payload/      # generated
```

---

## 6. Build & distribution

**Target platforms (priority):**
1. **Windows x64** — primary. NSIS installer via electron-builder.
2. **macOS arm64 + x64** — phase 3.
3. **Linux x64 AppImage** — phase 3.

**Code signing & auto-update:** skipped for v1. Document SmartScreen warning.
Phase 3.

**Bundling `nas/`:**
`installer/scripts/copy-nas-payload.mjs` runs as a `prebuild` hook —
recursively copies `../nas/**` → `installer/resources/nas-payload/`,
**excluding** `.env` and `migration/`.

`electron-builder.yml`:

```yaml
files:
  - "out/**/*"
  - "package.json"
extraResources:
  - from: "resources/nas-payload"
    to:   "nas-payload"
    filter: ["**/*"]
```

Runtime resolution:

```ts
// installer/src/main/payload-resolver.ts
import { app } from 'electron'
import path from 'node:path'
export function payloadDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'nas-payload')
    : path.join(__dirname, '../../resources/nas-payload')
}
```

**Reproducibility:** the prebuild hook records `installer/resources/nas-payload/.payload-sha`
from `git rev-parse HEAD:nas`. The Dashboard screen displays it for support.

---

## 7. Phased delivery — 80/20

### Phase 1 — Walking skeleton (MVP) · 20–30h

Goal: from cold start, user clicks through and ends up with a running stack
on a real NAS.

- [ ] Scaffold with electron-vite + React + TS — 1h
- [ ] Tailwind v4 + shadcn (Button, Input, Label, Card, Form, Progress) — 2h
- [ ] IPC plumbing: ssh-service + sftp-service skeletons, preload bridge,
      type-safe `invoke` wrapper — 4h
- [ ] **One combined config screen** (everything from screens 5–9 on one
      tall scrollable form) — 4h
- [ ] **SSH connect** (password OR key path, no profile saving) +
      test-connect — 3h
- [ ] **SFTP upload** of `nas-payload/` recursively, progress events — 3h
- [ ] Generate `.env` from form values; SFTP-write it — 2h
- [ ] **Run setup.sh** with live streaming log panel (no stepper, just
      `<pre>` with auto-scroll) — 4h
- [ ] **Service URLs page** (static list, click to open) — 1h
- [ ] Windows NSIS package + smoke-test on real DS1522+ — 3h

**Phase-1 cuts:** no PUID/LAN_IP auto-detect, no NordVPN fetcher (user
pastes their own WireGuard key OR the bundled `setup-nordvpn.sh` runs as
part of `setup.sh` like today), no per-step retries, no profile saving,
no dark mode, no ANSI rendering (just strip control codes).

### Phase 2 — Full wizard · 25–35h

- [ ] Split combined form into screens 5–9 with zod + react-hook-form — 6h
- [ ] `env:detect` IPC + screen 3 with PUID/PGID/TZ/LAN_IP auto-detect — 4h
- [ ] **NordVPN key fetcher** (screen 6) — 3h
- [ ] **Indexers** (8) and **Bazarr** (9) screens with toggle cards — 4h
- [ ] **Stepper rail** in screens 12/13 driven by `setup.sh` step markers — 3h
- [ ] **Run configurators** screen 13 (3 Python scripts in sequence) — 2h
- [ ] **ANSI rendering** in log panel — 2h
- [ ] **Post-deploy dashboard** screen 14 — 4h
- [ ] **Resume mid-wizard** (Zustand persist) — 2h
- [ ] Polish, error remediation copy, retry buttons — 3h

### Phase 3 — Niceties · 20–40h, à la carte

- [ ] Connection profile saving, multi-NAS support — 4h
- [ ] Dark mode — 2h
- [ ] **macOS** + **Linux** builds + CI — 6h
- [ ] Code signing (Windows EV cert; macOS notarization) — 6h
- [ ] **Re-run a single step** UI — 3h
- [ ] **Log export** (.txt or .zip with timestamps) — 2h
- [ ] **Update Stack** mode (skip wizard, `docker-compose pull && up -d`) — 4h
- [ ] **Auto-update** via electron-updater + GitHub Releases — 4h
- [ ] **Migration assistant** wrapping `migration/fix-plex-paths.py` etc. — 4h
- [ ] Telemetry (opt-in, anonymous failure reports) — 3h
