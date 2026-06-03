# Installer Hardening & Platform-Support Plan

Goal: make the Mediarr Installer run reliably on **any** Docker-capable NAS/host,
not just the tested Synology + UGREEN. This plan is the output of a structured
research pass across NAS platforms + installer-hardening patterns. Items are
phased by **impact ÷ effort** — Phase 1 is cheap, high-impact correctness.

Status legend: ✅ supported & tested · 🟡 detected but behavioral gaps · 🔴 not
detected / mis-handled · ⛔ unsupportable (document & reject cleanly).

---

## 1. Platform support matrix

| Platform | Today | Key gap | Effort |
|---|---|---|---|
| **Synology DSM** (x86) | ✅ | — (RAM/arch unaware on ARM models) | — |
| **UGREEN UGOS** | ✅ | — | — |
| **QNAP QTS / QuTS hero** | 🟡 detected `qnap` | **admin == root with NO sudo** → `sudoMode` mis-detected as `password`, every `sudo` prefix fails | moderate |
| **TrueNAS SCALE** (24.10+) | 🟡 detected `truenas` | host `docker compose up` is unsupported vs middleware; set 568:568 dataset ACL; firewall no-op | moderate |
| **TrueNAS CORE** (FreeBSD) | 🔴 **mis-detected** as `truenas` | FreeBSD — no Linux Docker; the `/etc/version` regex matches it → confusing mid-install failure. Needs `uname -s` hard-reject | trivial |
| **Unraid** | 🟡 detected `unraid` | `/mnt/user` is **FUSE (fuseblk)** → must not be false-rejected by the SQLite-network-FS guard; stock Unraid has **no `docker compose`** (Compose Manager plugin); RAM-overlay rootfs | moderate |
| **OpenMediaVault** | 🟡 detected `omv` | `/srv` default should point at a per-disk shared folder, not bare `/srv` | trivial |
| **Asustor ADM** | 🔴 not detected → `linux` | falls to `/opt`+`/srv` (off the data pool). Add `asustor` family (`/volume0` + `/etc/nas.conf` → `/volume1` defaults; root login works) | moderate |
| **TerraMaster TOS 6** | 🔴 not detected → `linux` | **CAPITAL `/Volume1`** (lowercase checks miss it); install user is **uid 0 but not named `root`** | moderate |
| **ZimaOS** | 🔴 not detected → `linux` | **read-only root FS** → `/opt`+`/srv` writes FAIL; everything must live under `/DATA` | moderate |
| **CasaOS** (overlay) | 🟡 works as `linux` | installs fine (writable root) but not under `/DATA`; no Pi/arch guards | low (optional) |
| **Raspberry Pi / SBC** | 🟡 works as `linux` | armhf/SD-card/low-RAM guards missing | low |
| **Docker Desktop** (Mac/Win) | ⛔ not SSH-reachable | needs a separate "local Docker API" install mode, not SSH+bash | hard (separate track) |
| **WD My Cloud / Netgear ReadyNAS / Buffalo** | ⛔ | no arbitrary Docker / 32-bit / ancient Debian → detect & reject cleanly | trivial (reject path) |

---

## 2. Cross-cutting hardening themes (prioritized)

### Phase 1 — cheap, high-impact correctness
> **Status: items 1–4 + #11 shipped in v0.4.11.** (#5 FlareSolverr + #6 multi-arch pre-flight move with Sprint 2.)

