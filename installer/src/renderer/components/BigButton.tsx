// BigButton — the primary CTA component for child-friendly screens.
//
// Why a dedicated component:
//   - Consistent press feel (scale-down on active, micro hover lift) so
//     every step's "next action" feels the same. Children rely on visual
//     hierarchy way more than adults; making the primary action LOOK
//     primary across screens is one of the highest-impact UX wins.
//   - Built-in icon slot — Lucide icons paired with text reduces reading
//     load and gives a visual anchor that's faster to recognise.
//   - Loading state baked in — clicking a CTA that triggers async work
//     should LOOK busy, not just go silent. Built-in spinner avoids
//     each caller bolting one on differently.
//
// Variants:
//   - primary (default): emerald gradient, used for "Install" / "Next"
//   - secondary: slate, used for "Edit" / "Cancel"
//   - danger: rose, used for destructive confirmations
//
// Size:
//   - lg (default): generous padding, ~48px tall, comfortable for touch
//     and approachable on mouse — children + non-touch typists both win
//   - md: 36px tall, for inline / multi-button rows
//   - sm: 28px tall, for trailing icon-only actions (Export, Delete)

import { motion, useReducedMotion } from 'motion/react'
import { Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
type Size = 'sm' | 'md' | 'lg'

interface BigButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode
  variant?: Variant
  size?: Size
  /** Lucide icon component or other SVG/ReactNode rendered before text. */
  icon?: ReactNode
  /** Lucide icon component rendered AFTER text (e.g. arrow on "Next"). */
  trailingIcon?: ReactNode
  /** When true, shows a spinner in place of the leading icon and
   *  disables the button. */
  loading?: boolean
}

const VARIANT_CLASSES: Record<Variant, string> = {
  // Emerald gradient with subtle inner highlight. Gradients read as
  // "tappable" the way flat colors don't — same trick iOS uses on its
  // primary buttons. The shadow tints emerald too, so the button looks
  // like it's casting a light, not just sitting on a card.
  primary:
    'bg-gradient-to-b from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 ' +
    'text-white shadow-lg shadow-emerald-900/40 ' +
    'disabled:from-slate-700 disabled:to-slate-800 disabled:text-slate-500 disabled:shadow-none ' +
    'border border-emerald-400/30',
  secondary:
    'bg-slate-700 hover:bg-slate-600 text-slate-100 ' +
    'disabled:bg-slate-800 disabled:text-slate-500 ' +
    'border border-slate-600/30',
  danger:
    'bg-rose-700/70 hover:bg-rose-600 text-rose-50 ' +
    'disabled:bg-slate-800 disabled:text-slate-500 ' +
    'border border-rose-500/30',
  ghost:
    'bg-transparent hover:bg-slate-800/60 text-slate-300 hover:text-slate-100 ' +
    'disabled:text-slate-600 disabled:hover:bg-transparent',
}

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'h-7 px-2 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3 text-sm gap-2 rounded-md',
  lg: 'h-12 px-6 text-base font-semibold gap-2.5 rounded-lg',
}

export function BigButton({
  children,
  variant = 'primary',
  size = 'lg',
  icon,
  trailingIcon,
  loading = false,
  disabled,
  className = '',
  ...rest
}: BigButtonProps) {
  const reduced = useReducedMotion()
  const isDisabled = disabled || loading

  return (
    <motion.button
      {...(rest as any)}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      // whileHover/whileTap take care of the press feel without per-
      // browser hover CSS — and respect reduced-motion automatically
      // when the user has it on.
      whileHover={!isDisabled && !reduced ? { y: -1 } : {}}
      whileTap={!isDisabled && !reduced ? { scale: 0.97 } : {}}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className={
        `inline-flex items-center justify-center font-medium transition-colors ` +
        `disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 ` +
        `focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ` +
        `${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`
      }
    >
      {loading ? (
        <Loader2
          className="animate-spin"
          size={size === 'lg' ? 20 : size === 'md' ? 16 : 14}
          aria-hidden="true"
        />
      ) : icon ? (
        <span className="inline-flex items-center" aria-hidden="true">{icon}</span>
      ) : null}
      <span>{children}</span>
      {trailingIcon && !loading && (
        <span className="inline-flex items-center" aria-hidden="true">{trailingIcon}</span>
      )}
    </motion.button>
  )
}
