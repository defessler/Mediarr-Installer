// IndexerBrowser — unified searchable + filterable view over the
// curated indexer catalog (built-in entries) + custom user-defined
// indexers loaded from CUSTOM_INDEXERS_JSON.
//
// v0.3.32 redesign — the previous all-in-one grid dumped 30 cards on
// the user by default and left them scrolling through a wall of
// toggles. The new layout splits the catalog two ways:
//
//   1. Auto-added (public, no signup) — rendered as a compact pill
//      strip inside a collapsed summary block. These get added on
//      install regardless of user input, so they don't need a card.
//   2. Credentials-needed — rendered as cards, grouped by Kind
//      (Usenet sub-section + Torrent sub-section) so a user adding
//      usenet creds doesn't have to wade past every private tracker.
//
// Filter chips trimmed from four rows to three (Content / Cost /
// Signup). Kind is now visual (sub-section headers), making the
// Kind chip row redundant.
//
// Filter axes:
//   • Content — TV / Movies / Anime / K-drama / Asian / Music / Books / General
//   • Cost — Free / Paid
//   • Signup — No signup / Free signup / Invite-only / Application
// Within a single axis, the chip set is OR (e.g. "TV OR Movies"). Across
// axes the filter is AND (e.g. "Free AND Anime"). "All" clears the axis.

