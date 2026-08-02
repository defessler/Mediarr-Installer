import { describe, it, expect } from 'vitest'
import { compareVersions, isPrereleaseVersion } from '../../src/shared/version-compare.js'

// These two functions decide whether an existing install is offered a given
// GitHub release. Both had a real defect before this test existed:
//
//   1. compareVersions truncated the prerelease suffix, so "0.28.0-beta.1"
//      compared EQUAL to "0.28.0". The updater skips anything that isn't
//      strictly newer, so a beta user would never be offered the real release
//      that supersedes their build — permanently stuck, reported as up-to-date.
//   2. The release loop read `draft` but never `prerelease`, so publishing one
//      beta tag would push it to every install as an ordinary update.
//
// Both are silent in production: nothing errors, the user just gets the wrong
// answer. Hence the oracle.

describe('compareVersions', () => {
  const older = (a: string, b: string) => expect(compareVersions(a, b)).toBeLessThan(0)
  const newer = (a: string, b: string) => expect(compareVersions(a, b)).toBeGreaterThan(0)

  it('orders ordinary releases by each numeric part', () => {
    older('0.26.1', '0.27.0')
    older('0.27.0', '1.0.0')
    older('0.27.1', '0.27.10')
    newer('0.28.0', '0.27.9')
    expect(compareVersions('0.27.0', '0.27.0')).toBe(0)
  })

  it('strips a tag prefix so installer-v0.27.0 equals 0.27.0', () => {
    expect(compareVersions('installer-v0.27.0', '0.27.0')).toBe(0)
    older('installer-v0.26.1', 'installer-v0.27.0')
  })

  it('sorts a prerelease BEFORE its own release', () => {
    // The regression that would strand beta users on the beta forever.
    older('0.28.0-beta.1', '0.28.0')
    newer('0.28.0', '0.28.0-beta.1')
    expect(compareVersions('0.28.0-beta.1', '0.28.0')).not.toBe(0)
  })

  it('sorts a prerelease AFTER the previous release', () => {
    older('0.27.0', '0.28.0-beta.1')
  })

  it('orders prereleases of the same version numerically, not lexically', () => {
    older('0.28.0-beta.2', '0.28.0-beta.10')
    older('0.28.0-alpha.1', '0.28.0-beta.1')
    expect(compareVersions('0.28.0-beta.1', '0.28.0-beta.1')).toBe(0)
  })

  it('treats a missing part as zero rather than NaN', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0)
    older('1.0', '1.0.1')
  })
})

describe('isPrereleaseVersion', () => {
  it('is true only for versions carrying a suffix', () => {
    expect(isPrereleaseVersion('0.28.0-beta.1')).toBe(true)
    expect(isPrereleaseVersion('0.28.0-rc.1')).toBe(true)
    expect(isPrereleaseVersion('0.28.0')).toBe(false)
    expect(isPrereleaseVersion('0.26.1')).toBe(false)
  })

  it('is not fooled by the installer- tag prefix, which also contains a dash', () => {
    // The naive /-/.test() on a raw tag name would call every tagged release a
    // prerelease, which would flip the gate open for everyone — the exact bug
    // the gate exists to prevent.
    expect(isPrereleaseVersion('installer-v0.28.0')).toBe(false)
    expect(isPrereleaseVersion('installer-v0.28.0-beta.1')).toBe(true)
  })
})
