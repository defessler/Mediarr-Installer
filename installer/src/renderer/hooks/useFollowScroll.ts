import { useEffect, useRef, useState } from 'react'

/** Auto-scroll-to-bottom behavior with user-intent detection, lifted
 *  from LogPanel so both the install log AND the migration results
 *  panel get the same follow-and-yield-on-wheel feel.
 *
 *  Returns a ref to attach to the scrollable element, a `stuck` flag
 *  for showing a "Jump to bottom" affordance, and the action to do so.
 *  Pass any value (typically the data array length) as `tick` — every
 *  change scrolls to bottom unless the user has manually scrolled up.
 *
 *  Mirrors LogPanel's heuristics exactly:
 *    - Direct `scrollTop = scrollHeight` (no smooth scroll — lags
 *      behind during high-frequency appends).
 *    - "Stuck" only triggers from wheel/touch/keyboard, not from
 *      programmatic scrolls; otherwise our own scrollTop write fires
 *      a 'scroll' event that race-conditions us into stuck mode.
 *    - Unstuck the moment the user scrolls back to the bottom edge.
 *    - 250ms poll mirrors stuckRef → state so the button doesn't
 *      flicker on every append. */
export function useFollowScroll<T extends HTMLElement>(tick: unknown) {
  const ref = useRef<T>(null)
  const stuckRef = useRef(false)
  const [stuck, setStuck] = useState(false)

  // Scroll to bottom on every dep change (typically items.length). The
  // dep is intentionally permissive — we run on every render the
  // caller asks for and let stuckRef short-circuit when the user
  // wants to read history.
  useEffect(() => {
    if (!ref.current || stuckRef.current) return
    ref.current.scrollTop = ref.current.scrollHeight
  }, [tick])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const markStuck = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      stuckRef.current = !atBottom
    }
    const checkUnstuck = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      if (atBottom) stuckRef.current = false
    }
    el.addEventListener('wheel', markStuck, { passive: true })
    el.addEventListener('touchmove', markStuck, { passive: true })
    el.addEventListener('keydown', markStuck)
    el.addEventListener('scroll', checkUnstuck, { passive: true })
    return () => {
      el.removeEventListener('wheel', markStuck)
      el.removeEventListener('touchmove', markStuck)
      el.removeEventListener('keydown', markStuck)
      el.removeEventListener('scroll', checkUnstuck)
    }
  }, [])

  useEffect(() => {
    const i = setInterval(() => {
      if (stuckRef.current !== stuck) setStuck(stuckRef.current)
    }, 250)
    return () => clearInterval(i)
  }, [stuck])

  function jumpToBottom() {
    const el = ref.current
    if (!el) return
    stuckRef.current = false
    el.scrollTop = el.scrollHeight
    setStuck(false)
  }

  return { ref, stuck, jumpToBottom }
}
