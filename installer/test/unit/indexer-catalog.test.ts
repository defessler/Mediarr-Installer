import { describe, it, expect } from 'vitest'
import {
  USENET_INDEXERS,
  PUBLIC_TRACKERS,
  PRIVATE_TRACKERS,
  BAZARR_PROVIDERS,
  indexerTags,
  type IndexerDef,
} from '../../src/shared/env-render.js'
import { envObject } from '../../src/shared/env-schema.js'

const CATALOGUES: { name: string; defs: IndexerDef[]; categories: string[] }[] = [
  { name: 'USENET_INDEXERS', defs: USENET_INDEXERS, categories: ['usenet-free', 'usenet-paid'] },
  { name: 'PUBLIC_TRACKERS', defs: PUBLIC_TRACKERS, categories: ['tracker-public'] },
  { name: 'PRIVATE_TRACKERS', defs: PRIVATE_TRACKERS, categories: ['tracker-private'] },
  { name: 'BAZARR_PROVIDERS', defs: BAZARR_PROVIDERS, categories: ['subtitles'] },
]
const EVERY_DEF = CATALOGUES.flatMap((c) => c.defs)
const SCHEMA_KEYS = new Set(Object.keys(envObject.shape))

describe('indexer catalogue consistency', () => {
  it('every indexer id is a real env key (present in envObject)', () => {
    for (const d of EVERY_DEF) {
      expect(SCHEMA_KEYS.has(d.id), `${d.name}: id ${d.id} missing from envObject`).toBe(true)
    }
  })

  it('every credential field key is a real env key (present in envObject)', () => {
    for (const d of EVERY_DEF) {
      for (const f of d.fields) {
        expect(SCHEMA_KEYS.has(f.key), `${d.name}: field ${f.key} missing from envObject`).toBe(true)
      }
    }
  })

  it('ids are unique across all catalogues', () => {
    const ids = EVERY_DEF.map((d) => d.id)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(dupes).toEqual([])
  })

  it('each def carries the category its catalogue expects', () => {
    for (const { defs, categories } of CATALOGUES) {
      for (const d of defs) expect(categories).toContain(d.category)
    }
  })
})

describe('indexerTags derivation', () => {
  const def = (over: Partial<IndexerDef> & Pick<IndexerDef, 'id' | 'category'>): IndexerDef =>
    ({ name: 'x', fields: [], ...over })

  it('usenet-free derives usenet + free', () => {
    const t = indexerTags(def({ id: 'ANIMETOSHO_API_KEY', category: 'usenet-free' }))
    expect(t).toEqual(expect.arrayContaining(['usenet', 'free']))
  })

  it('usenet-paid derives usenet + paid (unless explicitly free)', () => {
    const t = indexerTags(def({ id: 'NZBGEEK_API_KEY', category: 'usenet-paid' }))
    expect(t).toEqual(expect.arrayContaining(['usenet', 'paid']))
  })

  it('tracker-public derives torrent + free + no-signup', () => {
    const t = indexerTags(def({ id: 'NYAA_NO_KEY', category: 'tracker-public' }))
    expect(t).toEqual(expect.arrayContaining(['torrent', 'free', 'no-signup']))
  })

  it('tracker-private derives torrent + paid by default', () => {
    const t = indexerTags(def({ id: 'BTN_API_KEY', category: 'tracker-private' }))
    expect(t).toEqual(expect.arrayContaining(['torrent', 'paid']))
  })

  it('an explicit "free" tag suppresses the derived "paid" on a private tracker', () => {
    const t = indexerTags(def({ id: 'RUTRACKER_USER', category: 'tracker-private', tags: ['free'] }))
    expect(t).toContain('free')
    expect(t).not.toContain('paid')
  })

  it('subtitles derive ONLY subtitles + free — never a bogus usenet/torrent pill', () => {
    const t = indexerTags(def({ id: 'OPENSUBTITLES_USER', category: 'subtitles' }))
    expect(t).toContain('subtitles')
    expect(t).toContain('free')
    expect(t).not.toContain('usenet')
    expect(t).not.toContain('torrent')
  })

  it('explicit tags are always preserved', () => {
    const t = indexerTags(def({ id: 'X1337_NO_KEY', category: 'tracker-public', tags: ['general'] }))
    expect(t).toContain('general')
  })
})

// Regression guard for the exact shipped bug: Bazarr subtitle providers used
// to reuse category 'usenet-free', so indexerTags derived a misleading
// 'usenet' pill on a subtitle card. Lock the live catalogue down.
describe('BAZARR_PROVIDERS never look like usenet/torrent indexers', () => {
  it('all live providers are category "subtitles" with no usenet/torrent tag', () => {
    for (const d of BAZARR_PROVIDERS) {
      expect(d.category).toBe('subtitles')
      const t = indexerTags(d)
      expect(t).not.toContain('usenet')
      expect(t).not.toContain('torrent')
    }
  })
})

describe('the live RuTracker def stays classed free (load-bearing tag)', () => {
  it('indexerTags(RuTracker) is free, not paid', () => {
    const ru = PRIVATE_TRACKERS.find((d) => d.id === 'RUTRACKER_USER')
    expect(ru, 'RuTracker def present').toBeTruthy()
    const t = indexerTags(ru!)
    expect(t).toContain('free')
    expect(t).not.toContain('paid')
  })
})
