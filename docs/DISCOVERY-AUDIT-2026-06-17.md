# Mediarr Installer — Whole-App Discovery Audit & Remediation Plan

_Generated 2026-06-17 from a multi-agent ultracode discovery pass over the whole app (installer + NAS payload). For review before any implementation work._

## How this was produced

- **20 parallel reviewers** swept the codebase — 16 subsystem reviewers (renderer flow/screens/components; main transport/detect/updater/secrets; payload bash setup/folders/vpn/validate; python arr-config/indexers/playlistsync) + 4 cross-cutting sweeps (cross-platform gaps, re-run/idempotency, compose+env coherence, unhappy-path dead-ends).
- Every finding was **adversarially verified** by an independent agent that re-read the cited code and defaulted to *refute* — hallucinated/stylistic noise was dropped.
- A synthesizer **deduplicated** across reviewers, grouped into themes, and ranked by leverage (impact × inverse effort).
- Result: **72 confirmed findings** → **46 remediations** in **9 themes** (severity: 6 high · 22 medium · 18 low; effort: 31 S · 15 M).

> Note: the first run was throttled by a server-side rate limit and only the indexers reviewer survived; this plan is the **completed** batched re-run plus those 5 carried-forward indexer findings. CI/.github workflows and the GitHub Wiki were out of scope.

## Executive summary

52 verified findings across the Mediarr Installer reduce to ~46 distinct remediations after deduplication, organized into 9 themes. The highest-leverage work is a cluster of cheap renderer/script fixes that resolve hard dead-ends and silent data-loss on the most-traveled paths: (1) the default fresh-install Configure dead-end (hidden qBit password field), (2) "Retry step N" leaving the install stuck in 'failed' after every step turns green, (3) stop-all.sh silently leaving AzuraCast + Playlist Sync running, and (4) an SSH-drop during the install prelude stranding the user on a raw-UUID error with no Reconnect. Two cross-cutting root causes dominate the long tail: AzuraCast/Playlist-Sync were bolted onto the stack later and were missed in three hardcoded service lists (stop-all, boot-orchestrator, and implicitly the firewall fallback), and credentials/config get silently clobbered or reverted across re-runs because preserve-gating, carry-forward lists, and the install marker were not kept in sync with later features (setup-folders re-chmod, SLSKD_API_KEY rotation, marker orphaned on relocation, download-client revert). Several findings are duplicates of one root cause (setup-folders recursive chmod appears twice; the AzuraCast-profile omission spans stop-all + boot-orchestrator) and were merged. Most findings are correctly low severity — defensible design tradeoffs, defense-in-depth, or cosmetic nits — and are deferred. Effort is overwhelmingly S/M; there is one genuinely false-promise data-safety bug (plex-upload delete-before-upload) and one updater non-atomic-swap bug worth M effort.

## Themes

| # | Theme | Sev | Findings |
|---|-------|-----|----------|
| 1 | Dead-ends & false-negative recovery on the install/update flow | 🟠 high | 7 |
| 2 | Silent credential & config loss / unwanted reverts across re-runs | 🟠 high | 8 |
| 3 | Late/heavy AzuraCast & Playlist-Sync wired into the stack but missed in shared lists | 🟠 high | 4 |
| 4 | Cross-platform boot resilience & detection gaps (DSM/TrueNAS/UGREEN/ZimaOS) | 🟠 high | 5 |
| 5 | Validation hard-fails on benign first-boot races (reds the whole install) | 🟠 high | 4 |
| 6 | Destructive auto-remediation on transient faults | 🟡 medium | 2 |
| 7 | Path/relocation data-safety & consent gaps | 🟡 medium | 5 |
| 8 | Validation/escaping edge cases & robustness hardening (mostly defense-in-depth) | 🟡 medium | 9 |
| 9 | Cosmetic, a11y, secret-permission & code-health nits | ⚪ low | 14 |

**1. Dead-ends & false-negative recovery on the install/update flow** — The most-common failure modes leave the user stuck with no working forward path or a misleading 'failed' state: the all-defaults Configure screen errors on a hidden qBit password; the prominent per-step Retry turns every step green but keeps the install 'failed'; an SSH drop in the upload/ACL/.env prelude shows a raw 'unknown sessionId' with no Reconnect; UpdateRunScreen has no resume/reconnect at all; and the Done hero+confetti over-promise while the footer says services aren't ready. These are recoverable in principle but the screen's own recommended action lands users in a contradictory dead-end on the single most-traveled routes.

**2. Silent credential & config loss / unwanted reverts across re-runs** — Re-running the wizard (an encouraged action) silently mutates or discards user state because preserve-gating and carry-forward lists were not kept in sync with later features: setup-folders re-chmods/re-chowns the whole multi-TB media + Plex tree every run (clobbering out-of-band perms, two duplicate findings); a relocation orphans the install marker so the next run reverts all arr/qBit UI edits; .env re-render blanks and rotates SLSKD_API_KEY; the download-client config reverts a deliberate UI change; toggling an IndexerCard off or editing the custom-indexer form after a parse error instantly and unrecoverably wipes entered secrets (with autosave flushing the loss to disk).

**3. Late/heavy AzuraCast & Playlist-Sync wired into the stack but missed in shared lists** — AzuraCast (radio) and Playlist Sync (playlists) were added after the core stack and were omitted from three places that hardcode the service set: stop-all.sh leaves both running on a 'Stop all' (high — a 2-4 GB-RAM container and bound LAN ports survive); boot-orchestrator.sh never restores radio to COMPOSE_PROFILES on reboot; the firewall no-.env fallback opens no opt-in ports while claiming to open all; and playlistsync crash-loops forever on a hand-edited .env because it lacks recyclarr-trigger's on-failure:5 cap.

**4. Cross-platform boot resilience & detection gaps (DSM/TrueNAS/UGREEN/ZimaOS)** — boot-orchestrator.sh never exports PATH, so on DSM (the only platform with an auto-installed rc.d hook) docker isn't found at boot and the entire ordered-boot/self-heal feature silently no-ops (high). TrueNAS SCALE and ZimaOS get a root-crontab hook that doesn't persist while reporting success; manual_hint and diagnose-firewall family classifiers omit the appliance families env-detector explicitly supports; and the detect-time port-conflict scan uses netstat-only with no ss fallback, so the early conflict warning never fires on net-tools-less NAS.

**5. Validation hard-fails on benign first-boot races (reds the whole install)** — post-deploy-validate.sh fails the entire install on conditions the same script elsewhere downgrades to warn: the Recyclarr-trigger check is a single no-retry 10s probe whose comment falsely claims a 30s budget (high — a still-booting tile reds the install on a slow apk mirror); a slow WireGuard handshake leaving gluetun 'unhealthy' hard-fails qBit with a wrong 'credentials may be wrong' message; and the indexer 0/N check warns despite a preamble promising a hard fail. A broken VPN can also pass validation entirely when qBit is disabled.

**6. Destructive auto-remediation on transient faults** — tune-arrs.sh permanently DISABLES a Prowlarr indexer on a single transient test failure (CloudFlare/rate-limit mid-challenge) with no re-test and no auto-re-enable, contradicting post-deploy-validate's warn-don't-touch stance for the identical probe — and it is marketed 'Safe to re-run any time'. plex-upload.py deletes the existing Plex playlist BEFORE uploading the new one, so any transient Plex hiccup destroys the user's playlist until the next daily run.

**7. Path/relocation data-safety & consent gaps** — Relocation is data-safe (source preserved) but the surrounding flow surprises users: a normal --from N run unconditionally runs the relocation pre-flight and can tear down a live stack the user asked to leave alone; an interrupted cross-fs copy dead-ends on resume with a generic 'destination not empty' that mis-frames the user's own partial copy; a cross-fs move has no free-space pre-flight so a too-small disk fails mid-rsync with the stack down; the Configure screen edits INSTALL_DIR/DATA_ROOT with no relocation warning (it exists only on Detect); and empty path fields pass validation then fall back to hardcoded /volume1 Synology paths on non-Synology NAS.

**8. Validation/escaping edge cases & robustness hardening (mostly defense-in-depth)** — A cluster of bounded correctness gaps: forceSave swallows credential-validation 400s and silently saves broken private trackers; auto-manual-import drops queue items past a hardcoded 500-item page; the ESCAPE<->env_val shell contract mismatch can silently clobber a single-quote SLSKD_API_KEY; an unknown VPN_PROVIDER silently renders a NordVPN .env; port fields accept out-of-range values; core arr GET reads have no retry; and the connect hard-timeout (20s) pre-empts the intended 30s SSH handshake budget.

**9. Cosmetic, a11y, secret-permission & code-health nits** — Low-impact polish: modal dialogs don't trap Tab focus (systemic a11y); profile-export and qBittorrent.conf are written world-readable (encrypted/hashed, so bounded); the passphrase meter can never show 'Very strong'; CustomIndexerEditor 'Apply JSON' silently no-ops on bad input; stale 'mode' leaks the wrong stepper onto Welcome; DoneScreen update is unguarded by busy; the updater orphans a ~200 MB temp zip and uses size+magic-only integrity; SiriusXM custom slugs aren't scrubbed; HAS_IPV6 is undocumented; and several wording/affordance mismatches ('paused' implying resume).

## Tier 1 — High severity (do first)

### R1. Fix the all-defaults Configure dead-end: reveal the qBit password field (or seed a default) when validation flags it
`🟠 high` · effort **S** · _Dead-ends & false-negative recovery on the install/update flow_

- **Impact:** Unblocks the single most-traveled path (fresh install, all defaults, click Continue). Today the user gets a blocking 'qBittorrent password: at least 8 characters' error with NO password field on screen (hidden behind the checked 'Use same credentials as ARR Web UI' box) and error text pointing at neither the checkbox nor the ARR password.
- **Files:** `installer/src/renderer/screens/ConfigureScreen.tsx`, `installer/src/shared/env-schema.ts`, `installer/src/renderer/store/wizard.ts`
- **Fix:** In ConfigureScreen.go(), when the parse fails with an issue path of QBITTORRENT_USER or QBITTORRENT_PASS, also call setQbitSameAsArr(false) alongside expanding the groups so the flagged qBit user/pass fields (gated by !qbitSameAsArr at ConfigureScreen.tsx:1178) actually render on the same Continue click. Additionally make the error message actionable ('fill an ARR password in Advanced or uncheck Use same credentials as ARR Web UI'). Best: also seed a usable QBITTORRENT_PASS default in wizard.ts so the all-defaults path validates without forcing the user to invent one.
- **Why this rank:** go() currently only expands groups (setOpenGroups) and its adjacent comment claims that makes 'every flagged input reachable' — false for a field gated behind the checkbox. Highest leverage: small, localized renderer change on the most common route, converting a hard-feeling stuck state into a self-evident next action.

### R2. Make a successful per-step 'Retry step N' promote the install to 'done' instead of leaving it stuck in 'failed'
`🟠 high` · effort **S** · _Dead-ends & false-negative recovery on the install/update flow_

- **Impact:** The most common failure is a single transient step. The prominent 'Retry step N' button is built for exactly this, but after every step turns green the screen still says 'Something needs attention', the bar stays red, the footer says 'Install paused — tap Retry', and Continue stays disabled. The intended happy path is a false-negative dead-end; the only escape is a wasteful full --resume run.
- **Files:** `installer/src/renderer/screens/RunScreen.tsx`
- **Fix:** In the RERUN_CHANNEL_PREFIX branch of onStreamClose (~RunScreen.tsx:442-453), after updating the step's status build the freshly-updated steps array and, if d.exitCode===0 and no step remains 'fail' or 'running', setPhase('done') and clear droppedConnection/errorMsg (mirroring the main-channel exitCode===0 cleanup at ~430-439, e.g. consuming the Plex claim). Compute over the new array, not the pre-update closure value. This single fix also covers the StepperRail hover-rerun since both share rerunStep/the same close handler.
- **Why this rank:** phase is set to 'done' ONLY by the main channel's close handler (line 395); the per-step rerun handler never re-evaluates phase. Tiny, targeted change that rescues the screen's own recommended recovery action on the highest-frequency failure mode.

### R3. Add `radio` and `playlists` to stop-all.sh so 'Stop all' actually stops AzuraCast and Playlist Sync
`🟠 high` · effort **S** · _Late/heavy AzuraCast & Playlist-Sync wired into the stack but missed in shared lists_

- **Impact:** A user who enabled AzuraCast (a deliberately heavy ~1.4 GB image, 2-4 GB RAM floor) and/or Playlist Sync clicks the wizard's 'Stop all' (TroubleshootingModal.tsx:416) expecting the whole stack down, but both keep running — holding RAM and bound LAN ports (49157, 8000-8029) — and the leftover AzuraCast container can then interfere with a cross-disk relocation that assumes the stack is down.
- **Files:** `nas\scripts\stop-all.sh`, `installer\src\renderer\components\TroubleshootingModal.tsx`
- **Fix:** Add `radio` and `playlists` to the PROFILES array at stop-all.sh:102 (alongside `soulseek`), matching setup.sh's stop_disabled_services (684-685) and COMPOSE_PROFILES builder (489/501). Also append `azuracast playlistsync` to the post-down leftover safety-check container list at stop-all.sh:139-140 (it already lists slskd/soularr for exactly this reason). Compose v2 `down` only acts on named profiles and --remove-orphans never treats defined-but-inactive services as orphans, so the two-line list addition is the actual fix.
- **Why this rank:** Confirmed: PROFILES at line 102 lacks radio/playlists; both are real defined services (profiles ['radio'] / ['playlists']) added later. A stop-everything safety action silently breaking its core promise on heavy services is high-impact and the fix is a one-line array edit.

### R4. Recover SSH drops during the install prelude (prep/ACL/SFTP/.env) instead of stranding the user on 'unknown sessionId'
`🟠 high` · effort **M** · _Dead-ends & false-negative recovery on the install/update flow_

