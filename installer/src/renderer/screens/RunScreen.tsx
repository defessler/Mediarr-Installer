import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import {
  Rocket, ArrowLeft, ArrowRight, AlertCircle, RotateCw, CheckCircle2,
  XCircle, AlertTriangle, Clock,
} from 'lucide-react'
import { useWizard } from '../store/wizard.js'
import { LogPanel, stripAnsi } from '../components/LogPanel.js'
import { LogActions } from '../components/LogActions.js'
import { PlexClaimRefresh } from '../components/PlexClaimRefresh.js'
import { IssuesModal } from '../components/IssuesModal.js'
import { BigButton } from '../components/BigButton.js'
import { PATH_PREFIX } from '../../shared/synology-path.js'
import { reportError } from '../store/errors.js'
import { renderEnv, isEnabled, type EnvFormValues } from '../../shared/env-render.js'
import { SETUP_STEPS, StepperRail, type SetupStep } from '../components/StepperRail.js'
import { toConnectConfig } from '../../shared/connect-config.js'

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

// WHY: setup.sh emits run_step markers for steps 1..12 (TOTAL_STEPS=12 in
// nas/scripts/setup.sh — steps 11 "Import any download backlog" and 12
// "Auto-confirm manual imports" were added after the shared SETUP_STEPS
// table was last synced). The imported SETUP_STEPS only covers 1..10, so
// the Step 11/12 markers parsed by applyStepMarkers fell outside the steps
// array bounds (idx 10/11 >= length 10) and were silently dropped — the
// last two steps never lit up. We reconcile to the full 12 here by spreading
// the shared 10-step table and appending the two missing entries (labels
// copied verbatim from setup.sh's run_step calls; rerun commands follow the
// established scripts/ style). We build a NEW array rather than mutating the
// imported SETUP_STEPS so other consumers (UpdateRunScreen) are unaffected.
const RUN_SCREEN_STEPS: SetupStep[] = [
  ...SETUP_STEPS,
  { number: 11, label: 'Import any download backlog',   status: 'pending', rerun: 'bash scripts/fix-imports.sh' },
  { number: 12, label: 'Auto-confirm manual imports',   status: 'pending', rerun: 'python3 scripts/auto-manual-import.py' },
]

