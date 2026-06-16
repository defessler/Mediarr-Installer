import { useMemo, useState } from 'react'
import { Search, CheckCircle2 } from 'lucide-react'
import { SIRIUSXM_STATIONS, type SiriusXmStation } from '../../shared/siriusxm-stations.js'

interface Props {
  /** Comma-separated slug list — the SIRIUSXM_CHANNELS value. */
  value: string
  /** Emits the new comma-separated slug list (or '' when empty). */
  onChange: (csv: string) => void
}

// Parse the comma list into clean slugs (trimmed, de-duped, order preserved).
function parseSlugs(v: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of (v || '').split(',')) {
    const s = raw.trim()
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/** Searchable multi-select for SiriusXM channels, backed by the bundled
 *  xmplaylist directory (SIRIUSXM_STATIONS). Selected channels are written
 *  back as a comma-separated slug list; a custom-slug box covers any channel
 *  not in the snapshot. Mirrors the look of TimezoneSelect. */
export function SiriusxmSelect({ value, onChange }: Props) {
  const [filter, setFilter] = useState('')
  const [custom, setCustom] = useState('')

  const selected = useMemo(() => parseSlugs(value), [value])
  const selectedSet = useMemo(() => new Set(selected), [selected])

  const bySlug = useMemo(() => {
    const m = new Map<string, SiriusXmStation>()
    for (const s of SIRIUSXM_STATIONS) m.set(s.slug, s)
    return m
  }, [])

  const filtered = useMemo(() => {
    const terms = filter.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return SIRIUSXM_STATIONS
    return SIRIUSXM_STATIONS.filter((s) => {
      const hay = (s.name + ' ' + s.slug + ' ch ' + s.number).toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [filter])

  const emit = (slugs: string[]) => onChange(slugs.join(', '))
  const toggle = (slug: string) =>
    selectedSet.has(slug)
      ? emit(selected.filter((s) => s !== slug))
      : emit([...selected, slug])
  const remove = (slug: string) => emit(selected.filter((s) => s !== slug))
  const addCustom = () => {
    const s = custom.trim()
    if (s && !selectedSet.has(s)) emit([...selected, s])
    setCustom('')
  }

  return (
    <div className="space-y-2">
      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((slug) => {
            const st = bySlug.get(slug)
            return (
              <span
                key={slug}
                className="inline-flex items-center gap-1.5 rounded bg-emerald-900/40 border border-emerald-700/40 px-2 py-0.5 text-xs text-emerald-100"
              >
                <span className="truncate max-w-[12rem]">{st ? st.name : slug}</span>
                {st && <span className="text-emerald-400/70">· ch {st.number}</span>}
                <button
                  type="button"
                  onClick={() => remove(slug)}
                  aria-label={`Remove ${st ? st.name : slug}`}
                  className="text-emerald-300/70 hover:text-emerald-100 leading-none"
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Search box */}
      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
          aria-hidden="true"
        />
        <input
          type="text"
          placeholder="Search SiriusXM channels (e.g. 'octane', '80s', 'hip hop')"
          aria-label="Search SiriusXM channels"
          className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {/* Channel list (multi-select) */}
      <div
        role="listbox"
        aria-multiselectable="true"
        aria-label="SiriusXM channels"
        className="max-h-60 overflow-y-auto rounded-md border border-slate-700 bg-slate-900/40"
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-5 text-sm text-slate-500 text-center">
            No channels match <span className="font-mono text-slate-400">{filter}</span>. You can
            still add it as a custom slug below.
          </div>
        ) : (
          filtered.map((s) => {
            const on = selectedSet.has(s.slug)
            return (
              <button
                key={s.slug}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => toggle(s.slug)}
                className={
                  'w-full text-left px-3 py-1.5 flex items-center gap-2.5 text-sm border-b border-slate-800 last:border-b-0 ' +
                  'focus:outline-none focus-visible:bg-emerald-900/20 focus-visible:ring-1 focus-visible:ring-emerald-500/40 focus-visible:ring-inset ' +
                  (on ? 'bg-emerald-900/30 text-emerald-100' : 'hover:bg-slate-800 text-slate-200')
                }
              >
                {on ? (
                  <CheckCircle2 size={14} className="text-emerald-400 shrink-0" aria-hidden="true" />
                ) : (
                  <span className="inline-block w-3.5 h-3.5 rounded-full border border-slate-600 shrink-0" />
                )}
                <span className="flex-1 truncate">{s.name}</span>
                <span className="text-slate-500 text-xs shrink-0">ch {s.number}</span>
                <span className="text-slate-600 text-[11px] font-mono shrink-0 hidden sm:inline">
                  {s.slug}
                </span>
              </button>
            )
          })
        )}
      </div>

      {/* Custom slug escape hatch + count */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Add a custom slug not in the list"
          aria-label="Add a custom SiriusXM slug"
          className="flex-1 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs focus:border-emerald-500 focus:outline-none"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addCustom()
            }
          }}
        />
        <button
          type="button"
          onClick={addCustom}
          disabled={!custom.trim()}
          className="px-3 py-1.5 text-xs rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 transition-colors"
        >
          Add
        </button>
      </div>
      <div className="text-[11px] text-slate-500">
        {selected.length} selected · {filtered.length} of {SIRIUSXM_STATIONS.length} channels
      </div>
    </div>
  )
}
