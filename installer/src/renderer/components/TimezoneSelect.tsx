import { useMemo, useState } from 'react'

interface Props {
  value: string
  onChange: (tz: string) => void
  /** Optional zone the env-detect picked up — surfaced as a "use detected" hint. */
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

export function TimezoneSelect({ value, onChange, detectedTz }: Props) {
  const zones = useMemo(loadZones, [])
  const [filter, setFilter] = useState('')

  // Pre-filter by area when there are 600 entries — the typeahead drives a
  // datalist for keyboard users. We render the matching subset as <option>s.
  const matching = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return zones
    return zones.filter((z) => z.toLowerCase().includes(f))
  }, [zones, filter])

  const isValid = !value || zones.includes(value)
  const detectedDifferent = detectedTz && detectedTz !== value && zones.includes(detectedTz)

  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        Timezone (Area/City)
        {!isValid && (
          <span className="ml-2 text-xs text-rose-300">unknown zone</span>
        )}
      </label>
      <input
        list="tz-zones"
        type="text"
        placeholder="America/New_York"
        className={
          'w-full px-3 py-2 bg-slate-800 border rounded-md ' +
          (isValid ? 'border-slate-700' : 'border-rose-600')
        }
        value={value ?? ''}
        onChange={(e) => {
          setFilter(e.target.value)
          onChange(e.target.value)
        }}
        autoComplete="off"
      />
      <datalist id="tz-zones">
        {matching.slice(0, 250).map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      {detectedDifferent && (
        <button
          type="button"
          onClick={() => onChange(detectedTz!)}
          className="mt-1 text-xs text-emerald-400 hover:underline"
        >
          Use detected: {detectedTz}
        </button>
      )}
    </div>
  )
}
