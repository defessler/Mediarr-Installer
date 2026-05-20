// CustomIndexerEditor — in-app editor for CUSTOM_INDEXERS_JSON.
//
// Power users want to add specialty indexers the wizard doesn't ship
// with — niche regional sites, private indexers without an automation
// helper, brand-new Newznab boxes — without waiting for the wizard
// catalog to catch up. This editor lets them register one or more
// Newznab-compatible entries by URL + API key, persisted as a JSON
// blob in the .env (CUSTOM_INDEXERS_JSON). setup-indexers.py parses
// that JSON at install time and registers each entry against Prowlarr
// alongside the curated catalog.
//
// Scope intentionally narrow:
//   • Only Newznab-compatible indexers. Private cardigann/jackett
//     trackers have a different add path and are easier to manage
//     directly in Prowlarr's web UI; the editor doesn't try to model
//     them. We surface this limitation in the helper text.
//   • Optional fields stay truly optional — missing `tags` / `note` /
//     `categories` is fine. We don't bark at the user for an empty
//     field that the underlying Prowlarr API treats as optional too.

import { useMemo, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import {
  Plus, Trash2, ExternalLink, AlertCircle, Code2, ChevronDown,
} from 'lucide-react'
import type { EnvFormValues } from '../../shared/env-render.js'
import { PasswordInput } from './PasswordInput.js'
import { BigButton } from './BigButton.js'

/** One user-defined indexer entry. The shape is intentionally narrower
 *  than IndexerDef — we don't need wizard-side field metadata since
 *  every entry has the same set of fields (name / url / apiKey / etc.). */
export interface CustomIndexer {
  /** Display name in Prowlarr + the wizard. Required. */
  name: string
  /** Base URL (host + optional path). Must start with http:// or
   *  https://. setup-indexers.py POSTs this as the indexer's base
   *  URL when calling Prowlarr's /api/v1/indexer endpoint. */
  url: string
  /** API key. Optional for fully-public no-signup indexers (rare for
   *  Newznab — most still want a key). Empty string is treated as
   *  "no auth". */
  apiKey?: string
  /** Newznab API path override (default /api). Some indexers use
   *  /api/v1.0 or /api.php. Leave blank to use the default. */
  apiPath?: string
  /** Newznab category list (CSV of ints, e.g. "2000,3000,5000") to
   *  restrict the indexer's search categories. Leave blank for all. */
  categories?: string
  /** Optional one-line description for the editor + wizard UI. */
  note?: string
  /** Optional content tags. Power-user metadata for the user's own
   *  reference; not consumed by setup-indexers.py at this time. */
  tags?: string[]
}

interface Props {
  values: Partial<EnvFormValues>
  onChange: (patch: Partial<EnvFormValues>) => void
}

/** Parse CUSTOM_INDEXERS_JSON safely. Returns ([], parseError) when the
 *  blob is malformed — the editor surfaces the error in a banner and
 *  refuses to overwrite the bad JSON automatically (the user can hit
 *  "Reset to empty" to fix it). Empty / missing returns ([], null). */
function parseCustomIndexers(
  raw: string | undefined,
): { items: CustomIndexer[]; parseError: string | null } {
  if (!raw || !raw.trim()) return { items: [], parseError: null }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return {
        items: [],
        parseError: 'CUSTOM_INDEXERS_JSON is not an array. Expected a JSON list of indexer objects.',
      }
    }
    // Light coercion — anything that's not a string drops to empty,
    // missing optional fields stay missing. We don't validate at parse
    // time so the user can save partial entries and finish later.
    const items: CustomIndexer[] = parsed.map((p: unknown): CustomIndexer => {
      const obj = (p && typeof p === 'object') ? p as Record<string, unknown> : {}
      const asStr = (k: string) => typeof obj[k] === 'string' ? obj[k] as string : ''
      const asTagList = (k: string) => {
        const v = obj[k]
        if (!Array.isArray(v)) return undefined
        return v.filter((t): t is string => typeof t === 'string')
      }
      const out: CustomIndexer = {
        name: asStr('name'),
        url:  asStr('url'),
      }
      // Only attach optional fields when they have content — keeps the
      // JSON round-trip clean for entries that omitted them.
      const ak = asStr('apiKey')
      if (ak) out.apiKey = ak
      const ap = asStr('apiPath')
      if (ap) out.apiPath = ap
      const cats = asStr('categories')
      if (cats) out.categories = cats
      const note = asStr('note')
      if (note) out.note = note
      const tags = asTagList('tags')
      if (tags && tags.length > 0) out.tags = tags
      return out
    })
    return { items, parseError: null }
  } catch (e) {
    return { items: [], parseError: (e as Error).message }
  }
}

