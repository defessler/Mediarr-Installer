// Services that do the same job, where one is the recommended pick.
//
// The Configure screen pops a modal the moment a toggle turns a pair ON
// together, so nobody ends up with two book downloaders writing into the same
// folder without being told what each one is for. Running both is allowed. The
// modal explains the trade-off and lets the user keep both, or drop either.
//
// Kept apart from ConfigureScreen.tsx so the trigger rule is a pure function a
// unit test can pin without rendering anything.

import { type EnvFormValues, isOptInEnabled } from '../shared/env-render.js'

export interface ServiceOverlap {
  /** The service the stack recommends. */
  recommended: keyof EnvFormValues
  recommendedLabel: string
  /** The older or narrower service it overlaps with. */
  other: keyof EnvFormValues
  otherLabel: string
  title: string
  /** One short paragraph on why the recommended pick is the recommended one. */
  summary: string
  /** Where the recommended service comes out ahead. */
  recommendedPros: string[]
  /** What the other service still does better. The reason it's offered at all. */
  otherPros: string[]
  /** What happens if both stay on. */
  bothNote: string
}

export const SERVICE_OVERLAPS: ServiceOverlap[] = [
  {
    recommended: 'ENABLE_SHELFMARK',
    recommendedLabel: 'Shelfmark',
    other: 'ENABLE_LAZYLIBRARIAN',
    otherLabel: 'LazyLibrarian',
    title: 'Shelfmark and LazyLibrarian both download books',
    summary:
      'Shelfmark is the recommended book service. The installer sets it up all the ' +
      'way, and it handles audiobooks too. LazyLibrarian is still offered for the ' +
      'one thing Shelfmark doesn\'t do, which is following authors.',
    recommendedPros: [
      'Fully set up for you: Prowlarr, qBittorrent, SABnzbd and the library folders are written during install.',
      'Ebooks and audiobooks from one search page.',
      'Simple to use. Look a book up, pick a release, done.',
      'Actively developed, with a modern interface.',
    ],
    otherPros: [
      'Follows authors and grabs their new books as they come out. Shelfmark only fetches what you ask for.',
      'Tracks a wanted list and keeps searching for books it hasn\'t found yet.',
    ],
    bothNote:
      'Running both works. They share the "books" download category and both write into ' +
      'Media/Books, so the same book can land twice if you ask both for it. LazyLibrarian ' +
      'also needs its download client and library folder set by hand in its own settings.',
  },
]

/** The overlap a toggle change just completed, if any. Fires only when
 *  `changed` is being switched ON and its partner is already ON, so loading a
 *  profile that has both doesn't pop anything, and switching one off never does. */
export function overlapTriggeredBy(
  changed: keyof EnvFormValues,
  nextValue: string | undefined,
  config: Partial<EnvFormValues>,
): ServiceOverlap | undefined {
  if (!isOptInEnabled(nextValue)) return undefined
  return SERVICE_OVERLAPS.find((o) => {
    if (o.recommended === changed) return isOptInEnabled(config[o.other] as string | undefined)
    if (o.other === changed) return isOptInEnabled(config[o.recommended] as string | undefined)
    return false
  })
}
