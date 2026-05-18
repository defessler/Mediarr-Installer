# Mediarr Installer

Electron desktop wizard that installs the Arr media stack onto a Synology NAS
over SSH. Wraps the bash + Python automation in `../nas/`.

## Status

**Shipping** (current: `v0.2.0`). Multi-screen wizard with auto-detection,
profile save/restore, migration from existing arrs, full ANSI-colored live
log, and per-service health-dot output on Done. See [`PLAN.md`](./PLAN.md)
for architecture.

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

## Build a runnable folder

```bash
npm run build:win      # → installer/dist/win-unpacked/
npm run build:mac      # → installer/dist/mac-arm64/  (or mac/)
npm run build:linux    # → installer/dist/linux-unpacked/
```

The Windows build produces an unpacked folder with `Mediarr Installer.exe`
and all its support files. Double-click the .exe inside the folder to run.
Nothing gets installed to the system; per-user state (logs, saved SSH
profiles) lives at `%APPDATA%\Mediarr Installer\`. To uninstall, just
delete the folder.

Native deps (ssh2 → cpu-features) compile per host, so each platform must
be built on its own runner. Unsigned — Windows SmartScreen and macOS
Gatekeeper will warn until we add signing.

## CI / Releases

Two GitHub Actions workflows under `.github/workflows/`:

- **installer-ci.yml** — typecheck + electron-vite build on every PR and on
  pushes to `master` / `electron-installer`. Catches type regressions
  before they land.
- **installer-release.yml** — matrix-builds Windows / macOS / Linux artifacts
  on tag push (`installer-v*`) and attaches them to a draft GitHub Release.

Cutting a release:

```bash
# Bump version in installer/package.json and commit
git tag -a installer-v<X.Y.Z> -m "release notes here..."
git push origin master installer-v<X.Y.Z>
```

The workflow runs three platform jobs in parallel, then a final job
gathers their artifacts into a draft release for review.

A third workflow job — **lint-nas-scripts** — runs `shellcheck` on every
shell script in `../nas/` and `python -m py_compile` on every Python file.
Catches typos in nas-payload scripts before they ship.

> **GitHub gotcha**: `workflow_dispatch` (manual trigger) and the
> `gh workflow list` command both require the workflow file to be on
> the **default branch**. If the installer branch hasn't been merged to
> `master` yet, the release workflow only fires on tag push (which
> always works regardless of branch). Merge the branch to enable the
> manual trigger.

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

## Known limitations

- No code signing — Windows SmartScreen and macOS Gatekeeper will warn on
  first launch. Click "More info → Run anyway" on Windows; on macOS,
  open via right-click + Open the first time.
- macOS builds ship as separate arm64 and x64 dmgs (no universal binary).
- The hardlink probe in `setup-validate.sh` is the safety net for the
  Synology btrfs subvolume trap, but it can't auto-fix the underlying
  layout — see the in-app Help → Hardlinks section for the remediation.
