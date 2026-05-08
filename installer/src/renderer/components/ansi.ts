// Tiny ANSI SGR parser. The arr scripts only use a small subset of CSI:
// SGR (m) for color/bold/reset. Other CSI sequences (cursor moves, erase
// line, etc.) are stripped silently — we only render colors.
//
// Returns an array of styled segments suitable for rendering as <span>s.

export interface AnsiSegment {
  text: string
  fg?: AnsiColor
  bold?: boolean
}

export type AnsiColor =
  | 'red' | 'green' | 'yellow' | 'blue'
  | 'magenta' | 'cyan' | 'white' | 'gray'

const SGR_TO_COLOR: Record<number, AnsiColor> = {
  // Standard
  31: 'red', 32: 'green', 33: 'yellow', 34: 'blue',
  35: 'magenta', 36: 'cyan', 37: 'white',
  // Bright (treated identically; we don't track distinct shades)
  90: 'gray',
  91: 'red', 92: 'green', 93: 'yellow', 94: 'blue',
  95: 'magenta', 96: 'cyan', 97: 'white',
}

// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[([0-9;?]*)([a-zA-Z])/g

export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  let cursor = 0
  let cur: { fg?: AnsiColor; bold?: boolean } = {}

  function applySgr(params: string) {
    // Empty params (ESC[m) means reset.
    const codes = params === '' ? [0] : params.split(';').map((p) => Number(p) || 0)
    for (const code of codes) {
      if (code === 0) cur = {}
      else if (code === 1) cur.bold = true
      else if (code === 22) cur.bold = false
      else if (code === 39) cur.fg = undefined
      else if (SGR_TO_COLOR[code]) cur.fg = SGR_TO_COLOR[code]
      // 256-color and truecolor (38;5;n / 38;2;r;g;b) ignored — not used by the scripts.
    }
  }

  function pushText(text: string) {
    if (!text) return
    // Merge into the previous segment if styles match.
    const last = segments[segments.length - 1]
    if (last && last.fg === cur.fg && last.bold === cur.bold) {
      last.text += text
    } else {
      segments.push({ text, fg: cur.fg, bold: cur.bold })
    }
  }

  let m: RegExpExecArray | null
  while ((m = CSI_RE.exec(input)) !== null) {
    if (m.index > cursor) pushText(input.slice(cursor, m.index))
    if (m[2] === 'm') applySgr(m[1])
    // Non-SGR CSI is silently dropped.
    cursor = CSI_RE.lastIndex
  }
  if (cursor < input.length) pushText(input.slice(cursor))

  return segments
}

export const COLOR_CLASS: Record<AnsiColor, string> = {
  red:     'text-rose-400',
  green:   'text-emerald-400',
  yellow:  'text-amber-300',
  blue:    'text-sky-400',
  magenta: 'text-fuchsia-400',
  cyan:    'text-cyan-400',
  white:   'text-slate-100',
  gray:    'text-slate-500',
}
