// IndexerCard — a single torrent/usenet indexer or subtitle provider
// card. Toggling it on reveals the credential fields with an expand
// animation. Toggling off clears all of the def's fields so we don't
// leak partial credentials into the .env.

import { useEffect, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { ExternalLink } from 'lucide-react'
import {
  type EnvFormValues,
  type IndexerDef,
  type IndexerTag,
  indexerTags,
} from '../../shared/env-render.js'
import { PasswordInput } from './PasswordInput.js'

/** Visual style per tag for the at-a-glance pill row on each card.
 *  Content-type tags get accent colours; cost/signup/kind tags use a
 *  muted slate so the card doesn't turn into a rainbow. Hard-coded
 *  Tailwind class names so the production build doesn't purge them. */
const TAG_STYLE: Partial<Record<IndexerTag, { label: string; cls: string }>> = {
  anime:        { label: 'anime',        cls: 'bg-pink-500/15 text-pink-200 border-pink-500/30' },
  kdrama:       { label: 'k-drama',      cls: 'bg-rose-500/15 text-rose-200 border-rose-500/30' },
  asian:        { label: 'asian',        cls: 'bg-rose-500/15 text-rose-200 border-rose-500/30' },
  tv:           { label: 'tv',           cls: 'bg-sky-500/15 text-sky-200 border-sky-500/30' },
  movies:       { label: 'movies',       cls: 'bg-violet-500/15 text-violet-200 border-violet-500/30' },
  music:        { label: 'music',        cls: 'bg-amber-500/15 text-amber-200 border-amber-500/30' },
  books:        { label: 'books',        cls: 'bg-teal-500/15 text-teal-200 border-teal-500/30' },
  general:      { label: 'general',      cls: 'bg-slate-700/40 text-slate-300 border-slate-600/40' },
  // Cost / signup / kind use a single muted style so the row stays
  // readable. The labels carry the info; colour is reserved for content.
  free:         { label: 'free',         cls: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30' },
  paid:         { label: 'paid',         cls: 'bg-slate-700/40 text-slate-300 border-slate-600/40' },
  'no-signup':   { label: 'no signup',    cls: 'bg-slate-700/40 text-slate-300 border-slate-600/40' },
  'free-signup': { label: 'free signup',  cls: 'bg-slate-700/40 text-slate-300 border-slate-600/40' },
  'invite-only': { label: 'invite-only',  cls: 'bg-slate-700/40 text-slate-300 border-slate-600/40' },
  application:  { label: 'application',  cls: 'bg-slate-700/40 text-slate-300 border-slate-600/40' },
  usenet:       { label: 'usenet',       cls: 'bg-slate-700/40 text-slate-300 border-slate-600/40' },
  torrent:      { label: 'torrent',      cls: 'bg-slate-700/40 text-slate-300 border-slate-600/40' },
}

/** Tags worth surfacing on the card — content first (most useful),
 *  then signup, then kind. We deliberately drop redundant cost tags
 *  ("paid" is implied by "invite-only" / "application") to keep the
 *  row short on small cards. */
const DISPLAY_ORDER: IndexerTag[] = [
  'anime', 'kdrama', 'asian', 'tv', 'movies', 'music', 'books', 'general',
  'no-signup', 'free-signup', 'invite-only', 'application',
  'usenet', 'torrent',
]

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
      // But a collapse is destructive when the user has already entered a
      // credential (a private-tracker passkey, a usenet API key): the clear
      // builds patch[key]=undefined for every field, onChange fires
      // immediately, and autosave then flushes the loss to the on-disk
      // profile ~600ms later — no undo. So when ANY field is non-empty,
      // confirm before wiping; an empty card collapses silently as before.
      const hasEntered = def.fields.some((f) => Boolean(values[f.key]))
      if (hasEntered && !window.confirm(
        `Turn off ${def.name}? This clears the credentials you entered for it.`,
      )) {
        return
      }
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
          aria-expanded={open}
          aria-label={`Toggle ${def.name} ${open ? 'on (collapse details)' : 'off (expand to configure)'}`}
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
                className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 hover:underline shrink-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded px-1"
                onClick={(e) => e.stopPropagation()}
                title={`Visit ${def.name} — opens in browser`}
                aria-label={`Visit ${def.name} website — opens in new tab`}
              >
                site <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </div>
          {def.note && (
            <div className="text-xs text-slate-400 truncate">{def.note}</div>
          )}
          {/* Tag pill row — at-a-glance metadata so the user can tell
              "anime + invite-only" without reading the note. Only
              renders when there's at least one tag worth showing; the
              IndexerBrowser filter chips key off the same taxonomy so
              the on-card pills double as filter affordances later. */}
          {(() => {
            const tagSet = new Set<IndexerTag>(indexerTags(def))
            const display = DISPLAY_ORDER.filter((t) => tagSet.has(t))
            if (display.length === 0) return null
            return (
              <div className="flex items-center flex-wrap gap-1 mt-1.5">
                {display.map((t) => {
                  const style = TAG_STYLE[t]
                  if (!style) return null
                  return (
                    <span
                      key={t}
                      className={
                        `inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ` +
                        `font-medium border ${style.cls}`
                      }
                    >
                      {style.label}
                    </span>
                  )
                })}
              </div>
            )
          })()}
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
              {def.fields.map((f) => {
                const inputId = `${def.id}-${f.key}`
                return (
                  <div key={f.key}>
                    <label
                      className="block text-xs text-slate-400 mb-1"
                      htmlFor={inputId}
                    >
                      {f.label}
                    </label>
                    {f.password ? (
                      <PasswordInput
                        id={inputId}
                        aria-label={`${def.name} ${f.label}`}
                        className="text-sm bg-slate-900 py-2"
                        value={(values[f.key] as string | undefined) ?? ''}
                        onChange={(e) => onChange({ [f.key]: e.target.value || undefined } as Partial<EnvFormValues>)}
                      />
                    ) : (
                      <input
                        id={inputId}
                        aria-label={`${def.name} ${f.label}`}
                        type="text"
                        className="w-full px-2.5 py-2 text-sm bg-slate-900 border border-slate-700 rounded focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
                        value={(values[f.key] as string | undefined) ?? ''}
                        onChange={(e) => onChange({ [f.key]: e.target.value || undefined } as Partial<EnvFormValues>)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
