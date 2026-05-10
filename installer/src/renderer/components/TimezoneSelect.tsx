import { useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (tz: string) => void
  /** Optional zone the env-detect picked up — surfaced as a quick-set hint. */
  detectedTz?: string | null
}

// All ~600 IANA Area/City zones the runtime knows about, alphabetized.
function loadZones(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const I = Intl as any
  if (typeof I?.supportedValuesOf === 'function') {
    try {
      return (I.supportedValuesOf('timeZone') as string[]).sort()
    } catch {
      /* fall through */
    }
  }
  return [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Toronto', 'America/Vancouver', 'America/Mexico_City',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Amsterdam',
    'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Moscow',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Hong_Kong',
    'Asia/Kolkata', 'Asia/Dubai',
    'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland', 'UTC',
  ]
}

interface ZoneInfo {
  zone: string             // e.g. "America/New_York"
  region: string           // "America"
  city: string             // "New York"
  longName: string         // "Eastern Standard Time" / "Pacific Daylight Time"
  offset: string           // "GMT-5" / "GMT+09:00" — current
  offsetMinutes: number    // -300 / 540 — for sorting
  /** Lowercased haystack for the fuzzy-ish search. */
  haystack: string
}

function buildZoneInfo(zone: string, now: Date): ZoneInfo {
  const slash = zone.indexOf('/')
  const region = slash === -1 ? '' : zone.slice(0, slash)
  const city = (slash === -1 ? zone : zone.slice(slash + 1)).replace(/_/g, ' ')

  let longName = ''
  let offset = ''
  let offsetMinutes = 0
  try {
    const long = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value
    if (long) longName = long
    const off = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value
    if (off) offset = off
    // Parse "GMT+5", "GMT-04:30", "GMT" → minutes east of UTC.
    const m = (off || '').match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/)
    if (m) {
      const sign = m[1] === '-' ? -1 : 1
      offsetMinutes = sign * (Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0))
    } else if ((off || '').toUpperCase() === 'GMT') {
      offsetMinutes = 0
    }
  } catch {
    /* zone is in supportedValuesOf but DateTimeFormat doesn't accept it — rare */
  }

  const haystack = [zone, region, city, longName, offset]
    .join(' ')
    .toLowerCase()
    .replace(/_/g, ' ')

  return { zone, region, city, longName, offset, offsetMinutes, haystack }
}

function formatTimeIn(zone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone, hour: 'numeric', minute: '2-digit', weekday: 'short',
    }).format(now)
  } catch {
    return ''
  }
}

