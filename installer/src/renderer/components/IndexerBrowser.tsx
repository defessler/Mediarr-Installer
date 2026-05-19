// IndexerBrowser — unified searchable + filterable view over the
// curated indexer catalog (built-in entries) + custom user-defined
// indexers loaded from CUSTOM_INDEXERS_JSON.
//
// Why a single browser instead of three separate sections (the previous
// Usenet / Private trackers / Bazarr split): users don't think in
// "is this usenet or torrent" — they think "is this for anime?" or
// "do I need to pay?". A filterable view lets the user discover an
// indexer by what they actually care about. The legacy section
// headers are gone; their content is folded into this list with tag
// chips on each card.
//
// Filter axes:
//   • Content — TV / Movies / Anime / K-drama / Asian / Music / Books / General
//   • Cost — Free / Paid
//   • Signup — No signup / Free signup / Invite-only / Application
//   • Kind — Usenet / Torrent
// Within a single axis, the chip set is OR (e.g. "TV OR Movies"). Across
// axes the filter is AND (e.g. "Free AND Anime"). "All" clears the axis.

import { useMemo, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Search, Filter, Globe, X, Sparkles, AlertCircle } from 'lucide-react'
import {
  type EnvFormValues,
  type IndexerDef,
  type IndexerTag,
  indexerTags,
} from '../../shared/env-render.js'
import { IndexerCard } from './IndexerCard.js'

interface Props {
  /** Built-in catalog from env-render.ts — typically the concat of
   *  USENET_INDEXERS + PUBLIC_TRACKERS + PRIVATE_TRACKERS. */
  catalog: IndexerDef[]
  values: Partial<EnvFormValues>
  onChange: (patch: Partial<EnvFormValues>) => void
}

/** Filter chip set for one axis. Each item is rendered as a toggleable
 *  pill; selecting multiple OR's them within the axis. */
const CONTENT_FILTERS: { tag: IndexerTag; label: string }[] = [
  { tag: 'tv',      label: 'TV' },
  { tag: 'movies',  label: 'Movies' },
  { tag: 'anime',   label: 'Anime' },
  { tag: 'kdrama',  label: 'K-drama' },
  { tag: 'asian',   label: 'Asian (live)' },
  { tag: 'music',   label: 'Music' },
  { tag: 'general', label: 'General' },
]
const COST_FILTERS: { tag: IndexerTag; label: string }[] = [
  { tag: 'free', label: 'Free' },
  { tag: 'paid', label: 'Paid' },
]
const SIGNUP_FILTERS: { tag: IndexerTag; label: string }[] = [
  { tag: 'no-signup',   label: 'No signup' },
  { tag: 'free-signup', label: 'Free signup' },
  { tag: 'invite-only', label: 'Invite-only' },
  { tag: 'application', label: 'Application' },
]
const KIND_FILTERS: { tag: IndexerTag; label: string }[] = [
  { tag: 'usenet',  label: 'Usenet' },
  { tag: 'torrent', label: 'Torrent' },
]