/** Serialise back to a JSON string, dropping fully-empty entries so a
 *  user who clicks Add and then never types anything doesn't get an
 *  orphan row persisted. Empty array is stored as '' (not '[]') so
 *  the .env doesn't gain a useless line for the common no-custom case. */
function serializeCustomIndexers(items: CustomIndexer[]): string {
  const cleaned = items
    .map((i) => ({
      name: i.name.trim(),
      url: i.url.trim(),
      apiKey: i.apiKey?.trim() || undefined,
      apiPath: i.apiPath?.trim() || undefined,
      categories: i.categories?.trim() || undefined,
      note: i.note?.trim() || undefined,
      tags: i.tags && i.tags.length > 0 ? i.tags : undefined,
    }))
    .filter((i) => i.name || i.url)        // drop blank rows
    // Strip undefined-valued keys before serialising — keeps the JSON
    // string compact and stable. `JSON.stringify` already skips
    // undefined values; this just makes that explicit.
    .map((i) => {
      const out: Record<string, unknown> = { name: i.name, url: i.url }
      if (i.apiKey)     out.apiKey = i.apiKey
      if (i.apiPath)    out.apiPath = i.apiPath
      if (i.categories) out.categories = i.categories
      if (i.note)       out.note = i.note
      if (i.tags)       out.tags = i.tags
      return out
    })
  return cleaned.length === 0 ? '' : JSON.stringify(cleaned, null, 2)
}

/** Quick URL sniff — does it look like a Newznab base URL? We only flag
 *  obvious mistakes (no protocol, embedded query string) — the actual
 *  validation happens server-side when Prowlarr tries to add it. */
