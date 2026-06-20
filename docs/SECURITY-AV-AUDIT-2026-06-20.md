# Security / Antivirus Audit — "virus" alerts (2026-06-20)

**Trigger:** Windows Defender raised threat alerts that appeared to originate from
Claude Code sessions. This audit determines whether any malware exists in the
repository, in any published release, or on this machine, and explains what
Defender actually detected.

## Verdict

**No malware.** There is no virus in the repository, in any release artifact's
source, or as a live threat on this machine. All three Defender alerts are
**behavioral / AMSI false-positives on PowerShell command-lines** that were
generated and run by Claude Code sessions — not file infections, not committed
code, not shipped binaries. Every detection is already neutralized
(`IsActive = False`).

The one genuine, actionable finding is a *product* concern, not a virus: the
installer's **self-updater uses a VBScript → hidden-`cmd.exe` swap technique**
that antivirus behavioral engines legitimately flag. That technique ships in
every release since **v0.4.0** and is what the "virus-looking" reproduction
scripts were modeling.

---

## 1. What Defender actually detected

Source: `Get-MpThreatDetection` / `Get-MpThreat` on this machine.

| When (2026) | Threat name | What it scanned | Origin | In repo? | Active? |
|---|---|---|---|---|---|
| 06-20 02:26 | `Trojan:Win32/ClickFix.EEI!MTB` | `CmdLine:` PowerShell | **DokiDex** llama.cpp/llama-swap binary download (`curl` GitHub releases → extract → run `.exe`) | No | No |
| 06-18 18:44 | `Trojan:Win32/PowhidSubExec.B` | `CmdLine:` PowerShell | Mediarr updater **relaunch-hang reproduction** (`swapavrace_*`) | No | No |
| 06-18 18:44 | `Trojan:Win32/PowhidSubExec.B` | `CmdLine:` PowerShell | Same reproduction, second variant | No | No |

Key facts:

- **Every detection's `Resources` is `CmdLine:_…powershell…`** — Defender's AMSI
  scanned the *script text as it executed*. No file, no binary, no repo artifact
  was flagged or quarantined.
- **Threat names are heuristics, not signatures:**
  - `PowhidSubExec` = "PowerShell hidden subprocess execution" — fires on
    *PowerShell that launches a hidden child process*. The repro scripts write a
    `.vbs` that runs `cmd.exe` hidden (`intWindowStyle = 0`). That shape is
    indistinguishable from a malware loader to a behavioral engine.
  - `ClickFix…!MTB` = machine-learning ("Monitoring Threat Behavior") detection
    of download-and-run chains (`curl` an `.exe` from the internet and execute
    it).
- All `IsActive = False` → Defender already handled them; nothing is live.

## 2. Why the reproduction scripts "reference the installer"

This was the sharp question, and it has a clean answer: **the `swapavrace_*`
scripts are minimized copies of the installer's *own* self-updater swap helper**,
used as test fixtures. A prior Claude session was debugging the v0.16.x
"update never relaunches" bug (see the v0.16.2 → v0.16.7 commit run) and
reproduced the installer's real swap/relaunch dance in `%TEMP%` to confirm the
"AV quarantine race / hidden-dialog hang" failure mode — hence the literal
`Mediarr Installer.exe`, the `RC` robocopy exit-code logic, and the
`about to relaunch` log lines.

They reference the installer because they are *about* the installer's updater —
but they are **not part of the product, not in the repo, and self-deleted**
(`[System.IO.Directory]::Delete($root, $true)`). The `swapavrace_*` and
`doki-llm-*` temp directories are already gone from this machine.

## 3. The real shipped concern: the self-updater technique

`installer/src/main/updater-service.ts` performs in-place self-update like this:

1. Download the new build `.zip` from GitHub releases; extract via PowerShell.
2. `writeSwapScript()` writes **two files to `%TEMP%`**:
   - `mediarr-swap-<pid>.cmd` — waits for the app's processes to exit, robocopies
     the staged build into a sibling dir, atomically swaps it into the install
     dir, relaunches `Mediarr Installer.exe`, self-deletes.
   - `mediarr-swap-<pid>.vbs` — `CreateObject("WScript.Shell").Run "cmd.exe /c …", 0, False`
     → runs the `.cmd` **hidden**.
3. `spawn('wscript.exe', [vbs], { windowsHide: true, detached: true })`, then quit.

