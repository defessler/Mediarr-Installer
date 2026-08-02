/** Version comparison for the in-app updater.
 *
 *  Lives in shared/ rather than in updater-service.ts because that module
 *  imports electron, which can't be loaded in a plain vitest run — the same
 *  reason update-message.ts sits here. This is the piece worth testing.
 */

/** Semver-ish compare that understands prerelease suffixes.
 *
 *  The original version split on /[.-]/ and took the first three numbers, which
 *  made "0.28.0-beta.1" parse as [0,28,0] — identical to the final "0.28.0".
 *  That is not cosmetic rounding: a user who installed a beta would compare
 *  EQUAL to the release that supersedes it, the updater's `<= 0` guard would
 *  skip it, and they'd be pinned on the prerelease forever while the updater
 *  cheerfully reported "up to date".
 *
 *  Rule, matching semver: a prerelease sorts BEFORE its own release
 *  (0.28.0-beta.1 < 0.28.0), and two prereleases of the same core version fall
 *  back to comparing the suffix so beta.10 beats beta.2.
 *
 *  Returns <0 when a is older, 0 when equal, >0 when a is newer.
 */
export function compareVersions(a: string, b: string): number {
  const split = (s: string): { nums: number[]; pre: string } => {
    const bare = s.replace(/^[a-zA-Z-]*v?/, '')
    const dash = bare.indexOf('-')
    const core = dash === -1 ? bare : bare.slice(0, dash)
    const pre = dash === -1 ? '' : bare.slice(dash + 1)
    return {
      nums: core.split('.').slice(0, 3).map((n) => parseInt(n, 10) || 0),
      pre,
    }
  }
  const A = split(a)
  const B = split(b)
  for (let i = 0; i < 3; i++) {
    const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0)
    if (d !== 0) return d
  }
  // Same numeric core. No suffix outranks any suffix.
  if (!A.pre && !B.pre) return 0
  if (!A.pre) return 1
  if (!B.pre) return -1
  // Both prereleases: numeric-aware so beta.10 > beta.2 rather than "1" < "2".
  return A.pre.localeCompare(B.pre, undefined, { numeric: true })
}

/** Whether a running build is on the prerelease track.
 *
 *  Someone who deliberately installed a beta keeps getting betas. Everyone
 *  else never sees one. Before this existed the updater read `draft` but never
 *  `prerelease`, so a single beta tag would have been offered to every install
 *  as an ordinary update.
 */
export function isPrereleaseVersion(version: string): boolean {
  return version.replace(/^[a-zA-Z-]*v?/, '').includes('-')
}
