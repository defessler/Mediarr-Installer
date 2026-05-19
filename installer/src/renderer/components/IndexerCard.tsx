// IndexerCard — a single torrent/usenet indexer or subtitle provider
// card. Toggling it on reveals the credential fields with an expand
// animation. Toggling off clears all of the def's fields so we don't
// leak partial credentials into the .env.

import { useEffect, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { ExternalLink } from 'lucide-react'
import type { EnvFormValues, IndexerDef } from '../../shared/env-render.js'
import { PasswordInput } from './PasswordInput.js'

interface Props {
  def: IndexerDef
  values: Partial<EnvFormValues>
  onChange: (patch: Partial<EnvFormValues>) => void
}

export function IndexerCard({ def, values, onChange }: Props) {
  // "Enabled" if the user has typed anything into any field, OR explicitly
  // toggled the card open. Local state tracks the explicit toggle so the
  // form doesn't auto-collapse the moment they clear a field to retype it.
  const hasValue = def.fields.some((f) => Boolean(values[f.key]))
  const [open, setOpen] = useState(hasValue)
  useEffect(() => { if (hasValue) setOpen(true) }, [hasValue])
  const reduced = useReducedMotion()

  function toggle() {
    if (open) {
      // Collapsing — clear all fields so we don't write partials to .env.
      const patch: Partial<EnvFormValues> = {}
      for (const f of def.fields) patch[f.key] = undefined
      onChange(patch)
      setOpen(false)
    } else {
      setOpen(true)
    }
  }

  return (
    <div className={
      'rounded-lg border p-3 transition-colors ' +
      (open
        ? 'border-emerald-700/50 bg-emerald-900/10'
        : 'border-slate-700 bg-slate-800/30 hover:border-slate-600 hover:bg-slate-800/50')
    }>
      <div className="flex items-center gap-3">
        {/* Toggle pill — Motion handles the knob slide as a spring so
            the on/off transition feels physical, not mechanical. */}
        <motion.button
          type="button"
          onClick={toggle}
          aria-pressed={open}
          aria-label={`Toggle ${def.name}`}
          whileTap={reduced ? {} : { scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className={
            'shrink-0 inline-flex items-center w-11 h-6 rounded-full p-0.5 transition-colors ' +
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 ' +
            'focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ' +
            (open ? 'bg-emerald-500' : 'bg-slate-700 hover:bg-slate-600')
          }
        >
          <motion.span
            animate={{ x: open ? 20 : 0 }}
            transition={
              reduced
                ? { duration: 0 }
                : { type: 'spring', stiffness: 500, damping: 30 }
            }
            className="block w-5 h-5 bg-white rounded-full shadow-md"
          />
        </motion.button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="font-semibold truncate">{def.name}</div>
            {def.href && (
              <a
                href={def.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 hover:underline shrink-0 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                site <ExternalLink size={10} />
              </a>
            )}
          </div>
          {def.note && (
            <div className="text-xs text-slate-400 truncate">{def.note}</div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduced ? { height: 'auto', opacity: 1 } : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-3 space-y-2">
              {def.fields.map((f) => (
                <div key={f.key}>
                  <label className="block text-xs text-slate-400 mb-1">{f.label}</label>
                  {f.password ? (
                    <PasswordInput
                      className="text-sm bg-slate-900 py-2"
                      value={(values[f.key] as string | undefined) ?? ''}
                      onChange={(e) => onChange({ [f.key]: e.target.value || undefined } as Partial<EnvFormValues>)}
                    />
                  ) : (
                    <input
                      type="text"
                      className="w-full px-2.5 py-2 text-sm bg-slate-900 border border-slate-700 rounded focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
                      value={(values[f.key] as string | undefined) ?? ''}
                      onChange={(e) => onChange({ [f.key]: e.target.value || undefined } as Partial<EnvFormValues>)}
                    />
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