This is legitimate (the `.vbs` wrapper exists because `cmd.exe` + `windowsHide`
doesn't reliably hide under Windows Terminal — see the code comment), **but it is
exactly the "script drops a hidden cmd that copies executables and launches a new
.exe" behavior AV flags.** The code itself already treats AV as a known failure
mode: it handles the swap helper being *"blocked by AppLocker/SRP/GPO/AV"*.

**Affected releases:** introduced in commit `ac63651` (**installer-v0.4.0**,
"portable Windows zip + custom in-app updater"). Present in **all 105 release
tags from `installer-v0.4.0` through `installer-v0.16.13`** (current). The
pre-v0.4.0 builds used `electron-updater` and did not write a `.vbs`.

Impact of this technique (none of which is "a virus"):

- Trips the developer's own Defender during update testing / reproduction — what
  you saw.
- Can cause an end user's AV to quarantine the swap helper or the relaunched
  `.exe` mid-update, breaking self-update.
- The published `.exe` is unsigned, so SmartScreen / reputation engines have no
  trust anchor to offset the heuristic.

## 4. Repository & release scan (clean)

- **Working tree (this session):** test-only. `git status` shows exclusively the
  Vitest scaffold, new `installer/test/`, and two behavior-neutral refactors
  (`splitTrailingUrl` → `shared/update-message.ts`; exporting `envObject`).
  Nothing injected.
- **No script-dropper files anywhere:** glob for `*.vbs *.hta *.scr *.jse *.wsf
  *.pif` across the whole repo → **0 files**.
- **No stray binaries:** no tracked `*.exe/*.dll/*.vbs/*.scr/*.hta/*.bat/*.jar`
  outside `node_modules/` and `installer/dist/` (build output).
- **Only one tracked file references the VBScript/hidden-exec patterns:**
  `installer/src/main/updater-service.ts` — the legitimate updater, which
  *generates* the helper at runtime. The `.vbs` is **never committed and never
  shipped**; it is written on the user's machine at update time.
- **Shipped NAS payload** (`nas/`, `installer/resources/nas-payload/`) is bash +
  Python (already CI-linted with shellcheck / py_compile); the only non-script
  file is `nas/scripts/playlistsync/Dockerfile`.

**Caveat (honesty):** this verifies the *source* the releases are built from. I
did not bit-for-bit re-download and hash each published GitHub `.zip`, nor deeply
audit bundled `node_modules` production dependencies. See recommendations.

## 5. This machine

- `swapavrace_*`, `doki-llm-*` temp dirs: **gone** (self-deleted).
- All Defender detections: **neutralized** (`IsActive = False`).
- **Leftover, benign:** ~12 `mediarr-swap-<pid>.cmd` + `.vbs` pairs and
  `mediarr-update.log` in `%TEMP%`, dated 06-15…06-19 — abandoned helpers from
  the real app self-updating / being tested. Harmless, but they are the same
  AV-triggering shape, so they are worth deleting (done / offered — see below).

## 6. Recommendations

1. **Clean the `%TEMP%\mediarr-swap-*` leftovers** (stale; reduces future false
   alarms).
2. **Vet AI-run commands going forward** for AV-triggering shapes — hidden
   `wscript`/`cmd`, `curl | run .exe`, base64/`IEX`. Prefer visible, non-VBS
   reproductions when testing the updater.
3. **Product — reduce updater AV false-positives** (biggest wins first):
   - **Code-sign** the `.exe` and the swap helper. A signed, reputable binary is
     the single biggest reducer of SmartScreen/AV friction.
   - Reconsider the **VBS + hidden-cmd** mechanism: a small signed helper `.exe`,
     a scheduled task, or a non-hidden console swap would all look far less like
     a loader.
   - At minimum, **document the AV caveat** for users (and that a quarantined
     swap helper means "re-run the update / add an exclusion").
4. **Dependency hygiene:** run `npm audit` and review the lockfile so "no malware
   in releases" also covers bundled deps, not just first-party source.

## Appendix — provenance summary

All three flagged command-lines were generated by Claude Code sessions and run
through its PowerShell tool (the trailing `claude-pwd-ps-*` markers are that
tool's wrapper):

- **DokiDex download** — a *different project*; fetches `llama.cpp` / `llama-swap`
  (legit open-source LLM binaries) from GitHub. Unrelated to Mediarr.
- **Two `swapavrace_*` reproductions** — Mediarr updater relaunch-bug fixtures,
  transient, self-deleted.

None are malicious in intent; two of three are genuinely AV-worthy *techniques*
(hidden subprocess execution; download-and-run) that a behavioral engine is
right to flag regardless of who authored them.
