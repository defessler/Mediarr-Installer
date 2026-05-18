// AnimatedCheck — SVG checkmark that draws itself in.
//
// Used on the Done screen + after successful API actions. The drawing
// motion (instead of just fading the check in) gives the user a clear
// "yes, this just succeeded" cue that's instantly recognisable and
// feels celebratory without being cartoonish.
//
// Technique: a single SVG path with pathLength=1, dasharray=1 dashoffset=1,
// animated to dashoffset=0. Standard "draw SVG path" trick — no
// additional deps, GPU-cheap.
//
// Sizes are tied to use-case: 48 for inline confirmations, 96 for big
// step-completed moments, 160 for the hero "Done" screen.

import { motion, useReducedMotion } from 'motion/react'

interface AnimatedCheckProps {
  size?: number
  /** Color of the circle + check stroke. Pass a Tailwind text color
   *  class via `className` instead if you want this themed. */
  color?: string
  /** Optional className for sizing/positioning. Overrides `size`. */
  className?: string
}

export function AnimatedCheck({
  size = 96,
  color = 'currentColor',
  className,
}: AnimatedCheckProps) {
  const reduced = useReducedMotion()
  const duration = reduced ? 0 : 0.45

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 52 52"
      width={size}
      height={size}
      className={className}
      style={{ color }}
    >
      {/* Outer circle — draws first */}
      <motion.circle
        cx="26"
        cy="26"
        r="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        initial={reduced ? { pathLength: 1 } : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration, ease: 'easeOut' }}
      />
      {/* Check — starts AFTER circle finishes */}
      <motion.path
        d="M14 27 L23 36 L40 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reduced ? { pathLength: 1 } : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: duration * 0.6, delay: duration, ease: 'easeOut' }}
      />
    </svg>
  )
}
