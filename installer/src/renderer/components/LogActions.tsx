// Inline action bar for the streaming install log — copy/save buttons
// with confirmation flashes. Sits at the top of the log panel.

import { useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { Clipboard, ClipboardCheck, Save } from 'lucide-react'
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
  const reduced = useReducedMotion()

  function buildContent(): string {
    const ts = new Date().toISOString()
    const head = `# Mediarr Installer log — ${ts}${header ? '\n# ' + header : ''}\n\n`
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
      <motion.button
        onClick={copy}
        whileTap={reduced ? {} : { scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50"
        title="Copy log contents to clipboard"
      >
        {/* Swap icon between Clipboard / ClipboardCheck with a fade —
            confirms the copy action took effect without the button
            visually shifting size. */}
        <AnimatePresence mode="wait" initial={false}>
          {copied ? (
            <motion.span
              key="check"
              initial={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.12 }}
              className="text-emerald-400 inline-flex items-center"
            >
              <ClipboardCheck size={13} />
            </motion.span>
          ) : (
            <motion.span
              key="clip"
              initial={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.12 }}
              className="inline-flex items-center"
            >
              <Clipboard size={13} />
            </motion.span>
          )}
        </AnimatePresence>
        {copied ? 'Copied!' : 'Copy log'}
      </motion.button>
      <motion.button
        onClick={save}
        whileTap={reduced ? {} : { scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50"
        title="Save log to a file"
      >
        <Save size={13} />
        Save log…
      </motion.button>
      <AnimatePresence>
        {savedPath && (
          <motion.span
            initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
            className="text-xs text-emerald-400 truncate"
            title={savedPath}
          >
            ✓ Saved to {savedPath}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  )
}
