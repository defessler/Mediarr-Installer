import { describe, it, expect } from 'vitest'
import { SERVICE_OVERLAPS, overlapTriggeredBy } from '../../src/renderer/service-overlaps.js'
import { SERVICE_TOGGLES, OPT_IN_SERVICES } from '../../src/renderer/screens/ConfigureScreen.js'

// The Configure screen pops a modal when a click turns on two services that
// do the same job. These pin when it fires, and that the "Not recommended"
// chip and the modal can't drift apart.

const [books] = SERVICE_OVERLAPS

describe('service overlap modal trigger', () => {
  it('fires when LazyLibrarian is ticked with Shelfmark already on', () => {
    expect(overlapTriggeredBy('ENABLE_LAZYLIBRARIAN', 'true', { ENABLE_SHELFMARK: 'true' })).toBe(books)
  })

  it('fires the other way round too', () => {
    expect(overlapTriggeredBy('ENABLE_SHELFMARK', 'true', { ENABLE_LAZYLIBRARIAN: 'true' })).toBe(books)
  })

  it('stays quiet when the partner is off or missing', () => {
    expect(overlapTriggeredBy('ENABLE_LAZYLIBRARIAN', 'true', { ENABLE_SHELFMARK: 'false' })).toBeUndefined()
    expect(overlapTriggeredBy('ENABLE_LAZYLIBRARIAN', 'true', {})).toBeUndefined()
  })

  it('never fires on switching something off', () => {
    expect(overlapTriggeredBy('ENABLE_LAZYLIBRARIAN', 'false', { ENABLE_SHELFMARK: 'true' })).toBeUndefined()
  })

  it('ignores unrelated toggles even when both books services are on', () => {
    expect(overlapTriggeredBy('ENABLE_MYLAR', 'true', {
      ENABLE_SHELFMARK: 'true', ENABLE_LAZYLIBRARIAN: 'true',
    })).toBeUndefined()
  })
})

describe('overlap pairs match the toggle grid', () => {
  it('every not-recommended toggle is the "other" half of a pair', () => {
    for (const t of SERVICE_TOGGLES.filter((x) => x.notRecommended)) {
      expect(SERVICE_OVERLAPS.some((o) => o.other === t.key), `${t.label} is marked not recommended with no overlap pair`).toBe(true)
    }
  })

  it('both halves of every pair are real opt-in toggles', () => {
    for (const o of SERVICE_OVERLAPS) {
      for (const k of [o.recommended, o.other]) {
        expect(SERVICE_TOGGLES.some((t) => t.key === k), `${k} has no toggle`).toBe(true)
        expect(OPT_IN_SERVICES.has(k), `${k} is not opt-in, so a missing key would read as on`).toBe(true)
      }
      expect(SERVICE_TOGGLES.find((t) => t.key === o.other)?.notRecommended).toBeTruthy()
    }
  })
})
