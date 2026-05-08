# NAS Arr Installer (Phase 1 — walking skeleton)

Electron desktop wizard that installs the Arr media stack onto a Synology NAS
over SSH. Wraps the bash + Python automation in `../nas/`.

## Status

**Phase 1 (MVP)** — connect, one combined config form, upload, run `setup.sh`
with live log, show service URLs. See [`PLAN.md`](./PLAN.md) for the
architecture and roadmap (Phase 2 = full wizard, Phase 3 = niceties).

## Develop

```bash
cd installer
npm install
npm run dev          # talks to a real NAS over SSH
npm run dev:mock     # stubs SSH/SFTP/env-detect/NordVPN — no NAS needed
```

`npm run dev` runs the `copy-nas-payload` script first, which mirrors `../nas/`
(minus `.env` and `migration/`) to `resources/nas-payload/`. Electron-vite then
boots the main process and a Vite renderer with HMR.

### Mock mode

Set `INSTALLER_MOCK=1` (or use the `dev:mock` script) and the IPC handlers in
`src/main/ipc-handlers.ts` swap the real ssh/sftp/env-detect/vpn services
for mocks in `src/main/mock-services.ts`. The wizard runs end-to-end with no
NAS contacted; the Run screen plays back a pre-recorded transcript that
exercises the StepperRail's marker parser, and the Done screen plays back
fake `post-deploy-validate` output that exercises the per-service health-dot
parser. A yellow `MOCK MODE` banner appears at the top of the window.

A few useful test flows:
- enter `fail.example.com` as the host to exercise the auth-failed error UI
- on the VPN screen, enter a token shorter than 16 chars to exercise the
  validation error path

## Build platform installers

```bash
npm run build:win      # NSIS installer  → installer/dist/*Setup*.exe
npm run build:mac      # arm64 + x64 dmg → installer/dist/*.dmg
npm run build:linux    # AppImage        → installer/dist/*.AppImage
```

Native deps (ssh2 → cpu-features) compile per host, so each platform must
be built on its own runner. The artifacts are unsigned; Windows SmartScreen
and macOS Gatekeeper will warn until we add signing.

## CI / Releases

Two GitHub Actions workflows under `.github/workflows/`:

- **installer-ci.yml** — typecheck + electron-vite build on every PR and on
  pushes to `master` / `electron-installer`. Catches type regressions
  before they land.
- **installer-release.yml** — matrix-builds Windows / macOS / Linux artifacts
  on tag push (`installer-v*`) and attaches them to a draft GitHub Release.

Cutting a release:

```bash
git tag installer-v0.1.0
git push origin installer-v0.1.0
```

The workflow runs three platform jobs in parallel, then a final job
gathers their artifacts into a draft release for review.

## Layout

```
installer/
├── PLAN.md                  architecture & phased roadmap
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig*.json
├── tailwind.config.ts
├── postcss.config.js
├── index.html               renderer entry
├── resources/
│   └── nas-payload/         GENERATED — mirror of ../nas/
├── scripts/
│   └── copy-nas-payload.mjs prebuild hook
└── src/
    ├── shared/              types + helpers usable by main & renderer
    │   ├── ipc.ts           IPC channel contract (single source of truth)
    │   ├── env-render.ts    form values → .env text
    │   └── env-schema.ts    zod validation
    ├── main/                Node-side: ssh2 client, sftp upload, NordVPN API
    │   ├── index.ts
    │   ├── ssh-service.ts
    │   ├── sftp-service.ts
    │   ├── env-detector.ts
    │   ├── vpn-service.ts
    │   ├── payload-resolver.ts
    │   └── ipc-handlers.ts
    ├── preload/             contextBridge surface — only path renderer uses
    │   └── index.ts
    └── renderer/            React + Tailwind UI
        ├── main.tsx
        ├── App.tsx
        ├── store/wizard.ts  Zustand
        ├── components/LogPanel.tsx
        ├── screens/{Connect,Configure,Run,Done}Screen.tsx
        ├── styles/globals.css
        └── global.d.ts
```

## Security boundary

Renderer is `contextIsolation: true`, `nodeIntegration: false`. The only API
surface it sees is `window.installer.*`, defined in `src/preload/index.ts`.
Renderer never imports `ssh2`, `fs`, `child_process`, or any other Node API.

## Phase 1 limitations (deliberate)

- One combined config form rather than per-step wizard screens — Phase 2
  splits these out with auto-detection (PUID/LAN_IP) and a NordVPN key
  fetcher.
- ANSI colors are stripped from the live log (Phase 2 renders them).
- No connection profile saving (Phase 3).
- Windows-only installer build (macOS + Linux in Phase 3).
- No code signing — Windows SmartScreen will warn.
