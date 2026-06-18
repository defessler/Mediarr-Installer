import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

interface FocusTrapOptions {
  /** When false, the trap is inert — no focus capture, no Tab cycling,
   *  no Escape handling, no focus restore. Lets a caller relax the trap
   *  mid-flight (e.g. while an export is busy) without unmounting. */
  active: boolean
  /** Escape handler. When provided, Escape (while active) calls it —
   *  this folds the per-dialog Escape listeners into one place. Omit it
   *  for overlays that intentionally trap focus but can't be dismissed
   *  with Escape (e.g. the non-interruptible update phases). */
  onClose?: () => void
}

// Tabbable-element selector — the usual interactive set, minus anything
// explicitly removed from the tab order (tabindex="-1") or disabled.
// `details > summary` and contenteditable are omitted intentionally:
// none of the dialogs this trap serves use them as focus targets.
const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function tabbables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    // offsetParent is null for display:none elements — skip those so we
    // never try to focus something the user can't see.
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

/** Focus-trap for aria-modal overlays. Attach the returned-nothing hook
 *  by passing the overlay's container ref:
 *
 *    const ref = useRef<HTMLDivElement>(null)
 *    useFocusTrap(ref, { active: true, onClose })
 *    return <motion.div ref={ref} role="dialog" aria-modal="true" …>
 *
 *  While active it (1) records the previously-focused element and moves
 *  focus to the first tabbable element inside the container, (2) keeps
 *  Tab / Shift-Tab cycling within the container (wrapping at the first /
 *  last element), (3) routes Escape to `onClose` when one is supplied,
 *  and (4) restores focus to the opener on unmount / deactivation. This
 *  keeps the aria-modal contract — keyboard and screen-reader users
 *  can't Tab onto controls behind the overlay. */
export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T | null>,
  { active, onClose }: FocusTrapOptions,
): void {
  // Hold the latest onClose in a ref so the keydown handler always calls
  // the current one WITHOUT making it an effect dependency. Callers pass
  // a fresh inline arrow each render; keeping it out of the dep array
  // means the focus-into / focus-restore side effects fire only when
  // `active` actually flips (mount/unmount, or the busy gate) — never on
  // an unrelated parent re-render, which would otherwise steal focus.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    // Remember who had focus so we can hand it back on close. Capture
    // before we move focus into the dialog.
    const opener = document.activeElement as HTMLElement | null

    // Move focus inside. Prefer an element the markup already opted into
    // (autoFocus sets document.activeElement synchronously on mount, so
    // if it's already inside the container we leave it alone), else the
    // first tabbable, else the container itself (a no-op on a plain div
    // without tabindex, which is fine as a last resort).
    const focusables = tabbables(container)
    if (!container.contains(document.activeElement)) {
      if (focusables.length > 0) {
        focusables[0].focus()
      } else {
        container.focus?.()
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const close = onCloseRef.current
        if (close) {
          e.preventDefault()
          close()
        }
        return
      }
      if (e.key !== 'Tab') return
      // Re-query on each Tab — the dialog's tabbable set can change
      // (a button enables, an error field appears) between keystrokes.
      const list = tabbables(container)
      if (list.length === 0) {
        // Nothing to focus inside — keep focus pinned to the container
        // rather than letting Tab escape the overlay.
        e.preventDefault()
        container.focus?.()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const activeEl = document.activeElement
      // If focus has somehow drifted outside the container, pull it back
      // to the appropriate edge.
      if (!container.contains(activeEl)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (e.shiftKey && activeEl === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault()
        first.focus()
      }
    }

    // Capture phase so we see Tab before any inner handler can swallow it.
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      // Restore focus to the opener if it's still in the document and
      // focusable. Guard against the opener having been removed (e.g. a
      // profile row deleted while the dialog was open).
      if (opener && document.contains(opener)) {
        opener.focus?.()
      }
    }
    // onClose intentionally omitted — read live via onCloseRef so a new
    // inline arrow from the parent doesn't re-run the focus side effects.
  }, [active, ref])
}
