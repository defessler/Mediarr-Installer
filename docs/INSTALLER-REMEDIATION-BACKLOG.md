# Installer remediation backlog

**Produced:** 2026-06-15 by a read-only whole-app discovery pass (5 parallel agents over
install reliability, idempotency/update safety, cross-platform robustness, wizard UX, and
secrets/VPN posture). Every item is evidence-cited (`file:line`) with a fix sketch + effort
(S/M/L). The **music** feature set was excluded (just hardened across v0.9.1–v0.10.2), as
was the deliberately-unbuilt **Deezer** feature.

**Overall health:** the app is mature and battle-hardened — platform detection, secrets
(safeStorage + passphrase-gated export + SFTP-0600 .env, no PTY echo), VPN killswitch, and
re-run idempotency are all genuinely solid, most with scar-tissue comments naming the exact
bug they fixed. The findings below are concentrated rough edges, not systemic problems.

**Status (updated 2026-06-15):** every finding with a clear-correct, low-risk fix has now
been **shipped** across v0.10.3–v0.10.9 (see below). What remains needs *your* decision —
design choices, a security default with breakage risk, or platform fixes that can't be
verified without that hardware. Pick any and I'll implement it.

---

## ✅ Shipped (v0.10.3 – v0.10.9)

- **v0.10.3** — *Refresh dashboard* wrote to an unmounted path (silent no-op), now fixed;
  Homepage `services.yaml`/`settings.yaml` backed up before regen.
- **v0.10.4** — **H2** FlareSolverr disabled on arm64 at the `setup.sh` layer (no more
  crash-loop via manual run / imported profile); **M5** Configure footer + Continue reflect
  validity live (no false "Ready"); **L1** `.env` written atomically.
- **v0.10.5** — **M7** platform-neutral "Before you begin" copy (non-Synology users).
- **v0.10.6** — **M11** qBit WebUI auth fails **closed** (loopback only) when LAN_IP is
  unreadable, instead of opening to all RFC1918.
- **v0.10.7** — **L7** profile-export passphrase floor (12+ chars) + PBKDF2 200k→600k;
  **M2** UGREEN gid-10 default only applied on DMI-confirmed UGREEN, not the heuristic.
- **v0.10.8** — **M9** custom-VPN passthrough drops killswitch-weakening keys (`FIREWALL=off`,
  internet-wide `FIREWALL_OUTBOUND_SUBNETS`).
- **v0.10.9** — **M8** Cancel can no longer freeze the install screen (timeout safety-net →
  unlock, resumable).
- **v0.10.10** — **M6** importing a profile jumps straight to Connect with it active;
  **H3 (partial)** a blocking Configure error now expands all groups so no flagged field
  stays hidden (the humanize-labels / click-to-jump part of H3 remains).

---

## 🔴 HIGH — recommend tackling next (each needs a design call)

### H1. VPN-off compose override uses `!reset` (Compose 2.20+) on the DEFAULT install path
- **Impact:** VPN is off by default, so *every* default install layers
  `docker-compose.no-vpn.yml`, whose qBittorrent/slskd `depends_on: !reset null` needs
  Compose Spec 2.20+. **podman-compose can't parse it** and **pre-2.20 docker-compose v1
  (common on QNAP Container Station, older DSM/UGOS) silently ignores it** → compose waits
  forever for gluetun (not in the active profile when VPN is off). The host hangs at
  "Start the stack" for the 600s timeout, then fails with a generic error.
- **Evidence:** `docker-compose.no-vpn.yml:52,74`; `setup-validate.sh:376-385` only `warn`s
  (doesn't FAIL, so `abort_if_failed` doesn't catch it). Podman is a supported runtime.
- **Fix:** make the incompatibility a hard FAIL in setup-validate.sh (stop with a clear
  message before the hang), **or better** ship two complete standalone compose files
  (vpn / no-vpn) selected by setup.sh instead of a `!reset`-layered override; force the
  standalone path when podman-compose is detected. **Effort: M.** *Design call: hard-fail vs
  standalone-files rewrite.*

