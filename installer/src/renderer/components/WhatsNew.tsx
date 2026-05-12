import { useState } from 'react'
import type { AppInfo } from '../../shared/ipc.js'
import { useErrors, reportError } from '../store/errors.js'

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
  const [busy, setBusy] = useState<'download' | 'skip' | null>(null)
  const u = info.updateAvailable
  if (!u) return null

  async function download() {
    setBusy('download')
    try {
      const r = await window.installer.app.downloadUpdate()
      if (r.error) {
        useErrors.getState().pushError('Download failed', r.error)
      } else if (r.path) {
        const mb = (r.bytes / (1024 * 1024)).toFixed(1)
        useErrors.getState().pushInfo(
          `Downloaded v${u!.latest}`,
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
    <section className="rounded-md border border-emerald-700/40 bg-emerald-900/15 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-emerald-200">
            Update available — v{u.latest}
          </h2>
          <p className="text-xs text-emerald-300/80 mt-0.5">
            You're on v{info.version}. Notification only — your existing
            install keeps working until you swap the folder.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {u.zipUrl && (
            <button
              type="button"
              onClick={download}
              disabled={busy !== null}
              className="px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 rounded-md disabled:opacity-40 font-medium"
              title="Download the win-unpacked zip to your Downloads folder"
            >
              {busy === 'download' ? 'Downloading…' : 'Download zip'}
            </button>
          )}
          <a
            href={u.url}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 rounded-md"
            title="Open the release page on GitHub"
          >
            Release page
          </a>
          <button
            type="button"
            onClick={skip}
            disabled={busy !== null}
            className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40"
            title={`Don't remind me about v${u.latest} again`}
          >
            Skip
          </button>
        </div>
      </div>

      <details className="rounded-md bg-slate-900/40 text-sm">
        <summary className="cursor-pointer px-3 py-2 select-none text-slate-300 font-medium">
          What's new in v{u.latest}
        </summary>
        <div className="px-3 pb-3 pt-1 space-y-1 text-sm">
          {renderNotes(u.notes)}
        </div>
      </details>
    </section>
  )
}
