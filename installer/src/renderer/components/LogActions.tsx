import { useState } from 'react'
import { stripAnsi } from './LogPanel.js'

interface Props {
  /** Raw lines (with ANSI escapes) — they're stripped before export. */
  lines: string[]
  /** Default filename suggested in the save dialog. */
  defaultName: string
  /** Optional extra context written to the top of the saved log. */
  header?: string
}

export function LogActions({ lines, defaultName, header }: Props) {
  const [copied, setCopied] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)

  function buildContent(): string {
    const ts = new Date().toISOString()
    const head = `# NAS Arr Installer log — ${ts}${header ? '\n# ' + header : ''}\n\n`
    return head + lines.map(stripAnsi).join('\n')
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(buildContent())
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  async function save() {
    try {
      const r = await window.installer.dialog.saveText({
        defaultName,
        content: buildContent(),
        title: 'Save install log',
      })
      if (r.saved) {
        setSavedPath(r.path)
        setTimeout(() => setSavedPath(null), 4000)
      }
    } catch {
      /* ignore — user cancelled */
    }
  }

  return (
    <div className="flex gap-2 items-center text-sm">
      <button
        onClick={copy}
        className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs"
      >
        {copied ? 'Copied' : 'Copy log'}
      </button>
      <button
        onClick={save}
        className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs"
      >
        Save log...
      </button>
      {savedPath && (
        <span className="text-xs text-emerald-400 truncate">Saved to {savedPath}</span>
      )}
    </div>
  )
}