export function TimezoneSelect({ value, onChange, detectedTz }: Props) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Build enriched zone info once. Tick the underlying "now" every minute
  // so the displayed offsets/times stay accurate without a per-render
  // re-build (the offset can change at DST crossings).
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(i)
  }, [])
  const zones = useMemo(loadZones, [])
  const allInfo = useMemo(() => zones.map((z) => buildZoneInfo(z, now)),
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
    [zones])

  // Filtering — split on whitespace and require every term to match the
  // haystack. So "ny east" matches "America/New_York Eastern Standard Time".
  const filtered = useMemo(() => {
    const terms = filter.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return allInfo
    return allInfo.filter((z) => terms.every((t) => z.haystack.includes(t)))
  }, [allInfo, filter])

  // Reset highlight when filter changes.
  useEffect(() => { setHighlighted(0) }, [filter])

  // Keep the highlighted item scrolled into view.
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${highlighted}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [highlighted, open])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const isKnown = !value || zones.includes(value)
  const selectedInfo = value ? allInfo.find((z) => z.zone === value) : undefined
  const displayLabel = selectedInfo
    ? `${selectedInfo.city}${selectedInfo.region ? ', ' + selectedInfo.region : ''}`
    : ''
  const displayMeta = selectedInfo
    ? `${selectedInfo.offset}${selectedInfo.longName ? ' — ' + selectedInfo.longName : ''} · ${formatTimeIn(selectedInfo.zone, now)}`
    : ''

  function pick(zone: string) {
    onChange(zone)
    setOpen(false)
    setFilter('')
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (open && filtered[highlighted]) pick(filtered[highlighted].zone)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="space-y-1.5" ref={containerRef}>
      <label className="block text-sm font-medium">
        Timezone
        <span className="text-slate-500 text-xs ml-2">
          (the NAS&apos;s local time — used by Plex schedules, log timestamps, etc.)
        </span>
      </label>

      {/* Selected-value display + opener. The actual search happens in the
          dropdown to keep the resting state readable. */}
      <button
        type="button"
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0) }}
        className={
          'w-full px-3 py-2 bg-slate-800 border rounded-md text-left flex items-center justify-between gap-3 ' +
          (isKnown ? 'border-slate-700 hover:border-slate-600' : 'border-rose-600')
        }
      >
        {selectedInfo ? (
          <>
            <span>
              <span className="text-slate-100">{displayLabel}</span>
              <span className="text-slate-400 text-xs ml-2">{displayMeta}</span>
            </span>
            <span className="text-slate-500 text-xs">▾</span>
          </>
        ) : value ? (
          <>
            <span className="text-rose-300 font-mono">{value} (unknown zone)</span>
            <span className="text-slate-500 text-xs">▾</span>
          </>
        ) : (
          <>
            <span className="text-slate-500">— Pick a timezone —</span>
            <span className="text-slate-500 text-xs">▾</span>
          </>
        )}
      </button>

      {/* The combobox dropdown — search input + scrollable result list. */}
      {open && (
        <div className="rounded-md border border-slate-700 bg-slate-900 shadow-xl">
          <input
            ref={inputRef}
            type="text"
            placeholder="Search city, region, or zone (e.g. 'eastern', 'tokyo', 'utc-8')"
            className="w-full px-3 py-2 bg-slate-900 border-b border-slate-700 rounded-t-md text-sm focus:outline-none"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <div ref={listRef} className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-sm text-slate-500 italic">
                No timezones match.
              </div>
            ) : (
              filtered.map((z, idx) => (
                <button
                  key={z.zone}
                  type="button"
                  data-idx={idx}
                  onClick={() => pick(z.zone)}
                  onMouseEnter={() => setHighlighted(idx)}
                  className={
                    'w-full text-left px-3 py-1.5 flex items-baseline gap-3 text-sm ' +
                    (z.zone === value
                      ? 'bg-emerald-900/40'
                      : highlighted === idx
                      ? 'bg-slate-800'
                      : 'hover:bg-slate-800')
                  }
                >
                  <span className="text-slate-100 min-w-[10rem] truncate">{z.city}</span>
                  <span className="text-slate-500 text-xs min-w-[5rem]">{z.region}</span>
                  <span className="text-slate-400 text-xs font-mono w-20 shrink-0">{z.offset}</span>
                  <span className="text-slate-500 text-xs flex-1 truncate">{z.longName}</span>
                  <span className="text-slate-400 text-xs ml-auto font-mono">
                    {formatTimeIn(z.zone, now)}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="px-3 py-1.5 border-t border-slate-800 text-[11px] text-slate-500 flex justify-between">
            <span>{filtered.length} of {allInfo.length} zones</span>
            <span>↑/↓ navigate, Enter to pick, Esc to close</span>
          </div>
        </div>
      )}

      {/* Quick-set chips that only appear when relevant */}
      <div className="flex flex-wrap gap-1.5 text-xs">
        {detectedTz && detectedTz !== value && zones.includes(detectedTz) && (
          <button
            type="button"
            onClick={() => onChange(detectedTz)}
            className="px-2 py-0.5 bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-200 rounded font-mono"
          >
            Use NAS&apos;s timezone: {detectedTz}
          </button>
        )}
      </div>
    </div>
  )
}
