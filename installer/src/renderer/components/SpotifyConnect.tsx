import { useMemo, useState } from 'react'
import { Search, CheckCircle2, Lock, Music2 } from 'lucide-react'
import type { SpotifyPlaylist } from '../../shared/ipc.js'

interface Props {
  clientId: string
  clientSecret: string
  /** SPOTIFY_PLAYLISTS value — a comma list of "Label|URL" or bare "URL". */
  value: string
  onChange: (csv: string) => void
  /** Stores the OAuth refresh token (→ SPOTIFY_REFRESH_TOKEN) after a connect. */
  onConnected: (refreshToken: string) => void
  /** Whether a refresh token is already saved (a prior connect). */
  connected: boolean
}

interface Entry {
  label: string | null
  url: string
}

function parseEntries(v: string): Entry[] {
  const out: Entry[] = []
  for (const raw of (v || '').split(',')) {
    const s = raw.trim()
    if (!s) continue
    const bar = s.indexOf('|')
    if (bar >= 0) out.push({ label: s.slice(0, bar).trim() || null, url: s.slice(bar + 1).trim() })
    else out.push({ label: null, url: s })
  }
  return out
}

function serialize(entries: Entry[]): string {
  return entries
    .map((e) => {
      if (!e.label) return e.url
      // The label is only a cosmetic Plex title, taken verbatim from the Spotify
      // playlist name. Strip the wire separators — ',' (record) and '|' (field) —
      // and collapse whitespace so a name like "Chill, Vibes" can never corrupt
      // parseEntries() here or the comma/pipe split in the container's sync.sh.
      const safe = e.label.replace(/[,|]/g, ' ').replace(/\s+/g, ' ').trim()
      return safe ? `${safe}|${e.url}` : e.url
    })
    .join(', ')
}

// Match playlists by their Spotify id so a ?si=… query or open.spotify vs
// spotify: form doesn't create duplicates.
function playlistId(url: string): string {
  const m = url.match(/playlist[/:]([A-Za-z0-9]+)/)
  return m ? m[1] : url.trim()
}

/** "Connect Spotify" picker: runs the main-process OAuth flow to list the
 *  user's playlists (checkbox multi-select, private ones included), with a
 *  paste-a-URL fallback. Selected playlists are written into SPOTIFY_PLAYLISTS
 *  as "Name|URL"; the refresh token is stored so the downloader can read
 *  private playlists at sync time. */