- **Impact:** A Wi-Fi blip or NAS sleep during the first ~30-90s (upload + ACL + chown, itself minutes on a large Plex config) leaves the user clicking Retry and getting the developer-facing 'unknown sessionId <uuid>'. The working 'Reconnect & resume' affordance that exists for the same drop during streamSetup is unreachable here; effectively an app-restart dead-end for a common transient failure.
- **Files:** `installer/src/renderer/screens/RunScreen.tsx`, `installer/src/main/ssh-service.ts`, `installer/src/renderer/store/wizard.ts`, `installer/src/shared/ipc.ts`
- **Fix:** Preferred: add a session-lost IPC event emitted from ssh-service.ts's client 'error'/'close' handler (~267) and have RunScreen clear the renderer sessionId on receipt, so go()'s existing `if (!sessionId)` guard fires its friendly 'No SSH session. Go back and reconnect.' message. Minimal alternative: in go()'s prelude catch (~981-985), detect a drop signature on the rejected error (account for Electron's 'Error invoking remote method' wrapping, e.g. /unknown sessionId|not connected|ECONNRESET|channel .*closed/) and set droppedConnection=true so the existing reconnectAndResume() button (mints a fresh session, runs setup.sh --resume) is offered.
- **Why this rank:** main silently sessions.delete(sessionId) on drop and never tells the renderer; droppedConnection is set only in the CHANNEL_ID stream-close handler, which never runs during the prelude (streamSetup is the last step of go()). Higher effort than the rank-1/2 fixes (touches main+renderer+IPC) but rescues a common transient failure on the core path.

### R11. Export PATH (full Synology/QNAP set) in boot-orchestrator.sh so the ordered-boot feature works on DSM
`🟠 high` · effort **S** · _Cross-platform boot resilience & detection gaps (DSM/TrueNAS/UGREEN/ZimaOS)_

- **Impact:** On DSM (the primary platform and the only one with an auto-installed rc.d boot hook) `command -v docker` returns false at boot in the stripped rc.d/cron PATH, so RT stays 'docker', `docker info` fails for the full 5-minute deadline, and the entire ordered-boot/self-heal feature silently no-ops. qBit then hits the 'must join at least one network' + multi-minute restart-backoff wedge — exactly what the orchestrator exists to prevent.
- **Files:** `nas\scripts\boot-orchestrator.sh`, `nas\scripts\install-boot-resilience.sh`
- **Fix:** Add a PATH export near the top of boot-orchestrator.sh using the FULL set the codebase already standardizes on (synology-path.ts / env-detector.ts), NOT just the guardian's shorter /usr/local/bin line — on modern DSM 7 docker lives under /var/packages/ContainerManager/target/usr/bin: `export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/var/packages/ContainerManager/target/usr/bin:/var/packages/Docker/target/usr/bin:/share/CACHEDEV1_DATA/.qpkg/container-station/bin:/share/.qpkg/container-station/bin:${PATH:-}"`. Optionally add an absolute-path docker/podman fallback if command -v still misses.
- **Why this rank:** The sibling qbit-guardian.sh:29-30 already carries this fix verbatim with the exact comment, proving the project knows the problem and omitted it only here. High (not critical) because restart: unless-stopped still brings the stack back in arbitrary order and the guardian recovers the wedge in ~5 min — degraded, not an outage. One-line export.

### R14. Use check_url_lenient for the Recyclarr-trigger post-deploy probe (and fix the false '30s retry budget' comment)
`🟠 high` · effort **S** · _Validation hard-fails on benign first-boot races (reds the whole install)_

- **Impact:** ENABLE_RECYCLARR is default-on. The recyclarr-trigger container binds port 8889 only AFTER `apk add docker-cli` at boot; on a slow/contended package mirror the single no-retry 10s check_url probe returns HTTP 000 and HARD-fails, which exits post-deploy-validate 1, makes the whole install exit 1, and shows the user a red DoneScreen instead of confetti — for a purely cosmetic web tile that is still booting.
- **Files:** `nas/scripts/post-deploy-validate.sh`, `nas/scripts/docker-compose.yml`
- **Fix:** At post-deploy-validate.sh:414 replace check_url with check_url_lenient for the Recyclarr trigger (it's a non-critical late-binding tile like Seerr/AzuraCast, which already use lenient), passing a hint like 'Recyclarr trigger apk-installs docker-cli at first boot — wait a minute and re-run.' Correct the false comment at 411-413 that claims a non-existent 30s retry budget. (Alternatively give check_url a real curl --retry, but lenient is the right classification here.)
- **Why this rank:** check_url is a single curl --max-time 10 with no retry; the gating comment's claimed budget does not exist. The author already applies check_url_lenient to other still-booting tiles, so this is a one-line consistency fix that stops a default-config install from going red on environmental apk latency.

## Quick wins (cheap + high value)

- Reveal the hidden qBit password field when validation flags it (rank 1) — one renderer change unblocks the most common fresh-install path.
- Promote a successful 'Retry step N' to 'done' (rank 2) — tiny onStreamClose change rescues the screen's own recommended recovery on the most common failure.
- Add radio+playlists to stop-all.sh's PROFILES + leftover check (rank 3) — two-line array edit fixes a high-impact broken 'Stop all'.
- Export the full Synology/QNAP PATH in boot-orchestrator.sh (rank 11) — one-line export the sibling guardian already carries; makes ordered-boot actually work on DSM.
- Switch the Recyclarr-trigger post-deploy probe to check_url_lenient + fix the false 30s-budget comment (rank 14) — one-line consistency fix stops a default install going red on apk latency.
- Gate the Done hero+confetti on warnCount===0 (rank 5) — cheap honesty fix so the celebration stops contradicting the footer.
- Copy the install marker on relocation (rank 7) — one-line cp stops the next run reverting all arr/qBit customizations.
- Add SLSKD_API_KEY to the RunScreen carry-forward array (rank 8) — one string stops a secret rotating on every reconfigure.
- Add a radio case-branch to boot-orchestrator.sh COMPOSE_PROFILES (rank 12) — restores an opted-in AzuraCast on reboot.
- Change playlistsync to restart: on-failure:5 (rank 13) — one-word compose change matching the project's own recyclarr-trigger standard, ends a crash-loop.
- Derive the SSH connect hard-timeout as readyTimeout+10s (rank 20) — trivial constant fix restores the intended 30s handshake budget.
- Reorder plex-upload.py to upload-then-prune (rank 17) — cheap reorder closes a playlist-loss window.

## All remediations (by theme)

### Dead-ends & false-negative recovery on the install/update flow

| Rank | Sev | Eff | Remediation | Files |
|------|-----|-----|-------------|-------|
| R1 | high | S | Fix the all-defaults Configure dead-end: reveal the qBit password field (or seed a default) when validation flags it | `ConfigureScreen.tsx`, `env-schema.ts`, `wizard.ts` |
| R2 | high | S | Make a successful per-step 'Retry step N' promote the install to 'done' instead of leaving it stuck in 'failed' | `RunScreen.tsx` |
| R4 | high | M | Recover SSH drops during the install prelude (prep/ACL/SFTP/.env) instead of stranding the user on 'unknown sessionId' | `RunScreen.tsx`, `ssh-service.ts`, `wizard.ts`, `ipc.ts` |
| R5 | medium | S | Gate the celebratory Done hero + confetti on warnCount===0 so it stops contradicting its own 'not ready yet' footer | `DoneScreen.tsx`, `post-deploy-validate.sh` |
| R29 | medium | M | Add a TERM->KILL escalation + orderly cancel so a swallowed Cancel doesn't show a false 'failed' while the NAS keeps converging | `RunScreen.tsx`, `ssh-service.ts`, `setup.sh` |
| R30 | medium | M | Port resume/reconnect plumbing into UpdateRunScreen so a transient failure isn't a full-replay dead-end | `UpdateRunScreen.tsx` |

<details><summary><b>R1. Fix the all-defaults Configure dead-end: reveal the qBit password field (or seed a default) when validation flags it</b> — 🟠 high · S</summary>

- **Impact:** Unblocks the single most-traveled path (fresh install, all defaults, click Continue). Today the user gets a blocking 'qBittorrent password: at least 8 characters' error with NO password field on screen (hidden behind the checked 'Use same credentials as ARR Web UI' box) and error text pointing at neither the checkbox nor the ARR password.
- **Files:** `installer/src/renderer/screens/ConfigureScreen.tsx`, `installer/src/shared/env-schema.ts`, `installer/src/renderer/store/wizard.ts`
- **Recommendation:** In ConfigureScreen.go(), when the parse fails with an issue path of QBITTORRENT_USER or QBITTORRENT_PASS, also call setQbitSameAsArr(false) alongside expanding the groups so the flagged qBit user/pass fields (gated by !qbitSameAsArr at ConfigureScreen.tsx:1178) actually render on the same Continue click. Additionally make the error message actionable ('fill an ARR password in Advanced or uncheck Use same credentials as ARR Web UI'). Best: also seed a usable QBITTORRENT_PASS default in wizard.ts so the all-defaults path validates without forcing the user to invent one.
- **Rationale:** go() currently only expands groups (setOpenGroups) and its adjacent comment claims that makes 'every flagged input reachable' — false for a field gated behind the checkbox. Highest leverage: small, localized renderer change on the most common route, converting a hard-feeling stuck state into a self-evident next action.

</details>

<details><summary><b>R2. Make a successful per-step 'Retry step N' promote the install to 'done' instead of leaving it stuck in 'failed'</b> — 🟠 high · S</summary>

- **Impact:** The most common failure is a single transient step. The prominent 'Retry step N' button is built for exactly this, but after every step turns green the screen still says 'Something needs attention', the bar stays red, the footer says 'Install paused — tap Retry', and Continue stays disabled. The intended happy path is a false-negative dead-end; the only escape is a wasteful full --resume run.
- **Files:** `installer/src/renderer/screens/RunScreen.tsx`
- **Recommendation:** In the RERUN_CHANNEL_PREFIX branch of onStreamClose (~RunScreen.tsx:442-453), after updating the step's status build the freshly-updated steps array and, if d.exitCode===0 and no step remains 'fail' or 'running', setPhase('done') and clear droppedConnection/errorMsg (mirroring the main-channel exitCode===0 cleanup at ~430-439, e.g. consuming the Plex claim). Compute over the new array, not the pre-update closure value. This single fix also covers the StepperRail hover-rerun since both share rerunStep/the same close handler.
- **Rationale:** phase is set to 'done' ONLY by the main channel's close handler (line 395); the per-step rerun handler never re-evaluates phase. Tiny, targeted change that rescues the screen's own recommended recovery action on the highest-frequency failure mode.

</details>

<details><summary><b>R4. Recover SSH drops during the install prelude (prep/ACL/SFTP/.env) instead of stranding the user on 'unknown sessionId'</b> — 🟠 high · M</summary>

- **Impact:** A Wi-Fi blip or NAS sleep during the first ~30-90s (upload + ACL + chown, itself minutes on a large Plex config) leaves the user clicking Retry and getting the developer-facing 'unknown sessionId <uuid>'. The working 'Reconnect & resume' affordance that exists for the same drop during streamSetup is unreachable here; effectively an app-restart dead-end for a common transient failure.
- **Files:** `installer/src/renderer/screens/RunScreen.tsx`, `installer/src/main/ssh-service.ts`, `installer/src/renderer/store/wizard.ts`, `installer/src/shared/ipc.ts`
- **Recommendation:** Preferred: add a session-lost IPC event emitted from ssh-service.ts's client 'error'/'close' handler (~267) and have RunScreen clear the renderer sessionId on receipt, so go()'s existing `if (!sessionId)` guard fires its friendly 'No SSH session. Go back and reconnect.' message. Minimal alternative: in go()'s prelude catch (~981-985), detect a drop signature on the rejected error (account for Electron's 'Error invoking remote method' wrapping, e.g. /unknown sessionId|not connected|ECONNRESET|channel .*closed/) and set droppedConnection=true so the existing reconnectAndResume() button (mints a fresh session, runs setup.sh --resume) is offered.
- **Rationale:** main silently sessions.delete(sessionId) on drop and never tells the renderer; droppedConnection is set only in the CHANNEL_ID stream-close handler, which never runs during the prelude (streamSetup is the last step of go()). Higher effort than the rank-1/2 fixes (touches main+renderer+IPC) but rescues a common transient failure on the core path.

</details>

<details><summary><b>R5. Gate the celebratory Done hero + confetti on warnCount===0 so it stops contradicting its own 'not ready yet' footer</b> — 🟡 medium · S</summary>

