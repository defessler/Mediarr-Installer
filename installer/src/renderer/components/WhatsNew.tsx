import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Sparkles, Download, ExternalLink, ChevronDown, FileText, RefreshCw } from 'lucide-react'
import type { AppInfo, UpdaterState } from '../../shared/ipc.js'
import { useErrors, reportError } from '../store/errors.js'
import { BigButton } from './BigButton.js'

interface Props {
  info: AppInfo
  /** Bumped by the parent to force re-render after a skip / download. */
  onChanged?: () => void
}

// Very small Markdown subset renderer. GitHub release notes typically
// use:
//   ##  …                       headings
//   - / *                       bullets
//   `inline code`               inline code
//   [text](url)                 links
//   *italic* / **bold**         emphasis
// We render that and ESCAPE everything else (no <script>, no raw HTML).
// zero deps — release notes are a few KB at most.
//
// Security note: the *only* place where we accept potentially-attacker-
// controlled data and use it in something other than text content is
// the link href. A malicious release body could include
// `[click me](javascript:alert(1))` — React doesn't sanitise `href`,
// it'll happily render that and the link IS clickable. So we whitelist
// http:/https:/mailto: at the parser level. Anything else falls back
// to plain text.
function safeUrl(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed) return null
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  // Allow protocol-relative // and root-relative / urls too — they
  // resolve under our app's origin, which is benign.
  if (/^\/\//.test(trimmed)) return 'https:' + trimmed
  if (/^\//.test(trimmed)) return trimmed
  // Reject javascript:, data:, vbscript:, file:, etc.
  return null
}

function renderNotes(md: string): React.ReactNode {
  if (!md.trim()) return <p className="text-slate-500 italic">No release notes provided.</p>
  const out: React.ReactNode[] = []
  const lines = md.split('\n')

  function inline(text: string): React.ReactNode[] {
    // First, escape any html-ish chars by treating them as text — we
    // never use dangerouslySetInnerHTML so React handles this for us.
    // Then walk through inline tokens in priority order.
    const tokens: React.ReactNode[] = []
    let rest = text
    let idx = 0
    while (rest.length > 0) {
      // [link](url) — only http(s) / mailto / relative; reject
      // javascript:, data:, etc. URLs and render as plain text.
      const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/)
      if (link) {
        const safe = safeUrl(link[2])
        if (safe) {
          tokens.push(
            <a key={idx++} href={safe} target="_blank" rel="noreferrer"
               className="text-emerald-400 hover:underline">{link[1]}</a>,
          )
        } else {
          // Unsafe scheme — drop the link wrapping but keep the text.
          tokens.push(<span key={idx++}>{link[1]}</span>)
        }
        rest = rest.slice(link[0].length); continue
      }
      // **bold**
      const bold = rest.match(/^\*\*([^*]+)\*\*/)
      if (bold) {
        tokens.push(<strong key={idx++}>{bold[1]}</strong>)
        rest = rest.slice(bold[0].length); continue
      }
      // *italic*
      const ital = rest.match(/^\*([^*]+)\*/)
      if (ital) {
        tokens.push(<em key={idx++}>{ital[1]}</em>)
        rest = rest.slice(ital[0].length); continue
      }
      // `code`
      const code = rest.match(/^`([^`]+)`/)
      if (code) {
        tokens.push(
          <code key={idx++} className="bg-slate-800 px-1 rounded font-mono text-[0.85em]">
            {code[1]}
          </code>,
        )
        rest = rest.slice(code[0].length); continue
      }
      // Plain run — consume up to next special char
      const m = rest.match(/^[^[*`]+/)
      if (m) {
        tokens.push(<span key={idx++}>{m[0]}</span>)
        rest = rest.slice(m[0].length); continue
      }
      // Fallback: consume one char
      tokens.push(<span key={idx++}>{rest[0]}</span>)
      rest = rest.slice(1)
    }
    return tokens
  }

  // Group consecutive bullet lines into a single <ul>.
  let i = 0
  let key = 0
  while (i < lines.length) {
    const raw = lines[i]
    // Headings ## …
    const h = raw.match(/^(#{1,4})\s+(.+)$/)
    if (h) {
      out.push(
        <div key={key++} className="font-semibold text-slate-200 mt-2 first:mt-0">
          {inline(h[2])}
        </div>,
      )
      i++; continue
    }
    // Bullet group
    if (/^\s*[-*]\s+/.test(raw)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      out.push(
        <ul key={key++} className="list-disc list-inside space-y-0.5 text-slate-300">
          {items.map((it, j) => <li key={j}>{inline(it)}</li>)}
        </ul>,
      )
      continue
    }
    // Blank line → spacing
    if (!raw.trim()) {
      out.push(<div key={key++} className="h-2" />)
      i++; continue
    }
    out.push(<p key={key++} className="text-slate-300">{inline(raw)}</p>)
    i++
  }
  return out
}

export function WhatsNew({ info, onChanged }: Props) {
  const [busy, setBusy] = useState<'download' | 'skip' | 'install' | null>(null)
  const reduced = useReducedMotion()
  // Live updater state, subscribed from the main process. Drives whether
  // we show "Install update" (in-place), a progress bar, or the legacy
  // "Download zip" button. Builds older than the electron-updater
  // integration (or builds running in dev / mock) stay on `idle`
  // forever — the legacy zip flow handles those.
  const [updater, setUpdater] = useState<UpdaterState>({ kind: 'idle' })
  useEffect(() => {
    let cancelled = false
    void window.installer.updater?.getState().then((s) => {
      if (!cancelled) setUpdater(s)
    }).catch(() => { /* updater unavailable — stay idle */ })
    const off = window.installer.updater?.onState((s) => setUpdater(s))
    return () => { cancelled = true; off?.() }
  }, [])

  const u = info.updateAvailable
  // Only suppress the banner if there's no GitHub-reported newer version
  // AND the in-place updater hasn't found one. The updater can fire
  // before our GitHub fetch (it has its own publish.yml manifest), so
  // we surface the banner from either source.
  if (!u && updater.kind === 'idle') return null
  if (!u && updater.kind === 'not-available') return null

  // The version we display in the banner — prefer whichever source
  // has fresher info. Both should agree on the same tag.
  const latestVersion = (updater.kind === 'available' || updater.kind === 'downloaded')
    ? updater.version
    : u?.latest ?? ''

  // What action button to show:
  // - 'install'   — update is downloaded; one click restarts + replaces.
  // - 'download'  — in-place updater knows about the version but hasn't
  //                 downloaded it yet; one click pulls + installs.
  // - 'fallback'  — no in-place updater in this build (idle even after
  //                 page mount); fall back to the legacy zip download.
  const mode: 'install' | 'download' | 'progress' | 'fallback' =
    updater.kind === 'downloaded'   ? 'install'
    : updater.kind === 'downloading' ? 'progress'
    : updater.kind === 'available'   ? 'download'
    : 'fallback'

  async function startInPlaceDownload() {
    setBusy('download')
    try {
      await window.installer.updater?.download()
      // State transitions land via the onState subscription; we don't
      // poll. Just clear the local busy flag once the IPC returns —
      // the actual progress bar is updater-driven.
    } catch (e) {
      reportError('Start update download', e)
    } finally {
      setBusy(null)
    }
  }

  async function installAndRestart() {
    setBusy('install')
    try {
      await window.installer.updater?.install()
      // The app is about to quit — there's nothing to clean up here.
    } catch (e) {
      reportError('Install update', e)
      setBusy(null)
    }
  }

  async function legacyDownload() {
    setBusy('download')
    try {
      const r = await window.installer.app.downloadUpdate()
      if (r.error) {
        useErrors.getState().pushError('Download failed', r.error)
      } else if (r.path) {
        const mb = (r.bytes / (1024 * 1024)).toFixed(1)
        useErrors.getState().pushInfo(
          `Downloaded v${latestVersion}`,
          `Saved to ${r.path} (${mb} MB). Close this app and extract the new ` +
          `folder over your current install.`,
        )
      }
    } catch (e) {
      reportError('Download update', e)
    } finally {
      setBusy(null)
    }
  }

  async function skip() {
    setBusy('skip')
    try {
      await window.installer.app.skipUpdateVersion()
      onChanged?.()
    } catch (e) {
      reportError('Skip update', e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-xl border border-emerald-700/40 bg-gradient-to-b from-emerald-950/30 to-slate-900/30 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <motion.div
            className="shrink-0 w-9 h-9 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center"
            animate={reduced ? {} : { scale: [1, 1.06, 1] }}
            transition={reduced ? {} : { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Sparkles size={20} className="text-emerald-300" aria-hidden="true" />
          </motion.div>
          <div className="min-w-0">
            <h2 className="font-semibold text-emerald-100 flex items-center gap-2 flex-wrap">
              <span>{mode === 'install' ? 'Update ready' : 'New version'}</span>
              <span className="px-1.5 py-0.5 rounded text-xs font-bold bg-emerald-500/20 text-emerald-200 border border-emerald-500/30">
                v{latestVersion}
              </span>
            </h2>
            <p className="text-xs text-emerald-200/70 mt-0.5">
              {mode === 'install'
                ? 'Downloaded — restart now to apply the update in place.'
                : mode === 'progress'
                  ? 'Downloading update… you can keep using the app.'
                  : mode === 'download'
                    ? `You're on v${info.version}. Click below to download and install in place — no manual extract needed.`
                    : /* fallback */
                      `You're on v${info.version}. Your current install keeps working until you swap the folder.`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {mode === 'install' && (
            <BigButton
              size="sm"
              variant="primary"
              icon={busy === 'install' ? undefined : <RefreshCw size={14} aria-hidden="true" />}
              onClick={installAndRestart}
              disabled={busy !== null}
              loading={busy === 'install'}
              title="Quit the app and apply the downloaded update, then relaunch"
            >
              {busy === 'install' ? 'Restarting…' : 'Restart & install'}
            </BigButton>
          )}
          {mode === 'download' && (
            <BigButton
              size="sm"
              variant="primary"
              icon={busy === 'download' ? undefined : <Download size={14} aria-hidden="true" />}
              onClick={startInPlaceDownload}
              disabled={busy !== null}
              loading={busy === 'download'}
              title="Download the update in the background; you'll get a restart prompt when it's ready"
            >
              Install update
            </BigButton>
          )}
          {mode === 'fallback' && u?.zipUrl && (
            <BigButton
              size="sm"
              variant="primary"
              icon={busy === 'download' ? undefined : <Download size={14} aria-hidden="true" />}
              onClick={legacyDownload}
              disabled={busy !== null}
              loading={busy === 'download'}
              title="Download the win-unpacked zip to your Downloads folder (manual swap)"
            >
              {busy === 'download' ? 'Downloading…' : 'Download zip'}
            </BigButton>
          )}
          {u && (
            <a
              href={u.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 h-7 px-2 text-xs bg-slate-700 hover:bg-slate-600 rounded-md transition-colors text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              title="Open the release page on GitHub"
              aria-label={`Open v${latestVersion} release notes on GitHub — opens in new tab`}
            >
              Release page <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
          <BigButton
            size="sm"
            variant="ghost"
            onClick={skip}
            disabled={busy !== null}
            loading={busy === 'skip'}
            title={`Don't remind me about v${latestVersion} again`}
          >
            Skip
          </BigButton>
        </div>
      </div>

      {/* Download progress bar — only when the in-place updater is
          actively downloading. Shows percent + MB transferred so the
          user knows the wait is bounded. */}
      {mode === 'progress' && updater.kind === 'downloading' && (
        <div className="space-y-1.5" aria-live="polite">
          <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
            <motion.div
              className="h-2 bg-gradient-to-r from-emerald-600 to-emerald-400 rounded-full"
              animate={{ width: `${updater.percent}%` }}
              transition={{ type: 'spring', stiffness: 80, damping: 20 }}
            />
          </div>
          <div className="text-xs text-emerald-200/80 flex items-center justify-between gap-2 font-mono">
            <span>
              {updater.percent}% &middot; {(updater.transferred / (1024 * 1024)).toFixed(1)}/
              {(updater.total / (1024 * 1024)).toFixed(1)} MB
            </span>
            <span>{(updater.bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s</span>
          </div>
        </div>
      )}

      {/* Updater error banner — separate from the toast tray so it stays
          visible while the user reads it, not auto-dismissing after 6s. */}
      {updater.kind === 'error' && (
        <div
          className="rounded-md border border-rose-700/40 bg-rose-900/15 px-3 py-2 text-xs text-rose-200 flex items-start gap-2"
          role="alert"
        >
          <span className="font-medium">Update failed:</span>
          <span className="flex-1">{updater.message}</span>
        </div>
      )}

      {u && (
        <details className="rounded-md bg-slate-900/40 text-sm group">
          <summary className="cursor-pointer px-3 py-2 select-none text-slate-300 font-medium hover:text-slate-100 transition-colors flex items-center gap-2 [&::-webkit-details-marker]:hidden">
            <ChevronDown size={16} className="text-slate-500 transition-transform group-open:rotate-180 shrink-0" aria-hidden="true" />
            <FileText size={16} className="text-slate-500 shrink-0" aria-hidden="true" />
            What's new in v{latestVersion}
          </summary>
          <div className="px-3 pb-3 pt-1 space-y-1 text-sm">
            {renderNotes(u.notes)}
          </div>
        </details>
      )}
    </section>
  )
}