export function SpotifyConnect({ clientId, clientSecret, value, onChange, onConnected, connected }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[] | null>(null)
  const [filter, setFilter] = useState('')
  const [manual, setManual] = useState('')

  const entries = useMemo(() => parseEntries(value), [value])
  const selectedIds = useMemo(() => new Set(entries.map((e) => playlistId(e.url))), [entries])

  const credsReady = !!clientId.trim() && !!clientSecret.trim()

  const connect = async () => {
    setError(null)
    setBusy(true)
    try {
      const res = await window.installer.spotify.connect({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      })
      onConnected(res.refreshToken)
      setPlaylists(res.playlists)
      if (res.playlists.length === 0) {
        setError('Connected, but no playlists were found on your account.')
      }
    } catch (e) {
      setError((e as Error)?.message || 'Spotify connect failed.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (p: SpotifyPlaylist) => {
    const id = playlistId(p.url)
    if (selectedIds.has(id)) onChange(serialize(entries.filter((e) => playlistId(e.url) !== id)))
    else onChange(serialize([...entries, { label: p.name, url: p.url }]))
  }
  const removeEntry = (url: string) => {
    const id = playlistId(url)
    onChange(serialize(entries.filter((e) => playlistId(e.url) !== id)))
  }
  const addManual = () => {
    const s = manual.trim()
    if (!s) return
    const bar = s.indexOf('|')
    const entry: Entry = bar >= 0
      ? { label: s.slice(0, bar).trim() || null, url: s.slice(bar + 1).trim() }
      : { label: null, url: s }
    if (entry.url && !selectedIds.has(playlistId(entry.url))) {
      onChange(serialize([...entries, entry]))
    }
    setManual('')
  }

  const filtered = useMemo(() => {
    if (!playlists) return []
    const t = filter.toLowerCase().trim()
    if (!t) return playlists
    return playlists.filter((p) => (p.name + ' ' + p.owner).toLowerCase().includes(t))
  }, [playlists, filter])

  return (
    <div className="space-y-3">
      {/* Selected playlists */}
      {entries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((e) => (
            <span
              key={e.url}
              className="inline-flex items-center gap-1.5 rounded bg-green-900/40 border border-green-700/40 px-2 py-0.5 text-xs text-green-100"
            >
              <span className="truncate max-w-[14rem]">{e.label || e.url}</span>
              <button
                type="button"
                onClick={() => removeEntry(e.url)}
                aria-label="Remove playlist"
                className="text-green-300/70 hover:text-green-100 leading-none"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Connect button */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={connect}
          disabled={!credsReady || busy}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
        >
          {busy ? (
            <>
              <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              Waiting for Spotify…
            </>
          ) : (
            <>
              <Music2 size={15} aria-hidden="true" />
              {connected || playlists ? 'Reconnect Spotify' : 'Connect Spotify'}
            </>
          )}
        </button>
        {!credsReady ? (
          <span className="text-xs text-slate-500">Enter your Spotify Client ID + Secret above first.</span>
        ) : connected && !playlists ? (
          <span className="text-xs text-emerald-400/80 inline-flex items-center gap-1">
            <CheckCircle2 size={13} aria-hidden="true" /> Connected — reconnect to re-list your playlists.
          </span>
        ) : busy ? (
          <span className="text-xs text-slate-500">A browser tab opened — sign in and approve, then come back.</span>
        ) : null}
      </div>

      {error && (
        <p className="text-xs text-rose-300 bg-rose-900/20 border border-rose-700/40 rounded px-2.5 py-1.5">
          {error}
        </p>
      )}

      {/* Playlist checklist (after a successful connect) */}
      {playlists && playlists.length > 0 && (
        <div className="space-y-2">
          <div className="relative">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              placeholder="Filter your playlists"
              aria-label="Filter your Spotify playlists"
              className="w-full pl-9 pr-3 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-sm focus:border-emerald-500 focus:outline-none"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div
            role="listbox"
            aria-multiselectable="true"
            aria-label="Your Spotify playlists"
            className="max-h-56 overflow-y-auto rounded-md border border-slate-700 bg-slate-900/40"
          >
            {filtered.map((p) => {
              const on = selectedIds.has(playlistId(p.url))
              return (
                <button
                  key={p.url}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(p)}
                  className={
                    'w-full text-left px-3 py-1.5 flex items-center gap-2.5 text-sm border-b border-slate-800 last:border-b-0 ' +
                    (on ? 'bg-green-900/30 text-green-100' : 'hover:bg-slate-800 text-slate-200')
                  }
                >
                  {on ? (
                    <CheckCircle2 size={14} className="text-green-400 shrink-0" aria-hidden="true" />
                  ) : (
                    <span className="inline-block w-3.5 h-3.5 rounded-full border border-slate-600 shrink-0" />
                  )}
                  <span className="flex-1 truncate">{p.name}</span>
                  {!p.isPublic && (
                    <span className="text-amber-300/70 text-[11px] inline-flex items-center gap-0.5 shrink-0">
                      <Lock size={11} aria-hidden="true" />
                      private
                    </span>
                  )}
                  <span className="text-slate-500 text-xs shrink-0">{p.trackCount} tracks</span>
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-slate-500">
            Private playlists work too — the installer saved a refresh token so the downloader can read them.
          </p>
        </div>
      )}

      {/* Manual URL fallback */}
      <details className="text-sm group">
        <summary className="cursor-pointer text-slate-400 hover:text-slate-200 select-none text-xs">
          Or paste a playlist URL manually
        </summary>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            placeholder="https://open.spotify.com/playlist/…  (or Label|URL)"
            aria-label="Paste a Spotify playlist URL"
            className="flex-1 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs focus:border-emerald-500 focus:outline-none"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addManual()
              }
            }}
          />
          <button
            type="button"
            onClick={addManual}
            disabled={!manual.trim()}
            className="px-3 py-1.5 text-xs rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200"
          >
            Add
          </button>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          A playlist added by URL must be public unless you've connected your account above.
        </p>
      </details>
    </div>
  )
}
