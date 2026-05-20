// PasswordInput — drop-in <input type="password"> with a built-in
// eye toggle that flips it to type="text" so the user can confirm
// what they've typed. Especially valuable for kid + cognitive-load
// reasons: typing a password into a black field of dots and having
// it rejected feels punitive in a way that "let me see what I typed"
// fixes immediately.
//
// The icon button is positioned absolutely inside a relative wrapper,
// padded into the input's right margin so it doesn't overlap the
// caret. Focus ring inherits the standard emerald accent.

import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Eye, EyeOff } from 'lucide-react'
import type { InputHTMLAttributes } from 'react'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Show the eye toggle (default true). Set false for password-style
   *  fields where revealing the value isn't appropriate (e.g. when the
   *  field is a confirm-passphrase next to a primary one). */
  toggle?: boolean
}

export function PasswordInput({ toggle = true, className = '', ...rest }: Props) {
  const [shown, setShown] = useState(false)
  const reduced = useReducedMotion()
  // Caller's className gets appended after ours so they can extend
  // (e.g. add `font-mono` for SSH key paths). pr-10 reserves room for
  // the eye button.
  const base =
    'w-full px-3 py-2.5 pr-10 bg-slate-800 border border-slate-700 rounded-md ' +
    'focus:border-emerald-500 focus:outline-none focus:ring-1 ' +
    'focus:ring-emerald-500/40 transition-colors'
  return (
    <div className="relative">
      <input
        {...rest}
        type={shown ? 'text' : 'password'}
        className={`${base} ${className}`}
      />
      {toggle && (
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          title={shown ? 'Hide password' : 'Show password'}
          className={
            'absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center ' +
            'w-7 h-7 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 ' +
            'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400'
          }
          tabIndex={-1}
        >
          {/* Crossfade Eye ↔ EyeOff so the toggle feels physical, not a
              jarring instant swap. Inherits reduced-motion. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={shown ? 'eye-off' : 'eye'}
              initial={reduced ? { opacity: 1 } : { opacity: 0, rotate: -90, scale: 0.7 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, rotate: 90, scale: 0.7 }}
              transition={{ duration: 0.14 }}
              className="inline-flex items-center justify-center"
            >
              {shown ? <EyeOff size={16} /> : <Eye size={16} />}
            </motion.span>
          </AnimatePresence>
        </button>
      )}
    </div>
  )
}
