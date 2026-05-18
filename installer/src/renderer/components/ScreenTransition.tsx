// ScreenTransition — wraps every screen in a consistent fade-up entrance.
//
// Why a single wrapper instead of per-screen <motion.div> blocks:
//   - One place to tune the timing curve for the whole app (so future
//     "make it snappier" / "make it softer" tweaks land in one file)
//   - Reduced-motion users get instant transitions automatically —
//     framer-motion's `useReducedMotion()` hook reads OS prefers-reduced-
//     motion and we adapt without per-screen plumbing
//   - Keeps screens free of layout-animation imports
//
// Easing is `easeOut` (slow → stop) intentionally: a screen change is
// the user moving forward in a flow, and easing OUT feels like landing
// confidently. easeInOut would feel mushy; linear would feel mechanical.

import { motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

interface ScreenTransitionProps {
  children: ReactNode
  /** Unique key per screen so AnimatePresence treats them as distinct.
   *  Pass the wizard step id. */
  screenKey?: string
}

export function ScreenTransition({ children, screenKey }: ScreenTransitionProps) {
  const reduced = useReducedMotion()
  return (
    <motion.div
      key={screenKey}
      // Initial state: 8px below + transparent. Small distance so the
      // motion reads as "settle into place" rather than "swoop in" —
      // research consistently shows 6–10px is the sweet spot for
      // entrance animations in productivity software.
      initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      // Exit just fades — most screens don't have time to slide back
      // before the new one mounts (~180ms total).
      exit={reduced ? { opacity: 1 } : { opacity: 0 }}
      transition={{
        duration: reduced ? 0 : 0.22,
        ease: [0.16, 1, 0.3, 1], // cubic-bezier curve, classic "easeOutQuart"
      }}
      className="h-full"
    >
      {children}
    </motion.div>
  )
}