1. **CPU-arch + RAM probe** *(trivial, high)* — ✅ **v0.4.11**. — env-detector has **zero** arch awareness. Add `uname -m` and `MemTotal` (`/proc/meminfo`) to the batched probe. Decision tree: 32-bit ARM (`armv7l`/armhf) → **hard-block** (linuxserver dropped armhf 2023-07-01, no current images); arm64 → allow but warn "no HW transcode" + warn if RAM < ~2 GB; amd64 → current behavior. This single change unblocks correct handling of ARM Synology/QNAP/SBC and prevents silent breakage.
2. **TrueNAS CORE hard-reject** *(trivial, high)* — add a `uname -s == FreeBSD` early-exit ("requires TrueNAS SCALE or a Linux host"). Today CORE matches the same `/etc/version` regex as SCALE and is accepted, then fails confusingly when `ip`/`lsmod`/`iptables`/`stat -f` probes break on BSD userland.
3. **Unraid FUSE not false-rejected** *(trivial, high)* — verify `/mnt/user` reporting as `fuseblk`/`fuse.*` is treated as **local** by the install-dir-fs SQLite guard (it's local shfs, not NFS/CIFS). A false reject would block every Unraid install. Recommend appdata on `/mnt/cache` where a cache pool exists.
4. **uid-0-not-named-root** *(trivial, high for QNAP/TerraMaster/ZimaOS)* — `isRoot` currently tests `whoami === 'root'`. QNAP `admin`, TerraMaster superadmin, and others are **uid 0 with a different name**. Switch to `id -u == 0 ⇒ root` (drop sudo). This is the core QNAP fix.
5. **FlareSolverr is deprecated + broken on arm64** *(moderate, high)* — bundled Chromium crashes on ARM and the project is unmaintained. Make it **optional**, default **off on arm64**, and offer **Byparr** (drop-in, maintained) as a substitute. It's an internal Prowlarr dependency (not a `depends_on`), so breakage is silent — exactly the kind of thing to gate on arch.
6. **Multi-arch pre-flight** *(moderate, high)* — before the long `compose up`, probe arch once and run `docker manifest inspect <image>` per enabled image to assert the host platform is in the manifest. Fail fast with "no arm64 variant for X" instead of 15 min into a pull. Cheap (no layer download).

### Phase 2 — new platform families
7. **Asustor `asustor`** — marker `[ -d /volume0 ] && [ -f /etc/nas.conf ]`; defaults `INSTALL_DIR=/volume1/Docker/mediarr`, `DATA_ROOT=/volume1/Data`; prefer **root SSH** (`sudoMode=root`). PATH-augment the docker-ce plugin bin dir.
8. **TerraMaster `terramaster`** — marker `[ -d /etc/tos ]`; **case-sensitive `/Volume1`** (add to `data_candidates`, the data-share picker, the df/fstype ancestor walks); defaults `/Volume1/docker/media` + `/Volume1/data`. Depends on the uid-0 fix (#4). Surface "install Docker Manager from App Center" when docker is absent.
9. **ZimaOS `zimaos`** — composite marker (`/DATA` + read-only root + casaos stack); defaults **must** be under `/DATA` (`/DATA/AppData/mediarr` + `/DATA/Media`) because the root FS is read-only. Wizard must instruct enabling SSH (Developer Mode) + setting a root password first.
10. **CasaOS `casaos`** *(optional)* — marker `/etc/casaos` / `/usr/bin/casaos` / `casaos.service`; default to `/DATA/AppData` so it shows in CasaOS's file manager; add armhf + SD-card/low-RAM warnings on Pi.
11. **Unsupportable detection** — when `docker` is missing **and** (32-bit arch **or** ancient Debian Jessie/Stretch), emit "this device cannot run the stack" instead of attempting a doomed install (covers WD/Netgear/Buffalo + dead ReadyNAS Docker).

### Phase 3 — privilege & dependency robustness
12. ✅ **v0.4.15** **Per-operation privilege strategy** *(moderate, medium)* — detect `docker`-group membership (`docker ps` works without sudo) and run docker/compose **unprivileged**, reserving sudo only for genuinely-root steps (Synology firewall, chown-to-PUID, tun insmod). Treat "docker works, no sudo" as a **supported** mode instead of throwing. Add `doas` as an escalation backend alongside `sudo -S`. *(Shipped: `privMode` = none/wrap-nopass/password/fail; docker-group fallback runs unprivileged + emits a one-time "degrade with a warning" notice; doas backend with `-n`/PTY-password and a non-PTY fail-fast guard; NOPASSWD-without-password now supported via `wrap-nopass`.)*
13. **Containerize host-python3 steps** *(moderate, high)* — the qBittorrent PBKDF2 hash (`setup-folders.sh`) and `setup-arr-config.py`/indexers run with **host python3**, making it a hard host requirement. Run them in a throwaway `python:3` container on the stack network instead (keep the host-python fast path when present). This collapses the host contract to **"just Docker"** and demotes python3 from REQUIRED to optional.
14. ✅ **v0.4.15** **Capability matrix → actionable remediation** *(moderate, medium)* — map each dependency to the steps that need it **given the user's `.env`** and a family-aware remediation string (apt / opkg / Package Center / Container Station), instead of hard blocks or Synology-flavored hints on every platform. *(Shipped: `dockerRemediation(family)` renders platform-correct Docker install guidance under the Docker check when it's missing; the sudo-strategy panel also offers the `usermod -aG docker` shortcut on generic Linux / OMV / TrueNAS.)*

### Phase 4 — resilience & detection quality
15. ✅ **v0.5.0** **Detection confidence** *(moderate, medium)* — return `nasFamily` **plus** `familyConfidence: high|low|unknown` (high = OS marker matched; low = heuristic like Debian+/volume1; unknown = fell through to `linux`). Surface "unknown" so the user confirms paths instead of silently inheriting `/opt`+`/srv`. Add `dmidecode -s system-manufacturer` (best-effort sudo) as a tiebreaker so a real UGREEN box is confirmed by vendor string and a plain Debian box with a stray `/volume1` isn't mis-tagged `ugreen`. *(Shipped: DMI probe reads world-readable `/sys/class/dmi/id/sys_vendor` first → `dmidecode` fallback; `vendorSaysUgreen` confirms→high, `vendorIsGeneric` (QEMU/VMware/cloud) demotes a stray-/volume1 VM to `linux`; markers always win; `systemVendor` surfaced in the Detect UI; CI UGREEN sim now brands `os-release` ID=ugos + `classify.sh` mirrors the guard.)*
16. ✅ **v0.5.0** **Idempotency / resumability / retries** *(moderate, medium)* — add a `.setup-state` checkpoint (completed steps + `.env` content-hash) so a re-run fast-skips unchanged steps; a `--resume`/`--from N` flag; and retry-with-backoff around network-bound steps (`compose pull`, NordVPN fetch). *(Shipped: `--resume`/`--from N` flags; `.setup-state` (last_completed + freshly-recomputed `.env` sha256) in SCRIPT_DIR; `run_step` skips below START_STEP; `retry()` exponential backoff wraps step 4 + a split-out `compose pull` before `up -d`; default no-flag run unchanged. Auto-skip on plain re-run is opt-in via `--resume` to preserve the documented "re-run to reapply" workflow.)*
17. ✅ **v0.5.0** **Deeper pre-flight** *(moderate, medium)* — also check free space on the **Docker data-root** (`docker info -f '{{.DockerRootDir}}'`, often a different/smaller mount than INSTALL_DIR); a one-tiny-image registry pull dry-run to validate daemon egress; pull the hardlink EXDEV probe earlier. *(Shipped: `check_docker_dataroot_space` (DockerRootDir df vs 10 GiB) + `check_registry_egress` (pull hello-world, clean up if newly pulled) run right before the step-6 pull. The hardlink EXDEV probe already runs at step 5 — before the expensive pull — so it's kept there.)*
18. ✅ **v0.5.1** **Rootless Docker / Podman** *(hard, medium)* — if `docker` is absent, probe `podman` + its socket and set `DOCKER_HOST` so the official `docker compose` v2 binary drives Podman; detect rootless mode and warn about <1024-port binding + userns id-shifting. Partial groundwork shipped (`DOCKER_SOCK` override in v0.4.10). *(Shipped: detector probes podman presence/compose-frontend/socket/rootless; setup.sh selects docker→podman runtime, normalises DOCKER_SOCK→DOCKER_HOST, and a `CONTAINER_RUNTIME` var replaces every host-level `docker` call; Detect screen accepts Podman+compose as a runtime, auto-fills DOCKER_SOCK (root socket), and notes the rootless <1024 caveat.)*

### Phase 5 — testing & support
19. **Wire the DinD harness into CI** *(moderate, high)* — `test/run-e2e.sh` already runs the real payload against fake-NAS families but **CI never invokes it** (only typecheck/build/shellcheck/py_compile). Add a CI job: `run-e2e.sh --family {synology,ugreen,generic} --profile smoke` on pushes touching `nas/**`, plus assert family **classification** (run the env-detector probes in each fake-NAS, diff against expected `nasFamily`). Add an arm64 leg once #1 lands. Converts the harness from a manual tool into a regression gate.
20. ✅ **v0.5.1** **One-command diagnostics bundle** *(moderate, medium)* — `collect-diagnostics.sh` → one redacted tarball (probe output, `compose ps` + container log tails, `docker info`, arch/family/OS, **secret-masked** `.env`, free space on INSTALL_DIR + docker data-root, tun/iptables state, dmesg tail). Wire a "Download diagnostics" button into the Troubleshooting modal. Opt-in, no auto-upload. *(Shipped: runtime-aware (docker/podman) collector that secret-masks `.env` (case-insensitive, incl. cookies) AND scrubs API-keys/Bearer/Cookie/passwords from log tails; SFTP `downloadFile` (fastGet + base64 fallback) + native save dialog; `diag:collect` IPC handler runs it + fetches the bundle; Help-modal button gated on a live session.)*

---

## 3. Recommended sequencing

- **Sprint 1 (correctness)** — ✅ **shipped v0.4.11**: #1 arch/RAM probe, #2 CORE reject, #3 Unraid-FUSE, #4 uid-0-root, #11 unsupportable (via 32-bit block). Added `cpuArch`/`kernelOs`/`ramMB`/`familyConfidence` to `EnvDetectResult`; `wrapSudo` now skips `sudo` for effective-root (uid 0) sessions.
- **Sprint 2 (reach)** — ✅ **complete**: #7 Asustor, #8 TerraMaster, #9 ZimaOS families + #19 the DinD harness wired into CI (fast `e2e-detect` classification gate over all families via `test/classify.sh`, plus a manual `e2e-smoke` DinD payload run) shipped in **v0.4.12**; #5 FlareSolverr-optional/arm64 + #6 multi-arch pre-flight shipped in **v0.4.13**.
- **Sprint 3 (robustness)** — ✅ **complete**: #13 containerize python3 (host now needs only Docker — python3 demoted from REQUIRED) shipped **v0.4.14**; #12 privilege strategy (docker-group / doas / NOPASSWD) + #14 family-aware Docker remediation shipped **v0.4.15** (adversarially reviewed — 3 confirmed defects fixed: silent docker-group degradation → one-time warning, doas+password non-PTY hang → fail-fast guard, unclosed stdin → `stream.end()`).
- **Sprint 4 (resilience + ops):** ✅ **complete.** **v0.5.0** — #15 confidence/dmidecode + #16 resumability/retries + #17 deeper pre-flight (adversarially reviewed; 5 confirmed defects fixed: stale-ENV_FILE-after-migration, Python-hash quote injection, classify.sh parity, summary LAN_IP, frozen-hash-vs-NordVPN). **v0.5.1** — #18 Podman runtime + #20 diagnostics bundle (adversarially reviewed; 3 confirmed defects fixed: collect-diagnostics.sh Podman support, IPTORRENTS_COOKIE masking, Authorization/Bearer log scrubbing). #19 CI harness landed in Sprint 2.

**All five phases of the hardening plan are now shipped.**

The **DinD harness (#19)** should land early in Sprint 2 so every later platform change is regression-gated by a real install run.

---

## 4. Per-platform reference (SSH-level facts)

> Detection markers below are non-root SSH-readable unless noted. Always read the
> live `id`/paths over SSH rather than hardcoding uid/gid.

**QNAP QTS / QuTS hero** — marker `/etc/config/qpkg.conf` + `/share/CACHEDEV1_DATA` (hero adds `zpool`/`zfs`, firmware version prefixed `h`). Storage `/share/CACHEDEV<n>_DATA`, shares symlinked `/share/<name>`; INSTALL_DIR `/share/Container/mediarr`, DATA_ROOT `/share/Data`. Docker via Container Station 3 (`docker compose` v2); binary under `/share/.../.qpkg/container-station/bin` (already PATH-augmented). **`admin` IS the superuser (uid 0), NO sudo, root login off by default** → fix #4. No host firewall by default (QuFirewall optional). x86 + arm64 (some legacy armv7).

**TrueNAS SCALE (24.10+)** — marker `grep -qiE truenas\|freenas /etc/version` or `/etc/truenas_version` (os-release says `ID=debian` — do NOT use it). ZFS pools `/mnt/<pool>` (never assume `tank`; installer enumerates `/mnt/*`). Docker is native (off k3s as of 24.10) but iX's supported path is Apps→Custom App; host `docker compose up` is racy vs middleware. Apps run as `apps` uid/gid **568/568** (set dataset ACL preset "Apps"). No host-firewall UI. amd64-only.

**TrueNAS CORE** — `/etc/version` has `TrueNAS-13.x`; **`uname -s == FreeBSD`**. No Linux Docker (jails/plugins EOL post-FreeBSD-13.2). ⛔ hard-reject (#2).

**Unraid** — marker `/etc/unraid-version`. `/mnt/user` (FUSE merge) + `/mnt/disk*` + `/mnt/cache`; INSTALL_DIR `/mnt/user/appdata/mediarr` (or `/mnt/cache/appdata` for SQLite perf), DATA_ROOT `/mnt/user/data`. Docker built-in but **no `docker compose`** without the Compose Manager plugin. Single-superuser **root** (sudoMode=root). PUID/PGID **99/100** (nobody:users). **RAM-overlay rootfs** — only `/boot` + `/mnt/*` persist. No host firewall. amd64-only.

**OpenMediaVault** — marker `/etc/openmediavault/config.xml` or `dpkg -l openmediavault` (config.xml may be root-only — prefer dpkg / `/etc/default/openmediavault`). Disks under `/srv/dev-disk-by-*`, shares symlinked `/sharedfolders/<name>`; **don't default to bare `/srv`** — use a per-disk shared folder. Docker via OMV-Extras. PUID/PGID 1000/100. iptables (OMV firewall off by default; may flush our rules on Save&Apply). amd64 + arm64 (Pi).

**Asustor ADM** — marker `/volume0` (system vol) + `/etc/nas.conf`. Storage `/volume1/<share>`; INSTALL_DIR `/volume1/Docker/mediarr`. Docker via "Docker Engine" app under `/volume1/.@plugins/AppCentral/docker-ce/`. **Root SSH works (shares admin password)** → sudoMode=root. ADM Defender (not per-port firewall). x86 + arm64 (Realtek).

**TerraMaster TOS 6** — marker `/etc/tos` (hostname `TNAS-*`). Storage **`/Volume1` (capital)** + `/mnt/md0`; INSTALL_DIR `/Volume1/docker/media`. Docker via "Docker Manager" app (absent until installed). **Install user is uid 0, not named `root`** → fix #4. iptables (TOS firewall off by default). x86 + arm.

**ZimaOS** — composite marker: `/DATA` mount + **read-only root FS** + CasaOS stack (`/usr/bin/casaos`). Everything under `/DATA` (`/DATA/AppData/mediarr` + `/DATA/Media`) — root FS writes fail. Docker+compose pre-installed, root daemon, standard socket. **SSH off by default** (Developer Mode + set root password). amd64-only (UEFI).

**CasaOS (overlay)** — marker `/etc/casaos` / `/usr/bin/casaos` / `casaos.service` (underlying distro still debian/ubuntu/raspbian). Writable root → installs as `linux` today; `/DATA/AppData` is the native convention. amd64 + arm64 + armhf (Pi).

**Generic Linux (`linux` catch-all)** — confirm via os-release `ID`/`ID_LIKE`. Smoothness gaps: ufw-aware firewall (use `ufw allow` when active), docker.io-vs-docker-ce compose detection, **Proxmox unprivileged LXC**: `/dev/net/tun` absent (gluetun fails — same failure mode as DSM7 tun, already probed; add LXC remediation text via `systemd-detect-virt -c`), ZFS-pool data candidates, confirm DATA_ROOT instead of guessing.

**Arch / image support** — linuxserver.io stack = amd64 + arm64 (armhf DROPPED 2023-07-01). gluetun/unpackerr/homepage/recyclarr/python:alpine all arm64-clean (gluetun+unpackerr even armhf). **FlareSolverr = the arm64 blocker** (deprecated; Chromium crashes). Plex/Jellyfin arm64 = no HW transcode. 32-bit ARM = hard cliff (no images). RAM < ~2 GB = practical wall regardless of arch.