- **Impact:** On a typical first install (Seerr is default-on and doesn't bind its port until the user finishes its first-run wizard), warnCount>0 is the NORMAL end state, so the validator exits 0 and DoneScreen shows the full 'You did it! Your media stack is live. Click any service to open it' hero + confetti while the footer simultaneously says '{warnCount} not ready yet'. Users click a green-celebrated tile, get connection-refused, and distrust the wizard.
- **Files:** `installer/src/renderer/screens/DoneScreen.tsx`, `nas/scripts/post-deploy-validate.sh`
- **Recommendation:** Gate the hero and confetti on installSucceeded && warnCount===0. When exit===0 but warnCount>0, render a softer headline ('Almost there — {warnCount} service(s) still warming up') minus the 'click any service to open it' over-promise, and add a `warnCount===0` guard to the firedConfettiRef effect (~244-267). Reuse the footer's existing three-way all-clear/not-ready/failed partition (559-581) for the hero so the two regions can no longer disagree. No validator change needed.
- **Rationale:** installSucceeded = (exit===0) at line 199; the hero/confetti branch only on installSucceeded and never consult warnCount. Cheap honesty fix that directly undercuts the documented honesty work already done on the footer.

</details>

<details><summary><b>R29. Add a TERM->KILL escalation + orderly cancel so a swallowed Cancel doesn't show a false 'failed' while the NAS keeps converging</b> — 🟡 medium · M</summary>

- **Impact:** If the user clicks Cancel during a long compose up/image pull and the remote process tree ignores the first TERM, the wizard force-flips to red 'failed' after 15s (and unlocks the rail) while setup.sh keeps running on the NAS. A follow-up Retry can launch a SECOND setup.sh that races the live first one (the .setup.lock catches it, so no corruption, but a confusing lock-conflict on top of a 'failed' that wasn't). A stale old stream's late close can also clobber a new run's phase/log.
- **Files:** `installer/src/renderer/screens/RunScreen.tsx`, `installer/src/main/ssh-service.ts`, `nas/scripts/setup.sh`
- **Recommendation:** (1) ssh-service.ts streamCancel: do NOT delete the channel on TERM — keep the handle and after ~8s with no 'close' escalate to ch.signal('KILL')+close(); reject (or TERM+await-close) a second execStream for a channelId already in activeChannels so a second setup-sh-main can't launch over a live one. (2) setup.sh: trap INT/TERM to run `compose stop`/down for its own project so a cancel tears the stack down in order and releases the lock cleanly. (3) RunScreen: on the 15s net for a swallowed cancel, set droppedConnection/resume affordance and label it 'Stop signal sent — the NAS may still be finishing; use Reconnect & resume' rather than flat 'Install paused / Retry'; give each run a generation token and ignore stream events whose token doesn't match so a stale close can't clobber a new run.
- **Rationale:** Two verified findings (the cancel-timeout rail-unlock race and the swallowed-cancel misleading 'failed') share the streamCancel/15s-net mechanism and the missing active-channel guard; bundled. Narrow precondition (a Cancel the remote ignores >15s) and the .setup.lock prevents corruption — medium; touches main+renderer+script so M effort.

</details>

<details><summary><b>R30. Port resume/reconnect plumbing into UpdateRunScreen so a transient failure isn't a full-replay dead-end</b> — 🟡 medium · M</summary>

- **Impact:** A user updating an existing stack (the screen explicitly marketed as 'the recommended way to pick up a new wizard release') who hits a transient step failure or a connection blip gets a terminal 'paused — see log' with no in-place resume and no reconnect — they must restart the whole end-to-end setup.sh run (re-pull, re-validate, re-configure) or, on a drop, restart the app.
- **Files:** `installer/src/renderer/screens/UpdateRunScreen.tsx`
- **Recommendation:** Port RunScreen's recovery into updateStack(): (1) in onStreamClose (101-105) detect a dropped connection (d.exitCode===null) and set a droppedConnection flag instead of treating it as a step failure; (2) add reconnectAndResume() that re-establishes SSH and re-invokes setup.sh --resume (valid because Update never rewrites .env, so the .setup-state env_hash still matches); (3) for a normal red-step failure add an in-place setup.sh --resume rather than a from-scratch syncPayload()+setup.sh; (4) surface 'Reconnect & resume' / 'Resume' in the footer when droppedConnection/failed. The short pull/sync/rerun actions don't need full resume, but the end-to-end updateStack() path warrants at least the reconnect affordance.
- **Rationale:** UpdateRunScreen's close handler has no null-exit/drop detection (vs RunScreen.tsx:393) and no --resume; updateStack re-runs syncPayload+full setup.sh from scratch. setup.sh is idempotent so a re-click is wasteful not destructive, and this is the secondary maintenance path — medium.

</details>

### Silent credential & config loss / unwanted reverts across re-runs

| Rank | Sev | Eff | Remediation | Files |
|------|-----|-----|-------------|-------|
| R6 | medium | M | Replace the blanket recursive chmod/chown in setup-folders.sh so re-runs don't rewrite the whole media + Plex tree (MERGED: two findings) | `setup-folders.sh` |
| R7 | medium | S | Relocate the install marker on an INSTALL_DIR change so the next run doesn't revert every arr/qBit UI customization | `relocate-stack.sh`, `setup-arr-config.py` |
| R8 | low | S | Carry SLSKD_API_KEY forward on .env re-render so it isn't blanked and rotated every re-run | `RunScreen.tsx`, `env-render.ts`, `setup.sh` |
| R9 | medium | S | Confirm before clearing entered credentials when an IndexerCard is toggled off (and stop autosave flushing the loss) | `IndexerCard.tsx`, `useProfileAutosave.ts` |
| R10 | medium | M | Guard CustomIndexerEditor against destroying recoverable malformed JSON on form edits, and surface Apply errors (MERGED: two findings) | `CustomIndexerEditor.tsx`, `useProfileAutosave.ts` |
| R26 | medium | M | Surface a real failure cause to the UI when the post-quit updater robocopy fails, instead of a silent re-offer loop | `updater-service.ts`, `UpdateOverlay.tsx` |
| R37 | low | S | Skip re-pushing a user-set download-client category under REINSTALL_PRESERVE (or document the asymmetry) | `setup-arr-config.py` |
| R38 | low | S | Block the install marker on a thrown qBittorrent seeding/TMM setPreferences so defaults aren't suppressed forever | `setup-arr-config.py` |

<details><summary><b>R6. Replace the blanket recursive chmod/chown in setup-folders.sh so re-runs don't rewrite the whole media + Plex tree (MERGED: two findings)</b> — 🟡 medium · M</summary>

- **Impact:** Re-running the wizard (encouraged, e.g. to toggle one service) runs `chown -R`/`chmod -R 775` over the user's multi-TB library every pass: it sets the execute bit on every .mkv/.mp4, forces group-write onto files the user may have locked down, strips group-write from Plex's SQLite/cache (755), clobbers any out-of-band ownership a peer app set, and is an O(inodes) walk with no progress output. The script header even falsely claims existing folders are skipped.
- **Files:** `nas/scripts/setup-folders.sh`
- **Recommendation:** Move the `chown -R`/`chmod -R` calls INSIDE the `if [ ! -d "$dir" ]` create branch (both CONFIG_DIRS loop at 137-146 and DATA_DIRS loop at 150-163) so they run only on dirs this script just created; for the already-exists branch, apply ownership/mode to the directory NODE non-recursively. Separate dir vs file modes to drop the execute bit on plain files — `find -type d -exec chmod 775` / `find -type f -exec chmod 664`, or `chmod -R ug+rwX,o+rX` using capital X (the correct idiom the script itself already uses at line 350). Apply the same gating to the Synology synoacltool -enforce-inherit (318) and setfacl -R (330-331). Reserve any full recursive sweep for an explicit opt-in (MEDIARR_FIX_PERMS=1). Fix the misleading header comment.
- **Rationale:** Two verified findings ('setup-folders.sh recursively re-chmods/re-chowns the entire media + Plex config tree on EVERY re-run' and 'setup-folders.sh runs recursive chown -R / chmod -R over the entire media + downloads tree on every invocation') are the same root cause at lines 137-163 with the same fix; merged. Medium because the common case re-applies the same owner/modes (perm-clobber only bites deliberately-divergent perms) but the wasted-I/O and execute-bit defects are universal.

</details>

<details><summary><b>R7. Relocate the install marker on an INSTALL_DIR change so the next run doesn't revert every arr/qBit UI customization</b> — 🟡 medium · S</summary>

- **Impact:** Path relocation is a shipped feature (installer-v0.15.0). After it runs, the very next setup-arr-config.py pass sees REINSTALL_PRESERVE=False (the marker stayed at the old root) and re-applies wizard defaults over user UI edits: configure_auth, media-management (hardlinks/permissions/recycleBin/autoUnmonitor), backup schedule, Plex prefs, and qBittorrent seeding/ratio/queue/rate. The user moved their install dir and silently lost all their Sonarr/Radarr/Lidarr/qBit customizations — the exact symptom the marker machinery was built to prevent.
- **Files:** `nas/scripts/relocate-stack.sh`, `nas/scripts/setup-arr-config.py`
- **Recommendation:** In relocate-stack.sh, after the SERVICE_DIRS move loop (~137) and before teardown, copy the top-level marker into the new root unconditionally (it's a tiny one-line file, no cross-fs concern): `[ -f "$OLD_INSTALL/.wizard-stack-installed" ] && { mkdir -p "$NEW_INSTALL"; cp -p "$OLD_INSTALL/.wizard-stack-installed" "$NEW_INSTALL/.wizard-stack-installed" 2>/dev/null; }`. Add a regression test asserting is_reinstall(NEW_INSTALL) is True after a simulated relocation.
- **Rationale:** _stack_marker_path() returns INSTALL_DIR root (setup-arr-config.py:126-130) and is_reinstall reads it from B=INSTALL_DIR, but relocate-stack.sh's add_pair only moves per-service subtrees (SERVICE_DIRS) — the top-level marker provably stays at the old root. setup.sh runs relocate then setup-arr-config in the same invocation, so the revert fires on the relocation run itself. Settings-only + narrow + self-healing on subsequent runs = medium; cheap one-line cp fix.

</details>

<details><summary><b>R8. Carry SLSKD_API_KEY forward on .env re-render so it isn't blanked and rotated every re-run</b> — ⚪ low · S</summary>

- **Impact:** Every full re-install/reconfigure overwrites the on-NAS SLSKD_API_KEY with an empty line; setup.sh regenerates a fresh key and setup-arr-config.py rewrites soularr's config.ini + restarts containers to match. It self-heals but the internal slskd<->soularr secret rotates each run, causing extra container restarts, churn, and a brief mismatch window.
- **Files:** `installer/src/renderer/screens/RunScreen.tsx`, `installer/src/shared/env-render.ts`, `nas/scripts/setup.sh`
- **Recommendation:** Add 'SLSKD_API_KEY' to the RunScreen.tsx DISCOVERED carry-forward array (~935-938). It already uses a fill-if-blank-from-existing pattern for the 7 arr keys, so a key present on the NAS is preserved across the re-render instead of blanked. Optionally also carry MONITORED_DISK_N to avoid benign widget re-detection churn.
- **Rationale:** renderEnv emits SLSKD_API_KEY only from wizard config (which never holds the NAS-minted key), and the carry-forward list covers only arr keys, so the blank line is written back verbatim. Only triggers on a full reconfigure with opt-in ENABLE_SOULSEEK on, fully self-heals — low — but the one-string fix removes real restart churn and a secret-mismatch window.

</details>

<details><summary><b>R9. Confirm before clearing entered credentials when an IndexerCard is toggled off (and stop autosave flushing the loss)</b> — 🟡 medium · S</summary>

- **Impact:** A misclick on the toggle of an indexer the user just filled in (private-tracker passkey, usenet API key) silently builds patch[f.key]=undefined for every field and calls onChange immediately — the secrets are gone from the UI, and useProfileAutosave debounces ~600ms and removes them from the on-disk profile too. No confirm, no undo.
- **Files:** `installer/src/renderer/components/IndexerCard.tsx`, `installer/src/renderer/hooks/useProfileAutosave.ts`
- **Recommendation:** Stop mutating config on collapse. Preferred: keep field values in config when the card is toggled off and gate them out of the rendered .env based on the card's enabled state (env-render already decides what to emit), making collapse purely visual and lossless. If the .env contract requires absent keys, before clearing require a window.confirm only when at least one credential field is non-empty (def.fields.some(f => values[f.key])), or stash the cleared patch and offer a one-step Undo toast. Any in-memory undo must beat the 600ms autosave or also restore the profile blob.
- **Rationale:** toggle() at IndexerCard.tsx:67-77 clears all fields with no confirm/undo, and the loss propagates to disk via autosave. Silent, unrecoverable, targets secrets — medium; small localized fix on a primary control.

</details>

<details><summary><b>R10. Guard CustomIndexerEditor against destroying recoverable malformed JSON on form edits, and surface Apply errors (MERGED: two findings)</b> — 🟡 medium · M</summary>

- **Impact:** Two defects in the same component: (a) 'Apply JSON' silently discards malformed/non-array input with zero feedback — no banner, border, or aria-invalid — despite a label saying 'bad JSON is rejected' and a comment promising an 'invalid border' that does not exist; (b) a user with a hand-edited/corrupted CUSTOM_INDEXERS_JSON who clicks the always-on 'Add custom indexer' before fixing the text has parseCustomIndexers return items:[], so the add re-serializes to empty and overwrites the original blob — flushed to disk by autosave with no undo.
- **Files:** `installer/src/renderer/components/CustomIndexerEditor.tsx`, `installer/src/renderer/hooks/useProfileAutosave.ts`
- **Recommendation:** For (a): add a draft-parse-error state set in commitAdvancedDraft's non-array branch and catch, render it under the textarea reusing the rose alert block (221-239), drive aria-invalid + rose border off it (mirroring the urlErr pattern at 287-294), and clear it on success/Revert/onChange. For (b): when parseError is non-null, disable the 'Add custom indexer' button and gate commit()/addEmpty() so they refuse to overwrite while a parse error is present — keep the explicit 'Reset to empty' as the only sanctioned clear; or route addEmpty through the raw editor so the user starts from their original text.
- **Rationale:** Both findings target CustomIndexerEditor.tsx (commitAdvancedDraft 184-197; addEmpty 170) and share the 'malformed blob is never re-read' root cause; the feedback fix and the overwrite-guard are complementary and naturally land together. Confined to the advanced power-user path — medium.

</details>

<details><summary><b>R26. Surface a real failure cause to the UI when the post-quit updater robocopy fails, instead of a silent re-offer loop</b> — 🟡 medium · M</summary>

- **Impact:** Two related updater defects: (a) a robocopy that fails partway (AV/Search-indexer file lock on a ~200 MB build, disk-full, permission/ACL) leaves installDir a half-old/half-new mix and relaunches it, because the in-place copy isn't atomic and there's no backup; (b) the post-quit failure surfaces nothing to the UI — the relaunched OLD app simply re-detects the same release and re-offers it, so the user loops download+extract+fail with the only cause buried in a %TEMP% log they don't know exists.
- **Files:** `installer/src/main/updater-service.ts`, `installer/src/renderer/components/UpdateOverlay.tsx`
- **Recommendation:** Make the swap atomic: extract/robocopy into a sibling temp dir, then `move installDir installDir.bak` and `move tempNew installDir`, restoring from .bak on any failure before relaunch; delete .bak only after a clean swap. For the silent loop: pass a userData path into writeSwapScript and have the rc>=8 branch write a sentinel (e.g. userData\update-failed.txt with the robocopy rc); in initUpdater read+delete it before scheduling checkForUpdates and, if present, broadcast a clear 'last update couldn't replace program files (code N) — close other apps/AV and try again, or update manually from <htmlUrl>' instead of re-offering the same version. Clear the sentinel on a successful boot of the new version.
- **Rationale:** updater-service.ts:752 robocopy /E copies in place (no purge protects only deletions, not overwrites); the spawn-failure path is handled but the post-exit copy failure has no channel back to the UI. The at-risk artifact is the re-downloadable installer binary (not NAS/user data) and /R:5 mitigates transient locks — medium. Two verified findings (non-atomic swap; silent re-offer loop) share the updater swap path and are bundled.

</details>

<details><summary><b>R37. Skip re-pushing a user-set download-client category under REINSTALL_PRESERVE (or document the asymmetry)</b> — ⚪ low · S</summary>

- **Impact:** If a user re-points the qBittorrent/SABnzbd download client in the arr UI (e.g. changes the category from 'radarr' to something custom, or the port), the next setup.sh re-run detects the diff and rewrites the client back to wizard values, also re-pushing the .env password/apiKey. The category is the one field with no .env source that a user can deliberately set, so a deliberate UI tweak is silently reverted.
- **Files:** `nas/scripts/setup-arr-config.py`
- **Recommendation:** Keep host/port/useSsl always-reapplied (they must follow VPN on/off and .env edits), but under REINSTALL_PRESERVE skip re-pushing `category` when the existing client already has a non-wizard category value. Secrets already only get re-written when another field drifts (the intended .env-rotation path), so they need no change. If even that is more than warranted, add a one-line comment in add_download_client noting the deliberate asymmetry — download-client connections are wizard-owned/stack-essential and intentionally NOT preserve-gated (mirroring indexer connections per the lines 99-106 design note).
- **Rationale:** add_download_client (851-913) has no REINSTALL_PRESERVE gate (unlike configure_auth/media-management/backup). Largely consistent with the documented stack-essential design and config-revert-not-data-loss — low; the category-only gate or a comment is small.

</details>

<details><summary><b>R38. Block the install marker on a thrown qBittorrent seeding/TMM setPreferences so defaults aren't suppressed forever</b> — ⚪ low · S</summary>

- **Impact:** A transient failure on the single seeding/TMM defaults POST (after qBit auth already succeeded) only warns, so the install marker is still written and on subsequent runs REINSTALL_PRESERVE gates out the user_preference block — permanently skipping the seeding/queue/rate-cap defaults. Stack-essential TMM relocate-triggers live in stack_essential and are re-applied every run, so Completed Download Handling still works; only cosmetic seeding defaults are lost.
- **Files:** `nas/scripts/setup-arr-config.py`
- **Recommendation:** In the except at line 3085, after the warn(), add a note_unreachable() call (mirroring the login-failure 2900 and slow-boot 2941 branches) so the marker is blocked and the next run re-treats qBit as fresh and re-applies the defaults, without flipping the install red (exit stays governed by errors). Alternatively retry the POST once before warning.
- **Rationale:** The except only warn()s (no note_unreachable/fail), connectivity_errors stays 0, the marker is written, and the gated user_preference block is never re-attempted. Very low likelihood (POST against an endpoint that just authed) and cosmetic-only impact — low; one-line addition.

</details>

### Late/heavy AzuraCast & Playlist-Sync wired into the stack but missed in shared lists

| Rank | Sev | Eff | Remediation | Files |
|------|-----|-----|-------------|-------|
| R3 | high | S | Add `radio` and `playlists` to stop-all.sh so 'Stop all' actually stops AzuraCast and Playlist Sync | `nas\scripts\stop-all.sh`, `installer\src\renderer\components\TroubleshootingModal.tsx` |
| R12 | low | S | Add `radio` to boot-orchestrator.sh COMPOSE_PROFILES so an opted-in AzuraCast is restored on reboot | `nas\scripts\boot-orchestrator.sh` |
| R13 | medium | S | Cap playlistsync restarts with on-failure:5 so a hand-edited .env doesn't crash-loop forever | `sync.sh`, `docker-compose.yml`, `docker-compose.no-vpn.yml` |

<details><summary><b>R3. Add `radio` and `playlists` to stop-all.sh so 'Stop all' actually stops AzuraCast and Playlist Sync</b> — 🟠 high · S</summary>

- **Impact:** A user who enabled AzuraCast (a deliberately heavy ~1.4 GB image, 2-4 GB RAM floor) and/or Playlist Sync clicks the wizard's 'Stop all' (TroubleshootingModal.tsx:416) expecting the whole stack down, but both keep running — holding RAM and bound LAN ports (49157, 8000-8029) — and the leftover AzuraCast container can then interfere with a cross-disk relocation that assumes the stack is down.
- **Files:** `nas\scripts\stop-all.sh`, `installer\src\renderer\components\TroubleshootingModal.tsx`
- **Recommendation:** Add `radio` and `playlists` to the PROFILES array at stop-all.sh:102 (alongside `soulseek`), matching setup.sh's stop_disabled_services (684-685) and COMPOSE_PROFILES builder (489/501). Also append `azuracast playlistsync` to the post-down leftover safety-check container list at stop-all.sh:139-140 (it already lists slskd/soularr for exactly this reason). Compose v2 `down` only acts on named profiles and --remove-orphans never treats defined-but-inactive services as orphans, so the two-line list addition is the actual fix.
- **Rationale:** Confirmed: PROFILES at line 102 lacks radio/playlists; both are real defined services (profiles ['radio'] / ['playlists']) added later. A stop-everything safety action silently breaking its core promise on heavy services is high-impact and the fix is a one-line array edit.

</details>

<details><summary><b>R12. Add `radio` to boot-orchestrator.sh COMPOSE_PROFILES so an opted-in AzuraCast is restored on reboot</b> — ⚪ low · S</summary>

- **Impact:** When the azuracast container doesn't exist at boot (removed by a prior failed update/recreate or docker rm) the boot orchestrator — whose job is to compose up the user's opted-in services — silently skips it because COMPOSE_PROFILES lacks 'radio', leaving the station down despite ENABLE_AZURACAST=true. The COMPOSE_PROFILES log line also under-reports.
- **Files:** `nas\scripts\boot-orchestrator.sh`
- **Recommendation:** After the ENABLE_PLAYLIST_SYNC block (~192) add an explicit-true case branch mirroring setup.sh:501 (use the case-guard style, NOT is_enabled, so a missing key isn't treated as enabled): `case "$(env_val ENABLE_AZURACAST | tr '[:upper:]' '[:lower:]')" in true|1|yes|on) PROFILES+=("radio") ;; esac`. AzuraCast is not VPN-coupled, so no vpn-sidecar dup-guard is needed.
- **Rationale:** boot-orchestrator handles ENABLE_SOULSEEK and ENABLE_PLAYLIST_SYNC but has no radio branch; setup.sh:501 does. Mostly masked by restart: unless-stopped, so low — same AzuraCast-late-addition root cause as the stop-all fix (rank 3) but a distinct file/branch, so kept separate. Cheap.

</details>

<details><summary><b>R13. Cap playlistsync restarts with on-failure:5 so a hand-edited .env doesn't crash-loop forever</b> — 🟡 medium · S</summary>

- **Impact:** An opt-in user who enables ENABLE_PLAYLIST_SYNC but clears a source/cred by hand (or trips a guard) gets a container whose validate() exits 1 near-instantly and is restarted forever under restart: unless-stopped — an endless never-self-healing restart cycle that spams logs and adds daemon churn. The author already chose on-failure:5 for recyclarr-trigger's identical exit-1-on-bad-config shape.
- **Files:** `nas/scripts/playlistsync/sync.sh`, `nas/scripts/docker-compose.yml`, `nas/scripts/docker-compose.no-vpn.yml`
- **Recommendation:** Change the playlistsync service from `restart: unless-stopped` (docker-compose.yml:902) to `restart: on-failure:5`, mirroring recyclarr-trigger (758-763) and carrying the explanatory comment; apply the same to the playlistsync definition in docker-compose.no-vpn.yml. Optionally also `sleep 60` before validate()'s die() in sync.sh so even a single restart doesn't hammer, mirroring recyclarr-trigger's sleep-before-exit.
- **Rationale:** sync.sh runs validate() before exec crond and die() does exit 1; the service has the same boot-failure shape as recyclarr-trigger but lacks its on-failure cap. Trigger is narrow (opt-in + hand-edited .env) so medium, but the one-word compose change matches the project's own established standard.

</details>

### Cross-platform boot resilience & detection gaps (DSM/TrueNAS/UGREEN/ZimaOS)

| Rank | Sev | Eff | Remediation | Files |
|------|-----|-----|-------------|-------|
| R11 | high | S | Export PATH (full Synology/QNAP set) in boot-orchestrator.sh so the ordered-boot feature works on DSM | `nas\scripts\boot-orchestrator.sh`, `nas\scripts\install-boot-resilience.sh` |
| R18 | medium | S | Add an ss fallback to the detect-time port-conflict scan so the early warning fires on UGREEN/Debian-12 | `env-detector.ts`, `setup.sh` |
| R19 | medium | M | Add a TrueNAS SCALE / ZimaOS persistence path (or honest manual_hint) to install-boot-resilience.sh | `install-boot-resilience.sh`, `env-detector.ts` |

<details><summary><b>R11. Export PATH (full Synology/QNAP set) in boot-orchestrator.sh so the ordered-boot feature works on DSM</b> — 🟠 high · S</summary>

- **Impact:** On DSM (the primary platform and the only one with an auto-installed rc.d boot hook) `command -v docker` returns false at boot in the stripped rc.d/cron PATH, so RT stays 'docker', `docker info` fails for the full 5-minute deadline, and the entire ordered-boot/self-heal feature silently no-ops. qBit then hits the 'must join at least one network' + multi-minute restart-backoff wedge — exactly what the orchestrator exists to prevent.
- **Files:** `nas\scripts\boot-orchestrator.sh`, `nas\scripts\install-boot-resilience.sh`
- **Recommendation:** Add a PATH export near the top of boot-orchestrator.sh using the FULL set the codebase already standardizes on (synology-path.ts / env-detector.ts), NOT just the guardian's shorter /usr/local/bin line — on modern DSM 7 docker lives under /var/packages/ContainerManager/target/usr/bin: `export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/var/packages/ContainerManager/target/usr/bin:/var/packages/Docker/target/usr/bin:/share/CACHEDEV1_DATA/.qpkg/container-station/bin:/share/.qpkg/container-station/bin:${PATH:-}"`. Optionally add an absolute-path docker/podman fallback if command -v still misses.
- **Rationale:** The sibling qbit-guardian.sh:29-30 already carries this fix verbatim with the exact comment, proving the project knows the problem and omitted it only here. High (not critical) because restart: unless-stopped still brings the stack back in arbitrary order and the guardian recovers the wedge in ~5 min — degraded, not an outage. One-line export.

</details>

<details><summary><b>R18. Add an ss fallback to the detect-time port-conflict scan so the early warning fires on UGREEN/Debian-12</b> — 🟡 medium · S</summary>

- **Impact:** On UGREEN UGOS (Debian 12, a primary supported target) and any NAS without net-tools, the netstat-only probe yields an empty section, boundPorts is empty, and the Detect screen's pre-Install port-conflict warning NEVER fires even when a foreign process holds 32400/8096/49150-49156 etc. The user only discovers the conflict when compose up aborts mid-install with 'address already in use'.
- **Files:** `installer/src/main/env-detector.ts`, `nas/scripts/setup.sh`
- **Recommendation:** In the SSH probe (env-detector.ts:277) mirror setup.sh's snapshot logic: emit the listener table from `ss -ltn` if available, else `netstat -lnt`, else nothing — `echo "===netstat==="; (command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null || netstat -lnt 2>/dev/null) | awk '$4 ~ /:[0-9]+$/ {n=split($4,a,":"); print a[n]}' | sort -un`. Crucially drop the NR>2 header-skip (ss has a 1-line header; NR>2 would eat its first data row) and match the trailing :PORT on $4 as setup.sh:929 does. The TS parser (492-496) needs no change.
- **Rationale:** setup.sh:888-907 already documents that netstat is absent on Debian-12/UGREEN and prefers ss; env-detector never got that fix. Medium (not high) because setup.sh's own install-time check_port_conflicts and compose-up's bind error are real backstops — the loss is the early pre-Install diagnostic. Small, self-contained probe edit.

</details>

<details><summary><b>R19. Add a TrueNAS SCALE / ZimaOS persistence path (or honest manual_hint) to install-boot-resilience.sh</b> — 🟡 medium · M</summary>

- **Impact:** On TrueNAS SCALE / ZimaOS the boot-orchestrator + qbit-guardian crontab entries appear to install (exit 0, 'Boot hook installed' message) but vanish on the next reboot/update (middleware-owned cron / read-only rootfs), so a VPN+qBit stack loses ordered-boot + self-heal coverage and can sit wedged 10+ min after a reboot. The success message overstates what happened.
- **Files:** `nas/scripts/install-boot-resilience.sh`, `installer/src/main/env-detector.ts`
- **Recommendation:** Add a TrueNAS SCALE branch (detect via the same `grep -qiE 'truenas|freenas' /etc/version` / `/etc/truenas_version` signal env-detector uses) that installs through a persistent mechanism (TrueNAS init/shutdown scripts via midclt) or, at minimum, calls manual_hint with TrueNAS-specific guidance instead of claiming success. Independently harden the generic branch (274+): before declaring success, probe writability (a touch under /etc, the trick at env-detector ~162-165) and/or re-read `crontab -l` to confirm the marked line is actually present; if persistence can't be confirmed, print manual steps + a warning rather than 'Boot hook installed'. This also closes ZimaOS (read-only rootfs).
- **Rationale:** The script special-cases only synology/unraid/qnap; env-detector treats truenas/zimaos as first-class families. The analogous Unraid (M3) and QNAP (M4) boot gaps are already Medium in the backlog and these two are uncovered by either, so this is a genuine additional gap. Bounded by restart: unless-stopped (Docker still returns the stack), so medium.

</details>

### Validation hard-fails on benign first-boot races (reds the whole install)

| Rank | Sev | Eff | Remediation | Files |
|------|-----|-----|-------------|-------|
| R14 | high | S | Use check_url_lenient for the Recyclarr-trigger post-deploy probe (and fix the false '30s retry budget' comment) | `post-deploy-validate.sh`, `docker-compose.yml` |
| R15 | medium | M | Downgrade the gluetun-unhealthy qBit check to warn (or add a bounded gluetun health-wait) for slow WireGuard handshakes | `post-deploy-validate.sh`, `setup.sh`, `docker-compose.yml` |
| R31 | medium | M | Add a gluetun tunnel-health gate after start_stack so a broken VPN key can't pass the install (esp. when qBit is disabled) | `setup.sh`, `post-deploy-validate.sh`, `setup-nordvpn.sh` |
| R32 | low | S | Reconcile the indexer 0/N health check's 'hard fail' preamble with its deliberate warn-not-fail behavior | `post-deploy-validate.sh` |

<details><summary><b>R14. Use check_url_lenient for the Recyclarr-trigger post-deploy probe (and fix the false '30s retry budget' comment)</b> — 🟠 high · S</summary>

- **Impact:** ENABLE_RECYCLARR is default-on. The recyclarr-trigger container binds port 8889 only AFTER `apk add docker-cli` at boot; on a slow/contended package mirror the single no-retry 10s check_url probe returns HTTP 000 and HARD-fails, which exits post-deploy-validate 1, makes the whole install exit 1, and shows the user a red DoneScreen instead of confetti — for a purely cosmetic web tile that is still booting.
- **Files:** `nas/scripts/post-deploy-validate.sh`, `nas/scripts/docker-compose.yml`
- **Recommendation:** At post-deploy-validate.sh:414 replace check_url with check_url_lenient for the Recyclarr trigger (it's a non-critical late-binding tile like Seerr/AzuraCast, which already use lenient), passing a hint like 'Recyclarr trigger apk-installs docker-cli at first boot — wait a minute and re-run.' Correct the false comment at 411-413 that claims a non-existent 30s retry budget. (Alternatively give check_url a real curl --retry, but lenient is the right classification here.)
- **Rationale:** check_url is a single curl --max-time 10 with no retry; the gating comment's claimed budget does not exist. The author already applies check_url_lenient to other still-booting tiles, so this is a one-line consistency fix that stops a default-config install from going red on environmental apk latency.

</details>

<details><summary><b>R15. Downgrade the gluetun-unhealthy qBit check to warn (or add a bounded gluetun health-wait) for slow WireGuard handshakes</b> — 🟡 medium · M</summary>

- **Impact:** On a slow NAS/uplink where the first WG handshake exceeds ~120s, gluetun flips to 'unhealthy' exactly when post-deploy runs. check_qbit then HARD-fails with 'VPN credentials may be wrong' — reds the whole install and misdiagnoses a fine credential as wrong when the tunnel just needed another minute. This is the same first-boot race the script downgrades to warn for the plain not-serving-yet path.
- **Files:** `nas/scripts/post-deploy-validate.sh`, `nas/scripts/setup.sh`, `nas/scripts/docker-compose.yml`
- **Recommendation:** Downgrade the `vpn_on && gluetun_health==unhealthy` case in check_qbit (post-deploy-validate.sh:263-265) from fail to warn, with a 'WireGuard handshake can take a couple of minutes on a slow uplink — wait, then re-run / check compose logs gluetun' hint, mirroring the lenient slskd path (429-430). Reserve a hard fail for a CONFIRMED credential/key error (gluetun logs showing an auth/handshake-key pattern). Better/additionally: add gluetun to a bounded health-wait in wait_for_services when VPN is enabled (poll .State.Health.Status==healthy capped by max_wait) so post-deploy doesn't run until the tunnel settles, removing the race at the source.
- **Rationale:** gluetun is deliberately excluded from wait_for_services' readiness list and reports .State.Status=running while retrying the handshake; only post-deploy catches the dead tunnel, and it does so as a hard fail with a wrong cause. Self-correcting on re-run but mis-fires on the exact slow-uplink audience this project targets — medium.

</details>

<details><summary><b>R31. Add a gluetun tunnel-health gate after start_stack so a broken VPN key can't pass the install (esp. when qBit is disabled)</b> — 🟡 medium · M</summary>

- **Impact:** An install with a wrong/expired WireGuard key completes steps 6-9 green; the failure surfaces only as a single red post-deploy step — and ONLY if qBittorrent is enabled. If the user enabled the VPN profile for Soulseek/playlistsync but not qBit, check_qbit never runs and the broken tunnel slips to a passing post-deploy (slskd uses the lenient warn path), a privacy/leak blind spot for exactly the users who wanted the VPN.
- **Files:** `nas/scripts/setup.sh`, `nas/scripts/post-deploy-validate.sh`, `nas/scripts/setup-nordvpn.sh`
- **Recommendation:** After start_stack (~setup.sh:1545, alongside wait_for_services), add an explicit gluetun gate that runs whenever the vpn profile is active — VPN_ENABLED=true AND (ENABLE_QBITTORRENT OR ENABLE_SOULSEEK OR ENABLE_PLAYLIST_SYNC), not qBit alone. Poll `docker inspect -f '{{.State.Health.Status}}' gluetun` for a bounded window (HEALTH_VPN_DURATION_INITIAL=120s already gives the handshake room); if it settles 'unhealthy', surface its own red step 'VPN tunnel failed to come up — check WireGuard key / provider creds (compose logs gluetun --tail 50)'. Secondary: fix the stale comment at docker-compose.yml:430-431 (Soulseek + Playlist Sync also pull in the vpn profile) and mirror the empty-key warning in setup-nordvpn.sh to surfshark/custom.
- **Rationale:** gluetun is excluded from wait_for_services and reports running while retrying; the only tunnel-health detection is gated on ENABLE_QBITTORRENT, but Soulseek/playlistsync add the vpn profile independently. Common path still catches it (so not high) but a broken VPN can pass outright when qBit is off — medium. Note this coordinates with rank 15 (which downgrades the qBit-on gluetun check); do both.

</details>

<details><summary><b>R32. Reconcile the indexer 0/N health check's 'hard fail' preamble with its deliberate warn-not-fail behavior</b> — ⚪ low · S</summary>

- **Impact:** The stated '0/N passing is a hard fail — the user has no working source' guarantee is not enforced: a user whose every indexer is genuinely down (stale URLs, expired creds) still gets a green/exit-0 install and only a buried warning, so Sonarr/Radarr silently have nothing to search.
- **Files:** `nas/scripts/post-deploy-validate.sh`
- **Recommendation:** Reconcile the line-538 preamble with the v0.6.1 warn-not-fail decision (rationale at 606-608): either reword line 538 to drop the 'hard fail' claim, or, if 0 working indexers truly must be non-passing, make it un-missable (keep warn() but additionally set a distinct sentinel the caller surfaces) rather than silently exiting 0. Pick one so comment and code agree.
- **Rationale:** The 0-of-N branch (605-609) warns but the preamble (537-538) promises a hard fail; git history shows v0.6.1 intentionally downgraded fail->warn for transient install-time test failures but left the contradicting comment. Documentation/consistency issue on a deliberately-soft warning — low; one-line reword or a small sentinel.

</details>

### Destructive auto-remediation on transient faults

| Rank | Sev | Eff | Remediation | Files |
|------|-----|-----|-------------|-------|
| R16 | medium | M | Stop tune-arrs.sh from permanently disabling indexers on a single transient test failure | `tune-arrs.sh` |
| R17 | low | S | Reorder plex-upload.py to upload-then-prune so a transient Plex error can't destroy the user's playlist | `plex-upload.py` |

<details><summary><b>R16. Stop tune-arrs.sh from permanently disabling indexers on a single transient test failure</b> — 🟡 medium · M</summary>

- **Impact:** A user runs the 'slow NAS' fix while a CloudFlare-gated/rate-limited indexer is mid-challenge (the common transient case the project documents elsewhere). tune-arrs disables it on a single failed test, Prowlarr propagates enable=false to Sonarr/Radarr/Lidarr within ~30s, and the indexer silently stops being searched with no auto-re-enable. The user now has FEWER working sources than before running the 'fix' — worsened by the 'Safe to re-run any time' framing.
- **Files:** `nas/scripts/tune-arrs.sh`
- **Recommendation:** Match post-deploy-validate.sh's warn-don't-touch stance for the identical probe: before disabling, re-test each failing indexer 2-3 times with a short backoff to ride out CloudFlare/Flaresolverr/rate-limit transients; and/or only disable on errors indicating a permanent fault (auth failure, DNS/stale-URL, expired creds) rather than a generic transient 4xx. At minimum gate the disable behind an explicit opt-in flag (--disable-broken) and default Step 2 to report-only so a re-run can't silently prune a working setup. Drop or qualify the 'Safe to re-run any time' line (line 26).
- **Rationale:** tune-arrs.sh Step 2 (338-356) PUTs enable=False on ANY HTTPError with no re-test, directly contradicting post-deploy-validate.sh:609 which warns on the same probe and documents the failures as commonly transient. Config-level and reversible, partially disclosed — medium; fix is a re-test loop plus a default-safety flip.

</details>

<details><summary><b>R17. Reorder plex-upload.py to upload-then-prune so a transient Plex error can't destroy the user's playlist</b> — ⚪ low · S</summary>

- **Impact:** On any transient Plex error during the upload POST (Plex mid-restart, 500, scanner busy, claim/login race), the OLD playlist has already been deleted and the new one was never created — the user's Plex playlist disappears until the next successful pass (up to ~24h with the default 0 4 * * * cron). Underlying audio files are safe.
- **Files:** `nas/scripts/playlistsync/plex-upload.py`
- **Recommendation:** In main(), call the /playlists/upload POST FIRST; only after it returns successfully run delete_existing() to remove the OLD same-title playlist(s). Since the upload momentarily creates a second same-titled playlist, change delete_existing to delete the stale duplicate(s) by ratingKey while excluding the newly created one (capture existing ratingKeys before the POST and delete only those, or delete all-but-newest). Plex tolerates two same-titled playlists briefly. Lighter alternative: capture the existing item list before deleting and re-create it in an except block if the POST throws.
- **Rationale:** plex-upload.py:121-127 deletes first then uploads with no rollback. delete-then-upload is strictly worse than upload-then-delete. Severity low because the playlist is a machine-regenerated mirror that the tool overwrites wholesale every run and the outage self-heals next pass — but the fix is a cheap reorder that removes the data-loss window entirely.

</details>

### Path/relocation data-safety & consent gaps

| Rank | Sev | Eff | Remediation | Files |
|------|-----|-----|-------------|-------|
| R21 | medium | M | Gate the relocation pre-flight under --from N / --resume so a narrow re-run can't tear down a live stack | `setup.sh`, `relocate-stack.sh` |
| R22 | low | S | Make the cross-fs relocation resume-aware so an interrupted copy doesn't dead-end on 'destination not empty' | `relocate-stack.sh` |
| R23 | medium | S | Add a free-space pre-flight to the cross-fs relocation so an undersized destination is refused before teardown | `relocate-stack.sh` |
| R24 | medium | M | Warn (or block) when INSTALL_DIR/DATA_ROOT is edited on the Configure screen, mirroring the Detect relocation warning | `ConfigureScreen.tsx`, `EnvDetectScreen.tsx`, `ipc.ts` |
| R25 | medium | S | Require non-empty absolute INSTALL_DIR/DATA_ROOT in the schema so a cleared field can't silently fall back to /volume1 on non-Synology NAS | `env-schema.ts`, `ConfigureScreen.tsx`, `env-render.ts` |

<details><summary><b>R21. Gate the relocation pre-flight under --from N / --resume so a narrow re-run can't tear down a live stack</b> — 🟡 medium · M</summary>

- **Impact:** If .env's INSTALL_DIR/DATA_ROOT diverges from the live mounts (typo, half-finished edit, imported profile), invoking `--from 9` to just re-add subtitle providers instead stops the entire running stack and (same-fs) relocates every config subtree, or (cross-fs) exit 1 and halts — the opposite of the narrow idempotent re-run the user asked for. The user never consented to a relocation by passing --from.
- **Files:** `nas/scripts/setup.sh`, `nas/scripts/relocate-stack.sh`
- **Recommendation:** Keep auto-relocation on a full (no-flag) run, but under an explicit --from N / --resume detect a real path change (PAIRS non-empty) and, instead of silently tearing down (relocate-stack.sh:204-209) + forcing START_STEP=1 (setup.sh:1219-1223), print the detected OLD->NEW change and the containers that would stop, then require explicit confirmation or a flag (MEDIARR_RELOCATE=1 / a new --relocate) before proceeding; otherwise exit non-zero with guidance to re-run without --from to move, or fix .env. Keep the strict dest_blocked guard for the fresh case. (Trailing slashes are already stripped, so only substantive changes trigger.)
- **Rationale:** The pre-flight runs before step gating on every invocation (setup.sh:1211-1212) and overrides the user's --from. Safety invariants are strong (pre-flighted before teardown; same-fs atomic mv; cross-fs aborts without the flag) so the worst case is unwanted-but-safe relocation or a benign halt, not data loss — medium, a consent/least-surprise gap.

</details>

<details><summary><b>R22. Make the cross-fs relocation resume-aware so an interrupted copy doesn't dead-end on 'destination not empty'</b> — ⚪ low · S</summary>

- **Impact:** An interrupted large cross-disk relocation can't self-resume: on the next run, live detection finds nothing (containers torn down), PAIRS is rebuilt from .relocate-state, and the pre-flight hits dest_blocked on the partial dest and aborts with a generic 'destination already exists and is not empty / Refusing to overwrite an existing config/library'. The message mis-frames the user's OWN partial copy as a pre-existing library and never says the source is intact or that clearing the dest is safe.
- **Files:** `nas/scripts/relocate-stack.sh`
- **Recommendation:** Make the pre-flight resume-aware: set a flag when PAIRS was rebuilt from .relocate-state (143-148), and when dest_blocked is true for a recorded pending move either (a) resume the rsync into the dest (rsync -aHAX is restart-safe and reconciles/verifies) or (b) at minimum print a targeted message naming the situation: '$n is the partial copy left by the interrupted relocation of $o. The original at $o is intact. It is safe to delete $n and re-run setup to resume.' Keep the strict dest_blocked guard for the non-resume (fresh) case.
- **Rationale:** No data is lost (source preserved) and a recovery path is already printed ('Move it aside, then re-run setup'), so the only real defect is the under-specified/misleading message — low. Small, scoped change to the pre-flight loop.

</details>

<details><summary><b>R23. Add a free-space pre-flight to the cross-fs relocation so an undersized destination is refused before teardown</b> — 🟡 medium · S</summary>

- **Impact:** A user who opts into MEDIARR_RELOCATE=1 for a multi-TB DATA_ROOT move onto a too-small destination disk gets the stack fully torn down, a half-written copy at the new path consuming the remaining space, and a mid-rsync failure; a re-run then also aborts on the now-non-empty dest, forcing manual cleanup. Data is safe (source never deleted) but the stack is offline and the user must diagnose an out-of-space condition the pre-flight could have refused in one line while the stack was up.
- **Files:** `nas/scripts/relocate-stack.sh`
- **Recommendation:** In the pre-flight loop (168-198), add a best-effort free-space guard to the cross-fs branch that aborts BEFORE teardown, like the existing nesting/rsync-missing guards: compute `du -sk "$o"` vs `df -Pk "$(nearest_existing "$n")"` and refuse with a clear 'need ~X GiB, have ~Y GiB free' message when it won't fit with ~5% headroom. Skip the check when du/df output is non-numeric so a quirky environment never blocks a legitimate move.
- **Rationale:** The pre-flight checks dest-empty/same-fs/rsync but never compares source size to dest free space, and the only repo free-space check (Docker data-root, 10 GiB) runs after relocation and can't cover this. Availability/recoverability hazard not data loss, gated behind an advanced opt-in — medium; one-block fix mirroring existing guards.

</details>

<details><summary><b>R24. Warn (or block) when INSTALL_DIR/DATA_ROOT is edited on the Configure screen, mirroring the Detect relocation warning</b> — 🟡 medium · M</summary>

- **Impact:** A user who accepts the Detect paths, advances, then edits the install/data path on Configure (or loads a profile and tweaks it, never visiting Detect) changes where an existing stack + media live with zero on-screen warning that this triggers a stack-stop + data move. The single safety net (the Detect '⚠ Relocating an existing install' panel) is inconsistent across the two screens that both edit the same fields.
- **Files:** `installer/src/renderer/screens/ConfigureScreen.tsx`, `installer/src/renderer/screens/EnvDetectScreen.tsx`, `installer/src/shared/ipc.ts`
- **Recommendation:** Lift existingInstallDir/existingDataRoot out of EnvDetectScreen's local useState into the wizard store (a transient detect slice set alongside setNasFamily), extract the warning block (EnvDetectScreen.tsx:577-608) into a shared component, and render it under BOTH the Detect paths and the Configure INSTALL_DIR/DATA_ROOT inputs so the warning follows the field. This also covers the load-profile-then-edit path. Optionally surface a confirmation in ConfigureScreen.go() when the path differs from the existing install.
- **Rationale:** The detect result lives only in EnvDetectScreen's local state, so ConfigureScreen has no data to render the warning from. Relocation itself is data-safe (hardened over two adversarial passes), so this is an informed-consent/warning-inconsistency gap (unexpected downtime + data move without warning), not silent data loss — medium.

</details>

<details><summary><b>R25. Require non-empty absolute INSTALL_DIR/DATA_ROOT in the schema so a cleared field can't silently fall back to /volume1 on non-Synology NAS</b> — 🟡 medium · S</summary>

- **Impact:** On a non-Synology NAS (UGREEN/Unraid/QNAP/Linux) a user who clears a path field (e.g. to retype) sees the wizard declare itself 'Ready to install', then the install writes media/config to /volume1/* which doesn't exist there. Clearing INSTALL_DIR on Configure also sets targetDir='', so the SFTP/setup.sh destination resolves to root-anchored /.env while the rendered .env still says /volume1 — an internally inconsistent broken install that validation called ready.
- **Files:** `installer/src/shared/env-schema.ts`, `installer/src/renderer/screens/ConfigureScreen.tsx`, `installer/src/shared/env-render.ts`
- **Recommendation:** Make INSTALL_DIR/DATA_ROOT required-and-absolute in env-schema.ts (replace optStr.refine((v)=>!v||v.startsWith('/')) with z.string().min(1).refine(v=>v.startsWith('/'),'must be an absolute path starting with /')) so an emptied field fails safeParse, blocking the Ready footer and go() and the empty-targetDir write. Secondary: in ConfigureScreen.tsx:1512 fall targetDir back to a sane default instead of '' when cleared (mirroring the Detect screen). Keep the env-render Synology defaults as a last-resort once the schema guarantees a value, or remove the silent /volume1 default so a missing value is never masked on non-Synology.
- **Rationale:** The `!v ||` short-circuit makes empty/undefined valid, liveValid stays true, and env-render substitutes hardcoded Synology paths. Requires the user to actively clear a populated field (not the default flow) and is correct on Synology — medium; the schema change is one line and fixes the targetDir='' path too.

</details>

### Validation/escaping edge cases & robustness hardening (mostly defense-in-depth)

| Rank | Sev | Eff | Remediation | Files |
|------|-----|-----|-------------|-------|
| R20 | medium | S | Lengthen the SSH connect hard-timeout above the 30s handshake budget so slow-but-healthy NAS connects don't abort at 20s | `ssh-service.ts` |
| R27 | medium | M | Classify credential-validation 400s as failures in setup-indexers.py so broken private trackers reach the Issues panel | `setup-indexers.py` |
| R28 | medium | S | Paginate auto-manual-import's queue drain so backlogs over 500 items aren't silently truncated | `auto-manual-import.py` |
| R33 | low | S | Reject an unknown VPN_PROVIDER instead of silently rendering a NordVPN .env | `env-render.ts`, `vpn-providers.ts`, `env-schema.ts`, `TroubleshootingModal.tsx` |
| R34 | low | M | Fix the ESCAPE<->env_val shell contract so a single-quote SLSKD_API_KEY isn't silently clobbered | `env-render.ts`, `setup.sh` |
| R35 | low | S | Add bounded retries to the core arr GET reads in setup-arr-config.py | `setup-arr-config.py` |
| R36 | low | S | Tighten port-number validators to a 1-65535 range (USENET_PORT is the user-visible win) | `env-schema.ts` |

<details><summary><b>R20. Lengthen the SSH connect hard-timeout above the 30s handshake budget so slow-but-healthy NAS connects don't abort at 20s</b> — 🟡 medium · S</summary>

- **Impact:** On exactly the slow-handshake scenario the 30s readyTimeout was raised to cover (busy DSM, auth backend paging, NAS running Hyper Backup/Snapshot Replication), the independent 20s wall-clock backstop kills the connect first and shows 'Connection timed out / verify SSH is enabled' on a host that would have connected at ~22-28s.
- **Files:** `installer/src/main/ssh-service.ts`
- **Recommendation:** Make the wall-clock backstop strictly longer than readyTimeout instead of a shorter cap that pre-empts it: in connectClient derive HARD_TIMEOUT_MS = readyTimeout + 10_000 (=40s) from the configured readyTimeout (30_000). ssh2's readyTimeout then fires its own 'Timed out while waiting for handshake' at 30s on a stuck host, while the 40s timer still catches an OS-level connect hang (SYN black hole). Also fix the inaccurate comment at 146-149 (readyTimeout starts at connect-call time, not after TCP connect), and reference the new duration in the error message.
- **Rationale:** readyTimeout:30_000 (line 79) vs HARD_TIMEOUT_MS:20_000 (line 150) directly contradict; the shorter, less-informed constant always wins, making the intended 30s budget unreachable. Connect-time-only and recoverable on retry — medium; trivial constant + comment fix.

</details>

<details><summary><b>R27. Classify credential-validation 400s as failures in setup-indexers.py so broken private trackers reach the Issues panel</b> — 🟡 medium · M</summary>

- **Impact:** A wrong-but-nonempty private-tracker credential (passkey/cookie/PID/rssKey) is force-saved and reported only via info() ('saved with forceSave'); nothing reaches the wizard Issues panel, and Prowlarr auto-disables the indexer on its first scheduled search with no breadcrumb pointing back at the feeding .env var.
- **Files:** `nas/scripts/indexers/setup-indexers.py`
- **Recommendation:** In _post_indexer, on the forceSave 400 path (461-479), mirror the clean-POST safety net at 397-420: after force-save, GET the indexer list and if the indexer is absent, downgrade info()->warn() so the parser (which ignores info(), 57-65) sees it; OR classify credential-class 400s (must not be empty / validation / invalid / unauthor / forbidden / passkey / api key / cookie) as fail() naming the feeding .env var. Reserve forceSave for connectivity/cloudflare/timeout/refused.
- **Rationale:** The 200/201 path re-fetches+downgrades at 409-420 but the forceSave path lacks it; the main loop skips blank secrets so only wrong-but-nonempty creds hit this. A silent broken-source class that the user only discovers much later — medium; localized to one function.

</details>

<details><summary><b>R28. Paginate auto-manual-import's queue drain so backlogs over 500 items aren't silently truncated</b> — 🟡 medium · S</summary>

- **Impact:** On a backlog >500 queued items, import-blocked items beyond the first hardcoded page are never fetched/drained/reported while the run implies the queue was processed; re-running can't help (fixed page), and when blocked items exist the count line never fires so the truncation is fully invisible.
- **Files:** `nas/scripts/auto-manual-import.py`
- **Recommendation:** In _drain_arr (line 279) loop pages using totalRecords/totalPages; or minimally warn() when totalRecords > len(records) and print the true totalRecords instead of len(records) at line 292. The sibling fix-imports.sh:215 already reads totalRecords as a model.
- **Rationale:** auto-manual-import.py:279 fetches one page ?pageSize=500 and uses it as the sole source with no totalRecords loop. Affects large libraries (a weekly-cron-friendly script), invisible when it bites — medium; the minimal warn+true-count variant is small.

</details>

<details><summary><b>R33. Reject an unknown VPN_PROVIDER instead of silently rendering a NordVPN .env</b> — ⚪ low · S</summary>

- **Impact:** A hand-edited or migrated .env with e.g. VPN_PROVIDER=pia/expressvpn (anything not in the 6-entry registry) is silently rewritten to nordvpn and gluetun is fed NordVPN settings — the user's intended provider is dropped with no warning. The app's own TroubleshootingModal even advises pia/privatevpn values the registry can't represent.
- **Files:** `installer/src/shared/env-render.ts`, `installer/src/shared/vpn-providers.ts`, `installer/src/shared/env-schema.ts`, `installer/src/renderer/components/TroubleshootingModal.tsx`
- **Recommendation:** Change findVpnProvider to distinguish a miss from a hit (add findVpnProviderOrNull(id) returning `?? null`, keeping the NordVPN-defaulting wrapper only for the genuinely null/undefined back-compat case). Then in env-schema.ts add a branch after the empty check (~400) rejecting a non-empty VPN_PROVIDER not in the known-id set ('Unknown VPN provider — pick a supported one or use Custom'), and/or in renderVpnBlock emit the user's original VPN_PROVIDER verbatim on a miss (skipping the NordVPN credential block). Also reconcile TroubleshootingModal.tsx:514 to steer users to the Custom escape hatch.
- **Rationale:** findVpnProvider returns `?? NORDVPN` and the schema only rejects an empty provider; the wizard GUI only writes known IDs so normal flow is unaffected and the failure mode is a visibly-broken VPN (killswitch still blocks leaks), not a stealth leak — low. Small schema+helper change.

</details>

<details><summary><b>R34. Fix the ESCAPE<->env_val shell contract so a single-quote SLSKD_API_KEY isn't silently clobbered</b> — ⚪ low · M</summary>

- **Impact:** A user-pinned SLSKD_API_KEY containing a single quote is written unquoted by ESCAPE, makes `env_val SLSKD_API_KEY` return empty (xargs: unmatched single quote), so the `[ -z ... ]` guard treats it as unset and OVERWRITES it with a freshly generated key — silently clobbering the user's chosen secret (both containers still agree, no breakage, but the value is lost without notice). A $/backtick/backslash value leaks a stray backslash.
- **Files:** `installer/src/shared/env-render.ts`, `nas/scripts/setup.sh`
- **Recommendation:** Add ' to ESCAPE's quote-trigger set in env-render.ts (so any single-quote value is emitted double-quoted, which Python's _parse_env_value already round-trips) — this alone fixes the silent clobber. Separately, to fix the $/backtick/backslash leak on the shell side, replace env_val's `| xargs` (setup.sh:317) with a parser mirroring ESCAPE (strip one layer of surrounding double-quotes and apply the documented \n/\r/\"/\$/\`/\\ un-escapes), or read SLSKD_API_KEY emptiness with a quote-aware check. Keep ESCAPE, env_val, _parse_env_value, and the schema consistent.
- **Rationale:** ESCAPE's regex omits the single quote and env_val ends in `| xargs`; SLSKD_API_KEY is the only realistic victim (auto-generated hex by default, schema allows arbitrary chars). Narrow and non-destructive (secret regenerated to an equally-strong value both containers agree on) — low; the ESCAPE one-char fix is trivial, the full shell-parser fix is M.

</details>

<details><summary><b>R35. Add bounded retries to the core arr GET reads in setup-arr-config.py</b> — ⚪ low · S</summary>

- **Impact:** A single transient blip during Step 7 (NAS under heavy load while every container is booting) on the FIRST GET of a config function fails that whole sub-step with a red and no diagnostic that it was a network error, even though wait_ready confirmed the service moments earlier. A clean re-run is required to recover.
- **Files:** `nas/scripts/setup-arr-config.py`
- **Recommendation:** Give the read helpers (_request 550-551, _safe_request 565-566) a small bounded retry (2-3 attempts with a short sleep) on URLError/OSError before returning None, and log the underlying error string so a network failure is distinguishable from a legitimate 'service has no such config' in the install log. The mutation paths already have 10x3s verify loops; this brings the leading GET in line.
- **Rationale:** `except (URLError, OSError): return None` with no retry/logging, and callers hard-fail on a None GET. Self-healing on a clean re-run with no persistent corruption — low; a few-line helper change.

</details>

<details><summary><b>R36. Tighten port-number validators to a 1-65535 range (USENET_PORT is the user-visible win)</b> — ⚪ low · S</summary>

- **Impact:** A typo like 8O96->'80096' or a stray 0 is accepted as a valid 'port number' and written to .env/compose; the failure only surfaces later as a compose bind error, not as inline validation at the screen where it was entered.
- **Files:** `installer/src/shared/env-schema.ts`
- **Recommendation:** Replace USENET_PORT's `/^\d+$/` check with a parse-and-range guard: refine((v)=>!v||(/^\d+$/.test(v) && +v>=1 && +v<=65535),'must be a port number between 1 and 65535'). Apply the same to AZURACAST_HTTP_PORT to keep the round-trip schema honest, but prioritize USENET_PORT — it's the only screen-entered port (ConfigureScreen.tsx:1226); AzuraCast has no wizard field.
- **Rationale:** Both validators check only `/^\d+$/`, so '0'/'70000'/'99999' pass. Benign and visible failure (errors at compose-up) — low; one-line refine, and the existing Field surfaces the inline error once the schema rejects out-of-range.

</details>

### Cosmetic, a11y, secret-permission & code-health nits

| Rank | Sev | Eff | Remediation | Files |
|------|-----|-----|-------------|-------|
| R39 | low | M | Trap Tab focus in the modal dialogs (shared useFocusTrap hook) | `ImportProfileDialog.tsx`, `ExportProfileDialog.tsx`, `IssuesModal.tsx`, `TroubleshootingModal.tsx`, `UpdateOverlay.tsx` |
| R40 | low | S | Write the qBittorrent.conf (WebUI password hash) and profile-export envelope with 0600, matching the project's .env convention | `setup-folders.sh`, `setup-chmod.sh`, `dialog-service.ts`, `ExportProfileDialog.tsx` |
| R41 | low | S | Reset mode to 'install' on return to Welcome so the wrong stepper rail/accent doesn't leak | `WelcomeScreen.tsx`, `UpdateRunScreen.tsx`, `DoneScreen.tsx`, `App.tsx` |
| R42 | low | S | Publish busy during DoneScreen post-deploy validation so the in-place updater can't quit mid-stream | `DoneScreen.tsx`, `App.tsx` |
| R43 | low | S | Serialize concurrent Spotify connect attempts and correct the misleading EADDRINUSE message | `spotify-oauth.ts` |
| R44 | low | S | Show a real error in CustomIndexerEditor / consolidate handled in rank 10; remaining cosmetic component nits | `auto-manual-import.py`, `SiriusxmSelect.tsx`, `sync.sh` |
| R45 | medium | S | Delete the orphaned ~200 MB update zip after a successful extract | `updater-service.ts` |
| R46 | low | S | Add a phase-aware notice during the RunScreen 'uploading' (prep/ACL/SFTP) no-escape window | `RunScreen.tsx` |

<details><summary><b>R39. Trap Tab focus in the modal dialogs (shared useFocusTrap hook)</b> — ⚪ low · M</summary>

- **Impact:** Keyboard and screen-reader users can Tab out of an open modal onto controls they cannot see, breaking the aria-modal contract and causing confusing focus loss. Consistent across the dialog set — a systemic a11y gap.
- **Files:** `installer/src/renderer/components/ImportProfileDialog.tsx`, `installer/src/renderer/components/ExportProfileDialog.tsx`, `installer/src/renderer/components/IssuesModal.tsx`, `installer/src/renderer/components/TroubleshootingModal.tsx`, `installer/src/renderer/components/UpdateOverlay.tsx`
- **Recommendation:** Add a shared useFocusTrap(ref,{active,onClose}) hook and apply it to all aria-modal overlays (the four dialogs plus UpdateOverlay): on mount record document.activeElement and focus the first tabbable element; cycle Tab/Shift-Tab within the dialog at the first/last element; on unmount restore focus to the opener. Fold the existing per-dialog Escape listeners into the same hook to keep modal hygiene DRY.
- **Rationale:** All four declare role=dialog aria-modal=true and add only an Escape listener; no focus trap or Tab containment exists anywhere in the renderer. Recoverable (Escape/click-outside dismiss) on a one-shot installer — low; a single reusable hook covers all five.

</details>

<details><summary><b>R40. Write the qBittorrent.conf (WebUI password hash) and profile-export envelope with 0600, matching the project's .env convention</b> — ⚪ low · S</summary>

- **Impact:** qBittorrent.conf is written 644 (world-readable) while containing the salted PBKDF2 WebUI hash, username, and LAN AuthSubnetWhitelist — readable by any local user/process for offline brute-force; the same credential is deliberately 600 in .env. Separately the profile-export file is written 0644 (world-readable) though its secrets are AES-256-GCM ciphertext under a PBKDF2-600k key, so confidentiality holds only by passphrase strength on a shared POSIX host.
- **Files:** `nas/scripts/setup-folders.sh`, `nas/scripts/setup-chmod.sh`, `installer/src/main/dialog-service.ts`, `installer/src/renderer/components/ExportProfileDialog.tsx`
- **Recommendation:** setup-folders.sh:619 change `chmod 644 "$QB_CONF_FILE"` to 600 (already chowned to $PUID:$PGID, the container UID, so it keeps working); tighten the .bak backup at 571-572 too; optionally have setup-chmod.sh re-assert 600 on qBittorrent.conf on idempotent re-runs. For the export: in dialog-service.ts:24 write with `{mode:0o600}` and, since mode is ignored on overwrite/Windows, also fs.chmod(filePath,0o600) on POSIX; thread an optional restrictPermissions flag through saveText so the shared log-export path isn't forced to 0600.
- **Rationale:** Two verified findings (qBittorrent.conf 644; export 0644) are the same 'sensitive file misses the project's 0600 convention' root cause and are bundled. Both are bounded (hash not plaintext; ciphertext not plaintext) defense-in-depth, exploitable only with existing host/shared-machine access — low; small chmod/mode edits.

</details>

<details><summary><b>R41. Reset mode to 'install' on return to Welcome so the wrong stepper rail/accent doesn't leak</b> — ⚪ low · S</summary>

- **Impact:** After an Update or Migrate run, returning to Welcome (Done, Back-to-start, header switch, ConnectScreen switch, deleted-profile bounce) leaves mode='update'/'migrate', so the home screen shows a reduced Update/Migrate rail with the wrong color theme over the generic 'Welcome back — pick a NAS' content. The two adjacent DoneScreen buttons differ ('Start over' clears mode, 'Done' doesn't), so they leave the app in visibly different states.
- **Files:** `installer/src/renderer/screens/WelcomeScreen.tsx`, `installer/src/renderer/screens/UpdateRunScreen.tsx`, `installer/src/renderer/screens/DoneScreen.tsx`, `installer/src/renderer/App.tsx`
- **Recommendation:** Have WelcomeScreen normalize mode on mount: `useEffect(() => { useWizard.getState().setMode('install') }, [])` — this fixes every entry path in one place (including the EnvDetect mode='update' switch) and matches the merge() rehydrate intent. Alternatively add a goHome() helper (setStep('welcome')+setMode('install')) at the four call sites.
- **Rationale:** The rail is chosen purely from mode (App.tsx:315-318) and renders unconditionally; every go-home path navigates without resetting mode. Purely cosmetic, self-heals on the next profile-action click — low; one mount effect.

</details>

<details><summary><b>R42. Publish busy during DoneScreen post-deploy validation so the in-place updater can't quit mid-stream</b> — ⚪ low · S</summary>

- **Impact:** DoneScreen streams post-deploy-validate.sh over SSH (auto on mount, and on every 'Re-check health') but never publishes busy, so the footer 'Install vX'/'Restart to update' controls stay enabled — a user can trigger an in-place update that quits the app mid-validation, severing the SSH stream and truncating its local log (silently, since App suppresses the post-deploy-validate stream-close toast).
- **Files:** `installer/src/renderer/screens/DoneScreen.tsx`, `installer/src/renderer/App.tsx`
- **Recommendation:** Mirror the other run screens: pull setBusy from useWizard (DoneScreen.tsx:56) and add `useEffect(() => setBusy(running), [running, setBusy])` plus an unmount net `useEffect(() => () => setBusy(false), [setBusy])`, reusing the existing `running` state that already tracks the in-flight validation (it flips false on stream close, so busy releases automatically).
- **Rationale:** busy exists precisely to stop the updater quitting a live SSH job (App footer disables on busy), and RunScreen/UpdateRunScreen/MigrateScreen all publish it — DoneScreen is the gap. Lower stakes (validation is read-only/re-runnable) and a narrow window — low; two one-line effects.

</details>

<details><summary><b>R43. Serialize concurrent Spotify connect attempts and correct the misleading EADDRINUSE message</b> — ⚪ low · S</summary>

- **Impact:** If a user double-clicks Connect or retries before the first attempt times out (reachable across separate windows since there's no single-instance lock), the second attempt hits 'Port 48721 is already in use — close whatever is using it' when the culprit is the wizard's own first in-flight attempt holding the loopback port for up to 3 minutes.
- **Files:** `installer/src/main/spotify-oauth.ts`
- **Recommendation:** Add a module-level `let inFlight=false` guard in spotify-oauth.ts: at the top of spotifyConnect() throw 'A Spotify sign-in is already in progress — finish (or cancel) the open browser tab, then try again' if inFlight; set inFlight=true before awaitAuthCode and clear it in finally. This both serializes attempts and gives an accurate message. Optionally soften the EADDRINUSE text to mention a sign-in may already be in progress.
- **Rationale:** The renderer disables the button while busy (single-window), so this is only reachable across windows/unusual timing; purely a cosmetic message in a rare scenario, user not blocked (port frees within 3 min) — low; a small in-flight guard.

</details>

<details><summary><b>R44. Show a real error in CustomIndexerEditor / consolidate handled in rank 10; remaining cosmetic component nits</b> — ⚪ low · S</summary>

- **Impact:** Remaining low-value polish bundled for one pass: the Lidarr identify-probe checks album.id but the real requirement is artist.id (mislabeled 'no usable candidate' skips, correctness preserved); downloadId is interpolated unescaped into the manualimport query (urlencode imported but unused; rare malformed-request skip); and SiriusXM custom slugs are written into the CSV with no whitespace/separator scrubbing (a space/comma silently yields an invalid xmplaylist slug that fails only in the container log).
- **Files:** `nas/scripts/auto-manual-import.py`, `installer/src/renderer/components/SiriusxmSelect.tsx`, `nas/scripts/playlistsync/sync.sh`
- **Recommendation:** auto-manual-import.py: set Lidarr media_field='artist' so the line-328 probe matches _lidarr_file_payload's artist.id requirement (do NOT touch the line-433 guard); at line 314 use the already-imported urlencode({'downloadId':download_id,'filterExistingFiles':'false'}). SiriusxmSelect.addCustom(): normalize the slug like SpotifyConnect.serialize — `const s = custom.trim().replace(/[,|]/g,'').replace(/\s+/g,'')` (slugs are bare identifiers, so strip internal whitespace), optionally hinting when the value contains chars outside /^[a-z0-9]+$/.
- **Rationale:** Three diagnostic/defense-in-depth nits with correctness preserved (None payload blocks a bad Lidarr POST; default clients emit URL-safe IDs; sync.sh's per-source loop skips a bad slug and continues). All trivially small and naturally batched into one cleanup commit — low.

</details>

<details><summary><b>R45. Delete the orphaned ~200 MB update zip after a successful extract</b> — 🟡 medium · S</summary>

- **Impact:** Every applied update leaves a ~200 MB zip in %TEMP%\mediarr-update that persists until the user installs another update (could be weeks/forever if they update rarely), silently consuming one full build's worth of dead space per release cycle on the system drive.
- **Files:** `installer/src/main/updater-service.ts`
- **Recommendation:** Delete the zip as soon as extraction succeeds — after `await extractZip(zipPath, stagingDir)` (line 485) add a best-effort `try { rmSync(zipPath, { force: true }) } catch {}`. This is safer than having the swap .cmd rmdir tmpRoot (the staging dir robocopy reads lives inside tmpRoot) and frees the space promptly.
- **Rationale:** The success swap script removes only the staging dir; tmpRoot/the zip is wiped only at the START of the next download. Self-bounded (never accumulates past one build, in OS-reapable %TEMP%) so no correctness/safety impact — disk-hygiene only — but the one-line immediate-delete is essentially free.

</details>

<details><summary><b>R46. Add a phase-aware notice during the RunScreen 'uploading' (prep/ACL/SFTP) no-escape window</b> — ⚪ low · S</summary>

- **Impact:** During the 'uploading' phase the prep chown (which the code comment says routinely takes 2-5 min on a large Synology library) and the ACL/SFTP work run with Back disabled and no Cancel — the only escape is a 5-/10-min timeout or killing the app. The static 'Uploading files... 0%' reads as a freeze with no affordance, the worst-feeling stretch of the flow.
- **Files:** `installer/src/renderer/screens/RunScreen.tsx`
- **Recommendation:** Replace the static 'Uploading files... {pct}%' during prep/ACL/SFTP with a phase-aware notice such as 'Preparing files on the NAS — on a large existing library this can take several minutes and can't be cancelled mid-copy', scoped to phase==='uploading' (writing-env already leaves Back enabled and is short). Optionally render a Cancel during 'uploading' that aborts by tearing down the SSH session (window.installer.ssh.disconnect, already used in reconnectAndResume).
- **Rationale:** Recoverable (timeouts fire; install is idempotent/resumable) and an affordance/perception issue not a functional defect — low; the copy change alone removes the freeze impression cheaply.

</details>

## Deferred (considered, not recommended now)

- AZURACAST_HTTP_PORT range validation — no UI field exists for it; only USENET_PORT is user-visible, so range-check that one (folded into rank 36) and skip AzuraCast beyond keeping the round-trip honest.
- Profile-export 0600 as a hard requirement — contents are AES-256-GCM under PBKDF2-600k, so the world-readable file exposes only ciphertext; bundled as optional hardening into rank 40, not pursued standalone.
- SHA/content-hash verification of the update download — the proposed .sha256 sidecar fetched over the same channel gives no protection against the malicious-substitution threat it raises, and accidental corruption is already caught downstream at ExtractToDirectory with an actionable message. Document the size+magic check as best-effort instead.
- Retry wrapper on vpn-service nordGet / qbit-migration / updater fetches — interactive, user-initiated, one-click manually retryable in ConfigureScreen; not a gating 'core feature' in practice. Nice-to-have, not worth the shared-utility churn now.
- Abort/Cancel for MigrateScreen long-running imports — optional advanced screen, force-quit is a real escape, qBit loop self-recovers per item via AbortSignal.timeout(15s); revisit only if users hit it (the arr-import path lacking a timeout is the one genuinely strong sub-case if it recurs).
- Modal Tab focus-trap could be deferred further if desired (rank 39 keeps it) — one-shot desktop installer, recoverable via Escape/click-outside; included only because a single reusable hook covers all five dialogs cheaply.
- HAS_IPV6 .env.example stub — non-breaking (:-false default keeps compose working); a commented template line is the whole fix, lowest priority doc drift. Add opportunistically when next touching .env.example.
- diagnose-firewall.sh missing asustor/terramaster/zimaos arms + manual_hint classifier gaps — read-only, non-fatal scripts whose core message is family-agnostic and correct; the generic hint is even accurate for UGREEN/OMV. Tailoring-only; batch with rank 19 if/when adding those family signals, otherwise defer.
- Steps 7-9 abort_if_failed — purely log-clarity (resume checkpoint is correct, FAIL-gated); real flooding is overstated (each dependent step fast-fails with ~1 line). A one-line abort_if_failed after step 7 is reasonable later but low-value; deferred.
- Boot/self-heal wiring running on every --from N pass — intentional and documented in-code (existing installs must pick up the hook), side-effect-stable (byte-identical when hooks exist). The remedy is a one-line --help note, not a behavior change; defer.
- RunScreen 'writing-env' framing — that phase already leaves Back enabled and is short; only the 'uploading' phase is the real no-escape window (addressed in rank 46), so no separate writing-env work needed.
- Lidarr media_field / unescaped downloadId / SiriusXM slug scrub — folded into a single cosmetic cleanup commit (rank 44); none worth standalone effort (correctness is preserved in all three).

## Appendix — all 72 verified findings

| Sev | Dimension | Finding | Files |
|-----|-----------|---------|-------|
| high | dead-end | Default fresh-install hits a hidden-field dead end: required qBittorrent password error with no visible password field | `ConfigureScreen.tsx`, `env-schema.ts`, `wizard.ts` |
| high | idempotency | stop-all.sh's hardcoded profile list omits `radio` and `playlists`, so "Stop all" leaves AzuraCast and Playlist Sync running | `nas\scripts\stop-all.sh`, `installer\src\renderer\components\TroubleshootingModal.tsx` |
| high | dead-end | Fixing the single failed step via the prominent "Retry step N" button leaves the install stuck in 'failed' — all steps go green but Continue stays disabled | `RunScreen.tsx` |
| high | cross-platform | boot-orchestrator.sh never exports PATH, so DSM's ordered boot silently no-ops (docker at /usr/local/bin isn't found in the stripped rc.d/cron PATH) | `boot-orchestrator.sh`, `install-boot-resilience.sh`, `qbit-guardian.sh` |
| high | error-handling | Recyclarr-trigger reachability is a HARD fail with a single no-retry 10s probe — the comment claiming a '30s retry budget' is false, so a slow apk-add reds the whole install | `post-deploy-validate.sh`, `docker-compose.yml`, `setup.sh` |
| high | dead-end | SSH drop during the install PRELUDE (prep/ACL/SFTP/.env write) strands the user on a cryptic "unknown sessionId" with no Reconnect button | `RunScreen.tsx`, `ssh-service.ts`, `wizard.ts` |
| medium | error-handling | forceSave net swallows credential-validation 400s, silently saving broken private trackers as success | `setup-indexers.py` |
| medium | robustness | auto-manual-import drops queue items past 500 (hardcoded pageSize, no pagination) | `auto-manual-import.py` |
| medium | ux | qBittorrent global speed caps (75 MB/s down, 25 MB/s up) are forced on every fresh install with no opt-out, no .env knob, and no documentation | `setup-arr-config.py` |
| medium | cross-platform | Detect-time port-conflict scan uses only `netstat` (no `ss` fallback) — a silent no-op on UGREEN/Debian-12 and other modern NAS | `env-detector.ts`, `setup.sh` |
| medium | robustness | Cancel timeout in RunScreen force-unlocks the rail by dropping to 'failed', but the underlying setup.sh may still be running on the NAS — re-entering can race a second run | `RunScreen.tsx`, `App.tsx` |
| medium | data-safety | Configure screen lets you change INSTALL_DIR/DATA_ROOT with no relocation warning (the warning exists only on Detect) | `ConfigureScreen.tsx`, `EnvDetectScreen.tsx`, `ipc.ts` |
| medium | data-safety | Empty INSTALL_DIR / DATA_ROOT pass validation ('Ready to install') but silently fall back to hardcoded Synology paths | `env-schema.ts`, `ConfigureScreen.tsx`, `env-render.ts` |
| medium | error-handling | CustomIndexerEditor "Apply JSON" silently discards malformed or non-array input — no error shown, work appears lost | `CustomIndexerEditor.tsx` |
| medium | data-safety | Editing the custom-indexer form after a CUSTOM_INDEXERS_JSON parse error destroys the recoverable malformed JSON | `CustomIndexerEditor.tsx` |
| medium | data-safety | IndexerCard toggle-off instantly clears all entered credentials with no confirmation or undo | `IndexerCard.tsx` |
| medium | data-safety | setup-folders.sh recursively re-chmods/re-chowns the entire media + Plex config tree on EVERY re-run, mutating existing user files | `setup-folders.sh` |
| medium | ux | DoneScreen shows the full "You did it! Your media stack is live" hero + confetti whenever the validator exits 0, even when services are still booting (warnCount>0) — directly contradicting its own footer | `DoneScreen.tsx`, `post-deploy-validate.sh` |
| medium | idempotency | Path relocation orphans the install marker, so the next configure run reverts every user-tweaked arr/qBit setting to wizard defaults | `relocate-stack.sh`, `setup-arr-config.py` |
| medium | idempotency | setup-folders.sh runs recursive chown -R / chmod -R over the entire media + downloads tree on every invocation | `setup-folders.sh` |
| medium | robustness | Connect hard-timeout (20s) is shorter than the SSH handshake budget (30s), so the documented 30s budget never applies and slow-but-healthy NAS connects abort early | `ssh-service.ts` |
| medium | dead-end | SFTP writeFile() of the .env has no timeout on either the SFTP or exec path — a wedged SFTP channel hangs the install permanently in the 'writing-env' phase | `sftp-service.ts`, `RunScreen.tsx` |
| medium | data-safety | A normal --from N run unconditionally runs the relocation pre-flight, which can tear down the whole live stack when the user only asked to re-run one step | `setup.sh`, `relocate-stack.sh` |
| medium | cross-platform | TrueNAS SCALE (and OMV/UGREEN/asustor/terramaster/zimaos) get no boot-resilience branch — fall through to a root-crontab hook that does not persist on TrueNAS | `install-boot-resilience.sh`, `env-detector.ts` |
| medium | data-safety | tune-arrs.sh permanently DISABLES indexers on a single transient test failure — destroying a working setup the post-deploy explicitly says to leave alone | `tune-arrs.sh` |
| medium | error-handling | qBittorrent check hard-fails when gluetun is 'unhealthy', but a slow WireGuard handshake legitimately leaves gluetun unhealthy right after install (false positive the rest of the script tries to avoid) | `post-deploy-validate.sh`, `setup.sh`, `docker-compose.yml` |
| medium | robustness | Hand-edited .env tips playlistsync into a tight crash-loop (validate() exits 1 under restart: unless-stopped) — the exact failure the repo guards against elsewhere with on-failure:5 | `sync.sh`, `docker-compose.yml` |
| medium | robustness | No timeout or track cap around the sockseek invocation — a hung/slow Soulseek+yt-dlp pass can block the whole run indefinitely with no upper bound | `sync.sh` |
| medium | data-safety | Partial robocopy failure corrupts the install in place, then relaunches it while telling the user nothing changed | `updater-service.ts`, `UpdateOverlay.tsx` |
| medium | code-health | Successful update orphans the ~200 MB downloaded zip in %TEMP% until the next update runs | `updater-service.ts` |
| medium | data-safety | Cross-filesystem relocation has no free-space pre-flight — a disk that fills mid-rsync leaves the stack DOWN with both copies and a partial destination to clean up by hand | `relocate-stack.sh` |
| medium | error-handling | A user-Cancel that the remote ignores degrades to a generic "failed" with no indication the install is still converging on the NAS | `RunScreen.tsx`, `ssh-service.ts` |
| medium | dead-end | UpdateRunScreen has no resume/reconnect path: any failure (SSH drop or a single red step) dead-ends at "paused — see log" with only a full-replay Continue gate | `UpdateRunScreen.tsx` |
| medium | error-handling | VPN that won't connect (bad WireGuard key) passes the install entirely; the failure only surfaces as a single red post-deploy step, and a successful-looking Done screen still appears if qBit is disabled | `setup.sh`, `post-deploy-validate.sh`, `setup-nordvpn.sh` |
| low | robustness | downloadId interpolated unescaped into manualimport query URL (urlencode imported but unused) | `auto-manual-import.py` |
| low | code-health | Lidarr identify-probe checks album.id but real requirement is artist.id (mislabeled skips) | `auto-manual-import.py` |
| low | security | recyclarr-trigger exposes an unauthenticated docker.sock-backed HTTP endpoint on the LAN | `recyclarr-trigger.py` |
| low | idempotency | If qBittorrent authenticates but the seeding/TMM setPreferences POST throws, it only warns (no marker block) — the install marker is written and the defaults are suppressed forever on later runs | `setup-arr-config.py` |
| low | data-safety | add_download_client re-applies wizard field values (host/port/category + write-only secrets) on every run and is NOT gated by REINSTALL_PRESERVE — a user UI change to a non-secret field is reverted whenever the wizard's value differs | `setup-arr-config.py` |
| low | error-handling | Core arr GET reads have no retry and silently collapse transient network errors to a hard fail (only PUT/POST paths get verify-retries) | `setup-arr-config.py` |
| low | data-safety | ESCAPE() ↔ shell `env_val()` contract mismatch: single-quote values are emitted unquoted (crash xargs) and $/backtick/backslash values leak their escaping backslash | `env-render.ts`, `setup.sh` |
| low | error-handling | An unknown/typo'd VPN_PROVIDER with VPN_ENABLED=true silently renders a NordVPN .env | `env-render.ts`, `vpn-providers.ts` |
| low | ux | Stale `mode` leaks onto the Welcome screen, showing the wrong (Update/Migrate) stepper rail and accent color over "pick a NAS" | `App.tsx`, `UpdateRunScreen.tsx`, `DoneScreen.tsx`, `wizard.ts` |
| low | robustness | Manual app-update on the Done screen is unguarded by `busy`, so it can quit/swap the binary while post-deploy validation is streaming over SSH | `DoneScreen.tsx`, `App.tsx` |
| low | ux | RunScreen "Back" during the upload/writing-env phase is blocked, but the SFTP upload and .env prep keep running unsupervised because `busy`-lock and the Back guard cover only some sub-phases | `RunScreen.tsx` |
| low | ux | passphraseStrength can never return 4 ("Very strong") — the veryLong branch is dead because longEnough already matched | `profile-crypto.ts`, `ExportProfileDialog.tsx` |
| low | data-safety | Profile export envelope is written to disk with default 0644 permissions (world-readable on POSIX), but contents are passphrase-encrypted so impact is limited | `dialog-service.ts`, `ExportProfileDialog.tsx` |
| low | error-handling | Spotify connect cannot run two concurrent attempts and the EADDRINUSE message is slightly misleading when the prior attempt is still bound | `spotify-oauth.ts` |
| low | error-handling | Detect 'Paths must be absolute' warning is advisory only — Continue stays enabled with a relative/invalid path | `EnvDetectScreen.tsx` |
| low | robustness | Port-number fields accept out-of-range / zero values (AZURACAST_HTTP_PORT, USENET_PORT) | `env-schema.ts` |
| low | robustness | boot-orchestrator.sh never adds the `radio` profile, so an opted-in AzuraCast is not restored to COMPOSE_PROFILES on NAS reboot | `nas\scripts\boot-orchestrator.sh` |
| low | ux | HAS_IPV6 is referenced by the SABnzbd service but is absent from .env.example, so the documented override is undiscoverable | `nas\scripts\docker-compose.yml`, `nas\scripts\.env.example` |
| low | ux | Modal dialogs set aria-modal but do not trap Tab focus; keyboard users can tab into the obscured background | `ImportProfileDialog.tsx`, `ExportProfileDialog.tsx`, `IssuesModal.tsx`, `TroubleshootingModal.tsx` |
| low | robustness | User-typed SiriusXM custom slugs are written into the CSV with no whitespace/separator scrubbing | `SiriusxmSelect.tsx`, `sync.sh` |
| low | security | qBittorrent.conf is written world-readable (644) but contains the WebUI password hash; sibling .env with the same secret is deliberately 600 | `setup-folders.sh`, `setup-chmod.sh` |
| low | dead-end | Cross-filesystem relocation interrupted mid-copy dead-ends on resume: dest_blocked aborts and the recovery step (clear the partial dest) is easy to miss | `relocate-stack.sh` |
| low | ux | UpdateRunScreen footer reports a failed action as 'paused — try again first', implying a resume that doesn't exist (these actions always re-run from scratch and there is no Retry control) | `UpdateRunScreen.tsx` |
| low | ux | MigrateScreen long-running imports (up to N arr titles / N torrents) have no cancel, and the loop is detached — a single hung item wedges the flow with Back/Continue disabled | `MigrateScreen.tsx` |
| low | idempotency | .env re-render blanks the NAS-generated SLSKD_API_KEY (not in the carry-forward list), rotating it on every re-run | `RunScreen.tsx`, `env-render.ts`, `setup.sh` |
| low | data-safety | A partial SFTP fastPut on a connection drop can leave a truncated .sh/.py on the NAS with no integrity check; the recorded .payload-sha is diagnostics-only | `sftp-service.ts`, `setup.sh` |
| low | robustness | Firewall's no-.env boot fallback claims to 'open all ports' but silently opens none for opt-in services (Soulseek 5030, AzuraCast 49157 + 8000-8029) | `setup-firewall.sh` |
| low | robustness | Guardian's inline fallback (when restart-qbit.sh is absent/non-executable) tears down gluetun to heal a qBit-WebUI-only fault, briefly dropping the VPN for the whole namespace | `qbit-guardian.sh` |
| low | error-handling | Steps 7-9 (core config / indexers / subtitle providers) have no abort_if_failed, so a failed core-config step still runs every dependent step and floods the log with cascade failures | `setup.sh` |
| low | idempotency | Boot/self-heal wiring runs on every pass including --from N, so a narrow re-run silently re-touches host cron/boot hooks | `setup.sh` |
| low | cross-platform | manual_hint() family classifier in install-boot-resilience.sh only knows synology/unraid/qnap — TrueNAS/OMV/UGREEN/asustor/terramaster/zimaos all get the generic 'sudo crontab -e' hint | `install-boot-resilience.sh` |
| low | cross-platform | diagnose-firewall.sh family detection omits asustor/terramaster/zimaos and orders OMV before UGREEN inconsistently with env-detector | `diagnose-firewall.sh`, `env-detector.ts` |
| low | dead-end | Indexer health check reports 0/N as a benign warn even when it indicates a real dead-end (no working source), and reuses the redacted list payload for the test | `post-deploy-validate.sh` |
| low | data-safety | plex-upload.py deletes the existing Plex playlist BEFORE the upload, so a transient upload failure destroys the user's playlist until the next daily run | `plex-upload.py` |
| low | error-handling | Spotify-only config with a SiriusXM-resolve-style failure still 'succeeds' as a no-op when creds are absent, but a Spotify-only run with EVERY source failing is reported only via per-source warns and a non-zero pass that nothing acts on | `sync.sh` |
| low | robustness | Download integrity check is size + 2-byte magic only — a same-size-but-corrupt or maliciously-substituted zip passes | `updater-service.ts` |
| low | error-handling | vpn-service fetches the WireGuard private key and lists countries with NO retry — a single transient host blip aborts the whole VPN setup | `vpn-service.ts` |
| low | error-handling | In-app update that fails to spawn the swap helper is recoverable, but a robocopy that fails AFTER the app quits relaunches the OLD build with only a %TEMP% log to explain why nothing changed | `updater-service.ts` |
