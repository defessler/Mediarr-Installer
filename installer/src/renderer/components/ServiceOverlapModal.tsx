// The "you picked two services that do the same job" modal.
//
// Opened by the Configure screen when a toggle turns on both halves of a
// SERVICE_OVERLAPS pair. It recommends one, says what each is better at, and
// lets the user decide. Dismissing it (Escape, the backdrop, the X) keeps both,
// since that's what the user had just ticked. Nothing here changes a setting
// the user didn't click.

import { useRef } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { AlertTriangle, Check, Star, X } from 'lucide-react'
import { BigButton } from './BigButton.js'
import { useFocusTrap } from '../hooks/useFocusTrap.js'
import type { ServiceOverlap } from '../service-overlaps.js'

export type OverlapChoice = 'recommended-only' | 'other-only' | 'both'

export function ServiceOverlapModal({
  overlap,
  onChoose,
}: {
  overlap: ServiceOverlap
  onChoose: (choice: OverlapChoice) => void
}) {
  const reduced = useReducedMotion()
  const dialogRef = useRef<HTMLDivElement>(null)
  const keepBoth = () => onChoose('both')
  useFocusTrap(dialogRef, { active: true, onClose: keepBoth })

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="overlap-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) keepBoth()
      }}
      initial={reduced ? { opacity: 1 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <motion.div
        ref={dialogRef}
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
        initial={reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
        transition={{ type: 'spring', stiffness: 360, damping: 30 }}
      >
        <header className="px-5 pt-4 pb-3 border-b border-slate-800 flex items-center justify-between gap-3">
          <h2 id="overlap-modal-title" className="text-lg font-semibold inline-flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30" aria-hidden="true">
              <AlertTriangle size={18} className="text-amber-300" strokeWidth={1.75} />
            </span>
            {overlap.title}
          </h2>
          <button
            onClick={keepBoth}
            className="text-slate-400 hover:text-slate-200 rounded-md p-1 hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            aria-label="Close and keep both"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <div className="px-5 py-4 space-y-4 text-sm">
          <p className="text-slate-300">{overlap.summary}</p>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-emerald-700/50 bg-emerald-900/10 p-3">
              <div className="font-medium text-emerald-300 flex items-center gap-1.5 mb-2">
                <Star size={14} strokeWidth={2} aria-hidden="true" />
                {overlap.recommendedLabel}
                <span className="text-[10px] leading-none uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-emerald-600/50 bg-emerald-900/30 text-emerald-300">
                  Recommended
                </span>
              </div>
              <ul className="space-y-1.5 text-slate-300">
                {overlap.recommendedPros.map((p) => (
                  <li key={p} className="flex items-start gap-1.5">
                    <Check size={13} className="shrink-0 mt-0.5 text-emerald-400" strokeWidth={2.25} aria-hidden="true" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-md border border-slate-700 bg-slate-900/40 p-3">
              <div className="font-medium text-slate-200 flex items-center gap-1.5 mb-2">
                {overlap.otherLabel}
                <span className="text-[10px] leading-none uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-amber-600/50 bg-amber-900/30 text-amber-300">
                  Not recommended
                </span>
              </div>
              <div className="text-xs text-slate-500 mb-1.5">Still better at:</div>
              <ul className="space-y-1.5 text-slate-300">
                {overlap.otherPros.map((p) => (
                  <li key={p} className="flex items-start gap-1.5">
                    <Check size={13} className="shrink-0 mt-0.5 text-slate-400" strokeWidth={2.25} aria-hidden="true" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <p className="text-xs text-amber-200/90 flex items-start gap-1.5">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
            <span>{overlap.bothNote}</span>
          </p>
        </div>

        <footer className="px-5 pb-4 pt-1 flex flex-wrap items-center justify-end gap-2">
          <BigButton variant="ghost" size="md" onClick={() => onChoose('other-only')}>
            {overlap.otherLabel} only
          </BigButton>
          <BigButton variant="secondary" size="md" onClick={keepBoth}>
            Keep both
          </BigButton>
          <BigButton variant="primary" size="md" onClick={() => onChoose('recommended-only')} autoFocus>
            {overlap.recommendedLabel} only (recommended)
          </BigButton>
        </footer>
      </motion.div>
    </motion.div>
  )
}