export function IndexerBrowser({ catalog, values, onChange }: Props) {
  const [query, setQuery] = useState('')
  const [contentTags, setContentTags] = useState<Set<IndexerTag>>(new Set())
  const [costTags, setCostTags]       = useState<Set<IndexerTag>>(new Set())
  const [signupTags, setSignupTags]   = useState<Set<IndexerTag>>(new Set())
  const [kindTags, setKindTags]       = useState<Set<IndexerTag>>(new Set())
  const reduced = useReducedMotion()

  // Pre-compute each indexer's tag set once (indexerTags() folds in
  // category-derived tags) so the per-render filter is cheap.
  const enriched = useMemo(() => catalog.map((d) => ({
    def: d,
    tags: new Set<IndexerTag>(indexerTags(d)),
    /** Lowercased haystack for the text search. */
    haystack: `${d.name} ${d.note ?? ''}`.toLowerCase(),
  })), [catalog])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return enriched.filter(({ def, tags, haystack }) => {
      // Text match: empty query passes everything.
      if (q && !haystack.includes(q)) return false
      // AND across axes; OR within each axis. An empty axis matches
      // everything (the "All" chip is implicit).
      if (contentTags.size > 0) {
        let ok = false
        for (const t of contentTags) if (tags.has(t)) { ok = true; break }
        if (!ok) return false
      }
      if (costTags.size > 0) {
        let ok = false
        for (const t of costTags) if (tags.has(t)) { ok = true; break }
        if (!ok) return false
      }
      if (signupTags.size > 0) {
        let ok = false
        for (const t of signupTags) if (tags.has(t)) { ok = true; break }
        if (!ok) return false
      }
      if (kindTags.size > 0) {
        let ok = false
        for (const t of kindTags) if (tags.has(t)) { ok = true; break }
        if (!ok) return false
      }
      // Reference def in a no-op so the destructure is type-stable
      // (TS would complain about unused `def` otherwise; we use it
      // in the JSX below).
      void def
      return true
    })
  }, [enriched, query, contentTags, costTags, signupTags, kindTags])

  const totalActive = contentTags.size + costTags.size + signupTags.size + kindTags.size
  const filtersDirty = totalActive > 0 || query.length > 0

  function clearAll() {
    setQuery('')
    setContentTags(new Set())
    setCostTags(new Set())
    setSignupTags(new Set())
    setKindTags(new Set())
  }

  return (
    <section className="space-y-3">
      <header className="space-y-2">
        <h3 className="text-base font-medium flex items-center gap-2">
          <Globe size={16} className="text-slate-400" strokeWidth={1.75} aria-hidden="true" />
          Find indexers
          <span className="text-xs font-normal text-slate-500 ml-1">
            ({visible.length} of {enriched.length} shown)
          </span>
        </h3>
        <p className="text-sm text-slate-400">
          The wizard ships with a curated catalog covering the most-used
          indexers. Use the filter chips to narrow by content type, cost,
          or signup style. For anything specialty, the{' '}
          <em>Custom indexers</em> block below lets you paste a
          Newznab-compatible URL + API key. Prowlarr supports 500+ more
          via its built-in catalogue — open Prowlarr after install if
          you need something not listed here.
        </p>
      </header>

      {/* Search input — debounced is overkill for ~30 entries; just
          filter on each keystroke. */}
      <div className="relative">
        <Search
          size={14}
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
        />
        <input
          type="text"
          placeholder="Search by name or description…"
          aria-label="Search indexers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full pl-9 pr-9 py-2 text-sm bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-6 h-6 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Filter chip rows — one row per axis. Each chip is a toggle;
          multiple selections within a row OR. The leading icon clarifies
          what axis the row is for at a glance. */}
      <div className="space-y-1.5">
        <ChipRow
          icon={<Sparkles size={12} aria-hidden="true" className="text-emerald-400" />}
          label="Content"
          filters={CONTENT_FILTERS}
          active={contentTags}
          setActive={setContentTags}
        />
        <ChipRow
          icon={<Filter size={12} aria-hidden="true" className="text-sky-400" />}
          label="Cost"
          filters={COST_FILTERS}
          active={costTags}
          setActive={setCostTags}
        />
        <ChipRow
          icon={<Filter size={12} aria-hidden="true" className="text-amber-400" />}
          label="Signup"
          filters={SIGNUP_FILTERS}
          active={signupTags}
          setActive={setSignupTags}
        />
        <ChipRow
          icon={<Filter size={12} aria-hidden="true" className="text-violet-400" />}
          label="Kind"
          filters={KIND_FILTERS}
          active={kindTags}
          setActive={setKindTags}
        />
        {filtersDirty && (
          <div className="pt-1">
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded px-1"
            >
              <X size={11} aria-hidden="true" />
              Reset filters
            </button>
          </div>
        )}
      </div>

      {/* Results grid */}
      {visible.length === 0 ? (
        <motion.div
          initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          role="status"
          aria-live="polite"
          className="rounded-md border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400 flex items-start gap-3"
        >
          <AlertCircle size={16} className="text-amber-300 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1">
            <div className="text-slate-200 font-medium">No indexers match your filters</div>
            <p className="text-xs mt-0.5">
              Try widening the chip set or clear the search box. If you
              need an indexer that isn't in this catalog, add it via the
              Custom indexers editor below or through Prowlarr's web UI
              after install.
            </p>
          </div>
        </motion.div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {visible.map(({ def }) => (
            <IndexerCard key={def.id} def={def} values={values} onChange={onChange} />
          ))}
        </div>
      )}
    </section>
  )
}

/** One row of toggleable filter chips. Multi-select within the row;
 *  the parent owns the Set state so cross-row reset is trivial. */
function ChipRow({
  icon, label, filters, active, setActive,
}: {
  icon: React.ReactNode
  label: string
  filters: { tag: IndexerTag; label: string }[]
  active: Set<IndexerTag>
  setActive: (s: Set<IndexerTag>) => void
}) {
  function toggle(tag: IndexerTag) {
    const next = new Set(active)
    if (next.has(tag)) next.delete(tag)
    else next.add(tag)
    setActive(next)
  }
  return (
    <div className="flex items-center flex-wrap gap-1.5 text-xs" role="group" aria-label={`${label} filter`}>
      <span className="inline-flex items-center gap-1 text-slate-500 uppercase tracking-wider font-semibold pr-1 min-w-[5.5em]">
        {icon} {label}
      </span>
      {filters.map((f) => {
        const isActive = active.has(f.tag)
        return (
          <button
            key={f.tag}
            type="button"
            onClick={() => toggle(f.tag)}
            aria-pressed={isActive}
            className={
              'px-2.5 py-1 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 ' +
              (isActive
                ? 'bg-emerald-600/30 border-emerald-500/50 text-emerald-100'
                : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600')
            }
          >
            {f.label}
          </button>
        )
      })}
    </div>
  )
}
