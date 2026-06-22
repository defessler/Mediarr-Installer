# Building a Desktop Installer Like Mediarr

A practical blueprint for building a **GUI desktop wizard that configures and deploys a
self-hosted Docker stack onto a remote machine (NAS/server) over SSH** — distilled from the
Mediarr Installer. It covers the architecture, the reusable patterns, the build/release
pipeline, the traps that cost real debugging time, and a concrete build order so you can
start from zero.

This is written so you can lift the *shape* even if your target stack is completely
different (a different set of containers, a different host family, a different domain).
Section 9 calls out what's generic vs. Mediarr-specific.

---

## Table of contents

1. [What you're actually building](#1-what-youre-actually-building)
2. [The five big design decisions](#2-the-five-big-design-decisions)
3. [Tech stack and why](#3-tech-stack-and-why)
4. [Architecture at a glance](#4-architecture-at-a-glance)
5. [The subsystems](#5-the-subsystems)
   - 5.1 [The typed IPC bridge](#51-the-typed-ipc-bridge)
   - 5.2 [Remote execution over SSH (streaming)](#52-remote-execution-over-ssh-streaming)
   - 5.3 [The payload pattern: ship scripts, run them remotely](#53-the-payload-pattern-ship-scripts-run-them-remotely)
   - 5.4 [The configuration system: schema → render → verify](#54-the-configuration-system-schema--render--verify)
   - 5.5 [The wizard UI: screens + state](#55-the-wizard-ui-screens--state)
   - 5.6 [Opt-in services](#56-opt-in-services)
   - 5.7 [Environment detection](#57-environment-detection)
   - 5.8 [Profiles and secrets](#58-profiles-and-secrets)
   - 5.9 [The in-place self-updater](#59-the-in-place-self-updater)
   - 5.10 [The host-side scripts](#510-the-host-side-scripts)
6. [Build, package, release](#6-build-package-release)
7. [Testing and verification](#7-testing-and-verification)
8. [Hard-won lessons](#8-hard-won-lessons)
9. [Generalizing to a different stack](#9-generalizing-to-a-different-stack)
10. [A concrete build order](#10-a-concrete-build-order)

---

## 1. What you're actually building

Three things wear the word "installer," and conflating them is the first mistake:

1. **A desktop GUI** the user runs on *their* machine (Windows/macOS/Linux).
2. **A remote-execution engine** that drives a *different* machine (the NAS/server) over SSH.
3. **A payload of host-side scripts + a compose file** that the GUI ships to the host and runs there.

The GUI never installs anything locally. It is a **front-end for a remote, idempotent,
shell-driven deployment**. Everything hard about the project lives in the seam between these
three: typed messaging between the GUI's two processes, streaming a long remote script's
output back to a progress UI, and keeping the GUI's notion of configuration in lockstep with
what the host-side scripts actually parse.

The user's journey is a linear wizard: **pick/enter a connection → detect the host
environment → configure (pick services, fill settings) → run (stream the install) → done
(validate, show next steps)**. Build the whole thing around that spine.

---

## 2. The five big design decisions

These shape everything else. Decide them first.

**1. The host does the work; the GUI orchestrates.**
All real logic (create directories, write `.env`, `docker compose up`, wire service APIs)
lives in **shell/Python scripts that run on the host**, not in the desktop app. The app's job
is: collect input, render a `.env`, upload the scripts, run an entrypoint, stream output.
Why: the host is where Docker, the filesystem, and the network actually are; shell is the
right tool there; and a script the user can read/re-run by hand is debuggable in a way a
compiled binary driving them remotely is not.

**2. One idempotent, resumable entrypoint.**
The GUI runs *one* command on the host (`setup.sh`) that converges the whole stack. It must be
safe to run twice, and resumable after a mid-run disconnect (the network *will* blip during a
10-minute install). Every step checks "is this already done?" before doing it. This single
decision removes an entire class of "the install half-failed and now I'm stuck" support load.

**3. Configuration is a single typed schema, rendered deterministically.**
There is exactly one source of truth for "what settings exist" — a schema in the shared
layer. The form, the validation, the `.env` writer, and the host-side parser all derive from
or are tested against it. The moment you have two lists of config keys, they drift, and you
ship a `.env` the host script can't read.

**4. Secrets never touch disk in plaintext and never reach a log.**
Connection passwords/keys are stored via the OS keychain. Sudo passwords are piped to the
remote process's stdin, never put in argv, and **redacted from every streamed chunk** before
it hits the UI or the on-disk log. Get this wrong once and you've written the user's NAS
password into a file on their desktop.

**5. Updates are in-place and self-contained.**
No app-store, no NSIS, no reliance on a framework updater that fights your layout. Ship an
unpacked folder; the app downloads a new build, extracts it, and a tiny helper swaps the
files on restart. The user double-clicks the same exe forever.

---

## 3. Tech stack and why

| Concern | Choice | Why |
|---|---|---|
| Shell | **Electron** | You need Node (for `ssh2`, OS keychain, child processes) *and* a rich UI. Electron is the path of least resistance; a web app can't open raw SSH sockets. |
| Build | **electron-vite** | First-class three-process (main/preload/renderer) build with HMR. Don't hand-roll Vite configs. |
| Packaging | **electron-builder** | Mature, but used in a deliberately minimal mode (`dir` target only — see §6). |
| UI | **React 19 + TypeScript** | Wizard = a state machine rendering forms. React's component model fits; TS catches the IPC contract drift. |
| UI state | **zustand** | A wizard has a little global state (current step, the form values, a toast/error queue). Zustand is ~lines of boilerplate; Redux is overkill. |
| Forms | **react-hook-form** | The Configure screen is one big form with conditional fields. RHF keeps re-renders cheap. |
| Validation | **zod** | The config schema *is* a zod object. `superRefine` expresses cross-field rules ("if Spotify is on, both creds are required"). |
| SSH/SFTP | **ssh2** | The only serious pure-JS SSH client. Streaming exec + SFTP in one library. |
| Styling | **Tailwind** | Fast, consistent, no CSS-file sprawl across 30 components. |
| Animation | **motion** (Framer Motion) | Screen transitions + progress affordances. Optional but cheap polish. |
| Logging | **electron-log** | Rotating main-process log on the user's disk; your #1 support tool. |
| Tests | **Vitest** | Fast, ESM-native, same toolchain as Vite. |

Keep runtime dependencies few. Every one is a thing electron-builder must bundle and the
updater must swap.

---

## 4. Architecture at a glance

```
┌──────────────────────────── Desktop app (Electron) ────────────────────────────┐
│                                                                                 │
│   MAIN process (Node)                 PRELOAD (contextBridge)    RENDERER (React)│
│   ───────────────────                 ─────────────────────     ───────────────│
│   • ssh-service   (ssh2 sessions)     window.installer = {       Wizard screens: │
│   • sftp-service  (file upload)  ◀──▶   ssh.exec/execStream,  ◀▶  Welcome→Connect │
│   • env-detector  (probe host)          sftp.uploadDir,           →Detect→Config  │
│   • profile-store (OS keychain)         env.detect,               →Run→Done       │
│   • updater-service                     profiles.*, …      }      zustand stores  │
│   • ipc-handlers  (registers all)     (the ONLY surface the       react-hook-form │
│                                        renderer can call)         zod (shared)    │
│        ▲                                                                          │
│        │  SHARED (imported by main + preload, type-only by renderer)             │
│        │  • ipc.ts        channel names + payload types                           │
│        │  • env-schema.ts zod schema + cross-field validation                    │
│        │  • env-render.ts form values → .env text                                │
└────────┼─────────────────────────────────────────────────────────────────────────┘
         │  SSH / SFTP
         ▼
┌──────────────────────────── Remote host (NAS / server) ────────────────────────┐
│  /install-dir/                                                                   │
│    .env                  ← rendered by the app, uploaded via SFTP               │
│    docker-compose.yml    ← from the bundled payload                             │
│    scripts/setup.sh      ← THE entrypoint; idempotent, resumable                │
│    scripts/setup-*.sh    ← folders, firewall, boot-resilience, validate…        │
│    scripts/*.py          ← API wiring (configure services after they're up)     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**The three Electron processes and the rule that governs them:**

- **Main** is Node. It owns everything privileged: SSH sockets, the filesystem, the keychain,
  child processes. It never renders UI.
- **Renderer** is the React app. It owns everything visual. It has **no Node access** —
  `nodeIntegration` is off, `contextIsolation` is on.
- **Preload** is the *only* bridge. It runs in an isolated world with access to both
  `ipcRenderer` and the DOM, and uses `contextBridge.exposeInMainWorld` to hand the renderer a
  **narrow, typed object** (`window.installer`). Raw `ipcRenderer` is never exposed.

This isn't ceremony — it's the security model. The renderer runs remote-ish content (your own,
but still web tech); if it could `require('child_process')` you'd have a problem. The bridge
means the renderer can only call the exact functions you chose to expose.

---

## 5. The subsystems

### 5.1 The typed IPC bridge

**The pattern:** one shared file defines channel names as constants and payloads as types.
Main, preload, and (type-only) renderer all import it. There are no string-literal channel
names at call sites and no `any` payloads.

```ts
// shared/ipc.ts — single source of truth
export interface ConnectionConfig { host: string; port: number; user: string; /* … */ }
export interface ExecResult { exitCode: number | null; signal: string | null; stdout: string; stderr: string }

export const IPC = {
  sshConnect:    'ssh:connect',
  sshExec:       'ssh:exec',
  sshExecStream: 'ssh:exec-stream',
  envDetect:     'env:detect',
  // … events (main → renderer) live here too:
  evtStreamData: 'ssh:stream:data',
  evtStreamClose:'ssh:stream:close',
} as const
```

```ts
// preload/index.ts — the contextBridge surface
const installer = {
  ssh: {
    exec: (a: { sessionId: string; cmd: string; sudo?: boolean }): Promise<ExecResult> =>
      ipcRenderer.invoke(IPC.sshExec, a),
    execStream: (a: { sessionId: string; cmd: string; channelId: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.sshExecStream, a),
    onStreamData: (cb: (d: SshStreamData) => void) => {           // event subscription
      const h = (_e: unknown, p: SshStreamData) => cb(p)
      ipcRenderer.on(IPC.evtStreamData, h)
      return () => ipcRenderer.off(IPC.evtStreamData, h)          // returns an unsubscribe
    },
  },
  // sftp, env, profiles, updater, dialog… each a small namespaced object
}
export type InstallerApi = typeof installer       // renderer augments Window with this
contextBridge.exposeInMainWorld('installer', installer)
```

Two details that matter:

- **Request/response** uses `ipcRenderer.invoke` ↔ `ipcMain.handle` (promises).
- **Streaming** (a long command's output) uses **events**: main `webContents.send(channel, …)`
  on every chunk; the preload exposes an `onStreamData(cb)` that returns an **unsubscribe**
  function. The renderer subscribes in a `useEffect` and unsubscribes on cleanup. Don't try to
  stream over `invoke` — it's one-shot.

The renderer declares `interface Window { installer: InstallerApi }` (a `global.d.ts`) and
calls `window.installer.ssh.execStream(...)`. Fully typed end-to-end; rename a channel and the
compiler finds every caller.

### 5.2 Remote execution over SSH (streaming)

This is the heart of the app and where the subtle bugs live. Use `ssh2`. Model **sessions**
(one persistent `Client` per connection, keyed by a `sessionId`) and **channels** (one
`exec` per command, keyed by a `channelId` the renderer chooses).

**One-shot exec** (buffered) for quick probes; **streaming exec** (PTY) for the long install:

```ts
// streaming: forward stdout/stderr to the renderer chunk-by-chunk
client.exec(fullCmd, { pty: true }, (err, stream) => {
  activeChannels.set(channelId, stream)
  stream.on('data',  d => send(IPC.evtStreamData, { channelId, type: 'stdout',
                                                    chunk: redact(d.toString()) }))
  stream.stderr.on('data', d => send(IPC.evtStreamData, { channelId, type: 'stderr',
                                                          chunk: redact(d.toString()) }))
  stream.on('close', (code, signal) => send(IPC.evtStreamClose, { channelId, exitCode: code, signal }))
})
```

The non-obvious requirements, each learned the hard way:

- **Handle `'error'` on the `Client`.** ssh2's `Client` is an `EventEmitter`; an unhandled
  `'error'` (WiFi blip mid-install) **throws and crashes the whole main process**. Attach a
  handler that drops the session so later ops fail cleanly with "no session" instead of taking
  the app down.
- **PTY for streaming, no PTY for one-shot.** A PTY gives line-buffered output (good progress
  feel) but **echoes stdin** — including a piped sudo password. One-shot `sudo -S` over a plain
  pipe keeps stdout clean. Pick per call.
- **Redact secrets from every chunk.** Because the PTY echoes the sudo password, run every
  outbound chunk through a redactor (`split(secret).join('••••••')`, fixed-width so you don't
  leak length) *before* it reaches the renderer **and** the on-disk log.
- **A stall watchdog.** A live install streams continuously; a long stretch of zero output
  means a dead socket or wedged step. Arm a timer that bumps on each chunk; if it fires,
  `signal('TERM')` the channel and emit a synthetic close so the UI recovers instead of
  spinning forever.
- **Cancel = TERM then KILL.** On user-cancel, send `TERM`, keep the channel handle, and after
  a grace period escalate to `KILL` + `close()`. A `compose pull` whose child swallows TERM
  will otherwise keep running on the host while the UI thinks it stopped.
- **Privilege escalation is a matrix, not a boolean.** The login may be root, root-under-another-name,
  passwordless-sudo, password-sudo, `doas`, or merely in the `docker` group. Compute the mode
  once per session; wrap with `sudo -S` / `sudo -n` / `doas` / nothing accordingly; and when
  there's *no* path to root, **fail fast with an actionable message** rather than silently
  running an unprivileged command that corrupts state.
- **Pipe stdin correctly.** `sudo -S` reads the password from stdin then you must `stream.end()`
  or it hangs forever. For large file bodies (an SFTP fallback), honor backpressure with a
  `drain` handler.

### 5.3 The payload pattern: ship scripts, run them remotely

The host-side scripts live in the *same repo* as the app (e.g. `nas/scripts/`) but are
**bundled into the app as a resource at build time** and **uploaded to the host at install
time**.

- **Build time:** a `copy-nas-payload.mjs` script (run before every `electron-vite build`)
  copies `nas/**` → `resources/nas-payload/`, excluding secrets/junk (`.env`, `__pycache__`,
  `*.pyc`, `*.log`, `*.lock`). It also records `git rev-parse HEAD:nas` into a `.payload-sha`
  file so the running app can tell you exactly which payload it's carrying (priceless for
  support). `electron-builder.yml` ships it via `extraResources`.
- **Install time:** the app SFTP-uploads `nas-payload/` to `<install-dir>/`, writes the
  rendered `.env`, then runs `bash <install-dir>/scripts/setup.sh` over a streaming channel.

Why bundle-and-upload instead of, say, `git clone` on the host: the host may have no internet
to GitHub, no git, or a locked-down shell. Shipping the exact scripts the app was tested with
removes a whole dimension of "works on my NAS." The `.payload-sha` then answers "is the user
running the scripts I think they are?" deterministically.

### 5.4 The configuration system: schema → render → verify

The single most leverage-dense part of the codebase. Four pieces, one source of truth.

**1. The schema (zod) — what settings exist + how they validate.**

```ts
// shared/env-schema.ts
export const envSchema = z.object({
  INSTALL_DIR: z.string().min(1),
  ENABLE_PLEX: optStr,            // "true" | "false" | undefined
  ENABLE_PLAYLIST_SYNC: optStr,
  JELLYFIN_API_KEY: optStr,
  // … every key the stack understands
}).superRefine((v, ctx) => {
  // cross-field rules live here, not scattered in the UI:
  if (isOn(v.ENABLE_PLAYLIST_SYNC)) {
    if (v.MEDIA_SERVER !== 'jellyfin' && !isOn(v.ENABLE_PLEX))
      ctx.addIssue({ path: ['ENABLE_PLAYLIST_SYNC'],
                     message: 'Playlist Sync needs a media server — Plex or Jellyfin' })
  }
})
```

**2. The renderer (`env-render.ts`) — form values → `.env` text, deterministically.**
A pure function: given the validated form object, emit `KEY=value` lines in a stable order
with helpful comments. Pure = testable, diff-able, and free of "why did the .env change order
this build."

**3. The example file (`.env.example`)** — the human-facing documentation of every key, with
comments. It is *also* a test fixture (below).

**4. The verification layer** — this is what keeps the four in sync as the project grows:

- **Key-parity test:** every key in `.env.example` must exist in the schema, and vice-versa
  (minus an explicit `NAS_ONLY` allowlist for keys the host scripts read but the wizard never
  sets). The day someone adds a key to `.env.example` and forgets the schema, CI goes red.
- **Cross-language oracle:** the host parses the `.env` with **bash/Python**, but the app
  *writes* it with **TypeScript**. These can disagree (quoting, spaces, `+` vs `%20`,
  `10#`-octal bashisms). So the test suite **extracts the real shipped bash/python parser
  functions and runs them against the TS writer's output**, asserting both languages agree on
  every value. This caught more than one "works in the test, breaks on the NAS" bug.

The lesson encoded here: **when two languages must agree on a format, test them against each
other, not each against your assumptions.**

### 5.5 The wizard UI: screens + state

A wizard is a linear state machine. Keep it dead simple:

- A `wizard` store (zustand) holds `step`, the active profile id, and the form values.
- `App.tsx` switches on `step` to render one screen, wrapped in an `<AnimatePresence>` +
  a `ScreenTransition` for a consistent fade. Define the step order as a const array so
  "next/back" and the progress rail derive from one list.
- Each screen is self-contained: `WelcomeScreen` (pick/create a profile), `ConnectScreen`
  (host/user/auth + test-connect), `EnvDetectScreen` (run detection, show findings/warnings),
  `ConfigureScreen` (the big form), `RunScreen` (stream the install into a log panel),
  `DoneScreen` (validate, show manual next-steps). Plus side-quests (`MigrateScreen`,
  `UpdateRunScreen`).
- The **layout contract** matters more than it sounds: pin the frame to the viewport
  (`h-screen` + `overflow:hidden` on the root) and give *each screen* its own scroll area
  (`flex-1 min-h-0 overflow-y-auto`) with a pinned header/footer. If you rely on the document
  to scroll, you get dead space and a scrolling title bar.
- The **log panel** (RunScreen) is just an append-only buffer fed by `onStreamData`, with ANSI
  parsing, follow-scroll (stick to bottom unless the user scrolls up), and copy/save actions.

### 5.6 Opt-in services

Most of the stack is optional. A clean opt-in service touches exactly **five** places — make
adding one a checklist, not an archaeology dig:

1. **Schema** (`env-schema.ts`): an `ENABLE_FOO` key + any `superRefine` requirements.
2. **Renderer + `.env.example`**: emit the flag with a default; document it.
3. **Compose**: put the service behind a `profiles: [foo]` so it only starts when selected.
4. **Boot orchestration**: a `boot-orchestrator.sh` that builds the active `--profile` list
   from the `.env` flags, so reboots bring up exactly what's enabled.
5. **UI toggle**: a card in the Configure screen's service list, with a `needs: ['ENABLE_BAR']`
   dependency if applicable.

Because the flag is a real schema key, the key-parity test guards step 2 automatically.

### 5.7 Environment detection

Before configuring, **probe the host** and adapt. One SSH round-trip runs a battery of cheap
checks and returns a big typed result object. The categories worth probing (generalize as
needed):

- **Runtime:** is Docker present (and which compose)? Podman fallback? socket location?
- **Identity/paths:** PUID/PGID, the data-volume path, free disk, timezone, LAN IP.
- **Capabilities:** can the SSH user reach Docker without sudo? what escalation backend?
  kernel modules the stack needs (e.g. `tun` for a VPN)? filesystem type (reject network
  mounts for SQLite configs)?
- **Pre-existing install:** is there already a compose/.env at the target? running containers?
- **Reachability:** can the host pull images / reach the services you depend on?
- **Family classification:** which NAS vendor (drives default paths, family-specific help, and
  gotchas) — with a confidence level so the UI asks the user to confirm when it's guessing.

Detection turns "fill in 20 fields correctly" into "confirm these sensible defaults," and lets
you **block impossible installs early** (32-bit ARM, FreeBSD, a network-mounted config dir)
with a clear message instead of a cryptic failure at step 7.

### 5.8 Profiles and secrets

A **profile** is all settings for one host — connection + the full config form + optional
migration state. The user picks one at the start; fields populate from it and autosave back.

- **At rest:** encrypt via Electron `safeStorage` (DPAPI on Windows, Keychain on macOS,
  libsecret on Linux). If the machine has no keyring, fall back to reversible base64 **and tell
  the user** (show an "at-rest warning" instead of a green lock — don't pretend).
- **In transit to the renderer:** the list endpoint returns a *public* shape (no secrets);
  secrets only load when the user explicitly selects a profile.
- **Portable export/import:** a passphrase-derived key (PBKDF2/scrypt) wrapping an AES-GCM
  envelope, written through a native save dialog. Return a *stable* error string for "wrong
  passphrase" so the UI can message it without pattern-matching OpenSSL output.

### 5.9 The in-place self-updater

Deliberately *not* electron-updater/NSIS. The model:

- **Package** as an unpacked **`dir`** target (electron-builder), zipped by CI and attached to
  a GitHub Release.
- **At runtime**, the app polls the GitHub Releases API (unauthenticated — mind the ~60 req/hr/IP
  limit; coalesce checks, throttle, and back off on the `X-RateLimit-Reset`). On "update
  available," it downloads the zip, extracts to a staging dir, and on "restart to finish"
  spawns a **detached helper** (a hidden `cmd` + `.vbs` on Windows) that waits for the app to
  exit, `robocopy`s the new files over the install dir, and relaunches.

Two traps:
- The swap helper must run with a CWD **outside** the install dir, and the helper script must
  `cd` somewhere neutral — you can't rename a directory that is a live process's CWD.
- AI-generated PowerShell/VBS swap helpers can trip AV heuristics. Keep the helper minimal and
  boring; expect to explain it.

For a v1, you can ship without auto-update and add it later — but design the `dir`-target +
zip-release shape from the start so you don't repackage.

### 5.10 The host-side scripts

This is a parallel mini-project. Structure it around the idempotent entrypoint:

- **`setup.sh`** — the orchestrator. Sources `.env`, then calls the focused scripts in order,
  each guarded so a re-run is a no-op. Traps INT/TERM to tear the stack down in order on cancel.
- **`setup-folders.sh`** — create the directory tree with correct ownership (`PUID:PGID`).
- **`setup-firewall.sh` / `setup-*.sh`** — host-specific wiring, each degradable with a warning
  when it can't run (non-root, unsupported family).
- **`*.py`** — post-up API configuration: wait for a service's HTTP API to come alive, then
  POST its settings (indexers, providers, keys). Python because JSON + HTTP + retries are
  nicer than bash there.
- **`boot-orchestrator.sh` / boot resilience** — re-derive the active compose profiles and
  bring the stack up in dependency order on reboot.
- **`post-deploy-validate.sh`** — reachability checks the Done screen surfaces ("13/13 services
  reachable").
- **compose overrides** — a base `docker-compose.yml` plus override files (`*.no-vpn.yml`,
  `*.test-override.yml`) selected by the entrypoint, rather than one mega-file with every
  permutation.

Golden rules for these scripts: **POSIX `sh` unless you truly need bash** (NAS busybox is
common — `shellcheck` in CI catches bashisms); **idempotent and resumable**; **a dead/optional
component is a warning, never a hard error** (reserve red "failed" for things that actually
break the stack).

---

## 6. Build, package, release

**Three-process build (`electron.vite.config.ts`):** main, preload, and renderer each get
their own build with shared path aliases. `externalizeDepsPlugin()` on main/preload keeps Node
deps external; the renderer is a normal Vite React build with `index.html` as input.

```
npm run dev        # copy-payload + electron-vite dev (HMR on all three)
npm run build      # copy-payload + electron-vite build → out/{main,preload,renderer}
npm run build:win  # build + electron-builder --win  → dist/win-unpacked/
```

**Packaging (`electron-builder.yml`), minimal on purpose:**
- `target: dir` (no NSIS/portable) — produces `win-unpacked/`; CI zips it. This is what makes
  the in-place updater's "swap the folder" strategy stable (a `portable` target self-extracts
  to a new temp path each launch).
- `asar: true`; `extraResources` ships `nas-payload/`.
- `signAndEditExecutable: false` to dodge the winCodeSign cache extraction failure on
  un-Developer-Mode Windows (skip signing for an unsigned internal tool; revisit if you
  distribute publicly).
- `publish:` points at the GitHub repo — the *updater* reads this at runtime to find releases;
  CI creates the release itself.

**Release flow (one tag, three workflows):**
- `npm version X --no-git-tag-version` in the app dir → commit → `git tag installer-vX` → push.
- **CI workflow** (`installer-ci.yml`): typecheck + build + `vitest run` on every push.
- **Release workflow** (`installer-release.yml`): on the `installer-v*` tag, build, zip
  `win-unpacked`, create the GitHub Release.
- **Image workflow** (optional): if your stack includes a container you build yourself, a
  separate workflow builds/pushes it on changes to its directory.

**Write version commits as changelogs** — GitHub auto-generates release notes from the tagged
commit message, so a clean, user-facing commit body becomes your release notes for free.

---

## 7. Testing and verification

You can't unit-test "deploys to a NAS," so test the **deterministic seams**:

- **Unit (Vitest):** the `.env` renderer (pure function), schema validation (feed it good/bad
  objects, assert the `superRefine` issues), any path/format helpers.
- **Cross-language oracle (the high-value one):** extract the *real* shipped bash/Python parser
  functions and run them against the TS writer's output, asserting both languages decode every
  value identically. Pin `LC_ALL=C` so locale can't perturb sorting/case. This is the test that
  catches the bugs that only show up on the host.
- **Parity guards:** `.env.example` ↔ schema key-parity (both directions, with an explicit
  allowlist). A blind guard like this is worth more than it looks — it fails the day the
  invariant breaks, not three releases later when a user hits it.
- **`shellcheck` in CI** for every host-side `.sh`, with the POSIX dialect where the host is
  busybox.

Wire all of it into the CI workflow so a red check blocks the release.

---

## 8. Hard-won lessons

A condensed list of things that cost real time — bake them in from day one:

- **An unhandled `'error'` on a persistent ssh2 `Client` crashes the main process.** Always
  attach a handler.
- **Idempotency isn't optional.** The network drops mid-install; the user clicks Run twice.
  Every step must check-then-act, and the entrypoint must resume.
- **Redact secrets at the stream boundary**, with a fixed-width mask (variable width leaks
  length). The PTY echo will otherwise write the sudo password into the user's log file.
- **`sudo -S` hangs without a stdin write + `end()`.** This is the "the directory silently
  didn't get created" bug.
- **Don't put file bodies or secrets in argv.** Busybox `sh` rejects argv over ~80 KB
  ("Argument list too long"); pipe via stdin instead.
- **Two parsers, one format → test them against each other.** `+` vs `%20`, `10#` octal, quoting
  — these differ across bash/python/TS and only bite on the host.
- **Adding a config key is a multi-file operation.** Schema + renderer + `.env.example` (+ the
  parity test that enforces it). Make it a checklist; let CI hold the line.
- **`h-full` depends on the whole ancestor chain being sized; `h-screen` doesn't.** Pin the
  frame to the viewport and let inner regions scroll, or you'll chase a "the whole app
  scrolls" ghost.
- **A dead optional indexer/service is a warning, not an error.** Reserve "failed" for things
  that break the stack, or users will think a working install is broken.
- **Detection should hard-block the impossible early** (wrong arch/OS, network-mounted config
  dir) with a clear reason, not a cryptic failure deep in the run.
- **The in-place swap can't rename a directory that's a live process's CWD.** Spawn the helper
  with a neutral CWD.

---

## 9. Generalizing to a different stack

What's **reusable verbatim** (the spine):
- The three-process Electron model + typed IPC bridge (§5.1).
- The streaming SSH execution engine, escalation matrix, redaction, watchdog (§5.2).
- The bundle-payload-and-upload pattern + `.payload-sha` (§5.3).
- The schema → render → verify config system, including the cross-language oracle (§5.4).
- The wizard shell, profiles/secrets, the `dir`-target + in-place updater (§5.5, 5.8, 5.9).
- The build/release pipeline and CI shape (§6, §7).

What's **Mediarr-specific** and you'd swap out:
- The *set* of services and their compose/profiles (the domain).
- The `*.py` API-wiring scripts (specific to the apps you deploy).
- The NAS-family detection table (keep the *idea*, change the families/paths you care about).
- The exact config keys and cross-field rules.

A good first port: keep `ssh-service`, `sftp-service`, `ipc.ts`, the preload, the env-system
skeleton, and the wizard frame almost unchanged; replace the payload (`nas/`), the schema's
keys, and the service cards. You inherit ~70% of the hard parts for free.

---

## 10. A concrete build order

Build it in this order — each step is runnable/demoable before the next, so you're never
debugging ten new things at once.

1. **Scaffold electron-vite** (main + preload + renderer). Get a window rendering "hello" with
   `contextIsolation` on and a one-function `window.app.ping()` bridge working. *This proves
   the IPC model before you build anything on it.*
2. **SSH connect + one-shot exec.** A Connect screen that calls `ssh.testConnect`, then runs
   `uname -a` and shows the output. Handle the `Client` `'error'` from the start.
3. **Streaming exec + a log panel.** Run `for i in $(seq 5); do echo $i; sleep 1; done` and
   watch it stream. Add the watchdog + cancel now, while the surface is small.
4. **The config schema + renderer + `.env.example` + the parity test.** No UI yet — just the
   shared module and its Vitest. Get CI green on it.
5. **The Configure form** bound to the schema (react-hook-form + zod). Conditional fields,
   `superRefine` errors surfaced inline.
6. **The payload pipeline.** `copy-nas-payload.mjs`, `extraResources`, SFTP upload, and a
   trivial `setup.sh` that just `echo`s and writes a marker file. End-to-end: configure →
   upload → run → stream → done.
7. **Flesh out the host scripts**: real `docker-compose.yml`, idempotent `setup-*.sh`, the
   post-up API wiring, boot resilience, validation. Add the cross-language oracle test.
8. **Environment detection** + the Detect screen; wire detected defaults into the form.
9. **Profiles + secrets** (keychain, list/load/save, export/import).
10. **Opt-in services** (the five-place checklist) for each optional component.
11. **Packaging + release CI** (`dir` target, zip, GitHub Release on tag).
12. **The in-place updater** last — it's the most fiddly and the least load-bearing for a v1.

Ship after step 7 if you must; everything after is hardening and polish. The first seven steps
*are* the installer.

---

*Distilled from the Mediarr Installer (Electron + electron-vite + React 19 + zod + ssh2),
which deploys a ~15-service Arr media stack onto NAS hardware over SSH. The patterns here are
the load-bearing ones; the domain specifics are not.*
