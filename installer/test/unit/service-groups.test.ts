import { describe, it, expect } from 'vitest'
import {
  SERVICE_TOGGLES,
  SERVICE_GROUPS,
  OPT_IN_SERVICES,
} from '../../src/renderer/screens/ConfigureScreen.js'
import { envObject } from '../../src/shared/env-schema.js'

// The Configure screen renders its service list by GROUP: for each entry in
// SERVICE_GROUPS it filters SERVICE_TOGGLES down to that group and draws the
// matches. That is a nice way to read twenty services, and it has one sharp
// edge — a toggle whose `group` doesn't match any group id is filtered out of
// every bucket and simply never renders. TypeScript can't catch it, because the
// value is a valid ServiceGroup either way; it just isn't one that's rendered.
//
// The consequence is bad and quiet: the service disappears from the wizard, so
// nobody can turn it on, and the only symptom is an absence. Hence this file.

describe('service groups', () => {
  it('every toggle lands in a group that is actually rendered', () => {
    const rendered = new Set(SERVICE_GROUPS.map((g) => g.id))
    for (const t of SERVICE_TOGGLES) {
      expect(
        rendered.has(t.group),
        `${t.label} has group "${t.group}", which is not in SERVICE_GROUPS — it would never render`,
      ).toBe(true)
    }
  })

  it('grouping loses nothing — every toggle renders exactly once', () => {
    // Mirrors the render: concat each group's filtered rows and compare to the
    // flat list. Catches both a dropped service and a duplicated one.
    const drawn = SERVICE_GROUPS.flatMap((g) =>
      SERVICE_TOGGLES.filter((t) => t.group === g.id),
    )
    expect(drawn).toHaveLength(SERVICE_TOGGLES.length)
    expect(new Set(drawn.map((t) => t.key)).size).toBe(SERVICE_TOGGLES.length)
  })

  it('no group heading is left empty', () => {
    // An empty group would draw a heading with nothing under it. The render
    // guards with `if (!rows.length) return null`, so this is about keeping the
    // data honest rather than preventing a crash.
    for (const g of SERVICE_GROUPS) {
      expect(
        SERVICE_TOGGLES.some((t) => t.group === g.id),
        `group "${g.label}" has no services`,
      ).toBe(true)
    }
  })

  it('every toggle key is a real env key', () => {
    const schemaKeys = new Set(Object.keys(envObject.shape))
    for (const t of SERVICE_TOGGLES) {
      expect(schemaKeys.has(t.key as string), `${t.label}: ${t.key} missing from envObject`).toBe(true)
    }
  })

  it('every opt-in service is a toggle that exists', () => {
    // OPT_IN_SERVICES drives the default-off semantics. A key in that set with
    // no matching toggle is dead weight; a toggle missing from it would default
    // ON for everyone, which for a brand-new service is the wrong direction.
    const keys = new Set(SERVICE_TOGGLES.map((t) => t.key))
    for (const k of OPT_IN_SERVICES) {
      expect(keys.has(k), `OPT_IN_SERVICES has ${String(k)} but no toggle renders it`).toBe(true)
    }
  })
})