### H2. arm64 FlareSolverr disable + 32-bit/FreeBSD blocks live ONLY in the renderer
- **Impact:** the only thing that drops FlareSolverr on arm64 (where its Chromium
  crash-loops) is a renderer effect. A manual `bash setup.sh` over SSH, a re-run on a
  pre-arm64-logic `.env`, or an imported x86 profile all re-arm the crash-looping container
  (burning CPU forever). Same for the 32-bit/FreeBSD hard-blocks.
- **Evidence:** `EnvDetectScreen.tsx:270-275,380-385` (renderer-only); `setup.sh:1130-1162`
  `check_image_arch` only echoes a warning.
- **Fix:** move the arm64 FlareSolverr gate + 32-bit/FreeBSD early-exit into setup.sh's
  profile-building block so the bash layer self-protects on every entry path. **Effort: S.**
  *(Lowest-risk HIGH — a strong candidate to just do.)*

### H3. Configure validation errors point at fields hidden in collapsed groups; empty default qBit password traps first-timers
- **Impact:** the schema requires `QBITTORRENT_PASS` ≥8 chars (qBit on by default) but the
  default config seeds no password. A first-timer who accepts defaults and clicks Continue
  is blocked by an error naming a raw env var (`QBITTORRENT_PASS`) for a field inside a
  *collapsed* group, with the footer having just said "Ready to install" — no auto-open, no
  click-to-jump.
- **Evidence:** `ConfigureScreen.tsx:908` (groups collapsed), `:895-903` (go() never opens a
  group), `:1506-1513` (raw paths), `env-schema.ts:256-265`, `wizard.ts` defaultConfig.
- **Fix:** in go(), map failing paths → owning group, auto-open + scroll to first; make error
  items clickable (reuse `jumpTo`); show human labels not env keys; optionally seed a default
  password or a red badge on the collapsed group header. **Effort: M.** *Design call: also
  seed a default qBit password, or just surface the requirement?*

### H4. Retry re-runs the whole install and invalidates the resume checkpoint
- **Impact:** a per-step Retry rewrites `.env` then runs setup with resume off, so the
  checkpoint hash no longer matches and resume is lost — a late-step failure replays from
  step 1.
- **Evidence:** `RunScreen.tsx:892`, `setup.sh:1050`. *(This finding's agent returned a thin
  summary; verify the exact retry path before fixing.)*
- **Fix:** on a normal step failure, resume without rewriting `.env`. **Effort: M.**

### H5. VPN IP-leak check is a one-shot install-time snapshot
- **Impact:** the only true leak detection (gluetun exit IP vs host IP) runs once at install.
  The 5-min guardian checks liveness/namespace but never compares IPs, so a qBit welded to a
  gluetun whose tunnel failed open is reported healthy. Also skipped (warn-only) if the host
  IP lookup blips, so a flaky-network install can finish green unverified.
- **Evidence:** `post-deploy-validate.sh:469-488`, `qbit-guardian.sh:149-205` (no IP probe),
  `post-deploy-validate.sh:475`.
- **Fix:** add a periodic leak assertion to the guardian (IP compare; fail-closed `docker
  pause qbittorrent` on match/unhealthy) and/or a Done-screen "Re-check VPN" button; make the
  install-time check retry harder before declaring inconclusive. **Effort: M.**

---

## 🟠 MEDIUM

- **M1. `.env` API-key lines blanked on full-wizard re-render.** renderEnv hardcodes
  `*_API_KEY=` empty; the install path SFTP-overwrites `.env` before setup.sh runs. Mostly
  self-healing (setup-arr-config.py re-discovers from config.xml) but a real blank window +
  residual loss for keys whose only copy was `.env`. Fix: merge-carry non-empty keys forward
  (the resume path already deliberately avoids this). `env-render.ts:463-470`,
  `RunScreen.tsx:869-875`. **M.**
