import { useEffect, useRef, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import { LogPanel, stripAnsi } from '../components/LogPanel.js'
import { LogActions } from '../components/LogActions.js'
import { PlexClaimRefresh } from '../components/PlexClaimRefresh.js'
import { PATH_PREFIX } from '../../shared/synology-path.js'
import { reportError } from '../store/errors.js'
import { renderEnv, type EnvFormValues } from '../../shared/env-render.js'
import { SETUP_STEPS, StepperRail, type SetupStep } from '../components/StepperRail.js'

type Phase =
  | 'idle'
  | 'uploading'
  | 'writing-env'
  | 'running-setup'
  | 'done'
  | 'failed'

const CHANNEL_ID = 'setup-sh-main'
const RERUN_CHANNEL_PREFIX = 'setup-sh-rerun-'

// setup.sh emits these markers in its run_step helper. We parse them
// from the streaming log to drive the StepperRail.
//
// Header (start of step):       │ Step 3: Apply firewall rules
// Footer (success):              ✔ Step 3 complete.
// Footer (failure):              ✘ Step 3 failed
const STEP_START_RE = /Step\s+(\d+):/
const STEP_OK_RE    = /✔\s*Step\s+(\d+)\s+complete/
const STEP_FAIL_RE  = /✘\s*Step\s+(\d+)\s+failed/

export function RunScreen() {
  const { sessionId, targetDir, config, setConfig, setStep } = useWizard()
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<{ pct: number; file: string } | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const linesRef = useRef<string[]>([])
  const [steps, setSteps] = useState<SetupStep[]>(() =>
    SETUP_STEPS.map((s) => ({ ...s })),
  )
  const [rerunningStep, setRerunningStep] = useState<number | null>(null)
  const [, setTick] = useState(0) // force re-render on log append
  /** Path of the on-disk install log for the current run. Set when go()
   *  starts a new run; surfaces in the header so the user can open it. */
  const [installLogPath, setInstallLogPath] = useState<string | null>(null)
  /** Tracks whether the current run has emitted an SFTP progress event
   *  yet. The first emit gets a fresh line; subsequent emits use \r to
   *  overwrite that line in place (one ticker, not 15 lines). */
  const sftpFirstRef = useRef(true)
  /** Last time we received a chunk on the setup.sh stream — drives the
   *  heartbeat in go() so the user knows we're not frozen. */
  const lastChunkAtRef = useRef<number>(Date.now())

  function resetSteps() {
    setSteps(SETUP_STEPS.map((s) => ({ ...s })))
  }

  function applyStepMarkers(newLines: string[]) {
    // Walk the new lines once and collect any state transitions we
    // observe, then commit a single setSteps update.
    const transitions: { idx: number; status: SetupStep['status'] }[] = []
    for (const raw of newLines) {
      const line = stripAnsi(raw)
      // Header lines look like:  "│ Step N: <description>"
      // The footer "✔ Step N complete." pattern is very similar — match
      // success/fail first so a "Step N complete" line isn't claimed by the
      // generic start matcher.
      const ok = line.match(STEP_OK_RE)
      if (ok) {
        transitions.push({ idx: Number(ok[1]) - 1, status: 'ok' })
        continue
      }
      const bad = line.match(STEP_FAIL_RE)
      if (bad) {
        transitions.push({ idx: Number(bad[1]) - 1, status: 'fail' })
        continue
      }
      const start = line.match(STEP_START_RE)
      if (start && line.includes('│')) {
        transitions.push({ idx: Number(start[1]) - 1, status: 'running' })
        continue
      }
    }
    if (transitions.length === 0) return
    setSteps((prev) => {
      const next = prev.map((s) => ({ ...s }))
      for (const t of transitions) {
        if (t.idx >= 0 && t.idx < next.length) next[t.idx].status = t.status
      }
      return next
    })
  }

  function appendChunk(text: string) {
    // Stream chunks may straddle line boundaries AND contain bare
    // carriage returns. Many CLIs (docker compose progress, curl, wget,
    // pip, npm) emit '\r' to redraw the same line in place — without
    // CR-handling, each frame becomes its own line and the panel fills
    // with hundreds of near-identical entries.
    //
    // CRITICAL: normalize CRLF → LF first. We open the remote channel
    // with pty:true, which puts the slave fd in ONLCR mode — every '\n'
    // that setup.sh writes becomes '\r\n' on the wire. Without this
    // normalize step, every normal line of output arrived as "text\r\n",
    // split on '\n' gave ["text\r", ""], and the trailing '\r' kicked
    // in the redraw logic below — wiping every single line of setup.sh
    // output as it came through. The panel looked frozen even though
    // the install was running fine. Only chunks WITHOUT \r\n (e.g.
    // renderer-internal wlog() calls) survived. Fix: strip the \r
    // in \r\n pairs FIRST, then any remaining bare \r really is a
    // redraw marker.
    text = text.replace(/\r\n/g, '\n')

    // Process the chunk in pieces split by cursor-up escapes. Docker
    // compose's fancy multi-line progress display emits "\x1b[<N>A\r"
    // to move the cursor up N rows before redrawing the block. Without
    // honoring this, each redraw frame stacks 16+ NEW lines onto the
    // buffer — within a minute the panel has 5000+ lines, scroll
    // can't keep up, and the user sees the spinner output flooding.
    // We split the chunk on those escapes, run the normal append
    // logic on each piece, and pop N buffer lines at each separator.
    // eslint-disable-next-line no-control-regex
    const CURSOR_UP_RE = /\x1b\[(\d*)A\r?/g
    const pieces: { text: string; popAfter: number }[] = []
    let lastIdx = 0
    let m: RegExpExecArray | null
    while ((m = CURSOR_UP_RE.exec(text)) !== null) {
      pieces.push({
        text: text.slice(lastIdx, m.index),
        popAfter: m[1] === '' ? 1 : Number(m[1]),
      })
      lastIdx = m.index + m[0].length
    }
    pieces.push({ text: text.slice(lastIdx), popAfter: 0 })

    const newlyCompleted: string[] = []
    if (linesRef.current.length === 0) linesRef.current.push('')

    for (const piece of pieces) {
      processSegments(piece.text, newlyCompleted)
      if (piece.popAfter > 0) {
        // Cursor moved up N — drop the last N lines we wrote and
        // reset the new last line to empty so the next bytes (which
        // come after the \r that's part of the same escape) write at
        // col 0, replacing whatever was there.
        const popCount = Math.min(piece.popAfter, linesRef.current.length - 1)
        if (popCount > 0) linesRef.current.splice(-popCount)
        if (linesRef.current.length > 0) {
          linesRef.current[linesRef.current.length - 1] = ''
        }
      }
    }

    // Cap memory.
    if (linesRef.current.length > 20_000) {
      linesRef.current.splice(0, linesRef.current.length - 20_000)
    }

    if (newlyCompleted.length > 0) applyStepMarkers(newlyCompleted)
    setTick((t) => t + 1)
  }

  /** Append the normal-text portion of a chunk to the buffer. Splits on
   *  '\n' and handles in-line '\r' for single-line redraws. */
  function processSegments(text: string, newlyCompleted: string[]) {
    if (text === '') return
    const segments = text.split('\n')
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const lastCR = seg.lastIndexOf('\r')
      const overwrite = lastCR >= 0
      const newContent = overwrite ? seg.slice(lastCR + 1) : seg

      if (i === 0) {
        if (overwrite) {
          linesRef.current[linesRef.current.length - 1] = newContent
        } else {
          linesRef.current[linesRef.current.length - 1] += newContent
        }
      } else {
        const finalised = linesRef.current[linesRef.current.length - 1]
        if (finalised && !overwrite) newlyCompleted.push(finalised)
        linesRef.current.push(newContent)
      }
    }
  }

  useEffect(() => {
    if (!sessionId) return
    const offData = window.installer.ssh.onStreamData((d) => {
      // Forward both the main install stream and any per-step re-runs
      // into the same log buffer.
      if (d.channelId !== CHANNEL_ID && !d.channelId.startsWith(RERUN_CHANNEL_PREFIX)) return
      lastChunkAtRef.current = Date.now()
      appendChunk(d.chunk)
    })
    const offClose = window.installer.ssh.onStreamClose((d) => {
      if (d.channelId === CHANNEL_ID) {
        setExitCode(d.exitCode)
        setPhase(d.exitCode === 0 ? 'done' : 'failed')
        // The remote setup.sh finished — flush + close the on-disk
        // log so it's complete on disk even if the app gets killed.
        window.installer.installLog.close().catch(() => { /* non-fatal */ })
        // Any remaining "running" steps after a clean exit are implicitly ok.
        // After a failed exit, the failed step already got marked fail by
        // the marker parser; leave others alone.
        if (d.exitCode === 0) {
          setSteps((prev) =>
            prev.map((s) => (s.status === 'running' ? { ...s, status: 'ok' } : s)),
          )
          // Clear the Plex claim — it's been consumed by the just-finished
          // install (or was empty). Either way, next time the user comes
          // here they should paste a fresh one rather than re-using the
          // dead token.
          setConfig({ PLEX_CLAIM: undefined })
        }
        return
      }
      if (d.channelId.startsWith(RERUN_CHANNEL_PREFIX)) {
        const stepNumber = Number(d.channelId.slice(RERUN_CHANNEL_PREFIX.length))
        setRerunningStep(null)
        // The transcript lines themselves carry "✔ Step N complete." or
        // "✘ Step N failed" which the marker parser already handled. As
        // a safety net, force the step to ok/fail based on exit code.
        setSteps((prev) => prev.map((s) =>
          s.number === stepNumber
            ? { ...s, status: d.exitCode === 0 ? 'ok' : 'fail' }
            : s,
        ))
      }
    })
    const offProg = window.installer.sftp.onProgress((p) => {
      setProgress({ pct: p.pctOverall, file: p.file })
      // Surface each file in the log too — so a wedged transfer is
      // visibly stuck on a specific file. After the first emit we
      // prefix '\r' (no '\n') so the line overwrites in place rather
      // than stacking 15 progress lines.
      const prefix = sftpFirstRef.current ? '\n' : '\r'
      sftpFirstRef.current = false
      appendChunk(`${prefix}\x1b[36m[sftp]\x1b[0m ${p.pctOverall}% — ${p.file}`)
    })
    return () => {
      offData()
      offClose()
      offProg()
    }
  }, [sessionId])

  async function rerunStep(stepNumber: number) {
    if (!sessionId || rerunningStep !== null) return
    const step = steps.find((s) => s.number === stepNumber)
    if (!step?.rerun) return

    setRerunningStep(stepNumber)
    setSteps((prev) =>
      prev.map((s) => (s.number === stepNumber ? { ...s, status: 'running' } : s)),
    )

    // Echo a small banner into the log so the user can find this re-run later.
    const banner = `\n--- Re-running step ${stepNumber}: ${step.label} ---\n`
    appendChunk(banner)

    try {
      await window.installer.ssh.execStream({
        sessionId,
        cmd:
          PATH_PREFIX +
          `cd ${shellQuote(targetDir)} && ${step.rerun}`,
        sudo: true,
        channelId: `${RERUN_CHANNEL_PREFIX}${stepNumber}`,
      })
    } catch (e) {
      appendChunk(`\nRe-run error: ${(e as Error).message}\n`)
      setRerunningStep(null)
      setSteps((prev) =>
        prev.map((s) => (s.number === stepNumber ? { ...s, status: 'fail' } : s)),
      )
      reportError(`Re-run step ${stepNumber}`, e)
    }
  }

  async function go() {
    if (!sessionId) {
      setErrorMsg('No SSH session. Go back and reconnect.')
      setPhase('failed')
      return
    }
    setErrorMsg(null)
    linesRef.current = []
    resetSteps()
    sftpFirstRef.current = true   // next sftp progress event starts a fresh line
    setTick((t) => t + 1)

    // Open a fresh on-disk install log. The main process mirrors
    // anything that flows through SSH exec channels to this file
    // automatically; wlog() also funnels through it so the user gets
    // a single complete transcript per run.
    try {
      const r = await window.installer.installLog.start('install')
      // Store the path so we can offer "open log file" later.
      setInstallLogPath(r.path)
    } catch (e) {
      // Non-fatal — the install still works, we just lose the local file.
      console.error('installLog.start failed', e)
    }

    // Helper: log a wizard-internal action into the same panel that
    // shows the streaming setup.sh output, so the user sees what's
    // happening before/between/after the script run. Prefix [wizard]
    // distinguishes our actions from setup.sh's output. ALSO mirror
    // to the on-disk install log via the dedicated append IPC, since
    // wlog() lines don't go through SSH and wouldn't otherwise land
    // in the file.
    const wlog = (msg: string) => {
      const line = `[wizard] ${msg}\n`
      appendChunk(`\x1b[36m[wizard]\x1b[0m ${msg}\n`)
      window.installer.installLog.append(line).catch(() => { /* non-fatal */ })
    }

    try {
      // 1. Make sure the target dir exists AND is writable by the SSH user.
      // The whole command runs inside `sudo bash -c '…'` for non-root
      // users, so naive `$(id -u)` would return 0 (root's uid) — making
      // chown a no-op. sudo sets $SUDO_UID/$SUDO_GID to the original
      // user's IDs; fall back to id -u/-g for the case where the user
      // is already root and no sudo was applied.
      //
      // Belt-and-suspenders: also chmod 0775 so the user's primary group
      // can write, in case ownership doesn't fully transfer due to ACLs
      // or shared-folder policies on Synology. And we now explicitly
      // *test* writability as the original SSH user (via su -c) so
      // failures surface here instead of cryptically inside SFTP.
      setPhase('uploading')
      wlog(`Preparing target directory ${targetDir}...`)
      const tq = shellQuote(targetDir)
      const prep = await window.installer.ssh.exec({
        sessionId,
        cmd:
          // use a subshell + set -x for inline diagnostics
          `set -e; ` +
          `mkdir -p ${tq}; ` +
          `OWNER_UID="\${SUDO_UID:-$(id -u)}"; OWNER_GID="\${SUDO_GID:-$(id -g)}"; ` +
          `echo "[prep] target=${targetDir} owner_uid=$OWNER_UID owner_gid=$OWNER_GID effective=$(id -u):$(id -g)"; ` +
          `chown -R "$OWNER_UID:$OWNER_GID" ${tq}; ` +
          `chmod -R u+rwX,g+rwX ${tq}; ` +
          `echo "[prep] now owned by $(stat -c '%u:%g' ${tq}) perms=$(stat -c '%a' ${tq})"; ` +
          // Sanity-test write access AS the original user. If the SSH
          // user genuinely can't write here, fail now with a clear msg
          // rather than letting SFTP get a generic Permission denied.
          // -m preserves the current environment instead of trying to
          // chdir to the user's home (which doesn't exist on Synology
          // when User Home Service is disabled). Avoids the noisy
          // "Could not chdir to home directory" stderr line.
          `if [ -n "\${SUDO_USER:-}" ]; then ` +
          `  if su -m "$SUDO_USER" -c "touch ${tq}/.installer_write_test && rm ${tq}/.installer_write_test" 2>/dev/null; then ` +
          `    echo "[prep] SSH user $SUDO_USER can write — ok"; ` +
          `  else ` +
          `    echo "[prep] WARN: SSH user $SUDO_USER cannot write (ACL/share policy?)"; ` +
          `    exit 13; ` +
          `  fi; ` +
          `else ` +
          `  echo "[prep] running as root directly — SFTP will too — ok"; ` +
          `fi`,
        sudo: true,
      })
      // Always log the prep output so the user sees what happened
      // regardless of pass/fail.
      if (prep.stdout.trim()) wlog(prep.stdout.trim())
      if (prep.stderr.trim()) wlog(`stderr: ${prep.stderr.trim()}`)
      if (prep.exitCode !== 0) {
        throw new Error(
          `Couldn't prepare ${targetDir} (exit ${prep.exitCode}): ${(prep.stderr || prep.stdout || '').slice(0, 500)}`,
        )
      }

      // The renderer can't read disk. We pass the sentinel "@payload" and
      // the main process's sftp-service resolves it via payload-resolver.
      // Renderer never learns absolute filesystem paths.
      // Wrap in a timeout so a wedged SFTP doesn't park the UI forever.
      wlog('Uploading nas/ payload via SFTP...')
      const SFTP_TIMEOUT_MS = 5 * 60 * 1000
      const uploadResult = await Promise.race([
        window.installer.sftp.uploadDir({
          sessionId,
          localDir: '@payload',
          remoteDir: targetDir,
        }),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error(
              `SFTP upload didn't complete within ${SFTP_TIMEOUT_MS / 60_000} min. ` +
              `Likely a permission problem — try logging in as root, ` +
              `or check that ${targetDir} is writable by your SSH user.`,
            )),
            SFTP_TIMEOUT_MS,
          ),
        ),
      ])
      wlog(`Uploaded ${uploadResult.uploaded} files (${(uploadResult.bytesTotal / 1024).toFixed(1)} KiB)`)

      // 2. Write the .env file with secrets.
      // Back up any existing .env first so the user can recover if our
      // form lost a value (we collect everything in .env.example, but a
      // user might have hand-added something custom).
      setPhase('writing-env')
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      wlog('Backing up any existing .env...')
      await window.installer.ssh.exec({
        sessionId,
        cmd: `[ -f ${shellQuote(`${targetDir}/.env`)} ] && cp -p ${shellQuote(`${targetDir}/.env`)} ${shellQuote(`${targetDir}/.env.backup-${ts}`)} && echo "backed up to .env.backup-${ts}" || echo "(no prior .env)"`,
        sudo: true,
      }).then((r) => wlog(r.stdout.trim() || '(done)'))

      wlog(`Writing ${targetDir}/.env (${Object.keys(config).filter((k) => (config as Record<string, unknown>)[k]).length} populated keys)...`)
      const envText = renderEnv(config as EnvFormValues)
      await window.installer.sftp.writeFile({
        sessionId,
        remotePath: `${targetDir}/.env`,
        content: envText,
        mode: 0o600,
      })
      wlog('.env written (mode 0600)')

      wlog('Starting setup.sh — output will stream below ↓')

      // 3. Stream-run setup.sh. PATH has to be augmented because SSH non-
      // interactive shells on Synology don't include the Docker package
      // paths by default, so setup.sh would otherwise see "docker: command
      // not found" even though docker is installed. The exit code arrives
      // via the stream-close event handled in useEffect.
      //
      // Heartbeat: log progress every 3s if there's been no output for
      // more than 5s. Aggressive on purpose — long silences are the
      // worst UX, and on Synology there are real causes (slow image
      // pull, denied PTY → buffered output) where we WILL stay quiet.
      setPhase('running-setup')
      const setupStartTs = Date.now()
      lastChunkAtRef.current = setupStartTs
      const heartbeat = setInterval(() => {
        const elapsed = Date.now() - setupStartTs
        const sinceLast = Date.now() - lastChunkAtRef.current
        if (sinceLast > 5_000) {
          wlog(`(still working — ${Math.floor(elapsed / 1000)}s elapsed, ${Math.floor(sinceLast / 1000)}s since last output)`)
          lastChunkAtRef.current = Date.now()
        }
      }, 3_000)
      try {
        // Defeat block-buffering: when stdout isn't a tty, glibc-linked
        // programs (docker, curl, etc.) buffer ~4–8 KiB before flushing,
        // so we see nothing on the wire until they exit. Three fallbacks
        // in order of preference:
        //
        //   1. script -qfc … /dev/null  — util-linux, allocates a fresh
        //      pty and runs the command inside it; programs see a real
        //      tty and line-buffer.
        //   2. stdbuf -oL -eL bash …    — coreutils; injects an LD_PRELOAD
        //      that switches stdout/stderr to line-buffered.
        //   3. bash … 2>&1 | awk        — busybox awk is everywhere on
        //      Synology, and `fflush()` after each print forces the line
        //      through the pipe immediately. We capture the bash exit
        //      code via ${PIPESTATUS[0]} since the pipe's exit is awk's.
        //
        // Each branch echoes a "using: …" line so the log tells us which
        // path actually ran when we're debugging silent installs.
        const targetSh = shellQuote(`${targetDir}/setup.sh`)
        await window.installer.ssh.execStream({
          sessionId,
          cmd:
            PATH_PREFIX +
            // Force docker compose to use plain output even when its
            // stdout is a tty (which it will be under script(1)). Without
            // these, docker draws a multi-line spinner that floods the
            // log with redraw frames. setup.sh also exports these, but
            // setting them here makes us robust to older setup.sh
            // payloads or shell variants that drop the export.
            `export COMPOSE_PROGRESS=plain COMPOSE_ANSI=never DOCKER_CLI_HINTS=false; ` +
            `echo "[wizard-debug] before setup.sh: $(date)"; ` +
            `if command -v script >/dev/null 2>&1; then ` +
            `  echo "[wizard-debug] using: script -qfc (forced pty)"; ` +
            `  script -qfc "bash ${targetSh}" /dev/null 2>&1; rc=$?; ` +
            `elif command -v stdbuf >/dev/null 2>&1; then ` +
            `  echo "[wizard-debug] using: stdbuf -oL -eL"; ` +
            `  stdbuf -oL -eL bash ${targetSh} 2>&1; rc=$?; ` +
            `elif command -v awk >/dev/null 2>&1; then ` +
            `  echo "[wizard-debug] using: bash | awk fflush"; ` +
            `  bash ${targetSh} 2>&1 | awk '{ print; fflush() }'; rc=\${PIPESTATUS[0]}; ` +
            `else ` +
            `  echo "[wizard-debug] using: plain bash (output may be block-buffered)"; ` +
            `  bash ${targetSh} 2>&1; rc=$?; ` +
            `fi; ` +
            `echo "[wizard-debug] after setup.sh (rc=$rc): $(date)"; exit $rc`,
          sudo: true,
          channelId: CHANNEL_ID,
        })
      } finally {
        clearInterval(heartbeat)
      }
    } catch (e) {
      setErrorMsg((e as Error).message)
      setPhase('failed')
      reportError('Install', e)
    }
  }

  // Pre-install screen: just the Plex claim widget and a big Start CTA.
  // Showing the empty stepper + empty log here was confusing — users
  // thought the install was running and stuck.
  if (phase === 'idle') {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-2xl mx-auto p-8 space-y-6">
          <header>
            <h1 className="text-2xl font-semibold">Ready to install</h1>
            <p className="text-slate-400 text-sm mt-1">
              The wizard will upload <code className="bg-slate-800 px-1 rounded">{targetDir}</code>{' '}
              to your NAS, write the <code className="bg-slate-800 px-1 rounded">.env</code>,
              and run <code className="bg-slate-800 px-1 rounded">setup.sh</code>{' '}
              with live output.
            </p>
          </header>

          <PlexClaimRefresh
            value={config.PLEX_CLAIM}
            onChange={(claim) => setConfig({ PLEX_CLAIM: claim })}
          />

          {errorMsg && (
            <div className="bg-rose-900/40 text-rose-200 rounded-md px-3 py-2 text-sm whitespace-pre-wrap font-mono">
              {errorMsg}
            </div>
          )}

          <div className="flex justify-between pt-4 border-t border-slate-800">
            <button
              onClick={() => setStep('configure')}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md"
            >
              Back
            </button>
            <button
              onClick={go}
              className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 rounded-md text-base font-medium shadow-lg shadow-emerald-900/30"
            >
              Start install →
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Active install / completed view: stepper + streaming log.
  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Installing the stack</h1>
        <div className="flex items-center gap-3">
          {installLogPath && (
            <button
              onClick={() => window.installer.installLog.reveal()}
              className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 rounded border border-slate-700"
              title={installLogPath}
            >
              Open log file
            </button>
          )}
          {linesRef.current.length > 0 && (
            <LogActions
              lines={linesRef.current}
              defaultName="mediarr-install.log"
              header={`exit=${exitCode ?? 'pending'} phase=${phase}`}
            />
          )}
          <div className="text-sm text-slate-400">
            {phase === 'uploading' && `Uploading files... ${progress?.pct ?? 0}%`}
            {phase === 'writing-env' && 'Writing .env'}
            {phase === 'running-setup' && 'Running setup.sh'}
            {phase === 'done' && 'Setup complete'}
            {phase === 'failed' && (errorMsg ? `Failed: ${errorMsg}` : `Setup exited ${exitCode}`)}
          </div>
        </div>
      </header>

      {phase === 'uploading' && progress && (
        <div className="space-y-1">
          <div className="w-full bg-slate-800 rounded h-2 overflow-hidden">
            <div className="h-2 bg-emerald-500 transition-all" style={{ width: `${progress.pct}%` }} />
          </div>
          <div className="text-xs text-slate-500 font-mono truncate">
            {progress.file}
          </div>
        </div>
      )}

      {/* Two-pane: stepper rail on the left, streaming log on the right */}
      <div className="flex-1 min-h-0 grid grid-cols-[260px_1fr] gap-4">
        <aside className="overflow-y-auto rounded-md border border-slate-800 bg-slate-900/40 p-4">
          <h2 className="text-xs uppercase tracking-wide text-slate-400 mb-3">
            setup.sh steps
          </h2>
          <StepperRail
            steps={steps}
            onRerun={phase === 'done' || phase === 'failed' ? rerunStep : undefined}
            rerunningStep={rerunningStep}
          />
          {(phase === 'done' || phase === 'failed') && (
            <p className="mt-3 text-xs text-slate-500">
              Hover a finished step to re-run it. Each script is idempotent.
            </p>
          )}
        </aside>
        <div className="min-h-0">
          <LogPanel lines={linesRef.current} />
        </div>
      </div>

      {phase === 'failed' && (
        <PlexClaimRefresh
          value={config.PLEX_CLAIM}
          onChange={(claim) => setConfig({ PLEX_CLAIM: claim })}
        />
      )}

      <div className="flex justify-between">
        <button
          onClick={() => setStep('configure')}
          disabled={phase === 'uploading' || phase === 'running-setup'}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md disabled:opacity-40"
        >
          Back
        </button>
        {phase === 'failed' ? (
          <button
            onClick={go}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md"
          >
            Retry
          </button>
        ) : phase === 'done' ? (
          <button
            onClick={() => setStep('done')}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md"
          >
            Continue
          </button>
        ) : null}
      </div>
    </div>
  )
}

// Shell-quote for embedding into a remote bash command.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
