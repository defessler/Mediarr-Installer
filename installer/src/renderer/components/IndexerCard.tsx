import { useEffect, useState } from 'react'
import type { EnvFormValues, IndexerDef } from '../../shared/env-render.js'

interface Props {
  def: IndexerDef
  values: Partial<EnvFormValues>
  onChange: (patch: Partial<EnvFormValues>) => void
}

// A single indexer or subtitle-provider card. Toggling it on reveals the
// credential fields. Toggling off clears all of the def's fields so we
// don't leak partial credentials into the .env.
export function IndexerCard({ def, values, onChange }: Props) {
  // "Enabled" if the user has typed anything into any field, OR explicitly
  // toggled the card open. Local state tracks the explicit toggle so the
  // form doesn't auto-collapse the moment they clear a field to retype it.
  const hasValue = def.fields.some((f) => Boolean(values[f.key]))
  const [open, setOpen] = useState(hasValue)
  useEffect(() => { if (hasValue) setOpen(true) }, [hasValue])

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
      'rounded-md border p-3 transition-colors ' +
      (open ? 'border-emerald-700/50 bg-emerald-900/10' : 'border-slate-700 bg-slate-800/30')
    }>
      <div className="flex items-center gap-3">
        {/* Toggle pill */}
        <button
          type="button"
          onClick={toggle}
          aria-pressed={open}
          className={
            'shrink-0 inline-flex items-center w-9 h-5 rounded-full transition-colors ' +
            (open ? 'bg-emerald-500' : 'bg-slate-700')
          }
        >
          <span
            className={
              'block w-4 h-4 bg-white rounded-full shadow transition-transform ' +
              (open ? 'translate-x-4' : 'translate-x-0.5')
            }
          />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="font-medium truncate">{def.name}</div>
            {def.href && (
              <a
                href={def.href}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-emerald-400 hover:underline shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                site
              </a>
            )}
          </div>
          {def.note && (
            <div className="text-xs text-slate-400 truncate">{def.note}</div>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          {def.fields.map((f) => (
            <div key={f.key}>
              <label className="block text-xs text-slate-400 mb-0.5">{f.label}</label>
              <input
                type={f.password ? 'password' : 'text'}
                className="w-full px-2 py-1.5 text-sm bg-slate-900 border border-slate-700 rounded"
                value={(values[f.key] as string | undefined) ?? ''}
                onChange={(e) => onChange({ [f.key]: e.target.value || undefined } as Partial<EnvFormValues>)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
