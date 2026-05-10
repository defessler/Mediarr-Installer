import { useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (tz: string) => void
  /** Optional zone the env-detect picked up — surfaced as a quick-set hint. */
  detectedTz?: string | null
}

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
  zone: string
  region: string
  city: string
  longName: string
  offset: string
  haystack: string
}

function buildZoneInfo(zone: string, now: Date): ZoneInfo {
  const slash = zone.indexOf('/')
  const region = slash === -1 ? '' : zone.slice(0, slash)
  const city = (slash === -1 ? zone : zone.slice(slash + 1)).replace(/_/g, ' ')

  let longName = ''
  let offset = ''
  try {
    const long = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value
    if (long) longName = long
    const off = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value
    if (off) offset = off
  } catch { /* zone doesn't format — rare */ }

  const haystack = [zone, region, city, longName, offset]
    .join(' ').toLowerCase().replace(/_/g, ' ')

  return { zone, region, city, longName, offset, haystack }
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
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Tick "now" every minute so offsets and current-time displays stay
  // accurate around DST boundaries without rebuilding zone data per render.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(i)
  }, [])

  const zones = useMemo(loadZones, [])
  const allInfo = useMemo(
    () => zones.map((z) => buildZoneInfo(z, now)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zones],
  )

  const filtered = useMemo(() => {
    const terms = filter.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return allInfo
    return allInfo.filter((z) => terms.every((t) => z.haystack.includes(t)))
  }, [allInfo, filter])

  // Auto-scroll to the currently-selected option when the list opens or
  // changes, so the user sees their current pick without scrolling.
  useEffect(() => {
    if (!value || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-zone="${CSS.escape(value)}"]`)
    if (el) el.scrollIntoView({ block: 'center' })
  }, [value, filtered])

  const isKnown = !value || zones.includes(value)
  const selectedInfo = value ? allInfo.find((z) => z.zone === value) : undefined

  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return null }
  }, [])

  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium">
        Timezone
        <span className="text-slate-500 text-xs ml-2">
          (the NAS&apos;s local time — used by Plex schedules, log timestamps, etc.)
        </span>
      </label>

      {/* Currently-selected indicator + clear shows what's picked */}
      {selectedInfo ? (
        <div className="rounded-md border border-emerald-700/40 bg-emerald-900/10 px-3 py-2 text-sm flex items-center justify-between gap-3">
          <span className="truncate">
            <span className="text-slate-100">{selectedInfo.city}</span>
            <span className="text-slate-400 text-xs ml-2">
              {selectedInfo.region}{selectedInfo.offset ? ` · ${selectedInfo.offset}` : ''}
              {selectedInfo.longName ? ` · ${selectedInfo.longName}` : ''}
              {' · '}{formatTimeIn(selectedInfo.zone, now)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onChange('')}
            className="text-xs text-slate-400 hover:text-slate-200 shrink-0"
          >
            Clear
          </button>
        </div>
      ) : value ? (
        <div className="rounded-md border border-rose-600 bg-rose-900/20 px-3 py-2 text-sm">
          <span className="font-mono text-rose-300">{value}</span> isn&apos;t a recognised IANA timezone.
        </div>
      ) : (
        <div className="text-xs text-slate-500">
          {isKnown ? 'No timezone selected.' : ''}
        </div>
      )}

      {/* Always-visible search input. No trigger-button-then-input pattern
          because that broke focus on some setups (the input wouldn't
          receive keystrokes even though it was visually focused). */}
      <input
        ref={inputRef}
        type="text"
        placeholder="Search city, region, or zone (e.g. 'eastern', 'tokyo', 'gmt-8')"
        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-sm"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {/* Quick-set chips */}
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
        {browserTz && browserTz !== value && browserTz !== detectedTz && zones.includes(browserTz) && (
          <button
            type="button"
            onClick={() => onChange(browserTz)}
            className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-mono"
          >
            Use this PC&apos;s timezone: {browserTz}
          </button>
        )}
      </div>

      {/* Always-visible scrollable list */}
      <div
        ref={listRef}
        className="max-h-72 overflow-y-auto rounded-md border border-slate-700 bg-slate-900/40"
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-3 text-sm text-slate-500 italic">
            No timezones match.
          </div>
        ) : (
          filtered.map((z) => (
            <button
              key={z.zone}
              type="button"
              data-zone={z.zone}
              onClick={() => onChange(z.zone)}
              className={
                'w-full text-left px-3 py-1.5 flex items-baseline gap-3 text-sm border-b border-slate-800 last:border-b-0 ' +
                (z.zone === value
                  ? 'bg-emerald-900/40 text-emerald-100'
                  : 'hover:bg-slate-800 text-slate-200')
              }
            >
              <span className="min-w-[10rem] truncate">{z.city}</span>
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
      <div className="text-[11px] text-slate-500">
        {filtered.length} of {allInfo.length} zones
      </div>
    </div>
  )
}
