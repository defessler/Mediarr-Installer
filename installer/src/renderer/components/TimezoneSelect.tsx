import { useMemo } from 'react'

interface Props {
  value: string
  onChange: (tz: string) => void
  /** Optional zone the env-detect picked up — surfaced as a quick-set hint. */
  detectedTz?: string | null
}

// All ~600 IANA Area/City zones the runtime knows about, alphabetized.
function loadZones(): string[] {
  // Intl.supportedValuesOf is in Chromium 99+ which Electron has shipped
  // with for a while; fall back to a small hand list if it's missing.
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

interface ZoneGroup {
  region: string
  zones: { value: string; label: string }[]
}

function groupZones(zones: string[]): ZoneGroup[] {
  const map = new Map<string, ZoneGroup>()
  for (const z of zones) {
    const slash = z.indexOf('/')
    const region = slash === -1 ? 'Other' : z.slice(0, slash)
    const label = slash === -1 ? z : z.slice(slash + 1).replace(/_/g, ' ')
    if (!map.has(region)) map.set(region, { region, zones: [] })
    map.get(region)!.zones.push({ value: z, label })
  }
  return [...map.values()].sort((a, b) => a.region.localeCompare(b.region))
}

export function TimezoneSelect({ value, onChange, detectedTz }: Props) {
  const zones = useMemo(loadZones, [])
  const groups = useMemo(() => groupZones(zones), [zones])
  const isKnown = !value || zones.includes(value)

  // Current local timezone from the browser/OS — handy as a "use my PC's tz" hint.
  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return null }
  }, [])

  // Pretty preview of "what time is it in this zone right now"
  const preview = useMemo(() => {
    if (!value || !isKnown) return null
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: value, hour: 'numeric', minute: '2-digit', weekday: 'short',
      }).format(new Date())
    } catch { return null }
  }, [value, isKnown])

  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium">
        Timezone
        <span className="text-slate-500 text-xs ml-2">
          (the NAS&apos;s local time — used by Plex schedules, log timestamps, etc.)
        </span>
      </label>

      <select
        className={
          'w-full px-3 py-2 bg-slate-800 border rounded-md ' +
          (isKnown ? 'border-slate-700' : 'border-rose-600')
        }
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">— Pick a timezone —</option>
        {groups.map((g) => (
          <optgroup key={g.region} label={g.region}>
            {g.zones.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {/* Quick-set chips for the most likely values */}
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

      {/* Live preview so the user can sanity-check */}
      {preview && (
        <div className="text-xs text-slate-400">
          Right now in <span className="font-mono text-slate-300">{value}</span>: {preview}
        </div>
      )}
      {!isKnown && (
        <div className="text-xs text-rose-300">
          &quot;{value}&quot; isn&apos;t a recognised IANA timezone.
        </div>
      )}
    </div>
  )
}