- **M2. UGREEN heuristic mis-tags plain Debian/UGOS-like hosts** → seeds PUID/PGID 1000/**10**
  (gid 10 = `wheel`, not the user's group) → arr configs chowned to a group the SSH user
  isn't in. Fix: gate the gid-10 default on high-confidence `vendorSaysUgreen` only;
  otherwise defer to the PUID's primary group. `env-detector.ts:573-577,759`. **S.**
- **M3. Unraid boot resilience calls host fn `update_cron` (not in scope) + writes an
  `@reboot` dynamix cron won't honor** → fresh VPN+qBit Unraid stack has no self-heal until
  an array restart, and the boot hook may never fire. Fix: drop `update_cron` reliance; use
  the User Scripts "At First Array Start" hook or document the */5 guardian as the sole
  cover. `install-boot-resilience.sh:196-210`. **M.**
- **M4. QNAP gets no boot hook AND no guardian on the VPN-off default** (guardian only
  installs when VPN+qBit on; QNAP boot hook is manual). After a reboot, nothing reconciles
  ordering. Fix: install a lightweight always-on */5 `boot-orchestrator.sh` cron regardless
  of VPN state (it no-ops when healthy). `install-boot-resilience.sh:52,220-249`. **M.**
- **M5. Configure footer says "✓ Ready to install" before any validation runs**, and Continue
  is enabled on an invalid config (errors only populate on click). Fix: derive validity
  reactively (`useMemo(envSchema.safeParse(config))`). `ConfigureScreen.tsx:1536-1549`. **S.**
- **M6. Importing a profile doesn't select/advance it** — user lands back on the list and
  must hunt for the new card (contrast createProfile which advances to Connect). Fix:
  `loadFromProfile` + `setStep('connect')` (or highlight+scroll). `WelcomeScreen.tsx:565-575`.
  **S.**
- **M7. "Before you begin" on Welcome is Synology-only copy shown to every NAS family**
  (Control Panel → Terminal & SNMP, Container Manager) — wrong menus for UGREEN/QNAP/Unraid/
  Linux. Fix: platform-neutral copy with Synology as an example, or a tiny "Which NAS?"
  picker reusing the family→instructions map. `WelcomeScreen.tsx:530-553`. **S.**
- **M8. Install Cancel can wedge into a permanent "Stopping…" + busy-locked state** with no
  non-restart recovery (canceling cleared only on stream-close; if cancel is swallowed the UI
  locks). Fix: timeout escape hatch ("Force stop") or keep Back enabled once canceling.
  `RunScreen.tsx:1340-1351`. **M.**
- **M9. Custom VPN provider passes pasted env unfiltered to gluetun** — a stray `FIREWALL=off`
  in a copied snippet silently disables the killswitch. Fix: blocklist/normalize
  killswitch-weakening keys; re-assert `FIREWALL=on` as a belt-and-suspenders default.
  `vpn-providers.ts:295-309`, `env-render.ts:337-342`. **S.**
- **M10. Homepage defaults `HOMEPAGE_ALLOWED_HOSTS=*` while mounting docker.sock** → DNS-
  rebinding from a browser reaches a socket-bearing service. Fix: default to the LAN_IP set
  the wizard already knows; keep `*` as a documented opt-out. `docker-compose.yml:229,234`.
  **S.** *Design call: changing this default could affect reverse-proxy users.*
- **M11. qBit WebUI auth-bypass fails OPEN to all of RFC1918** (with HostHeaderValidation
  off) when LAN_IP/LAN_SUBNET is unparseable — any RFC1918 device bypasses the password. Fix:
  fail CLOSED (whitelist only loopback; keep the login prompt). `setup-folders.sh:441-444`,
  `setup-arr-config.py:3012`. **S.**

---

## 🟡 LOW

- **L1. `.env` write-back is a non-atomic in-place truncate** (runs ~7×/install) — a crash
  mid-write corrupts the secrets file. Fix: temp-file + `os.replace` (atomic); batch the 7
  writes into 1. `setup-arr-config.py:363-364`. **S.**
