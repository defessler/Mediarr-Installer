# Mediarr Installer

Electron desktop wizard that installs the Arr media stack onto a Synology NAS
over SSH. Wraps the bash + Python automation in `../nas/`.

## Status

**Shipping** (current: `v0.3.4`). Eight-screen wizard with profile management,
NAS-family auto-detection, install / update / migrate flows, an animated
visual layer (Motion + Lucide), encrypted profile export/import, and a
searchable in-app troubleshooting modal. See [`PLAN.md`](./PLAN.md) for
architecture.

### v0.3.x highlights

The 0.3 line is the **child-friendly UX** release — every surface is
hand-tuned so a first-time user (literally a kid, with a parent looking
over their shoulder) can complete an install end-to-end:

- **Hero icons + soft copy** on every screen — Server / Plug / Radar /
  Settings2 / Rocket / AnimatedCheck. Failure language softened across the
  board ("Install paused — tap Retry" vs "Install failed").
- **Visible autosave**: the active-profile pill shows a Saving → Saved
  chip so users can see their edits actually persisted.
- **PasswordInput** with show/hide eye toggle on every credential field
  (SSH password, sudo, key passphrase, arr/qbit/indexer passwords, profile
  export passphrase).
- **Segmented controls + BigButton everywhere**: auth-method picker,
  install-mode pills, primary CTAs. Every clickable surface has spring
  press feel + focus ring.
- **Lucide status icons** in place of raw `✓ / ✘ / ●` glyphs across
  EnvDetect (~25 checks), the run-screen stepper, results panels, and the
  Done-screen service grid.
- **Animated screen transitions** (220ms fade-up via `AnimatePresence
  mode="wait"`), staggered grid entrances on Welcome + Done, Motion
  layoutId-driven segmented highlights.
- **Confetti** on a successful Done screen (suppressed under
  `prefers-reduced-motion`).
- **Inline animated delete confirm** replaces the system
  `window.confirm()` for profile delete — no more focus-yank.
- **Atkinson Hyperlegible + Lexend Deca** body / display fonts —
  research-backed picks for low-vision readers and dyslexic users.

Underlying mechanics (SSH/SFTP, env-detect, NordVPN API, payload sync,
mocked Run/Done playback for dev) are unchanged from the 0.2 line.

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
        ├── main.tsx           LazyMotion(domAnimation) wrap
        ├── App.tsx            stepper rail + AnimatePresence screen switcher
        ├── store/
        │   ├── wizard.ts      Zustand — wizard step + form values
        │   └── errors.ts      Zustand — toast tray
        ├── hooks/
        │   ├── useProfileAutosave.ts   debounced profile-save + status
        │   └── useFollowScroll.ts      log-panel auto-scroll
        ├── components/
        │   ├── BigButton.tsx           primary CTA with spring press feel
        │   ├── PasswordInput.tsx       password field with eye toggle
        │   ├── AnimatedCheck.tsx       SVG path-draw checkmark for Done
        │   ├── ScreenTransition.tsx    220ms fade-up wrapper
        │   ├── StepperRail.tsx         vertical step rail for the install
        │   ├── LogPanel.tsx            scrolling terminal-style log
        │   ├── LogActions.tsx          copy / save log to file
        │   ├── ToastTray.tsx           bottom-right notifications
        │   ├── IssuesModal.tsx         parsed install-log issues, tabbed
        │   ├── TroubleshootingModal.tsx footer Help — ~30 curated entries
        │   ├── WhatsNew.tsx            in-app new-version banner
        │   ├── IndexerCard.tsx         per-indexer toggle + field reveal
        │   ├── TimezoneSelect.tsx      searchable TZ picker
        │   ├── PlexClaimRefresh.tsx    re-fetch claim token mid-install
        │   ├── ExportProfileDialog.tsx AES-256-GCM passphrase export
        │   └── ImportProfileDialog.tsx encrypted import
        ├── screens/
        │   ├── WelcomeScreen.tsx       profile picker + Install / Update / Migrate
        │   ├── ConnectScreen.tsx       SSH host + creds
        │   ├── EnvDetectScreen.tsx     NAS family + readiness checks
        │   ├── ConfigureScreen.tsx     form for env values
        │   ├── RunScreen.tsx           streaming setup.sh
        │   ├── UpdateRunScreen.tsx     pull-and-recreate / sync-scripts / re-run-step
        │   ├── MigrateScreen.tsx       library transfer from another arr install
        │   └── DoneScreen.tsx          per-service health grid + confetti
        ├── styles/globals.css          fonts, motion vars, reduced-motion
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