import { useMemo, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import {
  Search, Filter, Globe, X, Sparkles, AlertCircle, Gift, Newspaper, Download,
} from 'lucide-react'
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

export function IndexerBrowser({ catalog, values, onChange }: Props) {
  const [query, setQuery] = useState('')
  const [contentTags, setContentTags] = useState<Set<IndexerTag>>(new Set())
  const [costTags, setCostTags]       = useState<Set<IndexerTag>>(new Set())
  const [signupTags, setSignupTags]   = useState<Set<IndexerTag>>(new Set())
  const reduced = useReducedMotion()

  // Pre-compute each indexer's tag set once (indexerTags() folds in
  // category-derived tags) so the per-render filter is cheap.
  const enriched = useMemo(() => catalog.map((d) => ({
    def: d,
    tags: new Set<IndexerTag>(indexerTags(d)),
    /** Lowercased haystack for the text search. */
    haystack: `${d.name} ${d.note ?? ''}`.toLowerCase(),
    /** Pre-computed: does this entry need credentials, or is it
     *  auto-added on install? Drives the dual-list split below. */
    autoAdded: d.fields.length === 0,
  })), [catalog])

  // Split the catalog two ways before filtering.
  //   • autoAdded — public, no-signup. Rendered as a compact pill list
  //     inside a collapsed summary block. The previous design rendered
  //     them as 30 toggleable cards alongside the credentials-needed
  //     cards, which was the biggest reason the panel felt heavy.
  //   • needsCreds — won't be added unless the user supplies API keys
  //     or login. These are the rows that actually need a card (you
  //     need somewhere to type credentials into).
  const { autoAdded, needsCreds } = useMemo(() => ({
    autoAdded:  enriched.filter((e) =>  e.autoAdded),
    needsCreds: enriched.filter((e) => !e.autoAdded),
  }), [enriched])

  function matches(e: typeof enriched[number]) {
    const q = query.trim().toLowerCase()
    if (q && !e.haystack.includes(q)) return false
    if (contentTags.size > 0) {
      let ok = false
      for (const t of contentTags) if (e.tags.has(t)) { ok = true; break }
      if (!ok) return false
    }
    if (costTags.size > 0) {
      let ok = false
      for (const t of costTags) if (e.tags.has(t)) { ok = true; break }
      if (!ok) return false
    }
    if (signupTags.size > 0) {
      let ok = false
      for (const t of signupTags) if (e.tags.has(t)) { ok = true; break }
      if (!ok) return false
    }
    return true
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visibleAuto = useMemo(() => autoAdded.filter(matches),
    [autoAdded, query, contentTags, costTags, signupTags])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visibleNeedsCreds = useMemo(() => needsCreds.filter(matches),
    [needsCreds, query, contentTags, costTags, signupTags])

  // Sub-bucket credentials-needed cards by Kind for visual sections.
  const credsByKind = useMemo(() => {
    const usenet: typeof visibleNeedsCreds = []
    const torrent: typeof visibleNeedsCreds = []
    const other: typeof visibleNeedsCreds = []
    for (const e of visibleNeedsCreds) {
      if (e.tags.has('usenet')) usenet.push(e)
      else if (e.tags.has('torrent')) torrent.push(e)
      else other.push(e)
    }
    return { usenet, torrent, other }
  }, [visibleNeedsCreds])

  const totalVisible = visibleAuto.length + visibleNeedsCreds.length
  const totalActive = contentTags.size + costTags.size + signupTags.size
  const filtersDirty = totalActive > 0 || query.length > 0

  function clearAll() {
    setQuery('')
    setContentTags(new Set())
    setCostTags(new Set())
    setSignupTags(new Set())
  }

  return (
    <section className="space-y-4">
      <header className="space-y-2">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <Globe size={18} className="text-slate-400" strokeWidth={1.75} aria-hidden="true" />
          Find indexers
          <span className="text-xs font-normal text-slate-500 ml-1">
            ({totalVisible} of {enriched.length} match)
          </span>
        </h3>
        <p className="text-sm text-slate-400">
          The wizard ships with a curated catalog covering the most-used
          indexers. The free / no-signup ones are added automatically — only
          the cards below need your input. For anything specialty, use the{' '}
          <em>Custom indexers</em> editor below or open Prowlarr after install.
        </p>
      </header>

      {/* Auto-added summary — collapsed accordion. Saves ~25 cards
          worth of visual noise (most users never touch these; they
          just want to know what they're getting). */}
      <details className="rounded-md border border-slate-700/40 bg-slate-900/30 group">
        <summary className="cursor-pointer px-3 py-2 text-sm flex items-center gap-2 select-none hover:bg-slate-900/50 transition-colors rounded-md [&::-webkit-details-marker]:hidden">
          <Gift size={16} className="text-emerald-400" aria-hidden="true" />
          <span className="font-medium text-slate-100">
            {visibleAuto.length} free indexer{visibleAuto.length === 1 ? '' : 's'} added automatically
          </span>
          <span className="text-xs text-slate-500">— no signup needed</span>
          <span className="ml-auto text-xs text-slate-500 group-open:hidden">click to list</span>
        </summary>
        <div className="px-3 pb-3 pt-1">
          {visibleAuto.length === 0 ? (
            <div className="text-xs text-slate-500">
              No auto-added indexers match the current filters.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {visibleAuto.map(({ def }) => (
                <a
                  key={def.id}
                  href={def.href ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => { if (!def.href) e.preventDefault() }}
                  className={
                    'inline-flex items-center px-2 py-0.5 rounded text-xs ' +
                    'bg-slate-800/70 border border-slate-700 text-slate-300 ' +
                    (def.href ? 'hover:border-emerald-600/50 hover:text-emerald-200 transition-colors' : 'cursor-default')
                  }
                  title={def.note ?? def.name}
                >
                  {def.name}
                </a>
              ))}
            </div>
          )}
        </div>
      </details>

      {/* Search input */}
      <div className="relative">
        <Search
          size={16}
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
        />
        <input
          type="text"
          placeholder="Search indexers by name or description…"
          aria-label="Search indexers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full pl-10 pr-9 py-2 text-sm bg-slate-800 border border-slate-700 rounded-md focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-6 h-6 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Filter chips — 3 axes (Kind is now visual via sub-sections). */}
      <div className="space-y-1.5">
        <ChipRow
          icon={<Sparkles size={14} aria-hidden="true" className="text-emerald-400" />}
          label="Content"
          filters={CONTENT_FILTERS}
          active={contentTags}
          setActive={setContentTags}
        />
        <ChipRow
          icon={<Filter size={14} aria-hidden="true" className="text-sky-400" />}
          label="Cost"
          filters={COST_FILTERS}
          active={costTags}
          setActive={setCostTags}
        />
        <ChipRow
          icon={<Filter size={14} aria-hidden="true" className="text-amber-400" />}
          label="Signup"
          filters={SIGNUP_FILTERS}
          active={signupTags}
          setActive={setSignupTags}
        />
        {filtersDirty && (
          <div className="pt-1">
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded px-1"
            >
              <X size={13} aria-hidden="true" />
              Reset filters
            </button>
          </div>
        )}
      </div>

      {/* Credentials-needed sub-sections, grouped by Kind. Each Kind
          gets its own h4 + card grid; empty Kinds collapse to a
          one-line "nothing matches" line so the heading still gives
          orientation but doesn't take screen space. */}
      {visibleNeedsCreds.length === 0 && visibleAuto.length === 0 ? (
        <motion.div
          initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          role="status"
          aria-live="polite"
          className="rounded-md border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400 flex items-start gap-3"
        >
          <AlertCircle size={18} className="text-amber-300 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1">
            <div className="text-slate-200 font-medium">No indexers match your filters</div>
            <p className="text-xs mt-0.5">
              Widen the chip set or clear the search box. If you need an
              indexer that isn't in this catalog, add it via the Custom
              indexers editor below or through Prowlarr's web UI after
              install.
            </p>
          </div>
        </motion.div>
      ) : (
        <>
          <KindSection
            icon={<Newspaper size={16} className="text-orange-400" aria-hidden="true" />}
            label="Usenet — credentials required"
            entries={credsByKind.usenet}
            values={values}
            onChange={onChange}
            filterActive={filtersDirty}
          />
          <KindSection
            icon={<Download size={16} className="text-blue-400" aria-hidden="true" />}
            label="Private torrent trackers"
            entries={credsByKind.torrent}
            values={values}
            onChange={onChange}
            filterActive={filtersDirty}
          />
          {credsByKind.other.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {credsByKind.other.map(({ def }) => (
                <IndexerCard key={def.id} def={def} values={values} onChange={onChange} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** One Kind sub-section (Usenet or Torrent). The h4 + count gives the
 *  user orientation; when filters hide every entry in this Kind we
 *  collapse to a one-liner so the section still exists in the visual
 *  hierarchy but doesn't waste vertical space. */
function KindSection({
  icon, label, entries, values, onChange, filterActive,
}: {
  icon: React.ReactNode
  label: string
  entries: { def: IndexerDef }[]
  values: Partial<EnvFormValues>
  onChange: (patch: Partial<EnvFormValues>) => void
  filterActive: boolean
}) {
  if (entries.length === 0) {
    return (
      <div className="text-xs text-slate-500 inline-flex items-center gap-2">
        {icon}
        <span className="font-medium text-slate-400">{label}</span>
        <span>— {filterActive ? 'nothing matches the current filters' : 'no entries'}</span>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold inline-flex items-center gap-2 text-slate-200">
        {icon}
        {label}
        <span className="text-xs font-normal text-slate-500">
          ({entries.length})
        </span>
      </h4>
      <div className="grid grid-cols-2 gap-3">
        {entries.map(({ def }) => (
          <IndexerCard key={def.id} def={def} values={values} onChange={onChange} />
        ))}
      </div>
    </div>
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
