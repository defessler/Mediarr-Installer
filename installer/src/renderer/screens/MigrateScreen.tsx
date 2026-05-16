// MigrateScreen — bring a library across from an EXISTING Sonarr / Radarr
// instance (e.g., the user's previous NAS) into the freshly-installed
// stack. Reads series/movies from the source via API, posts them to the
// local arrs.
//
// Why this is its own screen rather than a step in the install:
//   - Migration is opt-in and the source isn't always available at
//     install time. Some users migrate weeks after their first install.
//   - The source arr might be a *different machine entirely* — its URL +
//     API key are inputs the install wizard doesn't have any reason to
//     ask about.
//
// Architecture: all HTTP from the renderer. Both source and dest arrs
// expose their JSON API; Electron's renderer can fetch() either freely.
// API keys for the LOCAL arrs come from the NAS's .env file (read over
// SSH on screen entry) so the user only types the SOURCE key.
//
// What gets imported:
//   - Series (Sonarr): tvdbId, title, monitored flag, seriesType
//   - Movies (Radarr): tmdbId, title, monitored flag
//
// What does NOT get imported (yet):
//   - Quality profile per-item (we map by name with fallback to dest's
//     first profile)
//   - Custom formats, tags, root folder per-item
//   - Download history / queue state
//   - Episode-level monitored state (the show is added with default
//     "monitor all" — user can refine in Sonarr UI)

import { useEffect, useState } from 'react'
import { useWizard } from '../store/wizard.js'
import { useFollowScroll } from '../hooks/useFollowScroll.js'
import type { QbitTorrent } from '../../shared/ipc.js'

type ArrKind = 'sonarr' | 'radarr'

interface SourceItem {
  // Common fields. Sonarr uses tvdbId, Radarr uses tmdbId — one will
  // be populated per item, the other undefined.
  tvdbId?: number
  tmdbId?: number
  title: string
  /** Source arr's quality profile id — we map to dest by NAME, not id. */
  qualityProfileId?: number
  /** Source arr's quality profile name (denormalised from the id-lookup
   *  we do during fetch, so the import path doesn't need a second
   *  GET /qualityprofile round-trip). */
  qualityProfileName?: string
  monitored?: boolean
  seriesType?: string
}

interface FetchedSet {
  sonarr: SourceItem[] | null
  radarr: SourceItem[] | null
}

type ImportResult = { title: string; status: 'ok' | 'updated' | 'fail'; message?: string }

