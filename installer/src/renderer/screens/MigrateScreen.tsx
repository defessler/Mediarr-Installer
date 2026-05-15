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

type ImportResult = { title: string; status: 'ok' | 'exists' | 'fail'; message?: string }

export function MigrateScreen() {
  const { sessionId, targetDir, setStep } = useWizard()
  const [sourceSonarrUrl, setSourceSonarrUrl] = useState('')
  const [sourceSonarrKey, setSourceSonarrKey] = useState('')
  const [sourceRadarrUrl, setSourceRadarrUrl] = useState('')
  const [sourceRadarrKey, setSourceRadarrKey] = useState('')

  // qBittorrent migration — independent flow from the arr import,
  // shares the screen but has its own connect / fetch / import cycle.
  const [sourceQbitUrl, setSourceQbitUrl] = useState('')
  const [sourceQbitUser, setSourceQbitUser] = useState('')
  const [sourceQbitPass, setSourceQbitPass] = useState('')
  const [qbitFetching, setQbitFetching] = useState(false)
  const [qbitFetchError, setQbitFetchError] = useState<string | null>(null)
  const [qbitTorrents, setQbitTorrents] = useState<QbitTorrent[] | null>(null)
  /** Path-prefix remap. Source torrents typically save to a path like
   *  /downloads/Completed on the OLD system; on the NEW system that
   *  same data lives at /data/Downloads/Torrents/Completed. User
   *  provides find/replace; we apply per-torrent at migrate time.
   *  Defaults pre-fill once we see the first source torrent. */
  const [qbitRemapFrom, setQbitRemapFrom] = useState('')
  const [qbitRemapTo, setQbitRemapTo]     = useState('')
  const [qbitImporting, setQbitImporting] = useState(false)
  const [qbitResults, setQbitResults] = useState<ImportResult[]>([])

  /** Local arr URLs derived from the active profile's LAN_IP + the
   *  stack's standard ports. Could come from somewhere more robust
   *  (probing for the running containers) but the wizard's own config
   *  is authoritative for what we just installed. */
  const config = useWizard((s) => s.config)
  const lanIp = (config.LAN_IP as string | undefined) ?? ''
  const localSonarrUrl = lanIp ? `http://${lanIp}:49152` : ''
  const localRadarrUrl = lanIp ? `http://${lanIp}:49151` : ''

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
      if (fetched.sonarr && localSonarrUrl && localKeys.sonarr) {
        await importToArr(localSonarrUrl, localKeys.sonarr, 'sonarr', fetched.sonarr, push)
      }
      if (fetched.radarr && localRadarrUrl && localKeys.radarr) {
        await importToArr(localRadarrUrl, localKeys.radarr, 'radarr', fetched.radarr, push)
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
          setQbitRemapFrom(commonPrefix.replace(/\/$/, ''))
          setQbitRemapTo('/data/Downloads/Torrents')
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
    if (!lanIp || !localKeys.qbitUser || !localKeys.qbitPass) {
      setQbitFetchError("Local qBittorrent creds not loaded — wait for .env read or re-run the install.")
      return
    }
    setQbitImporting(true)
    setQbitResults([])
    const newResults: ImportResult[] = []
    const push = (r: ImportResult) => {
      newResults.push(r)
      setQbitResults([...newResults])
    }
    const destUrl = `http://${lanIp}:49156`
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
          destUrl,
          destUsername:   localKeys.qbitUser,
          destPassword:   localKeys.qbitPass,
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
    ok:     results.filter((r) => r.status === 'ok').length,
    exists: results.filter((r) => r.status === 'exists').length,
    fail:   results.filter((r) => r.status === 'fail').length,
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
            onChange={(e) => setSourceSonarrUrl(e.target.value.trim())}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
          <label>Source Sonarr API key</label>
          <input
            type="password"
            value={sourceSonarrKey}
            onChange={(e) => setSourceSonarrKey(e.target.value.trim())}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
          <label>Source Radarr URL</label>
          <input
            type="text" placeholder="http://old-nas:7878"
            value={sourceRadarrUrl}
            onChange={(e) => setSourceRadarrUrl(e.target.value.trim())}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
          <label>Source Radarr API key</label>
          <input
            type="password"
            value={sourceRadarrKey}
            onChange={(e) => setSourceRadarrKey(e.target.value.trim())}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchSource}
            disabled={fetching || importing}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 rounded-md text-sm disabled:opacity-40"
          >
            {fetching ? 'Fetching…' : 'Fetch lists from source'}
          </button>
          {fetchError && <span className="text-rose-300 text-sm">✘ {fetchError}</span>}
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

          <div className="flex items-center gap-3 pt-2 border-t border-slate-800">
            <div className="text-xs text-slate-400 flex-1">
              Destination: {' '}
              <code className="bg-slate-800 px-1 rounded font-mono">{localSonarrUrl || '(no LAN_IP)'}</code>
              {' · '}
              <code className="bg-slate-800 px-1 rounded font-mono">{localRadarrUrl || '(no LAN_IP)'}</code>
              <div className="mt-1">
                Each title will be added with the local arr&apos;s default
                quality profile + root folder. Existing titles are skipped.
                Search-after-add is OFF; trigger a search manually in the
                arr UI once monitoring looks right.
              </div>
            </div>
            <button
              onClick={importAll}
              disabled={importing || fetching || (!localKeys.sonarr && !localKeys.radarr)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md text-sm disabled:opacity-40 shrink-0"
            >
              {importing ? `Importing ${results.length}/${totalFetched}…` : `Import ${totalFetched} title${totalFetched === 1 ? '' : 's'}`}
            </button>
          </div>
        </section>
      )}

      {results.length > 0 && (
        <section className="rounded-md border border-slate-700 bg-slate-900/40 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Import results</h2>
            <span className="text-xs text-slate-400">
              <span className="text-emerald-300">✔ {counts_results.ok}</span>
              <span className="mx-2">·</span>
              <span className="text-slate-400">– {counts_results.exists}</span>
              <span className="mx-2">·</span>
              <span className="text-rose-300">✘ {counts_results.fail}</span>
            </span>
          </div>
          <ul className="text-xs font-mono space-y-0.5 max-h-64 overflow-y-auto">
            {results.map((r, i) => (
              <li key={i} className={
                r.status === 'ok' ? 'text-emerald-300'
                : r.status === 'exists' ? 'text-slate-400'
                : 'text-rose-300'
              }>
                {r.status === 'ok' ? '✔' : r.status === 'exists' ? '–' : '✘'} {r.title}
                {r.message && <span className="text-slate-500"> — {r.message}</span>}
              </li>
            ))}
          </ul>
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
            onChange={(e) => setSourceQbitUrl(e.target.value.trim().replace(/\/$/, ''))}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
          <label>Username</label>
          <input
            type="text"
            value={sourceQbitUser}
            onChange={(e) => setSourceQbitUser(e.target.value.trim())}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
          <label>Password</label>
          <input
            type="password"
            value={sourceQbitPass}
            onChange={(e) => setSourceQbitPass(e.target.value)}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchQbit}
            disabled={qbitFetching || qbitImporting}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 rounded-md text-sm disabled:opacity-40"
          >
            {qbitFetching ? 'Fetching…' : 'Fetch torrent list'}
          </button>
          {qbitFetchError && <span className="text-rose-300 text-sm">✘ {qbitFetchError}</span>}
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
                  onChange={(e) => setQbitRemapFrom(e.target.value.trim())}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-xs"
                />
                <label>Destination prefix</label>
                <input
                  type="text" placeholder="/data/Downloads/Torrents"
                  value={qbitRemapTo}
                  onChange={(e) => setQbitRemapTo(e.target.value.trim())}
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

            <div className="flex items-center gap-3 border-t border-slate-800 pt-3">
              <div className="text-xs text-slate-400 flex-1">
                Destination: {' '}
                <code className="bg-slate-800 px-1 rounded font-mono">
                  {lanIp ? `http://${lanIp}:49156` : '(no LAN_IP)'}
                </code>
                {' (creds from .env)'}
              </div>
              <button
                onClick={importQbit}
                disabled={qbitImporting || qbitFetching || !localKeys.qbitUser || !localKeys.qbitPass}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-md text-sm disabled:opacity-40 shrink-0"
              >
                {qbitImporting ? `Migrating ${qbitResults.length}/${qbitTorrents.length}…` : `Migrate ${qbitTorrents.length} torrent${qbitTorrents.length === 1 ? '' : 's'}`}
              </button>
            </div>
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
            <ul className="text-xs font-mono space-y-0.5 max-h-48 overflow-y-auto mt-1">
              {qbitResults.map((r, i) => (
                <li key={i} className={r.status === 'ok' ? 'text-emerald-300' : 'text-rose-300'}>
                  {r.status === 'ok' ? '✔' : '✘'} {r.title}
                  {r.message && <span className="text-slate-500"> — {r.message}</span>}
                </li>
              ))}
            </ul>
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

async function fetchArrList(baseUrl: string, apiKey: string, kind: ArrKind): Promise<SourceItem[]> {
  // Two GETs: the list (series/movie) and the quality profiles. We
  // denormalise profile name into each item up-front so the import
  // pass doesn't need another round-trip.
  const listPath = kind === 'sonarr' ? '/api/v3/series' : '/api/v3/movie'
  const [listRes, profilesRes] = await Promise.all([
    fetch(`${baseUrl}${listPath}`,                  { headers: { 'X-Api-Key': apiKey } }),
    fetch(`${baseUrl}/api/v3/qualityprofile`,       { headers: { 'X-Api-Key': apiKey } }),
  ])
  if (!listRes.ok) throw new Error(`${kind} list: HTTP ${listRes.status}`)
  if (!profilesRes.ok) throw new Error(`${kind} qualityprofile: HTTP ${profilesRes.status}`)

  const list     = (await listRes.json())     as any[]
  const profiles = (await profilesRes.json()) as { id: number; name: string }[]
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
  destUrl: string, apiKey: string, kind: ArrKind,
  items: SourceItem[],
  onResult: (r: ImportResult) => void,
) {
  // Build the dest-side context once: quality profile name→id map +
  // first root folder for default placement. Failures here abort the
  // whole batch since they'd cascade for every item.
  let destProfiles: { id: number; name: string }[]
  let rootFolders: { path: string }[]
  try {
    const [pRes, rRes] = await Promise.all([
      fetch(`${destUrl}/api/v3/qualityprofile`, { headers: { 'X-Api-Key': apiKey } }),
      fetch(`${destUrl}/api/v3/rootfolder`,     { headers: { 'X-Api-Key': apiKey } }),
    ])
    destProfiles = await pRes.json()
    rootFolders  = await rRes.json()
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

  // Fetch existing titles ONCE so we can skip duplicates without an
  // extra HTTP call per item.
  let existingIds: Set<number>
  try {
    const r = await fetch(`${destUrl}/api/v3/${kind === 'sonarr' ? 'series' : 'movie'}`, {
      headers: { 'X-Api-Key': apiKey },
    })
    const existing = (await r.json()) as any[]
    existingIds = new Set(existing.map((e) => kind === 'sonarr' ? e.tvdbId : e.tmdbId).filter(Boolean))
  } catch {
    existingIds = new Set()
  }

  for (const item of items) {
    const id = kind === 'sonarr' ? item.tvdbId : item.tmdbId
    if (!id) {
      onResult({ title: item.title, status: 'fail', message: 'missing tvdb/tmdb id' })
      continue
    }
    if (existingIds.has(id)) {
      onResult({ title: item.title, status: 'exists' })
      continue
    }
    const profileId = (item.qualityProfileName && profileByName.get(item.qualityProfileName))
                    ?? fallbackProfileId
    const body: any = {
      title:             item.title,
      qualityProfileId:  profileId,
      rootFolderPath:    defaultRoot,
      monitored:         item.monitored ?? true,
      addOptions: kind === 'sonarr'
        ? { searchForMissingEpisodes: false, ignoreEpisodesWithFiles: true, ignoreEpisodesWithoutFiles: false }
        : { searchForMovie: false },
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