function urlIssue(url: string): string | null {
  if (!url.trim()) return null
  if (!/^https?:\/\//i.test(url)) return 'URL must start with http:// or https://'
  if (url.includes('?')) return 'Drop the query string — paste only the base URL (e.g. https://indexer.tld)'
  return null
}

export function CustomIndexerEditor({ values, onChange }: Props) {
  const reduced = useReducedMotion()
  const raw = values.CUSTOM_INDEXERS_JSON
  const { items, parseError } = useMemo(() => parseCustomIndexers(raw), [raw])
  const [advanced, setAdvanced] = useState(false)
  const [draftRaw, setDraftRaw] = useState<string | null>(null)

  /** Replace the whole list with `next`, serialise, and push to the
   *  wizard's config store. Single source of truth — every mutation
   *  flows through here so the JSON round-trip is consistent. */
  function commit(next: CustomIndexer[]) {
    const json = serializeCustomIndexers(next)
    onChange({ CUSTOM_INDEXERS_JSON: json || undefined })
  }

  function addEmpty() {
    commit([...items, { name: '', url: '' }])
  }

  function updateAt(idx: number, patch: Partial<CustomIndexer>) {
    const next = items.slice()
    next[idx] = { ...next[idx], ...patch }
    commit(next)
  }

  function removeAt(idx: number) {
    const next = items.filter((_, i) => i !== idx)
    commit(next)
  }

  function commitAdvancedDraft() {
    if (draftRaw === null) return
    try {
      const parsed = JSON.parse(draftRaw)
      if (!Array.isArray(parsed)) {
        // surface the issue but don't overwrite
        return
      }
      commit(parsed as CustomIndexer[])
      setDraftRaw(null)
    } catch {
      // surface via the textarea's invalid border below
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="custom-indexers-heading">
      <header className="space-y-1.5">
        <h3
          id="custom-indexers-heading"
          className="text-base font-medium flex items-center gap-2"
        >
          <Plus size={18} className="text-emerald-400" strokeWidth={2.5} aria-hidden="true" />
          Custom indexers
          <span className="text-xs font-normal text-slate-500 ml-1">
            ({items.length} {items.length === 1 ? 'entry' : 'entries'})
          </span>
        </h3>
        <p className="text-sm text-slate-400">
          Add Newznab-compatible indexers not in the catalog above. The
          wizard registers each entry against Prowlarr at install time —
          name, URL, and (usually) API key are all that's needed. For
          non-Newznab trackers, add them in Prowlarr's web UI after
          install (Settings → Indexers → Add).
        </p>
      </header>

      {parseError && (
        <div
          role="alert"
          className="rounded-md border border-rose-700/40 bg-rose-900/20 p-3 text-xs text-rose-100 flex items-start gap-2"
        >
          <AlertCircle size={16} className="text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1">
            <div className="font-semibold">Couldn't parse CUSTOM_INDEXERS_JSON</div>
            <pre className="mt-1 whitespace-pre-wrap font-mono">{parseError}</pre>
            <button
              type="button"
              onClick={() => onChange({ CUSTOM_INDEXERS_JSON: undefined })}
              className="mt-2 underline hover:text-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40 rounded"
            >
              Reset to empty
            </button>
          </div>
        </div>
      )}

      {/* Entry list — each row is a self-contained form. Add new row
          via the button below the list. */}
      <AnimatePresence initial={false}>
        {items.map((entry, idx) => {
          const urlErr = urlIssue(entry.url)
          return (
            <motion.div
              key={idx}
              initial={reduced ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 p-3 space-y-2"
            >
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    className="block text-xs text-slate-400 mb-1"
                    htmlFor={`cidx-${idx}-name`}
                  >
                    Name
                    <span className="text-rose-400 ml-0.5">*</span>
                  </label>
                  <input
                    id={`cidx-${idx}-name`}
                    type="text"
                    placeholder="My Custom Indexer"
                    value={entry.name}
                    onChange={(e) => updateAt(idx, { name: e.target.value })}
                    className="w-full px-2.5 py-2 text-sm bg-slate-900 border border-slate-700 rounded focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
                  />
                </div>
                <div>
                  <label
                    className="block text-xs text-slate-400 mb-1"
                    htmlFor={`cidx-${idx}-url`}
                  >
                    Base URL
                    <span className="text-rose-400 ml-0.5">*</span>
                  </label>
                  <input
                    id={`cidx-${idx}-url`}
                    type="url"
                    placeholder="https://indexer.example.com"
                    value={entry.url}
                    onChange={(e) => updateAt(idx, { url: e.target.value })}
                    aria-invalid={urlErr ? true : undefined}
                    className={
                      'w-full px-2.5 py-2 text-sm bg-slate-900 border rounded focus:outline-none focus:ring-1 transition-colors ' +
                      (urlErr
                        ? 'border-rose-600 focus:ring-rose-400/40'
                        : 'border-slate-700 focus:border-emerald-500 focus:ring-emerald-500/40')
                    }
                  />
                  {urlErr && (
                    <div className="mt-1 text-xs text-rose-300">{urlErr}</div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    className="block text-xs text-slate-400 mb-1"
                    htmlFor={`cidx-${idx}-key`}
                  >
                    API key
                    <span className="ml-1 text-slate-600">(optional for no-signup)</span>
                  </label>
                  <PasswordInput
                    id={`cidx-${idx}-key`}
                    className="text-sm bg-slate-900 py-2"
                    value={entry.apiKey ?? ''}
                    onChange={(e) => updateAt(idx, { apiKey: e.target.value || undefined })}
                  />
                </div>
                <div>
                  <label
                    className="block text-xs text-slate-400 mb-1"
                    htmlFor={`cidx-${idx}-cats`}
                  >
                    Categories
                    <span className="ml-1 text-slate-600">(comma-separated, optional)</span>
                  </label>
                  <input
                    id={`cidx-${idx}-cats`}
                    type="text"
                    placeholder="2000,3000,5000"
                    value={entry.categories ?? ''}
                    onChange={(e) => updateAt(idx, { categories: e.target.value || undefined })}
                    className="w-full px-2.5 py-2 text-sm bg-slate-900 border border-slate-700 rounded focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors font-mono"
                  />
                </div>
              </div>

              <div>
                <label
                  className="block text-xs text-slate-400 mb-1"
                  htmlFor={`cidx-${idx}-note`}
                >
                  Note <span className="text-slate-600">(optional)</span>
                </label>
                <input
                  id={`cidx-${idx}-note`}
                  type="text"
                  placeholder="What this indexer is good for — only you see this."
                  value={entry.note ?? ''}
                  onChange={(e) => updateAt(idx, { note: e.target.value || undefined })}
                  className="w-full px-2.5 py-2 text-sm bg-slate-900 border border-slate-700 rounded focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <BigButton
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={14} aria-hidden="true" />}
                  onClick={() => removeAt(idx)}
                >
                  Remove
                </BigButton>
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>

      <div className="flex items-center gap-2 flex-wrap">
        <BigButton
          size="sm"
          variant="secondary"
          icon={<Plus size={14} fill="currentColor" aria-hidden="true" />}
          onClick={addEmpty}
        >
          Add custom indexer
        </BigButton>
        <button
          type="button"
          onClick={() => {
            setAdvanced((v) => !v)
            setDraftRaw(advanced ? null : (raw ?? ''))
          }}
          className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded px-1"
          aria-expanded={advanced}
        >
          <Code2 size={14} aria-hidden="true" />
          {advanced ? 'Hide raw JSON' : 'Edit JSON directly'}
          <ChevronDown
            size={13}
            aria-hidden="true"
            className={`transition-transform ${advanced ? 'rotate-180' : ''}`}
          />
        </button>
        <a
          href="https://github.com/Prowlarr/Indexers"
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 rounded px-1"
          aria-label="Browse Prowlarr's full indexer catalogue on GitHub — opens in new tab"
        >
          Browse Prowlarr's full catalogue
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>

      <AnimatePresence>
        {advanced && (
          <motion.div
            initial={reduced ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-1 space-y-2 rounded-md border border-slate-700/60 bg-slate-900/50 p-3">
              <label
                htmlFor="custom-indexers-json-raw"
                className="block text-xs text-slate-400"
              >
                Raw JSON
                <span className="ml-1 text-slate-600">
                  (advanced — edits here overwrite the form above on
                  Apply; bad JSON is rejected)
                </span>
              </label>
              <textarea
                id="custom-indexers-json-raw"
                value={draftRaw ?? ''}
                onChange={(e) => setDraftRaw(e.target.value)}
                rows={10}
                className="w-full px-2.5 py-2 text-xs font-mono bg-slate-950 border border-slate-700 rounded focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 transition-colors"
                placeholder='[\n  {\n    "name": "My Indexer",\n    "url": "https://example.com",\n    "apiKey": "abc123"\n  }\n]'
              />
              <div className="flex items-center justify-end gap-2">
                <BigButton
                  size="sm"
                  variant="ghost"
                  onClick={() => { setDraftRaw(raw ?? '') }}
                >
                  Revert
                </BigButton>
                <BigButton
                  size="sm"
                  variant="primary"
                  onClick={commitAdvancedDraft}
                >
                  Apply JSON
                </BigButton>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
