import { describe, it, expect } from 'vitest'
import {
  isEnabled,
  isOptInEnabled,
  ENABLE_DISABLED_VALUES,
  ENABLE_OPTIN_VALUES,
} from '../../src/shared/env-render.js'

// These two helpers are the TS half of a four-layer agreement (env-render.ts,
// env-schema.ts, setup.sh is_enabled/is_optin_enabled, setup-arr-config.py).
// If the token sets here drift, the wizard and the NAS scripts disagree about
// whether a service is on — exactly the class of bug these lock down.

describe('isEnabled (default-ON)', () => {
  it('treats missing / empty / whitespace as enabled (pre-selection .env back-compat)', () => {
    expect(isEnabled(undefined)).toBe(true)
    expect(isEnabled('')).toBe(true)
    expect(isEnabled('   ')).toBe(true)
  })

  it('only false / 0 / no / off disable — any case, surrounding whitespace tolerated', () => {
    for (const v of ['false', 'FALSE', 'False', '0', 'no', 'NO', 'off', 'OFF', '  off  ']) {
      expect(isEnabled(v)).toBe(false)
    }
  })

  it('true-ish and arbitrary values count as enabled', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', 'enabled', 'x']) {
      expect(isEnabled(v)).toBe(true)
    }
  })

  it('the disabled set is exactly the four documented tokens', () => {
    expect([...ENABLE_DISABLED_VALUES].sort()).toEqual(['0', 'false', 'no', 'off'])
  })
})

describe('isOptInEnabled (default-OFF)', () => {
  it('treats missing / empty / arbitrary as disabled', () => {
    for (const v of [undefined, '', '  ', 'false', '0', 'no', 'off', 'enabled', 'x']) {
      expect(isOptInEnabled(v)).toBe(false)
    }
  })

  it('only true / 1 / yes / on opt in — any case, surrounding whitespace tolerated', () => {
    for (const v of ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', 'ON', '  on  ']) {
      expect(isOptInEnabled(v)).toBe(true)
    }
  })

  it('the opt-in set is exactly the four documented tokens', () => {
    expect([...ENABLE_OPTIN_VALUES].sort()).toEqual(['1', 'on', 'true', 'yes'])
  })
})

describe('flag-set invariants', () => {
  it('disabled (default-on) and opt-in (default-off) token sets are disjoint', () => {
    for (const v of ENABLE_DISABLED_VALUES) expect(ENABLE_OPTIN_VALUES.has(v)).toBe(false)
    for (const v of ENABLE_OPTIN_VALUES) expect(ENABLE_DISABLED_VALUES.has(v)).toBe(false)
  })
})