export function RunScreen() {
  const { sessionId, targetDir, config, setConfig, setStep, activeProfileId, recordRunResult, clearRunResult, connection, setSessionId, setBusy } = useWizard()
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<{ pct: number; file: string } | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Track when the current run started so we can show "X min running"
  // alongside the progress bar. Resets when a new run starts (Retry /
  // first-run go()). Cleared when phase reaches done / failed so the
  // user doesn't keep seeing the counter climb post-finish.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number>(0)
  const linesRef = useRef<string[]>([])
  const [steps, setSteps] = useState<SetupStep[]>(() =>
    // RUN_SCREEN_STEPS = the full 1..12 setup.sh step list (SETUP_STEPS only
    // ships 1..10; see the WHY comment on RUN_SCREEN_STEPS above).
    RUN_SCREEN_STEPS.map((s) => ({ ...s })),
  )
  // Mirror `steps` into a ref so the stream-close handler can read the
  // latest array WITHOUT going through a setSteps setter callback —
  // React StrictMode runs setter callbacks twice in dev, and the close
  // handler's side-effect (recordRunResult) would fire twice as a
  // result. The ref read is single-shot.
  const stepsRef = useRef<SetupStep[]>(steps)
  useEffect(() => { stepsRef.current = steps }, [steps])
  const [rerunningStep, setRerunningStep] = useState<number | null>(null)
  const [, setTick] = useState(0) // force re-render on log append
  /** Path of the on-disk install log for the current run. Set when go()
   *  starts a new run; surfaces in the header so the user can open it. */
  const [installLogPath, setInstallLogPath] = useState<string | null>(null)
  /** True after we've signalled setup.sh to stop but before the stream
   *  closes — drives the Cancel button's "Stopping…" label. */
  const [canceling, setCanceling] = useState(false)
  // Mirror `canceling` into a ref so the stream-close handler reads the LIVE
  // value — its listener closure captures a stale `canceling` (the effect deps
  // are [sessionId]). Lets us tell a user-Cancel apart from a real drop.
  const cancelingRef = useRef(false)
  useEffect(() => { cancelingRef.current = canceling }, [canceling])
  // Safety net for a swallowed Cancel. streamCancel is best-effort; if the
  // remote command ignores the signal (or the close event never arrives), the
  // stream never closes, onStreamClose never fires, and `canceling` would stay
  // true forever — pinning the UI on "Stopping…" with Back + the stepper
  // busy-locked, recoverable only by restarting the app. After a grace period,
  // force-unlock locally: setup.sh is idempotent/resumable, so dropping to
  // 'failed' is safe (the user can Retry to resume, or navigate away). The
  // normal path clears `canceling` well within the window, cancelling this.
  useEffect(() => {
    if (!canceling) return
    const t = setTimeout(() => {
      setCanceling(false)
      setPhase((p) => (p === 'running-setup' ? 'failed' : p))
    }, 15_000)
    return () => clearTimeout(t)
  }, [canceling])
  /** True when the last run ended because the SSH connection DROPPED (stream
   *  closed with a null exit and no Cancel in flight) rather than setup.sh
   *  failing a step. We keep phase==='failed' so the whole failed-state UI works
   *  unchanged, and only swap the Retry button for "Reconnect & resume". */
  const [droppedConnection, setDroppedConnection] = useState(false)
  /** True while reconnect-and-resume is re-establishing SSH (drives the label). */
  const [reconnecting, setReconnecting] = useState(false)
  /** Issues parsed out of the streaming log. Surfaces failures and
   *  warnings from setup-arr-config.py et al as a tidy summary above
   *  the log panel, so the user doesn't have to scroll 500 lines to
   *  know what needs attention. Updated incrementally as chunks
   *  arrive; cleared at the start of each run. */
  const [issues, setIssues] = useState<{
    severity: 'fail' | 'warn' | 'note'
    text: string
  }[]>([])
  /** Which tab the IssuesModal opened on, or null if closed. The
   *  buttons set this to 'fail' or 'action'; the modal calls
   *  setIssuesModal(null) on close. Living here rather than inside
   *  IssuesModal means clicking a different button mid-open re-mounts
   *  the modal with a fresh initialTab. */
  const [issuesModal, setIssuesModal] = useState<'fail' | 'action' | null>(null)
  /** Tracks whether the current run has emitted an SFTP progress event
   *  yet. The first emit gets a fresh line; subsequent emits use \r to
   *  overwrite that line in place (one ticker, not 15 lines). */
  const sftpFirstRef = useRef(true)
  /** Last time we received a chunk on the setup.sh stream — drives the
   *  heartbeat in go() so the user knows we're not frozen. */
  const lastChunkAtRef = useRef<number>(Date.now())
  /** The exact .env text rendered for the last run (the pure render, before the
   *  API-key carry-forward). On a normal-failure Retry we re-render the current
   *  config and compare: byte-identical means the user changed nothing, so we
   *  can resume setup.sh from the failed step (the on-NAS .env + its .setup-state
   *  hash are still valid) instead of rewriting .env and replaying from step 1.
   *  Any real config edit shows up in the render (the .env round-trip invariant),
   *  forcing a full go(). Null until the first run writes it → Retry → go(). */
  const lastRenderedEnvRef = useRef<string | null>(null)
  // Guards go() against re-entry from a double-click on "Start install".
  // phase stays 'idle' through go()'s async prelude (the installLog.start
  // await) until setPhase('uploading'), so a second queued click would
  // otherwise launch a SECOND setup.sh on the same hardcoded SSH channel
  // (the two streams then race on activeChannels + onStreamClose). A
  // synchronous ref closes that window; the effect below clears it once the
  // run reaches a terminal/idle phase so Retry can legitimately call go().
  const goRunningRef = useRef(false)
  useEffect(() => {
    if (phase === 'idle' || phase === 'done' || phase === 'failed') {
      goRunningRef.current = false
    }
  }, [phase])

  // Publish a global "busy" flag while an install (or a single-step
  // re-run) is in flight, so App.tsx can disable the in-place app-updater
  // trigger — self-updating quits + swaps the binary, which would kill a
  // live setup.sh job. Cleared automatically once phase settles on
  // done/failed, and on unmount as a safety net.
  useEffect(() => {
    const active =
      phase === 'uploading' ||
      phase === 'writing-env' ||
      phase === 'running-setup' ||
      rerunningStep !== null
    setBusy(active)
  }, [phase, rerunningStep, setBusy])
  useEffect(() => () => setBusy(false), [setBusy])

  function resetSteps() {
    // Reset to the full 1..12 list (see RUN_SCREEN_STEPS WHY comment) so a
    // Retry re-arms steps 11 and 12 too, not just the 10 in SETUP_STEPS.
    setSteps(RUN_SCREEN_STEPS.map((s) => ({ ...s })))
  }

  /** Parse a completed log line for issue markers (✘, ⚠, !) and append
   *  to the issues list. We deliberately ignore noise that's loud in
   *  the log but not actionable: ANSI escapes, step-footer banners
   *  ("✘ Step 7 failed" — already shown in the stepper), and the
   *  end-of-script summary line. */
  function tryRecordIssue(rawLine: string) {
    const line = stripAnsi(rawLine).replace(/\s+/g, ' ').trim()
    if (!line) return
    // Skip the step-footer marker — stepper already shows it.
    if (/^✘\s*Step\s+\d+/.test(line)) return
    // Skip the "Done with N error(s)" summary banner — not actionable
    // on its own; the individual ✘ entries above it are.
    if (/^Done with \d+ error/i.test(line)) return
    let severity: 'fail' | 'warn' | 'note' | null = null
    let text = ''
    // Failure: lines starting with ✘ (with optional leading spaces).
    const failMatch = line.match(/^✘\s+(.+)$/)
    if (failMatch) { severity = 'fail'; text = failMatch[1] }
    // Warning: ⚠ marker (from setup-validate.sh).
    const warnMatch = !severity && line.match(/^⚠\s+(.+)$/)
    if (warnMatch) { severity = 'warn'; text = warnMatch[1] }
    // Note / "needs manual action": ! marker (used liberally by the
    // arr-config script for "set this in the UI manually" hints).
    const noteMatch = !severity && line.match(/^!\s+(.+)$/)
    if (noteMatch) { severity = 'note'; text = noteMatch[1] }
    // Raw failures that DON'T carry our ✘ glyph and would otherwise produce
    // zero issue entries — leaving the real failure buried in 500 log lines:
    // a Python traceback from a crashed setup-*.py, or a docker daemon error.
    if (!severity && /^Traceback \(most recent call last\)/.test(line)) {
      severity = 'fail'; text = 'A setup script crashed (Python traceback) — see the log below'
    }
    if (!severity) {
      const dockerErr = line.match(/^Error response from daemon:\s*(.+)$/)
      if (dockerErr) { severity = 'fail'; text = 'Docker error: ' + dockerErr[1] }
    }
    // Deliberately NOT matched: ℹ (U+2139). The bash/python helpers
    // use info() with that prefix for self-healing or non-actionable
    // status (CloudFlare-blocked indexers that Flaresolverr will heal
    // on first search; Seerr library selection that's part of normal
    // UI setup). Including it in the issues panel made successful
    // installs look broken. If you ever want to surface info, add a
    // separate 'info' severity tier — don't promote ℹ into this set.
    if (!severity) return
    // Trim trailing punctuation noise.
    text = text.replace(/[.\s]+$/, '').slice(0, 280)
    setIssues((prev) => {
      // De-dup by exact-text match across the whole history (not just
      // adjacent). Same root cause can emit identical issue lines from
      // multiple retry/probe cycles inside one install run — previously
      // only the adjacent-duplicate case was caught, so a user with a
      // genuinely-flaky service would see the same issue 3-4 times in
      // the modal. Per-text-once is the right granularity here:
      // different text = different problem worth surfacing.
      if (prev.some((it) => it.text === text)) return prev
      return [...prev, { severity: severity!, text }]
    })
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

    if (newlyCompleted.length > 0) {
      applyStepMarkers(newlyCompleted)
      // Same loop also feeds the issues parser — every newly-finalised
      // line gets scanned for ✘/⚠/! markers so the summary panel
      // updates as the install progresses.
      for (const line of newlyCompleted) tryRecordIssue(line)
    }
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
        // A null exit with no Cancel in flight = the channel died (socket drop
        // or the 30-min stall abort), not a setup.sh step failure. Flag it so
        // the footer offers "Reconnect & resume" (re-runs setup.sh --resume from
        // the .setup-state checkpoint) instead of a from-scratch Retry.
        setDroppedConnection(d.exitCode === null && !cancelingRef.current)
        setCanceling(false)
        setPhase(d.exitCode === 0 ? 'done' : 'failed')
        // The remote setup.sh finished — flush + close the on-disk
        // log so it's complete on disk even if the app gets killed.
        window.installer.installLog.close().catch(() => { /* non-fatal */ })
        // Persist the run result against the active profile so Welcome
        // can flag "last install failed at step N" if the user closes
        // the app and comes back later. On success we clear the entry
        // (fresh slate); on failure we record exitCode + the first
        // step that's still in 'running' or 'fail' state, which the
        // marker parser populated.
        //
        // Read the current steps via the Zustand store directly (NOT
        // via a setSteps setter side-effect — React StrictMode runs
        // setter callbacks twice on dev, which would record the run
        // result twice and the second `recordRunResult` call would
        // see Date.now() a few µs later and update finishedAt to a
        // slightly-different value, churning persisted state for no
        // reason). useWizard.getState() reads the latest steps array
        // without any subscription / lifecycle gymnastics.
        if (activeProfileId) {
          if (d.exitCode === 0) {
            clearRunResult(activeProfileId)
          } else {
            const currentSteps = stepsRef.current
            const failed = currentSteps.find((s) => s.status === 'fail' || s.status === 'running')
            recordRunResult(activeProfileId, {
              phase: 'failed',
              exitCode: d.exitCode,
              failedStep: failed?.number,
            })
          }
        }
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
    // Clear the issues list when starting a step rerun. Issues from the
    // PREVIOUS attempt of this step are stale by definition — the user
    // is re-running because they presumably fixed something. Issues
    // from OTHER steps will be re-parsed if they recur during this
    // session's log scroll, but we don't expect those to be re-emitted
    // by a single-step rerun. Net: cleaner modal contents that reflect
    // ONLY the in-flight attempt, not a growing history.
    setIssues([])

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

  /** Stream-run setup.sh on the given session and pipe its output to the log +
   *  StepperRail. Shared by the first install (go(), resume=false) and the
   *  reconnect-and-resume flow (resume=true → adds --resume so setup.sh skips
   *  the steps already recorded in .setup-state). Deliberately does NOT
   *  re-upload the payload or re-render .env: a resume must run against the
   *  EXACT on-NAS .env — re-rendering it could change its hash (forcing a full
   *  re-run) or blank API keys that setup-arr-config.py had discovered.
   *
   *  Resume correctness also relies on setup.sh's pre-step .env normalisation
   *  (the INSTALL_DIR / MONITORED_DISK_N appends, ~setup.sh:120-164) staying
   *  idempotent and running BEFORE the first checkpoint, so the env_hash it
   *  records matches on the --resume re-run. Don't make that prelude mutate
   *  .env non-idempotently or after a step completes, or resume will replay
   *  every step (still safe — all steps are idempotent — just slower). */
  async function streamSetup(sid: string, resume: boolean) {
    setReconnecting(false)
    setPhase('running-setup')
    const setupStartTs = Date.now()
    lastChunkAtRef.current = setupStartTs
    const heartbeat = setInterval(() => {
      const elapsed = Date.now() - setupStartTs
      const sinceLast = Date.now() - lastChunkAtRef.current
      if (sinceLast > 5_000) {
        const m = `(still working — ${Math.floor(elapsed / 1000)}s elapsed, ${Math.floor(sinceLast / 1000)}s since last output)`
        appendChunk(`\x1b[36m[wizard]\x1b[0m ${m}\n`)
        window.installer.installLog.append(`[wizard] ${m}\n`).catch(() => { /* non-fatal */ })
        lastChunkAtRef.current = Date.now()
      }
    }, 3_000)
    try {
      // Defeat block-buffering (script -qfc → stdbuf → bash|awk fflush → plain
      // bash, in preference order) and handle both the scripts/ layout and the
      // legacy loose-scripts path — setup.sh resolves either internally. $ARGS
      // carries --resume on a reconnect-resume (empty otherwise).
      const targetSh = shellQuote(`${targetDir}/scripts/setup.sh`)
      const legacySh = shellQuote(`${targetDir}/setup.sh`)
      const ARGS = shellQuote(resume ? '--resume' : '')
      await window.installer.ssh.execStream({
        sessionId: sid,
        cmd:
          PATH_PREFIX +
          `export COMPOSE_PROGRESS=plain COMPOSE_ANSI=never DOCKER_CLI_HINTS=false; ` +
          `if [ -f ${targetSh} ]; then SETUP=${targetSh}; ` +
          `else SETUP=${legacySh}; fi; ` +
          `ARGS=${ARGS}; ` +
          `echo "[wizard-debug] using setup.sh at: $SETUP $ARGS"; ` +
          `echo "[wizard-debug] before setup.sh: $(date)"; ` +
          `if command -v script >/dev/null 2>&1; then ` +
          `  echo "[wizard-debug] using: script -qfc (forced pty)"; ` +
          `  script -qfc "bash $SETUP $ARGS" /dev/null 2>&1; rc=$?; ` +
          `elif command -v stdbuf >/dev/null 2>&1; then ` +
          `  echo "[wizard-debug] using: stdbuf -oL -eL"; ` +
          `  stdbuf -oL -eL bash $SETUP $ARGS 2>&1; rc=$?; ` +
          `elif command -v awk >/dev/null 2>&1; then ` +
          `  echo "[wizard-debug] using: bash | awk fflush"; ` +
          `  bash $SETUP $ARGS 2>&1 | awk '{ print; fflush() }'; rc=\${PIPESTATUS[0]}; ` +
          `else ` +
          `  echo "[wizard-debug] using: plain bash (output may be block-buffered)"; ` +
          `  bash $SETUP $ARGS 2>&1; rc=$?; ` +
          `fi; ` +
          `echo "[wizard-debug] after setup.sh (rc=$rc): $(date)"; exit $rc`,
        sudo: true,
        channelId: CHANNEL_ID,
      })
    } finally {
      clearInterval(heartbeat)
    }
  }

  /** Reconnect a DROPPED SSH session and resume setup.sh from its checkpoint.
   *  Offered only after a connection drop (droppedConnection): re-establishes
   *  SSH with the saved connection, then re-runs setup.sh --resume against the
   *  on-NAS .env (no re-upload, no .env rewrite). The most common trigger is a
   *  Wi-Fi blip or laptop sleep while the user is watching the install. */
  async function reconnectAndResume() {
    if (reconnecting) return
    setReconnecting(true)
    setErrorMsg(null)
    // Keep droppedConnection===true through the reconnect window so the button
    // reads "Reconnecting…" and the dropped-state copy stays put (phase is still
    // 'failed' until streamSetup flips it). onStreamClose recomputes it when the
    // resumed run ends; the catch below re-sets it on a failed reconnect.
    appendChunk(`\x1b[36m[wizard]\x1b[0m Connection dropped — reconnecting to the NAS to resume…\n`)
    try {
      const r = await window.installer.ssh.connect(toConnectConfig(connection))
      setSessionId(r.sessionId)
      if (activeProfileId) window.installer.profiles.touch(activeProfileId).catch(() => { /* non-fatal */ })
      try {
        const lr = await window.installer.installLog.start('install')
        setInstallLogPath(lr.path)
      } catch { /* non-fatal — install still works without a local log file */ }
      appendChunk(`\x1b[36m[wizard]\x1b[0m Reconnected. Resuming setup.sh from the last completed step…\n`)
      setRunStartedAt(Date.now())
      setElapsedMs(0)
      await streamSetup(r.sessionId, true)
    } catch (e) {
      setReconnecting(false)
      setDroppedConnection(true)   // keep the Reconnect button available
      setPhase('failed')
      setExitCode(null)
      setErrorMsg(`Couldn’t reconnect to the NAS: ${(e as Error).message} — check it’s back online, then tap Reconnect again.`)
      reportError('Reconnect', e)
    }
  }

  async function go() {
    // Re-entrancy guard: ignore a double-click that lands during the async
    // prelude (phase is still 'idle' until setPhase('uploading') below).
    // Cleared by the terminal-phase effect above, or here on the no-session
    // early-out so a later Retry can still call go().
    if (goRunningRef.current) return
    goRunningRef.current = true
    if (!sessionId) {
      goRunningRef.current = false
      setErrorMsg('No SSH session. Go back and reconnect.')
      setPhase('failed')
      return
    }
    setErrorMsg(null)
    setDroppedConnection(false)
    linesRef.current = []
    resetSteps()
    setIssues([])
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
      setRunStartedAt(Date.now())
      setElapsedMs(0)
      wlog(`Preparing target directory ${targetDir}...`)
      const tq = shellQuote(targetDir)
      const prep = await window.installer.ssh.exec({
        sessionId,
        // Default 60s timeout is too short here: chown -R / chmod -R
        // on the install dir walks the entire tree, which includes
        // Plex's config (hundreds of thousands of metadata files +
        // transcoding cache) and qBit's resume data. On Synology
        // spinning rust this routinely takes 2-5 minutes, and the
        // default timeout fires before chown finishes — the wizard
        // mis-reports it as a sudo-password failure even though sudo
        // worked fine and chown is just slow. 10 minutes is plenty
        // for any reasonable home Plex library.
        timeoutMs: 600_000,
        cmd:
          // use a subshell + set -x for inline diagnostics
          `set -e; ` +
          `mkdir -p ${tq}; ` +
          `OWNER_UID="\${SUDO_UID:-$(id -u)}"; OWNER_GID="\${SUDO_GID:-$(id -g)}"; ` +
          `echo "[prep] target=${targetDir} owner_uid=$OWNER_UID owner_gid=$OWNER_GID effective=$(id -u):$(id -g)"; ` +
          // Skip the recursive walk on re-installs where ownership is
          // already correct — that's the slow part, and on idempotent
          // re-runs it's pure waste. We chown the TOP-level dir
          // unconditionally (cheap) and only recurse when at least
          // one of the immediate child paths doesn't match. find -mount
          // confines to the same filesystem (avoids descending into
          // bind-mounted /data inside the container's config etc).
          `chown "$OWNER_UID:$OWNER_GID" ${tq}; ` +
          `chmod u+rwX,g+rwX ${tq}; ` +
          `MISMATCH=$(find ${tq} -mindepth 1 -maxdepth 2 -mount \\( ! -uid "$OWNER_UID" -o ! -gid "$OWNER_GID" \\) -print -quit 2>/dev/null); ` +
          `if [ -n "$MISMATCH" ]; then ` +
          `  echo "[prep] some entries need re-chowning (first mismatch: $MISMATCH) — running recursive chown..."; ` +
          `  chown -R "$OWNER_UID:$OWNER_GID" ${tq}; ` +
          `  chmod -R u+rwX,g+rwX ${tq}; ` +
          `else ` +
          `  echo "[prep] ownership already correct on all children — skipping recursive chown"; ` +
          `fi; ` +
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

      // 1.5. Grant the container's PUID write access to DATA_ROOT.
      //
      // Synology shared folders layer their own ACL on top of POSIX.
      // chown + chmod 775 in setup-folders.sh isn't enough — Sonarr /
      // Radarr / Lidarr probe "is this writable" from inside the
      // container (as PUID), the shared-folder ACL says no, and the
      // arr reports "Path does not exist" (it conflates EACCES + ENOENT
      // in the root-folder validator). The cure is to add an explicit
      // write ACE to DATA_ROOT with file+directory inheritance.
      //
      // We do this from the wizard (rather than only in setup-folders.sh)
      // for two reasons:
      //   1. The wizard has the rich shell environment it needs to find
      //      synoacltool reliably — DSM puts it at /usr/syno/bin which
      //      isn't on PATH for non-interactive sudo'd shells, and the
      //      file is a symlink so `find -type f` skips it without `-L`.
      //   2. We can re-test the result by attempting a touch as the
      //      PUID and surface a clear failure if the ACL still isn't
      //      enough (DSM Control Panel hasn't granted share-level
      //      access at all).
      //
      // The remote shell branches on /etc/synoinfo.conf inside the
      // command so non-Synology hosts (Unraid / QNAP / TrueNAS / Linux)
      // skip the synoacltool path cleanly — POSIX permissions already
      // applied by `prep` above are enough for them, and the family-
      // specific fallback chain in setup-folders.sh handles the rest.
      const puid = (config.PUID ?? '').trim() || '1026'
      const dataRoot = (config.DATA_ROOT ?? '').trim() || '/volume1/Data'
      wlog(`Applying shared-folder ACL on ${dataRoot} (so containers can write)...`)
      try {
        const acl = await window.installer.ssh.exec({
          sessionId,
          cmd:
            `PUID="${puid}"; DATA=${shellQuote(dataRoot)}; ` +
            // Non-Synology hosts skip the ACL grant entirely — POSIX
            // permissions handle write access on Unraid / TrueNAS /
            // QNAP / Linux without an overlay ACL layer to override.
            `if [ ! -f /etc/synoinfo.conf ]; then ` +
            `  echo "[acl] non-Synology host — POSIX permissions already applied by prep; nothing to do."; ` +
            `  if [ -d "$DATA" ]; then ` +
            `    echo "[acl] verified: $DATA exists"; ` +
            `  else ` +
            `    echo "[acl] WARN: $DATA does not exist on this host. Create it (or change DATA_ROOT in the wizard) before continuing — every arr container bind-mounts it as /data."; ` +
            `  fi; ` +
            `  exit 0; ` +
            `fi; ` +
            // Resolve the username from the PUID. Synology busybox does
            // ship getent for the passwd database; fall back to awk on
            // /etc/passwd if it's not there.
            `USERNAME=$(getent passwd "$PUID" 2>/dev/null | cut -d: -f1); ` +
            `[ -z "$USERNAME" ] && USERNAME=$(awk -F: -v u="$PUID" '$3==u{print $1; exit}' /etc/passwd 2>/dev/null); ` +
            // Locate synoacltool. PATH first; then known DSM locations
            // (binaries are often symlinks, so we use -e not -x to
            // accept symlinks-with-targets); then `find -L` which
            // follows symlinks during the recursive scan.
            `SYNOACL=""; ` +
            `if command -v synoacltool >/dev/null 2>&1; then SYNOACL=$(command -v synoacltool); fi; ` +
            `if [ -z "$SYNOACL" ]; then ` +
            `  for c in /usr/syno/bin/synoacltool /usr/syno/sbin/synoacltool /usr/local/bin/synoacltool /usr/bin/synoacltool /bin/synoacltool; do ` +
            `    if [ -e "$c" ]; then SYNOACL="$c"; break; fi; ` +
            `  done; ` +
            `fi; ` +
            `if [ -z "$SYNOACL" ]; then ` +
            `  SYNOACL=$(find -L /usr /bin -maxdepth 6 -name synoacltool 2>/dev/null | head -1); ` +
            `fi; ` +
            `echo "[acl] USERNAME=$USERNAME PUID=$PUID SYNOACL=\${SYNOACL:-<not found>}"; ` +
            `if [ -z "$USERNAME" ]; then echo "[acl] no user matching PUID — skip"; exit 0; fi; ` +
            `if [ -z "$SYNOACL" ]; then ` +
            `  echo "[acl] synoacltool not found — install will likely fail with ACL errors in step 7."; ` +
            `  echo "[acl] DSM fix: Control Panel → Shared Folder → Data → Edit → Permissions → grant $USERNAME Read/Write"; ` +
            `  exit 0; ` +
            `fi; ` +
            // Apply the ACE — but check existence FIRST. synoacltool
            // -add is NOT idempotent: invoking it with a matching ACE
            // returns success and appends a duplicate entry. Real-world
            // user logs have shown up to 6 identical heoki ACEs after
            // a handful of re-installs. Grep the current -get output
            // for the exact ACE string we'd add; only -add if absent.
            `TARGET_ACE="user:$USERNAME:allow:rwxpdDaARWcCo:fd--"; ` +
            `if "$SYNOACL" -get "$DATA" 2>/dev/null | grep -qF "$TARGET_ACE"; then ` +
            `  echo "[acl] ACE already present for $USERNAME on $DATA — skip add"; ` +
            `elif "$SYNOACL" -add "$DATA" "$TARGET_ACE" 2>&1; then ` +
            `  echo "[acl] ACE added for $USERNAME on $DATA"; ` +
            `else rc=$?; echo "[acl] -add returned $rc"; fi; ` +
            // Propagate inheritance to existing children so the dirs
            // the arrs need are writable on first run, not just new ones.
            `if "$SYNOACL" -enforce-inherit "$DATA" 2>&1; then ` +
            `  echo "[acl] inheritance propagated to existing children"; ` +
            `else echo "[acl] enforce-inherit failed (older child files may still need manual fix)"; fi; ` +
            // Re-test from inside a temp container as PUID. This is the
            // exact same test the arrs do; if it passes, step 7 should
            // pass; if it fails, surface the DSM Control Panel hint NOW.
            `TESTDIR="$DATA/Media"; ` +
            `mkdir -p "$TESTDIR" 2>/dev/null; ` +
            `if su -m -s /bin/sh "$USERNAME" -c "touch '$TESTDIR/.acl_probe' && rm '$TESTDIR/.acl_probe'" 2>/dev/null; then ` +
            `  echo "[acl] verified: $USERNAME can write $TESTDIR — Sonarr/Radarr/Lidarr will accept the root folders"; ` +
            `else ` +
            `  echo "[acl] WARN: $USERNAME STILL cannot write $TESTDIR after ACL grant."; ` +
            `  echo "[acl] DSM fix: Control Panel → Shared Folder → Data → Edit → Permissions → grant $USERNAME Read/Write"; ` +
            `fi`,
          sudo: true,
        })
        if (acl.stdout.trim()) wlog(acl.stdout.trim())
        if (acl.stderr.trim()) wlog(`acl stderr: ${acl.stderr.trim()}`)
        // Don't throw on ACL failure — the install can still partially
        // succeed (downloads + non-/data steps), and the user might
        // already have the share permissions set in DSM such that the
        // arrs work even without our ACE. Log and continue.
      } catch (e) {
        wlog(`ACL grant errored (non-fatal): ${(e as Error).message}`)
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
      // v0.3.23+: .env lives next to docker-compose.yml under scripts/.
      // Back up BOTH possible legacy locations (root and scripts/) so
      // an in-place upgrade across the layout migration doesn't lose
      // either copy. Backup files land where their source was found.
      const envScripts = `${targetDir}/scripts/.env`
      const envLegacy  = `${targetDir}/.env`
      wlog('Backing up any existing .env (root + scripts/)...')
      await window.installer.ssh.exec({
        sessionId,
        cmd:
          `mkdir -p ${shellQuote(`${targetDir}/scripts`)}; ` +
          `[ -f ${shellQuote(envLegacy)} ] && cp -p ${shellQuote(envLegacy)} ${shellQuote(`${envLegacy}.backup-${ts}`)} && echo "backed up legacy .env"; ` +
          `[ -f ${shellQuote(envScripts)} ] && cp -p ${shellQuote(envScripts)} ${shellQuote(`${envScripts}.backup-${ts}`)} && echo "backed up scripts/.env"; ` +
          // Prune: keep only the 3 newest .env backups per location so
          // repeated re-installs/updates don't pile them up. busybox-safe
          // (no `xargs -r`): the while-read loop is a no-op on empty input.
          `for d in ${shellQuote(envLegacy)} ${shellQuote(envScripts)}; do ls -1t "$d".backup-* 2>/dev/null | tail -n +4 | while read -r f; do rm -f "$f"; done; done; ` +
          `echo "(done)"`,
        sudo: true,
      }).then((r) => wlog(r.stdout.trim() || '(done)'))

      wlog(`Writing ${envScripts} (${Object.keys(config).filter((k) => (config as Record<string, unknown>)[k]).length} populated keys)...`)
      // Snapshot this pure render (pre carry-forward) so a later Retry can tell
      // whether the user changed anything — if not, it resumes from the failed
      // step instead of replaying from step 1 (see retryOrResume).
      const renderedEnv = renderEnv(config as EnvFormValues)
      lastRenderedEnvRef.current = renderedEnv
      let envText = renderedEnv
      // M1: a full re-install re-renders .env with the auto-discovered API-key
      // lines blank (renderEnv can't know them — setup-arr-config.py re-reads
      // them from each arr's config.xml every run). That self-heals, but it
      // leaves a brief window of empty keys and can lose a key whose ONLY copy
      // was .env (an arr that hasn't booted yet). Carry forward any non-empty
      // discovered keys from the existing on-NAS .env into the fresh render.
      // Best-effort: any failure falls back to the plain render (today's
      // behaviour), so this can only help, never break the install.
      try {
        const DISCOVERED = [
          'SONARR_API_KEY', 'RADARR_API_KEY', 'LIDARR_API_KEY', 'PROWLARR_API_KEY',
          'SABNZBD_API_KEY', 'BAZARR_API_KEY', 'SEERR_API_KEY',
        ]
        const cur = await window.installer.ssh.exec({
          sessionId,
          cmd: `cat ${shellQuote(envScripts)} 2>/dev/null || cat ${shellQuote(envLegacy)} 2>/dev/null || true`,
          sudo: true,
        })
        const existing = cur.stdout || ''
        let carried = 0
        for (const key of DISCOVERED) {
          const m = existing.match(new RegExp(`^${key}=(.+)$`, 'm'))
          const val = m?.[1]?.trim()
          // Only fill a key the fresh render left blank, and only from a
          // non-empty existing value.
          if (val && new RegExp(`^${key}=[ \\t]*$`, 'm').test(envText)) {
            envText = envText.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${val}`)
            carried++
          }
        }
        if (carried > 0) wlog(`Carried forward ${carried} existing API key(s) from your current .env`)
      } catch { /* best-effort — fall back to the plain render */ }
      await window.installer.sftp.writeFile({
        sessionId,
        remotePath: envScripts,
        content: envText,
        mode: 0o600,
      })
      wlog('.env written under scripts/ (mode 0600)')

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
      // Stream-run setup.sh against the freshly-uploaded payload + .env. The
      // exit code arrives via the stream-close handler in useEffect above.
      await streamSetup(sessionId, false)
    } catch (e) {
      setErrorMsg((e as Error).message)
      setPhase('failed')
      reportError('Install', e)
    }
  }

  /** Resume the CURRENT (still-connected) run from setup.sh's checkpoint after a
   *  normal step failure — the in-place analogue of reconnectAndResume(), minus
   *  the reconnect. Runs setup.sh --resume against the UNTOUCHED on-NAS .env, so
   *  its .setup-state hash still matches and already-finished steps are skipped;
   *  the failed step re-runs and the stream markers carry the stepper red →
   *  amber → green. Used by retryOrResume() only when the config is unchanged. */
  async function resumeRun() {
    if (!sessionId) { go(); return }
    setErrorMsg(null)
    setIssues([])
    appendChunk(`\x1b[36m[wizard]\x1b[0m Resuming setup.sh from the last completed step…\n`)
    setRunStartedAt(Date.now())
    setElapsedMs(0)
    try {
      await streamSetup(sessionId, true)
    } catch (e) {
      setPhase('failed')
      reportError('Resume', e)
    }
  }

  /** What the footer "Retry" does on a normal (non-dropped) failure. If the
   *  freshly-rendered .env is byte-identical to what the last run wrote, the
   *  user changed nothing → resume from the failed step (fast; preserves the
   *  checkpoint). Otherwise — a changed setting, a new Plex claim, or ANY doubt
   *  (no snapshot yet, a render error) — fall back to a full go() that rewrites
   *  .env and applies the change. Degrading to go() on uncertainty keeps this
   *  strictly an optimisation over today's always-replay behaviour. */
  function retryOrResume() {
    let unchanged = false
    try {
      unchanged =
        lastRenderedEnvRef.current !== null &&
        lastRenderedEnvRef.current === renderEnv(config as EnvFormValues)
    } catch { unchanged = false }
    if (unchanged) resumeRun()
    else go()
  }

  // Tick the elapsed counter every second while the run is in flight.
  // Stops at done / failed so the counter freezes at the final value
  // (so the user can read "completed in 18:42").
  //
  // CRITICAL: this useEffect MUST live above the `if (phase === 'idle')`
  // early return below. React's Rules of Hooks demand the same hook
  // call order on every render — if this hook were called only when
  // phase !== 'idle', the very transition from idle → uploading on
  // Start install would add a "new" hook to the order and React would
  // throw, unmounting the entire screen. That manifested as a literal
  // blank window on v0.3.18 once the user clicked Install. Keep this
  // ABOVE any conditional return.
  useEffect(() => {
    if (!runStartedAt) return
    if (phase === 'done' || phase === 'failed') return
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - runStartedAt)
    }, 1000)
    return () => clearInterval(interval)
  }, [runStartedAt, phase])

  // Pre-install screen: just the Plex claim widget and a big Start CTA.
  // Showing the empty stepper + empty log here was confusing — users
  // thought the install was running and stuck.
  const reduced = useReducedMotion()
  if (phase === 'idle') {
    return (
      <div className="h-full flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-8 py-10 space-y-7">
            <motion.header
              initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="text-center"
            >
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-emerald-700/30 border border-emerald-500/30 mb-4">
                <Rocket size={36} className="text-emerald-300" strokeWidth={1.5} aria-hidden="true" />
              </div>
              <h1 className="text-3xl font-bold tracking-tight">Ready to launch</h1>
              <p className="text-slate-400 mt-3 text-base max-w-md mx-auto">
                Click <span className="text-emerald-400 font-semibold">Start install</span> below
                and the wizard handles everything — upload, config, services. Sit back; first
                install takes about 5–15 minutes.
              </p>
            </motion.header>

            {/* Plex claim collection — only relevant when the user actually
                installs Plex. Hidden when ENABLE_PLEX=false so the user
                isn't prompted to fetch a token they'll never use, and
                so the footer doesn't lie about "no Plex claim — Plex
                needs manual setup" when Plex isn't going to be in the
                stack at all. */}
            {isEnabled(config.ENABLE_PLEX as string | undefined)
              && (config.MEDIA_SERVER || 'plex') !== 'jellyfin' && (
              <PlexClaimRefresh
                value={config.PLEX_CLAIM}
                onChange={(claim) => setConfig({ PLEX_CLAIM: claim })}
              />
            )}

            {/* Jellyfin has no claim token. Optional API key — paste after
                the first-run browser setup so the arrs can wire library
                scans. Blank is fine; the install works without it. */}
            {isEnabled(config.ENABLE_PLEX as string | undefined)
              && (config.MEDIA_SERVER || 'plex') === 'jellyfin' && (
              <section className="rounded-md border border-sky-700/30 bg-sky-900/10 p-3 space-y-2 text-sm">
                <label htmlFor="jellyfin-api-key" className="font-medium text-sky-100 block">
                  Jellyfin API key <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <input
                  id="jellyfin-api-key"
                  type="text"
                  value={config.JELLYFIN_API_KEY ?? ''}
                  onChange={(e) => setConfig({ JELLYFIN_API_KEY: e.target.value || undefined })}
                  placeholder="paste after first-run — Jellyfin Dashboard → API Keys"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm font-mono focus:outline-none focus:border-sky-600 focus:ring-1 focus:ring-sky-500/40"
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="text-xs text-slate-400">
                  No claim token needed — you can install now and leave this blank.
                  After the stack is up, finish Jellyfin&apos;s setup at
                  <span className="font-mono"> :8096</span>, generate a key, paste it
                  here and re-run (or wire it later over SSH).
                </p>
              </section>
            )}

            {errorMsg && (
              <motion.div
                initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22 }}
                className="bg-rose-950/40 border border-rose-700/50 text-rose-100 rounded-lg px-4 py-3 text-sm flex items-start gap-3"
              >
                <AlertCircle size={20} className="text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="font-mono whitespace-pre-wrap">{errorMsg}</div>
              </motion.div>
            )}
          </div>
        </div>

        {/* Sticky footer: Back / status / Start install. */}
        <div className="border-t border-slate-800 bg-slate-950 px-8 py-3 shrink-0">
          <div className="max-w-2xl mx-auto flex items-center gap-3">
            <BigButton
              size="md"
              variant="secondary"
              icon={<ArrowLeft size={18} />}
              onClick={() => setStep('configure')}
            >
              Back
            </BigButton>
            <div className="flex-1 text-sm text-center">
              {errorMsg ? (
                <span className="text-rose-300">✘ {errorMsg.split('\n')[0]}</span>
              ) : !isEnabled(config.ENABLE_PLEX as string | undefined) ? (
                <span className="text-slate-400">Ready to install · Plex not in stack</span>
              ) : (
                <span className="text-slate-400">
                  {config.PLEX_CLAIM
                    ? '✓ Plex claim ready'
                    : 'No Plex claim — install will still work, Plex needs manual setup later'}
                </span>
              )}
            </div>
            <BigButton
              size="md"
              variant="primary"
              icon={<Rocket size={18} />}
              onClick={go}
            >
              Start install
            </BigButton>
          </div>
        </div>
      </div>
    )
  }

  // Active install / completed view: stepper + streaming log.
  //
  // Progress bar driven by the step markers we parsed out of setup.sh's
  // output. We treat anything that's `ok` as done, `running` as half a
  // step worth (so the bar moves when a step is in flight), and
  // pending/fail contribute zero. Total = steps.length (currently 12 —
  // RUN_SCREEN_STEPS; read from the array so it stays correct if steps move).
  const completedSteps = steps.filter((s) => s.status === 'ok').length
  const inflightSteps = steps.filter((s) => s.status === 'running').length

  // Format ms as "Xm Ys" — capped at 99 minutes so the chip doesn't
  // get unreasonably wide if something hangs.
  function fmtElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000)
    const m = Math.min(99, Math.floor(totalSec / 60))
    const s = totalSec % 60
    return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`
  }
  const progressPct =
    phase === 'uploading'
      ? Math.min(100, (progress?.pct ?? 0) * 0.1)   // SFTP is ~10% of the total bar
      : phase === 'writing-env'
        ? 10
        : phase === 'done'
          ? 100
          : Math.round(10 + ((completedSteps + inflightSteps * 0.5) / steps.length) * 90)
  const currentStep = steps.find((s) => s.status === 'running')
  const lastDoneStep = [...steps].reverse().find((s) => s.status === 'ok')

  // Friendly status string for the big headline above the bar.
  const statusHeadline =
    phase === 'uploading' ? 'Uploading files to your NAS…'
    : phase === 'writing-env' ? 'Writing config…'
    : phase === 'running-setup' && currentStep ? currentStep.label
    : phase === 'running-setup' ? 'Working on the next step…'
    : phase === 'done' ? 'All done — moving on'
    : phase === 'failed' ? (droppedConnection ? 'Connection dropped — reconnect to resume' : 'Something needs attention')
    : 'Starting…'

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <header className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
            {phase === 'failed' ? (droppedConnection ? 'Connection lost' : 'Install paused') : phase === 'done' ? 'Done' : 'Installing the stack'}
          </div>
          {/* Animated status headline — re-mounts on each phase change so
              the user sees motion when work progresses, even while the
              progress bar is mid-fill. */}
          <motion.h1
            key={statusHeadline}
            initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={
              `text-2xl font-bold truncate mt-1 ` +
              (phase === 'failed' ? 'text-rose-200' : phase === 'done' ? 'text-emerald-200' : 'text-slate-100')
            }
          >
            {statusHeadline}
          </motion.h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {installLogPath && (
            <button
              onClick={() => window.installer.installLog.reveal()}
              className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 rounded border border-slate-700 text-slate-300"
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
        </div>
      </header>

      {/* Animated progress bar with a soft sheen on the leading edge so
          the eye is reassured "still moving" even when the percentage
          updates infrequently between steps. */}
      <div className="space-y-1.5">
        <div
          className="w-full bg-slate-800 rounded-full h-3 overflow-hidden"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Install progress: ${progressPct}%${currentStep ? ` — ${currentStep.label}` : ''}`}
        >
          <motion.div
            initial={false}
            animate={{ width: `${progressPct}%` }}
            transition={{ type: 'spring', stiffness: 90, damping: 22 }}
            className={
              `h-3 rounded-full relative ` +
              (phase === 'failed'
                ? 'bg-gradient-to-r from-rose-600 to-rose-500'
                : 'bg-gradient-to-r from-emerald-600 to-emerald-400')
            }
          >
            {/* Animated shimmer on the bar's leading edge — moving
                stripe says "still alive" even when % is stuck for a
                long step (e.g. docker image pulls). Off in reduced-
                motion mode. */}
            {!reduced && phase !== 'failed' && phase !== 'done' && (
              <div
                className="absolute inset-y-0 right-0 w-12"
                style={{
                  background: 'linear-gradient(to right, transparent, rgba(255,255,255,0.25), transparent)',
                  animation: 'shimmer 1.8s ease-in-out infinite',
                }}
              />
            )}
          </motion.div>
        </div>
        <div className="text-xs text-slate-400 font-mono truncate flex items-center justify-between gap-3">
          <span className="truncate">
            {phase === 'uploading' && `Uploading ${progress?.file ?? 'payload'} (${progress?.pct ?? 0}%)`}
            {phase === 'writing-env' && 'Writing .env'}
            {phase === 'running-setup' && currentStep
              ? `Step ${currentStep.number} of ${steps.length}`
              : phase === 'running-setup' && lastDoneStep
                ? `Step ${lastDoneStep.number} of ${steps.length} done — waiting for next…`
                : null}
            {phase === 'done' && '✓ All steps complete'}
            {phase === 'failed' && (currentStep
              ? `Paused at step ${currentStep.number}: ${currentStep.label}`
              : 'Install paused — see log')}
          </span>
          <span className="shrink-0 flex items-center gap-2 text-slate-500">
            {/* Elapsed-time chip — reassures the user the install is
                making progress during long phases (Docker pulling
                images can take ~10 min on first run). Only renders
                once a run has started so the idle phase isn't
                cluttered. */}
            {runStartedAt && (
              <span
                className="inline-flex items-center gap-1 tabular-nums"
                title="Total time since the install started"
              >
                <Clock size={13} className="text-slate-600" aria-hidden="true" />
                {fmtElapsed(elapsedMs)}
              </span>
            )}
            <span className="tabular-nums">{progressPct}%</span>
          </span>
        </div>
      </div>

      {/* Issues summary buttons. Replace the previous inline <details>
          panel — it took layout space even when collapsed and pushed
          the user toward "is something wrong?" anxiety even on clean
          runs. The two-button design only renders when there's
          actually something to look at, so absence of buttons is
          itself a positive signal ("looks clean"). Clicking either
          button opens IssuesModal pre-selected to that tab.

          'Failed' counts ✘ entries (hard install errors).
          'Needs action' counts ⚠ + ! entries — folded together per
          the post-research three-bucket recommendation (warn/note both
          surface as "you might want to look at this manually"; further
          subdividing them just creates anxiety without information). */}
      {(() => {
        const failCount   = issues.filter((i) => i.severity === 'fail').length
        const actionCount = issues.length - failCount
        if (failCount === 0 && actionCount === 0) return null
        return (
          <div className="flex items-center gap-2 shrink-0">
            {failCount > 0 && (
              <motion.button
                onClick={() => setIssuesModal('fail')}
                whileHover={reduced ? {} : { y: -1 }}
                whileTap={reduced ? {} : { scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-rose-900/30 hover:bg-rose-800/40 border border-rose-700/50 rounded-md text-rose-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/50"
              >
                <XCircle size={16} aria-hidden="true" />
                <span className="font-semibold">{failCount}</span> failed
              </motion.button>
            )}
            {actionCount > 0 && (
              <motion.button
                onClick={() => setIssuesModal('action')}
                whileHover={reduced ? {} : { y: -1 }}
                whileTap={reduced ? {} : { scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-amber-900/20 hover:bg-amber-800/30 border border-amber-700/40 rounded-md text-amber-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
              >
                <AlertTriangle size={16} aria-hidden="true" />
                <span className="font-semibold">{actionCount}</span> need{actionCount === 1 ? 's' : ''} action
              </motion.button>
            )}
            <span className="text-xs text-slate-500 ml-1">
              click to view details
            </span>
          </div>
        )
      })()}
      {issuesModal && (
        <IssuesModal
          initialTab={issuesModal}
          issues={issues}
          onClose={() => setIssuesModal(null)}
        />
      )}

      {/* Prominent "Retry just that step" banner — shows up when the
          install ended in failure and EXACTLY one step is red. Re-runs
          via the existing rerunStep() plumbing, which the stream
          handlers naturally pick up so the stepper goes red → amber
          pulse → green/red without any other code changes. The footer
          Retry button (re-runs the entire install from scratch) stays
          available for the multi-failure case or a clean-slate re-run. */}
      {(() => {
        if (phase !== 'failed') return null
        const failed = steps.filter((s) => s.status === 'fail')
        if (failed.length !== 1) return null
        const f = failed[0]
        const inFlight = rerunningStep === f.number
        return (
          <div className="rounded-md border border-amber-700/60 bg-amber-900/20 p-3 shrink-0 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-amber-200">
                Step {f.number} failed — {f.label}
              </div>
              <div className="text-xs text-amber-200/70 mt-0.5">
                Re-runs idempotently. Most step failures are fixed by a single retry
                once the underlying issue is sorted (containers slow to boot, transient
                API errors, Synology shared-folder ACL settling, etc.).
              </div>
            </div>
            <button
              type="button"
              onClick={() => rerunStep(f.number)}
              disabled={inFlight || rerunningStep !== null}
              title={inFlight ? 'Re-running…' : `Re-run step ${f.number}`}
              className="shrink-0 px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 rounded-md disabled:opacity-40 font-medium"
            >
              {inFlight ? 'Re-running…' : `Retry step ${f.number}`}
            </button>
          </div>
        )
      })()}

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

      {phase === 'failed' && isEnabled(config.ENABLE_PLEX as string | undefined)
        && (config.MEDIA_SERVER || 'plex') !== 'jellyfin' && (
        <PlexClaimRefresh
          value={config.PLEX_CLAIM}
          onChange={(claim) => setConfig({ PLEX_CLAIM: claim })}
        />
      )}

      {/* Footer buttons stay visible at every phase — back, retry, and
          continue are all always rendered. Each carries a `title`
          tooltip explaining why it's disabled at the current phase, so
          the user is never wondering "what does this app want from me
          right now?" */}
      <div className="flex justify-between items-center gap-3">
        <BigButton
          variant="secondary"
          size="md"
          onClick={() => setStep('configure')}
          disabled={phase === 'uploading' || phase === 'running-setup'}
          title={
            phase === 'uploading' || phase === 'running-setup'
              ? 'Wait until the install finishes before going back'
              : 'Return to the configure screen'
          }
          icon={<ArrowLeft size={18} />}
        >
          Back
        </BigButton>
        {phase === 'running-setup' && (
          <BigButton
            variant="secondary"
            size="md"
            onClick={() => { setCanceling(true); window.installer.ssh.streamCancel(CHANNEL_ID).catch(() => { /* best-effort */ }) }}
            disabled={canceling}
            title="Stop the running install. setup.sh is idempotent and resumable — you can Retry afterward to pick up where it left off."
            icon={<XCircle size={18} />}
          >
            {canceling ? 'Stopping…' : 'Cancel'}
          </BigButton>
        )}
        <div className="flex-1 text-sm text-center text-slate-400" role="status" aria-live="polite">
          {phase === 'uploading'  && `Uploading files... ${progress?.pct ?? 0}%`}
          {phase === 'writing-env' && 'Writing .env'}
          {phase === 'running-setup' && 'Running setup.sh — see log'}
          {phase === 'done'   && (
            <span className="inline-flex items-center gap-1.5 text-emerald-300">
              <CheckCircle2 size={16} aria-hidden="true" /> Install complete — click Continue
            </span>
          )}
          {phase === 'failed' && (
            <span className="inline-flex items-start gap-1.5 text-amber-200/90">
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              {droppedConnection ? (
                <span>
                  Connection to the NAS dropped — tap <span className="text-slate-200 font-medium">Reconnect &amp; resume</span> to
                  pick up where it left off. Steps that already finished are skipped.
                </span>
              ) : (
                <span>
                  Install paused — tap <span className="text-slate-200 font-medium">Retry</span> to run it again,
                  or <span className="text-slate-200 font-medium">Back</span> to tweak a setting first.
                </span>
              )}
            </span>
          )}
        </div>
        <BigButton
          variant={phase === 'failed' ? 'primary' : 'secondary'}
          size="md"
          onClick={droppedConnection ? reconnectAndResume : retryOrResume}
          disabled={phase !== 'failed' || reconnecting}
          title={
            phase === 'failed'
              ? (droppedConnection
                  ? 'Reconnect to the NAS and resume setup.sh from the last completed step'
                  : 'Re-run the install — resumes from the failed step if nothing changed, or replays from the top to apply a setting you edited')
              : phase === 'done'
                ? 'Install already finished successfully'
                : 'Available once the install has paused'
          }
          icon={<RotateCw size={18} />}
        >
          {droppedConnection ? (reconnecting ? 'Reconnecting…' : 'Reconnect & resume') : 'Retry'}
        </BigButton>
        <BigButton
          variant={phase === 'done' ? 'primary' : 'secondary'}
          size="md"
          onClick={() => setStep('done')}
          disabled={phase !== 'done'}
          title={
            phase === 'done'
              ? 'Continue to the post-install dashboard'
              : phase === 'failed'
                ? 'Install paused — try Retry first'
                : 'Available once the install completes'
          }
          trailingIcon={<ArrowRight size={18} />}
        >
          Continue
        </BigButton>
      </div>
    </div>
  )
}

// Shell-quote for embedding into a remote bash command.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