export function MigrateScreen() {
  const { sessionId, targetDir, setStep } = useWizard()
  // Source connection info persists on the active profile (encrypted),
  // so closing the wizard or switching screens doesn't make the user
  // re-paste four URLs + four credentials. Reads via per-field
  // selector to keep render churn tight; writes via setMigrate which
  // shallow-merges. useProfileAutosave picks up changes and writes
  // back to the profile after a 600ms debounce.
  const migrate = useWizard((s) => s.migrate)
  const setMigrate = useWizard((s) => s.setMigrate)
  const sourceSonarrUrl = migrate.sourceSonarrUrl ?? ''
  const sourceSonarrKey = migrate.sourceSonarrKey ?? ''
  const sourceRadarrUrl = migrate.sourceRadarrUrl ?? ''
  const sourceRadarrKey = migrate.sourceRadarrKey ?? ''

  // qBittorrent migration — independent flow from the arr import,
  // shares the screen but has its own connect / fetch / import cycle.
  const sourceQbitUrl  = migrate.sourceQbitUrl  ?? ''
  const sourceQbitUser = migrate.sourceQbitUser ?? ''
  const sourceQbitPass = migrate.sourceQbitPass ?? ''
  const [qbitFetching, setQbitFetching] = useState(false)
  const [qbitFetchError, setQbitFetchError] = useState<string | null>(null)
  const [qbitTorrents, setQbitTorrents] = useState<QbitTorrent[] | null>(null)
  /** Path-prefix remap. Source torrents typically save to a path like
   *  /downloads/Completed on the OLD system; on the NEW system that
   *  same data lives at /data/Downloads/Torrents/Completed. User
   *  provides find/replace; we apply per-torrent at migrate time.
   *  Defaults pre-fill once we see the first source torrent. */
  const qbitRemapFrom = migrate.qbitRemapFrom ?? ''
  const qbitRemapTo   = migrate.qbitRemapTo   ?? ''
  const [qbitImporting, setQbitImporting] = useState(false)
  const [qbitResults, setQbitResults] = useState<ImportResult[]>([])

  /** Local arr URLs derived from the active profile's LAN_IP + the
   *  stack's standard ports. Could come from somewhere more robust
   *  (probing for the running containers) but the wizard's own config
   *  is authoritative for what we just installed. */
  const config = useWizard((s) => s.config)
  const lanIp = (config.LAN_IP as string | undefined) ?? ''
  const autoSonarrUrl = lanIp ? `http://${lanIp}:49152` : ''
  const autoRadarrUrl = lanIp ? `http://${lanIp}:49151` : ''
  const autoQbitUrl   = lanIp ? `http://${lanIp}:49156` : ''

  /** API keys / creds for the LOCAL services — read from the NAS's
   *  .env on screen entry. Sonarr/Radarr use X-Api-Key auth (auto-
   *  discovered by setup-arr-config.py). qBittorrent uses cookie auth
   *  via WebUI user+pass (set during install via QBITTORRENT_USER /
   *  QBITTORRENT_PASS). Loaded together in one grep so the user
   *  doesn't see two waterfalls. */
  const [localKeys, setLocalKeys] = useState<{
    sonarr: string | null
    radarr: string | null
    qbitUser: string | null
    qbitPass: string | null
  }>({ sonarr: null, radarr: null, qbitUser: null, qbitPass: null })
  const [keysError, setKeysError] = useState<string | null>(null)

  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [fetched, setFetched] = useState<FetchedSet>({ sonarr: null, radarr: null })

  const [importing, setImporting] = useState(false)
  const [results, setResults] = useState<ImportResult[]>([])

  // Auto-scroll behavior for both result lists, mirroring the install
  // log on the Run screen: scroll to bottom as items append, yield to
  // the user the moment they wheel/touch/key up, and re-stick on
  // return to the bottom edge. Two separate hooks so the qBit list
  // doesn't get jerked around when the arr list updates and vice versa.
  const arrScroll  = useFollowScroll<HTMLUListElement>(results.length)
  const qbitScroll = useFollowScroll<HTMLUListElement>(qbitResults.length)

  // Effective destination values — manual override beats auto-
  // discovered. The auto-discovered values still feed the placeholder
  // text so the user can see what we'd otherwise use, but anything
  // typed into the destination fields wins. This is what unblocks the
  // import button when the .env read failed or the wizard hasn't yet
  // generated keys (fresh install in flight, partial run, etc.) and
  // also covers the qBit "wrong password in .env" case where the user
  // needs to paste the actual WebUI password.
  const destSonarrUrl = (migrate.destSonarrUrl?.trim() || autoSonarrUrl).trim()
  const destSonarrKey = (migrate.destSonarrKey?.trim() || localKeys.sonarr || '').trim()
  const destRadarrUrl = (migrate.destRadarrUrl?.trim() || autoRadarrUrl).trim()
  const destRadarrKey = (migrate.destRadarrKey?.trim() || localKeys.radarr || '').trim()
  const destQbitUrl   = (migrate.destQbitUrl?.trim()   || autoQbitUrl).trim()
  const destQbitUser  = (migrate.destQbitUser?.trim()  || localKeys.qbitUser || '').trim()
  const destQbitPass  = (migrate.destQbitPass         || localKeys.qbitPass  || '')

  // Load local API keys from NAS .env on first mount. Single grep call,
  // pulls both keys + the .env-side hostname for sanity. Read-only.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await window.installer.ssh.exec({
          sessionId,
          cmd: `grep -E '^(SONARR_API_KEY|RADARR_API_KEY|QBITTORRENT_USER|QBITTORRENT_PASS)=' ${shellQuote(`${targetDir}/.env`)} 2>/dev/null`,
          sudo: false,
        })
        if (cancelled) return
        if (r.exitCode !== 0) {
          setKeysError(`Couldn't read .env: ${(r.stderr || '').slice(0, 120)}`)
          return
        }
        const lines = r.stdout.split('\n')
        const sonarr   = parseEnvLine(lines, 'SONARR_API_KEY')
        const radarr   = parseEnvLine(lines, 'RADARR_API_KEY')
        const qbitUser = parseEnvLine(lines, 'QBITTORRENT_USER')
        const qbitPass = parseEnvLine(lines, 'QBITTORRENT_PASS')
        setLocalKeys({ sonarr, radarr, qbitUser, qbitPass })
        if (!sonarr && !radarr && !qbitUser) {
          setKeysError("Local services don't have keys/creds yet — finish the install first, then come back here.")
        }
      } catch (e) {
        if (cancelled) return
        setKeysError(`Read .env failed: ${(e as Error).message}`)
      }
    })()
    return () => { cancelled = true }
  }, [sessionId, targetDir])

  async function fetchSource() {
    setFetching(true)
    setFetchError(null)
    setFetched({ sonarr: null, radarr: null })
    try {
      const next: FetchedSet = { sonarr: null, radarr: null }
      if (sourceSonarrUrl && sourceSonarrKey) {
        next.sonarr = await fetchArrList(sourceSonarrUrl, sourceSonarrKey, 'sonarr')
      }
      if (sourceRadarrUrl && sourceRadarrKey) {
        next.radarr = await fetchArrList(sourceRadarrUrl, sourceRadarrKey, 'radarr')
      }
      if (!next.sonarr && !next.radarr) {
        throw new Error('Provide a source URL + API key for at least one arr.')
      }
      setFetched(next)
    } catch (e) {
      setFetchError((e as Error).message)
    } finally {
      setFetching(false)
    }
  }

  async function importAll() {
    setImporting(true)
    setResults([])
    const newResults: ImportResult[] = []
    const push = (r: ImportResult) => {
      newResults.push(r)
      // Trigger re-render incrementally so the user sees progress as
      // items land instead of waiting for the whole batch.
      setResults([...newResults])
    }
    try {
      if (fetched.sonarr && destSonarrUrl && destSonarrKey) {
        await importToArr(destSonarrUrl, destSonarrKey, 'sonarr', fetched.sonarr, push)
      }
      if (fetched.radarr && destRadarrUrl && destRadarrKey) {
        await importToArr(destRadarrUrl, destRadarrKey, 'radarr', fetched.radarr, push)
      }
    } finally {
      setImporting(false)
    }
  }

  async function fetchQbit() {
    setQbitFetching(true)
    setQbitFetchError(null)
    setQbitTorrents(null)
    try {
      if (!sourceQbitUrl) throw new Error('Source qBittorrent URL required.')
      const r = await window.installer.qbit.fetchList({
        url: sourceQbitUrl,
        username: sourceQbitUser,
        password: sourceQbitPass,
      })
      if (!r.ok || !r.torrents) {
        throw new Error(r.error || 'unknown error')
      }
      setQbitTorrents(r.torrents)
      // Auto-suggest a remap if all source torrents share a path prefix.
      // Most users have a single save dir (e.g. /downloads); pre-fill
      // both fields with that as the From and the expected Mediarr
      // path (/data/Downloads/Torrents) as the To so the user just
      // tweaks rather than typing from scratch.
      if (r.torrents.length > 0 && !qbitRemapFrom && !qbitRemapTo) {
        const commonPrefix = longestCommonPrefix(r.torrents.map((t) => t.save_path))
        if (commonPrefix && commonPrefix.length > 1) {
          setMigrate({
            qbitRemapFrom: commonPrefix.replace(/\/$/, ''),
            qbitRemapTo:   '/data/Downloads/Torrents',
          })
        }
      }
    } catch (e) {
      setQbitFetchError((e as Error).message)
    } finally {
      setQbitFetching(false)
    }
  }

  async function importQbit() {
    if (!qbitTorrents || qbitTorrents.length === 0) return
    // Effective dest creds combine .env-read + manual override (override
    // wins). At least URL + user must resolve to something — pass is
    // optional when qBit has LAN auth-bypass (the install configures
    // 192.168/10.0/172.16 subnets to skip auth). Without these guards
    // a user with no .env read could submit an empty form and get
    // "Source qBit login failed" 160 times.
    if (!destQbitUrl || !destQbitUser) {
      setQbitFetchError("Destination qBittorrent URL + username missing — paste them in the Destination override below.")
      return
    }
    setQbitImporting(true)
    setQbitResults([])
    const newResults: ImportResult[] = []
    const push = (r: ImportResult) => {
      newResults.push(r)
      setQbitResults([...newResults])
    }
    for (const t of qbitTorrents) {
      const destSavePath = qbitRemapFrom && t.save_path.startsWith(qbitRemapFrom)
        ? qbitRemapTo + t.save_path.slice(qbitRemapFrom.length)
        : t.save_path
      try {
        const r = await window.installer.qbit.migrateOne({
          sourceUrl:      sourceQbitUrl,
          sourceUsername: sourceQbitUser,
          sourcePassword: sourceQbitPass,
          sourceHash:     t.hash,
          destUrl:        destQbitUrl,
          destUsername:   destQbitUser,
          destPassword:   destQbitPass,
          destSavePath,
          destCategory:   t.category,
          destTags:       t.tags,
          // Pause by default — gives the user a chance to verify the
          // remapped save_path is correct before qBit starts seeding
          // (with skip_checking=true, qBit doesn't verify files
          // exist; mismatched paths would lead to a "missing files"
          // error on first seed attempt).
          paused: true,
        })
        if (r.ok) {
          push({ title: t.name, status: 'ok' })
        } else {
          push({ title: t.name, status: 'fail', message: `${r.stage}: ${r.error}` })
        }
      } catch (e) {
        push({ title: t.name, status: 'fail', message: (e as Error).message })
      }
    }
    setQbitImporting(false)
  }

  const counts = {
    sonarr: fetched.sonarr?.length ?? 0,
    radarr: fetched.radarr?.length ?? 0,
  }
  const totalFetched = counts.sonarr + counts.radarr
  const counts_results = {
    ok:      results.filter((r) => r.status === 'ok').length,
    updated: results.filter((r) => r.status === 'updated').length,
    fail:    results.filter((r) => r.status === 'fail').length,
  }

  return (
    <div className="h-full flex flex-col p-6 gap-4 overflow-y-auto">
      <header>
        <h1 className="text-2xl font-semibold">Migrate library</h1>
        <p className="text-sm text-slate-400 mt-1">
          Pull a series + movie library from an EXISTING Sonarr / Radarr
          instance (your previous NAS, a Linux server, a friend&apos;s
          install) and re-add everything to this stack&apos;s local arrs.
        </p>
      </header>

      {keysError && (
        <div className="bg-amber-900/40 border border-amber-700/50 text-amber-200 rounded-md p-3 text-sm">
          {keysError}
        </div>
      )}

      <section className="rounded-md border border-slate-700 bg-slate-900/40 p-4 space-y-3">
        <h2 className="font-medium">Source arr connection</h2>
        <p className="text-xs text-slate-400">
          Provide the URL + API key for at least one of Sonarr / Radarr.
          Skip the one you don&apos;t need. API keys live under
          <code className="bg-slate-800 px-1 rounded mx-1">Settings → General → Security → API Key</code>
          in the source arr.
        </p>

        <div className="grid grid-cols-[1fr_2fr] gap-3 text-sm items-center">
          <label>Source Sonarr URL</label>
          <input
            type="text" placeholder="http://old-nas:8989"
            value={sourceSonarrUrl}
            onChange={(e) => setMigrate({ sourceSonarrUrl: e.target.value.trim() })}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
          <label>Source Sonarr API key</label>
          <input
            type="password"
            value={sourceSonarrKey}
            onChange={(e) => setMigrate({ sourceSonarrKey: e.target.value.trim() })}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
          <label>Source Radarr URL</label>
          <input
            type="text" placeholder="http://old-nas:7878"
            value={sourceRadarrUrl}
            onChange={(e) => setMigrate({ sourceRadarrUrl: e.target.value.trim() })}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
          <label>Source Radarr API key</label>
          <input
            type="password"
            value={sourceRadarrKey}
            onChange={(e) => setMigrate({ sourceRadarrKey: e.target.value.trim() })}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchSource}
            disabled={fetching || importing}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 rounded-md text-sm disabled:opacity-40"
          >
            {fetching
              ? 'Fetching…'
              : totalFetched > 0
                ? `✔ Re-fetch source lists (${totalFetched} cached)`
                : 'Fetch lists from source'}
          </button>
          {fetchError && <span className="text-rose-300 text-sm">✘ {fetchError}</span>}
          {totalFetched > 0 && !fetching && (
            <span className="text-emerald-300 text-sm">
              ✔ Got {totalFetched} title{totalFetched === 1 ? '' : 's'}. Scroll down to import →
            </span>
          )}
        </div>
      </section>

      {totalFetched > 0 && (
        <section className="rounded-md border border-slate-700 bg-slate-900/40 p-4 space-y-3">
          <h2 className="font-medium">Preview</h2>
          {counts.sonarr > 0 && (
            <PreviewList kind="sonarr" items={fetched.sonarr!} />
          )}
          {counts.radarr > 0 && (
            <PreviewList kind="radarr" items={fetched.radarr!} />
          )}

          {/* Destination credentials — pre-filled from auto-discovery
              (.env grep + LAN_IP), editable when the user needs to point
              at a different URL or supply a key the wizard couldn't
              find (partial install, behind reverse proxy, etc.).
              Persisted to the profile via setMigrate so the user
              doesn't have to re-paste on every wizard launch. */}
          <div className="border-t border-slate-800 pt-3 space-y-2">
            <h3 className="text-sm font-medium">Destination credentials</h3>
            {keysError && (
              <p className="text-xs text-amber-300">{keysError}</p>
            )}
            <p className="text-xs text-slate-400">
              Auto-filled from your local <code className="bg-slate-800 px-1 rounded">.env</code> and
              <code className="bg-slate-800 px-1 rounded mx-1">LAN_IP</code>. Override when
              auto-discovery missed something — typically a partial
              install, a different URL/port, or an arr stack the wizard
              didn&apos;t install.
            </p>
            <div className="grid grid-cols-[1fr_2fr] gap-2 text-sm items-center">
              {fetched.sonarr && (<>
                <label>Dest Sonarr URL</label>
                <input
                  type="text"
                  placeholder={autoSonarrUrl || 'http://nas:49152'}
                  value={migrate.destSonarrUrl ?? ''}
                  onChange={(e) => setMigrate({ destSonarrUrl: e.target.value.trim() })}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
                />
                <label>Dest Sonarr API key</label>
                <input
                  type="password"
                  placeholder={localKeys.sonarr ? '(from .env)' : 'paste API key'}
                  value={migrate.destSonarrKey ?? ''}
                  onChange={(e) => setMigrate({ destSonarrKey: e.target.value.trim() })}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
                />
              </>)}
              {fetched.radarr && (<>
                <label>Dest Radarr URL</label>
                <input
                  type="text"
                  placeholder={autoRadarrUrl || 'http://nas:49151'}
                  value={migrate.destRadarrUrl ?? ''}
                  onChange={(e) => setMigrate({ destRadarrUrl: e.target.value.trim() })}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
                />
                <label>Dest Radarr API key</label>
                <input
                  type="password"
                  placeholder={localKeys.radarr ? '(from .env)' : 'paste API key'}
                  value={migrate.destRadarrKey ?? ''}
                  onChange={(e) => setMigrate({ destRadarrKey: e.target.value.trim() })}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
                />
              </>)}
            </div>
          </div>

          {/* Big, obvious, sticky-feeling action bar. The Import
              button used to be a small green pill at the bottom of a
              long page — easy to miss after scrolling through fetch
              preview + dest credentials, which made users think the
              wizard was waiting on something else. Now: full-width
              bar with the action front-and-center, plus an explicit
              "what's missing" line when disabled so the user knows
              exactly which field to fill. */}
          {(() => {
            const sonarrReady = fetched.sonarr && destSonarrUrl && destSonarrKey
            const radarrReady = fetched.radarr && destRadarrUrl && destRadarrKey
            const canImport = sonarrReady || radarrReady
            const missing: string[] = []
            if (fetched.sonarr && !destSonarrUrl) missing.push('Sonarr URL')
            if (fetched.sonarr && !destSonarrKey) missing.push('Sonarr API key')
            if (fetched.radarr && !destRadarrUrl) missing.push('Radarr URL')
            if (fetched.radarr && !destRadarrKey) missing.push('Radarr API key')
            return (
              <div className="border-t border-slate-800 pt-3">
                <button
                  onClick={importAll}
                  disabled={importing || fetching || !canImport}
                  title={canImport ? 'Start importing' : `Missing: ${missing.join(', ')}`}
                  className={`w-full px-6 py-3 rounded-md text-base font-semibold disabled:opacity-40 ${
                    canImport && !importing
                      ? 'bg-emerald-600 hover:bg-emerald-500 ring-2 ring-emerald-400/30 animate-pulse'
                      : 'bg-emerald-600'
                  }`}
                >
                  {importing
                    ? `Importing ${results.length}/${totalFetched}…`
                    : canImport
                      ? `→ Import ${totalFetched} title${totalFetched === 1 ? '' : 's'} into destination arrs`
                      : `Fill destination credentials above to import ${totalFetched} title${totalFetched === 1 ? '' : 's'}`}
                </button>
                {!canImport && missing.length > 0 && !importing && (
                  <p className="mt-2 text-xs text-amber-300">
                    Missing: {missing.join(', ')}. Fill those in the &ldquo;Destination credentials&rdquo; box above.
                  </p>
                )}
                <p className="mt-2 text-xs text-slate-400">
                  New titles are added with the destination arr&apos;s default
                  quality profile + root folder. Existing titles get their
                  monitored flag + quality profile + series type
                  overwritten from the source (files on disk are kept).
                  A search kicks off for any monitored item that doesn&apos;t
                  have files yet — your old &ldquo;Wanted&rdquo; list will start
                  grabbing on the new NAS automatically.
                </p>
              </div>
            )
          })()}
        </section>
      )}

      {results.length > 0 && (
        <section className="rounded-md border border-slate-700 bg-slate-900/40 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Import results</h2>
            <span className="text-xs text-slate-400">
              <span className="text-emerald-300">✔ added {counts_results.ok}</span>
              <span className="mx-2">·</span>
              <span className="text-sky-300">↻ updated {counts_results.updated}</span>
              <span className="mx-2">·</span>
              <span className="text-rose-300">✘ {counts_results.fail}</span>
            </span>
          </div>
          <div className="relative">
            <ul
              ref={arrScroll.ref}
              tabIndex={0}
              className="text-xs font-mono space-y-0.5 max-h-64 overflow-y-auto focus:outline-none"
            >
              {results.map((r, i) => (
                <li key={i} className={
                  r.status === 'ok' ? 'text-emerald-300'
                  : r.status === 'updated' ? 'text-sky-300'
                  : 'text-rose-300'
                }>
                  {r.status === 'ok' ? '✔' : r.status === 'updated' ? '↻' : '✘'} {r.title}
                  {r.message && <span className="text-slate-500"> — {r.message}</span>}
                </li>
              ))}
            </ul>
            {arrScroll.stuck && (
              <button
                type="button"
                onClick={arrScroll.jumpToBottom}
                className="absolute bottom-1 right-1 px-2.5 py-1 text-xs rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/50 border border-emerald-500/40"
                title="Resume following — jump to bottom"
              >
                Jump to bottom ↓
              </button>
            )}
          </div>
        </section>
      )}

      {/* ── qBittorrent migration ─────────────────────────────────────── */}
      <section className="rounded-md border border-slate-700 bg-slate-900/40 p-4 space-y-3">
        <h2 className="font-medium">qBittorrent torrents</h2>
        <p className="text-xs text-slate-400">
          Move active torrents from an existing qBittorrent (your previous
          NAS, a Linux box, etc.) to this stack&apos;s qBit so they keep
          seeding without re-downloading. The .torrent files are exported
          from the source and re-added to the destination with{' '}
          <code className="bg-slate-800 px-1 rounded">skip_checking</code>
          {' '}— files must already exist at the mapped save path on the
          new system (move the data there first, OR keep the disk and
          use the same paths). Torrents are added <em>paused</em> so you
          can verify save paths before seeding starts.
        </p>

        <div className="grid grid-cols-[1fr_2fr] gap-3 text-sm items-center">
          <label>Source qBittorrent URL</label>
          <input
            type="text" placeholder="http://old-nas:49156"
            value={sourceQbitUrl}
            onChange={(e) => setMigrate({ sourceQbitUrl: e.target.value.trim().replace(/\/$/, '') })}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
          <label>Username</label>
          <input
            type="text"
            value={sourceQbitUser}
            onChange={(e) => setMigrate({ sourceQbitUser: e.target.value.trim() })}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
          <label>Password</label>
          <input
            type="password"
            value={sourceQbitPass}
            onChange={(e) => setMigrate({ sourceQbitPass: e.target.value })}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchQbit}
            disabled={qbitFetching || qbitImporting}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 rounded-md text-sm disabled:opacity-40"
          >
            {qbitFetching
              ? 'Fetching…'
              : qbitTorrents && qbitTorrents.length > 0
                ? `✔ Re-fetch torrent list (${qbitTorrents.length} cached)`
                : 'Fetch torrent list'}
          </button>
          {qbitFetchError && <span className="text-rose-300 text-sm">✘ {qbitFetchError}</span>}
          {qbitTorrents && qbitTorrents.length > 0 && !qbitFetching && (
            <span className="text-emerald-300 text-sm">
              ✔ Got {qbitTorrents.length} torrent{qbitTorrents.length === 1 ? '' : 's'}. Scroll down to migrate →
            </span>
          )}
        </div>

        {qbitTorrents && qbitTorrents.length > 0 && (
          <>
            <div className="text-sm border-t border-slate-800 pt-3">
              <span className="font-medium">{qbitTorrents.length}</span>{' '}
              torrents on source. Sample:
              <ul className="mt-1 text-xs text-slate-400 font-mono space-y-0.5">
                {qbitTorrents.slice(0, 5).map((t) => (
                  <li key={t.hash} className="truncate">· {t.name}</li>
                ))}
                {qbitTorrents.length > 5 && (
                  <li className="text-slate-500">  …and {qbitTorrents.length - 5} more</li>
                )}
              </ul>
            </div>

            <div className="border-t border-slate-800 pt-3 space-y-2">
              <h3 className="text-sm font-medium">Path remap</h3>
              <p className="text-xs text-slate-400">
                The source torrents&apos; save paths get rewritten when
                added to the dest. Leave blank if paths are identical
                on both systems. Example:{' '}
                <code className="bg-slate-800 px-1 rounded">/downloads</code>
                {' → '}
                <code className="bg-slate-800 px-1 rounded">/data/Downloads/Torrents</code>
              </p>
              <div className="grid grid-cols-[1fr_2fr] gap-2 text-sm items-center">
                <label>Source path prefix</label>
                <input
                  type="text" placeholder="/downloads"
                  value={qbitRemapFrom}
                  onChange={(e) => setMigrate({ qbitRemapFrom: e.target.value.trim() })}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
                />
                <label>Destination prefix</label>
                <input
                  type="text" placeholder="/data/Downloads/Torrents"
                  value={qbitRemapTo}
                  onChange={(e) => setMigrate({ qbitRemapTo: e.target.value.trim() })}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
                />
              </div>
              {qbitRemapFrom && (
                <p className="text-xs text-slate-500">
                  Preview: <code className="font-mono">{qbitTorrents[0].save_path}</code>
                  {' → '}
                  <code className="font-mono">
                    {qbitTorrents[0].save_path.startsWith(qbitRemapFrom)
                      ? qbitRemapTo + qbitTorrents[0].save_path.slice(qbitRemapFrom.length)
                      : qbitTorrents[0].save_path + ' (unchanged — prefix not in path)'}
                  </code>
                </p>
              )}
            </div>

            {/* Destination qBittorrent — auto-filled from .env +
                LAN_IP, editable to fix the most common "login-dest
                failed" causes: wrong password (qBit regenerated its
                PBKDF2 hash on first boot, .env's plain password no
                longer matches), wrong URL/port, or a fresh wizard run
                where .env hasn't been read yet. */}
            <div className="border-t border-slate-800 pt-3 space-y-2">
              <h3 className="text-sm font-medium">Destination qBittorrent</h3>
              <p className="text-xs text-slate-400">
                Auto-filled from <code className="bg-slate-800 px-1 rounded">LAN_IP</code> + your local
                <code className="bg-slate-800 px-1 rounded mx-1">.env</code>. Override if the WebUI password
                changed since install, or the URL/port is different.
              </p>
              <div className="grid grid-cols-[1fr_2fr] gap-2 text-sm items-center">
                <label>Dest URL</label>
                <input
                  type="text"
                  placeholder={autoQbitUrl || 'http://nas:49156'}
                  value={migrate.destQbitUrl ?? ''}
                  onChange={(e) => setMigrate({ destQbitUrl: e.target.value.trim().replace(/\/$/, '') })}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
                />
                <label>Dest username</label>
                <input
                  type="text"
                  placeholder={localKeys.qbitUser ? '(from .env)' : 'admin'}
                  value={migrate.destQbitUser ?? ''}
                  onChange={(e) => setMigrate({ destQbitUser: e.target.value.trim() })}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
                />
                <label>Dest password</label>
                <input
                  type="password"
                  placeholder={localKeys.qbitPass ? '(from .env)' : 'paste qBit WebUI password'}
                  value={migrate.destQbitPass ?? ''}
                  onChange={(e) => setMigrate({ destQbitPass: e.target.value })}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
                />
              </div>
            </div>

            {/* Full-width primary action — matches the arr import button
                so users don't miss it after scrolling through the
                preview, remap, and destination panels. */}
            {(() => {
              const canMigrate = Boolean(destQbitUrl && destQbitUser)
              const missing: string[] = []
              if (!destQbitUrl)  missing.push('Dest URL')
              if (!destQbitUser) missing.push('Dest username')
              return (
                <div className="border-t border-slate-800 pt-3">
                  <button
                    onClick={importQbit}
                    disabled={qbitImporting || qbitFetching || !canMigrate}
                    title={canMigrate ? 'Migrate torrents' : `Missing: ${missing.join(', ')}`}
                    className={`w-full px-6 py-3 rounded-md text-base font-semibold disabled:opacity-40 ${
                      canMigrate && !qbitImporting
                        ? 'bg-emerald-600 hover:bg-emerald-500 ring-2 ring-emerald-400/30 animate-pulse'
                        : 'bg-emerald-600'
                    }`}
                  >
                    {qbitImporting
                      ? `Migrating ${qbitResults.length}/${qbitTorrents.length}…`
                      : canMigrate
                        ? `→ Migrate ${qbitTorrents.length} torrent${qbitTorrents.length === 1 ? '' : 's'} into destination qBit`
                        : `Fill destination credentials above to migrate ${qbitTorrents.length} torrent${qbitTorrents.length === 1 ? '' : 's'}`}
                  </button>
                  {!canMigrate && missing.length > 0 && !qbitImporting && (
                    <p className="mt-2 text-xs text-amber-300">
                      Missing: {missing.join(', ')}. Fill those in the &ldquo;Destination qBittorrent&rdquo; box above.
                    </p>
                  )}
                  <p className="mt-2 text-xs text-slate-400">
                    Migrating to{' '}
                    <code className="bg-slate-800 px-1 rounded font-mono">
                      {destQbitUrl || '(URL missing)'}
                    </code>{' '}
                    as <code className="bg-slate-800 px-1 rounded font-mono">{destQbitUser || '(no user)'}</code>.
                  </p>
                </div>
              )
            })()}
          </>
        )}

        {qbitResults.length > 0 && (
          <div className="border-t border-slate-800 pt-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Migration results</h3>
              <span className="text-xs text-slate-400">
                <span className="text-emerald-300">✔ {qbitResults.filter((r) => r.status === 'ok').length}</span>
                <span className="mx-2">·</span>
                <span className="text-rose-300">✘ {qbitResults.filter((r) => r.status === 'fail').length}</span>
              </span>
            </div>
            <div className="relative mt-1">
              <ul
                ref={qbitScroll.ref}
                tabIndex={0}
                className="text-xs font-mono space-y-0.5 max-h-48 overflow-y-auto focus:outline-none"
              >
                {qbitResults.map((r, i) => (
                  <li key={i} className={r.status === 'ok' ? 'text-emerald-300' : 'text-rose-300'}>
                    {r.status === 'ok' ? '✔' : '✘'} {r.title}
                    {r.message && <span className="text-slate-500"> — {r.message}</span>}
                  </li>
                ))}
              </ul>
              {qbitScroll.stuck && (
                <button
                  type="button"
                  onClick={qbitScroll.jumpToBottom}
                  className="absolute bottom-1 right-1 px-2.5 py-1 text-xs rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/50 border border-emerald-500/40"
                  title="Resume following — jump to bottom"
                >
                  Jump to bottom ↓
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="mt-auto flex justify-between gap-3">
        <button
          onClick={() => setStep('welcome')}
          disabled={fetching || importing}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md text-sm disabled:opacity-40"
        >
          Back to start
        </button>
        <button
          onClick={() => setStep('done')}
          disabled={fetching || importing}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md text-sm disabled:opacity-40"
        >
          {results.length > 0 ? 'Done — go to dashboard' : 'Skip — go to dashboard'}
        </button>
      </div>
    </div>
  )
}

function PreviewList({ kind, items }: { kind: ArrKind; items: SourceItem[] }) {
  // Show first 8 titles + an ellipsis if there are more. Sample is
  // enough to confirm "yep that's my library" without overwhelming the
  // panel. Click "Import" to see the full list as it processes.
  const sample = items.slice(0, 8)
  const more = items.length - sample.length
  return (
    <div>
      <div className="text-sm flex items-center gap-2">
        <span className="font-medium capitalize">{kind}</span>
        <span className="text-slate-400">— {items.length} title{items.length === 1 ? '' : 's'}</span>
      </div>
      <ul className="mt-1 text-xs text-slate-400 font-mono space-y-0.5">
        {sample.map((s, i) => (
          <li key={i} className="truncate">· {s.title}</li>
        ))}
        {more > 0 && <li className="text-slate-500">  …and {more} more</li>}
      </ul>
    </div>
  )
}

// ── HTTP helpers (renderer-side fetch) ──────────────────────────────────────

/** Normalize a user-typed arr URL so concatenating `/api/v3/...` always
 *  produces a clean request line. Trailing slashes are the #1 source of
 *  the `<!doctype` / "is not valid JSON" surprise — `http://nas:8989/`
 *  + `/api/v3/series` becomes `http://nas:8989//api/v3/series`, which
 *  Sonarr's frontend either 404s (returning the SPA fallback HTML) or
 *  serves the index page directly. We also prepend `http://` if the
 *  user forgot the scheme. */
function normalizeArrUrl(raw: string): string {
  let url = raw.trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  // Collapse the trailing slash(es). Keep any UrlBase the user typed —
  // `http://nas:8989/sonarr/` is a legit Sonarr-behind-reverse-proxy
  // setup, we just don't want the trailing `/` doubling up.
  return url.replace(/\/+$/, '')
}

/** Fetch + safe-parse a JSON response from an arr API. Wraps fetch()
 *  with two extra guard rails that bare `.json()` doesn't give us:
 *    1. Check Content-Type before parsing. Sonarr/Radarr's frontend
 *       SPA returns HTML 200 OK on unknown paths — without this check
 *       we'd JSON.parse `<!doctype html>` and blow up with the user-
 *       hostile "Unexpected token '<'" error.
 *    2. Decode common failure shapes into helpful messages — wrong API
 *       key (401), wrong UrlBase (HTML response), wrong port (network
 *       error), HTTPS-only port (TLS error). */
async function arrFetchJson<T = any>(
  url: string,
  apiKey: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        'X-Api-Key': apiKey,
      },
    })
  } catch (e) {
    // Network error — DNS/refused/timeout. Re-throw with the original URL
    // so the user can spot a typo immediately.
    throw new Error(`Could not reach ${url} — ${(e as Error).message}`)
  }
  // 401 = wrong/missing API key. Sonarr/Radarr return this even when
  // Forms Auth is enabled, as long as the URL itself is right.
  if (res.status === 401) {
    throw new Error(
      `${url} returned 401 — API key looks wrong. Settings → General → Security → API Key in the arr.`,
    )
  }
  // 404 with HTML body = wrong UrlBase / SPA fallback. Tell the user.
  if (res.status === 404) {
    throw new Error(
      `${url} returned 404 — check the URL. If your arr has a "URL Base" set ` +
      `(Settings → General → Host), include it: e.g. http://nas:8989/sonarr`,
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${url} returned HTTP ${res.status}: ${body.slice(0, 120)}`)
  }
  // Check Content-Type before .json() — Sonarr's SPA returns text/html
  // 200 OK for the index page when the path doesn't match an API
  // route. Without this, a trailing slash on the user's URL ("http://
  // nas:8989/" + "/api/v3/series" = "//api/v3/series") parses the
  // index page as JSON and throws "Unexpected token '<'".
  const ct = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!ct.includes('json')) {
    const peek = await res.text().catch(() => '')
    const looksLikeHtml = /^\s*</.test(peek)
    throw new Error(
      looksLikeHtml
        ? `${url} returned HTML instead of JSON — most likely the URL has a trailing slash or your arr has a URL Base set. Try removing the trailing /, or include the URL Base (e.g. /sonarr).`
        : `${url} returned ${ct || 'unknown content-type'} instead of JSON: ${peek.slice(0, 120)}`,
    )
  }
  return res.json() as Promise<T>
}

async function fetchArrList(rawBaseUrl: string, apiKey: string, kind: ArrKind): Promise<SourceItem[]> {
  const baseUrl = normalizeArrUrl(rawBaseUrl)
  // Pre-flight: hit /system/status to confirm URL + API key BEFORE
  // pulling the (potentially large) series/movie list. Surfaces the
  // wrong-URL / wrong-key / wrong-UrlBase problem with one clean error
  // instead of a JSON-parse stack trace from the renderer.
  await arrFetchJson(`${baseUrl}/api/v3/system/status`, apiKey)

  // Two GETs: the list (series/movie) and the quality profiles. We
  // denormalise profile name into each item up-front so the import
  // pass doesn't need another round-trip.
  const listPath = kind === 'sonarr' ? '/api/v3/series' : '/api/v3/movie'
  const [list, profiles] = await Promise.all([
    arrFetchJson<any[]>(`${baseUrl}${listPath}`, apiKey),
    arrFetchJson<{ id: number; name: string }[]>(`${baseUrl}/api/v3/qualityprofile`, apiKey),
  ])
  const profileMap = new Map(profiles.map((p) => [p.id, p.name]))

  return list.map((item) => ({
    tvdbId:              kind === 'sonarr' ? item.tvdbId : undefined,
    tmdbId:              kind === 'radarr' ? item.tmdbId : undefined,
    title:               item.title,
    qualityProfileId:    item.qualityProfileId,
    qualityProfileName:  profileMap.get(item.qualityProfileId),
    monitored:           item.monitored,
    seriesType:          item.seriesType,
  }))
}

async function importToArr(
  rawDestUrl: string, apiKey: string, kind: ArrKind,
  items: SourceItem[],
  onResult: (r: ImportResult) => void,
) {
  const destUrl = normalizeArrUrl(rawDestUrl)
  // Build the dest-side context once: quality profile name→id map +
  // first root folder for default placement. Failures here abort the
  // whole batch since they'd cascade for every item.
  let destProfiles: { id: number; name: string }[]
  let rootFolders: { path: string }[]
  try {
    ;[destProfiles, rootFolders] = await Promise.all([
      arrFetchJson<{ id: number; name: string }[]>(`${destUrl}/api/v3/qualityprofile`, apiKey),
      arrFetchJson<{ path: string }[]>(`${destUrl}/api/v3/rootfolder`, apiKey),
    ])
  } catch (e) {
    onResult({ title: `(${kind} dest setup)`, status: 'fail', message: (e as Error).message })
    return
  }
  if (!destProfiles.length || !rootFolders.length) {
    onResult({
      title: `(${kind})`, status: 'fail',
      message: 'Local arr has no quality profiles / root folders yet — finish setup first',
    })
    return
  }
  const defaultRoot = rootFolders[0].path
  const profileByName = new Map(destProfiles.map((p) => [p.name, p.id]))
  const fallbackProfileId = destProfiles[0].id

  // Fetch existing entries ONCE so we can recognise dupes by tvdb/tmdb
  // id AND have the full record handy for the PUT-update path. The arr
  // PUT endpoint wants the whole object back — easier to mutate the
  // one we already pulled than to GET each one individually.
  let existingById: Map<number, any>
  try {
    const existing = await arrFetchJson<any[]>(
      `${destUrl}/api/v3/${kind === 'sonarr' ? 'series' : 'movie'}`,
      apiKey,
    )
    existingById = new Map<number, any>()
    for (const e of existing) {
      const eid = kind === 'sonarr' ? e.tvdbId : e.tmdbId
      if (eid) existingById.set(eid, e)
    }
  } catch {
    existingById = new Map()
  }

  // Tiny helper — best-effort POST to /api/v3/command. The Sonarr /
  // Radarr search trigger isn't required for migration to succeed; if
  // it 500s or times out we still want the add / update result to
  // count as success. The user can hit "Search Missing" in the arr UI
  // afterwards if needed.
  async function triggerSearch(arrId: number) {
    try {
      await fetch(`${destUrl}/api/v3/command`, {
        method:  'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify(
          kind === 'sonarr'
            ? { name: 'SeriesSearch', seriesId: arrId }
            : { name: 'MoviesSearch', movieIds: [arrId] }
        ),
      })
    } catch { /* best-effort */ }
  }

  for (const item of items) {
    const id = kind === 'sonarr' ? item.tvdbId : item.tmdbId
    if (!id) {
      onResult({ title: item.title, status: 'fail', message: 'missing tvdb/tmdb id' })
      continue
    }
    const profileId = (item.qualityProfileName && profileByName.get(item.qualityProfileName))
                    ?? fallbackProfileId

    // ── Existing entry → PUT-update path ────────────────────────────
    // The user asked for migration to overwrite existing entries on the
    // destination instead of skipping them. We do a targeted overwrite
    // of just the migration-relevant fields (quality profile, monitored
    // flag, seriesType) on top of the existing object so the dest's
    // local state — path, season folder, episode files, history —
    // stays intact. Then trigger a per-item search so anything sitting
    // in "Wanted" on the source that's still missing on dest gets
    // picked up immediately rather than waiting for the next RSS sync.
    const existing = existingById.get(id)
    if (existing) {
      const updated = {
        ...existing,
        qualityProfileId: profileId,
        monitored:        item.monitored ?? true,
        ...(kind === 'sonarr'
          ? { seriesType: item.seriesType ?? existing.seriesType ?? 'standard' }
          : {}),
      }
      try {
        const res = await fetch(
          `${destUrl}/api/v3/${kind === 'sonarr' ? 'series' : 'movie'}/${existing.id}`,
          {
            method:  'PUT',
            headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
            body:    JSON.stringify(updated),
          },
        )
        if (!res.ok) {
          const errBody = await res.text()
          onResult({ title: item.title, status: 'fail', message: `update HTTP ${res.status}: ${errBody.slice(0, 120)}` })
          continue
        }
        // Best-effort search — only when the entry's still wanted and
        // doesn't already have files. Saves spamming the indexers for
        // series the dest already has fully downloaded.
        const stillMissing = kind === 'sonarr'
          ? ((existing.statistics?.episodeFileCount ?? 0) === 0)
          : !existing.hasFile
        if (updated.monitored && stillMissing) {
          await triggerSearch(existing.id)
        }
        onResult({ title: item.title, status: 'updated' })
      } catch (e) {
        onResult({ title: item.title, status: 'fail', message: (e as Error).message })
      }
      continue
    }

    // ── New entry → POST-add path ───────────────────────────────────
    // searchForMissingEpisodes/searchForMovie=true so the "Wanted"
    // queue starts processing immediately after the add — that's the
    // whole point of bringing the library across, the user wants
    // anything that wasn't downloaded yet on the old NAS to start
    // grabbing on the new one.
    const body: any = {
      title:             item.title,
      qualityProfileId:  profileId,
      rootFolderPath:    defaultRoot,
      monitored:         item.monitored ?? true,
      addOptions: kind === 'sonarr'
        ? { searchForMissingEpisodes: true, ignoreEpisodesWithFiles: true, ignoreEpisodesWithoutFiles: false }
        : { searchForMovie: true },
    }
    if (kind === 'sonarr') {
      body.tvdbId     = item.tvdbId
      body.seriesType = item.seriesType ?? 'standard'
    } else {
      body.tmdbId = item.tmdbId
    }
    try {
      const res = await fetch(`${destUrl}/api/v3/${kind === 'sonarr' ? 'series' : 'movie'}`, {
        method:  'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      if (res.ok) {
        onResult({ title: item.title, status: 'ok' })
      } else {
        const errBody = await res.text()
        onResult({ title: item.title, status: 'fail', message: `HTTP ${res.status}: ${errBody.slice(0, 120)}` })
      }
    } catch (e) {
      onResult({ title: item.title, status: 'fail', message: (e as Error).message })
    }
  }
}

function parseEnvLine(lines: string[], key: string): string | null {
  // Match `KEY=value` exactly; strip surrounding whitespace, quoted
  // values, and trailing CR (Windows-edited .env files).
  for (const raw of lines) {
    const m = raw.match(/^([A-Z_]+)=(.*)$/)
    if (!m) continue
    if (m[1] !== key) continue
    let v = m[2].replace(/\r$/, '').trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    return v || null
  }
  return null
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Longest common string prefix across the supplied list. Used to
 *  auto-suggest the qBit save-path remap source — most users have all
 *  their torrents under one root (e.g. /downloads), and we'd rather
 *  pre-fill that than have them eyeball the source paths and type. */
function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return ''
  let prefix = strs[0]
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
      if (!prefix) return ''
    }
  }
  return prefix
}