- **L2. Resume checkpoint trusts a single env_hash whose prelude mutates `.env` every run** —
  benign normalization can force full replays; a future non-idempotent prelude edit would
  silently break resume. Fix: hash the behavior-relevant `.env` subset, or snapshot after the
  prelude. `setup.sh:1046-1056`. **M.**
- **L3. Firewall persistence is Synology-only** — non-DSM hosts with a real blocking
  DOCKER-USER/firewalld rule get one-shot guidance, no persistent rule, no re-check. Fix:
  offer an opt-in idempotent systemd unit / firewalld permanent rule for non-DSM.
  `setup.sh:1081`, `diagnose-firewall.sh:185-186`. **M.**
- **L4. EnvDetect "Re-detect" re-runs against the stale session** while the real fix is the
  less-obvious Back→reconnect; a user who installs Docker then clicks Re-detect concludes the
  tool still can't see it. Fix: make the primary affordance "Reconnect & re-scan".
  `EnvDetectScreen.tsx:1301-1310,609-613`. **S.**
- **L5. Two looping animations (stepper pulse, a shimmer) ignore prefers-reduced-motion** —
  the one leak in an otherwise-thorough reduced-motion story. Fix: `@media (prefers-reduced-
  motion: reduce){ animation: none }`. `App.tsx:478-484`. **S.**
- **L6. Stream redaction only scrubs SSH+sudo passwords** — safe today (`.env` goes via SFTP,
  never echoed) but fragile: any future code that echoes a key lands it in the persistent
  install log users attach to bug reports. Fix: pass `.env` high-entropy values into the
  execStream `secrets` array + a generic `KEY=secret` redaction in appendInstallLog.
  `ssh-service.ts:627-628`. **M.**
- **L7. Profile export weak passphrase floor** (`score!==0`; `password1234` passes) on a file
  bundling every secret; PBKDF2 200k is low for a portable artifact. Fix: require score≥2 +
  bump KDF iters toward 600k for new envelopes; optional "omit secrets" export mode.
  `profile-crypto.ts:172-187,43`. **S.**

---

## Remaining — needs your call

Everything below requires a decision, a test environment I don't have, or carries enough
risk that doing it blind is worse than waiting. **The single biggest unblocker is a way to
test compose + dashboard behavior** — a NAS, or even a local Docker host — which would let me
safely verify **H1 / M10 / M3 / M4** (the high-impact items) without risking the default
install for everyone. (L6 was assessed and intentionally skipped: it's purely preventive —
the real leak vector is already redacted and `.env` secrets never hit stdout.) The rest:

- **Design choices.** **H1** — the `!reset` compose tag breaks the *default* install on
  Podman / older-Compose / QNAP (**highest user impact**; fix is hard-fail-with-a-clear-
  message vs shipping two standalone compose files). **H3** — the Configure validation-error
  UX (auto-open the offending group, humanize the labels). **H4** — Retry rewrites `.env` and
  drops the resume checkpoint. **H5** — continuous VPN leak-checking vs today's install-time
  snapshot.
- **Security default with breakage risk.** **M10** — `HOMEPAGE_ALLOWED_HOSTS=*` alongside the
  docker.sock mount; tightening the default to the LAN set could break reverse-proxy setups,
  so it's your call.
- **Platform fixes I can't verify without the hardware.** **M3** (Unraid boot hook /
  `update_cron`), **M4** (QNAP has no boot hook or guardian on the VPN-off default), **L3**
  (non-DSM firewall persistence).
- **Core-flow / judgment.** **M1** full-wizard `.env` API-key blanking window (self-healing
  today), **M6** post-import flow (auto-advance vs highlight; install vs update), **L2**
  resume-hash fragility, **L4** EnvDetect "Re-detect vs Reconnect" affordance, **L6** broaden
  log redaction to `.env` secrets (defense-in-depth; needs cross-IPC plumbing).

**My recommendation: H1 first** (highest user impact). Tell me which to take and I'll
implement, verify, and ship it the same way as the rest.
