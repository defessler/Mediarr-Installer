// ── qBittorrent migration ────────────────────────────────────────────────────
//
// HTTP client for migrating torrents from one qBittorrent instance to
// another. Runs in the MAIN process (not renderer) because:
//
//   1. CORS — qBittorrent's WebUI doesn't send Access-Control-Allow-*
//      headers, so cross-origin fetch() from the renderer would block
//      with credentials. Node's net stack ignores CORS.
//   2. Cookie management — qBit uses a session cookie (SID) returned
//      from POST /api/v2/auth/login. Browsers limit Set-Cookie reads
//      from non-same-origin; Node sees the header raw.
//   3. Binary .torrent export — we GET /api/v2/torrents/export which
//      returns the binary .torrent file. Easier to forward through
//      memory in main than to plumb arraybuffers through IPC.
//
// API contract is small enough that we use plain fetch + manual cookie
// handling rather than pulling in a cookie-jar dependency. Three calls
// per torrent: login source, export, login dest + add.

import type {
  QbitFetchListRequest, QbitFetchListResult,
  QbitMigrateOneRequest, QbitMigrateOneResult,
  QbitTorrent,
} from '../shared/ipc.js'

/** Normalize a user-typed qBit WebUI URL so concatenating `/api/v2/...`
 *  always produces a clean request line. Same class of issue as the arr
 *  migration: `http://nas:49156/` + `/api/v2/torrents/info` becomes
 *  `//api/v2/torrents/info`, which qBit serves the WebUI index.html
 *  for — and `res.json()` then explodes with "Unexpected token '<',
 *  '<!doctype'...". Strip trailing slashes and prepend http:// when
 *  the user dropped the scheme. */
function normalizeQbitUrl(raw: string): string {
  let url = raw.trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  return url.replace(/\/+$/, '')
}

/** Result of a qBit login attempt. On success we return the SID
 *  cookie (or the `noauth` sentinel when qBit didn't issue one); on
 *  failure we report a specific reason so the user sees exactly what's
 *  wrong instead of a generic "login failed". */
type QbitLoginResult =
  | { ok: true; sid: string | 'noauth' }
  | { ok: false; reason: 'network' | 'http' | 'banned' | 'fails' | 'unexpected'; message: string }

/** Try POST /api/v2/auth/login with the given creds. Returns either
 *  the SID cookie value (or the `noauth` sentinel when qBit accepted
 *  us without issuing one — the LAN auth-bypass case) or a structured
 *  reason. Network errors, 4xx/5xx responses, body=="Fails." (wrong
 *  password), and unexpected text (HTML / qBit version mismatch) are
 *  each surfaced distinctly so the renderer can hint at the fix.
 *
 *  When username is empty we treat that as "no auth required" — qBit
 *  exposes the API to unauthenticated callers if WebUI auth is fully
 *  off, in which case subsequent API calls succeed without SID. */
async function qbitLogin(url: string, username: string, password: string): Promise<QbitLoginResult> {
  if (!username) return { ok: true, sid: 'noauth' }
  const body = new URLSearchParams({ username, password }).toString()
  let res: Response
  try {
    res = await fetch(`${url}/api/v2/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Referer':       url,    // qBit's CSRF guard checks Referer
        'User-Agent':    'mediarr-installer/1.0',
      },
      body,
    })
  } catch (e) {
    return {
      ok: false, reason: 'network',
      message: `Could not reach ${url} — ${(e as Error).message}`,
    }
  }
  // qBit's API banned-IP response: 403 after too many login failures.
  if (res.status === 403) {
    return {
      ok: false, reason: 'banned',
      message: `${url} returned 403 — qBit blocked the source IP after repeated bad logins. Restart the qBit container or wait it out.`,
    }
  }
  if (!res.ok) {
    return {
      ok: false, reason: 'http',
      message: `${url} returned HTTP ${res.status} on login — wrong WebUI path? Try removing any trailing slash, and confirm qBit's WebUI is reachable in a browser.`,
    }
  }
  // Check for a SID cookie BEFORE the body string match. qBit's standard
  // success path is body=="Ok." + Set-Cookie: SID=...; HttpOnly; path=/.
  // If we have a SID it doesn't matter what the body says — the
  // session's authenticated and the rest of the API will work. Some
  // qBit forks / proxies tweak the body but still issue the cookie.
  // Node's fetch exposes Set-Cookie via response.headers.get('set-cookie')
  // (combined value when multiple). Parse the SID=value out.
  const setCookie = res.headers.get('set-cookie') || ''
  const sidMatch = setCookie.match(/SID=([^;]+)/)
  const text = (await res.text()).trim()
  // "Fails." → wrong credentials. qBit returns this even when LAN
  // subnet whitelisting is enabled IF the user passed creds and they
  // didn't match. If we already have a SID cookie we trust that over
  // the body (some proxies inject "Fails." in error responses too).
  if (!sidMatch && text === 'Fails.') {
    return {
      ok: false, reason: 'fails',
      message: `${url} rejected the credentials (qBit replied "Fails."). Check the destination qBittorrent WebUI username + password — the ones set in your .env may not match qBit's current config.`,
    }
  }
  if (sidMatch) return { ok: true, sid: sidMatch[1] }
  // No SID cookie. qBit treats us as already-authenticated via the
  // AuthSubnetWhitelist (setup-folders.sh sets it to 192.168.0.0/16,
  // 10.0.0.0/8, 172.16.0.0/12 so any LAN request bypasses auth). The
  // observed response shapes in this case vary by qBit version:
  //   - body == "Ok."          (documented, older versions)
  //   - body empty + 200 OK    (newer 4.5+ when subnet matches BEFORE
  //                             the login handler runs — no body
  //                             written because no login was processed)
  // Both mean "go ahead, no session needed." Treat them identically.
  // Without this fallthrough, every migration from a LAN box to the
  // freshly-installed dest qBit failed at the login-dest stage with
  // all 160 torrents reporting "returned an unexpected response:".
  if (text === 'Ok.' || text === '') return { ok: true, sid: 'noauth' }
  // Anything else — HTML index page, JSON error from a proxy, version
  // mismatch — means the URL or path is wrong.
  return {
    ok: false, reason: 'unexpected',
    message: /^\s*</.test(text)
      ? `${url} returned HTML on /api/v2/auth/login — likely wrong URL / port (qBit served its WebUI fallback page).`
      : `${url} returned an unexpected response: ${text.slice(0, 120)}`,
  }
}

/** Build the Cookie header for authenticated qBit requests. Empty
 *  when sid is 'noauth' (qBit is wide open). */
function cookieHeader(sid: string | 'noauth'): string {
  return sid === 'noauth' ? '' : `SID=${sid}`
}

export async function qbitFetchList(req: QbitFetchListRequest): Promise<QbitFetchListResult> {
  if (!req.url) return { ok: false, error: 'missing source URL' }
  const url = normalizeQbitUrl(req.url)
  const login = await qbitLogin(url, req.username, req.password)
  if (!login.ok) {
    return { ok: false, error: login.message }
  }
  const sid = login.sid
  try {
    const res = await fetch(`${url}/api/v2/torrents/info`, {
      headers: {
        'Cookie':     cookieHeader(sid),
        'Referer':    url,
        'User-Agent': 'mediarr-installer/1.0',
      },
    })
    if (!res.ok) {
      return { ok: false, error: `torrents/info HTTP ${res.status}` }
    }
    // Guard against the WebUI-fallback case: when the URL or path is
    // wrong, qBit serves the WebUI's index.html with text/html, and a
    // raw .json() would throw "Unexpected token '<', '<!doctype'..."
    // Catch it here with a user-actionable message instead.
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!ct.includes('json')) {
      const peek = await res.text().catch(() => '')
      return {
        ok: false,
        error: /^\s*</.test(peek)
          ? `${url} returned HTML instead of JSON — typically a trailing slash on the URL or wrong WebUI path. Try removing the trailing /.`
          : `${url} returned ${ct || 'unknown content-type'} instead of JSON: ${peek.slice(0, 120)}`,
      }
    }
    const raw = (await res.json()) as Record<string, unknown>[]
    // Project down to QbitTorrent — qBit returns ~30 fields per torrent
    // and most are noise (download speed, ETA, peers, etc.) for the
    // migration case. We keep just enough to render the preview list +
    // re-add on the destination.
    const torrents: QbitTorrent[] = raw.map((t) => ({
      hash:       String(t.hash ?? ''),
      name:       String(t.name ?? ''),
      save_path:  String(t.save_path ?? ''),
      category:   String(t.category ?? ''),
      tags:       String(t.tags ?? ''),
      state:      String(t.state ?? ''),
      completed:  Number(t.completed ?? 0),
      size:       Number(t.size ?? 0),
    }))
    return { ok: true, torrents }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function qbitMigrateOne(req: QbitMigrateOneRequest): Promise<QbitMigrateOneResult> {
  const sourceUrl = normalizeQbitUrl(req.sourceUrl)
  const destUrl   = normalizeQbitUrl(req.destUrl)
  // Stage 1: login to source qBit.
  const srcLogin = await qbitLogin(sourceUrl, req.sourceUsername, req.sourcePassword)
  if (!srcLogin.ok) {
    return { ok: false, stage: 'login-source', error: srcLogin.message }
  }
  const srcSid = srcLogin.sid

  // Stage 2: export the .torrent file from source. qBit returns the
  // raw .torrent file bytes — pass them along to dest's /add as a
  // file part in multipart/form-data.
  let torrentBytes: Buffer
  try {
    const res = await fetch(`${sourceUrl}/api/v2/torrents/export?hash=${encodeURIComponent(req.sourceHash)}`, {
      headers: {
        'Cookie':     cookieHeader(srcSid),
        'Referer':    sourceUrl,
        'User-Agent': 'mediarr-installer/1.0',
      },
    })
    if (!res.ok) {
      return { ok: false, stage: 'export', error: `export HTTP ${res.status}` }
    }
    const ab = await res.arrayBuffer()
    torrentBytes = Buffer.from(ab)
    if (torrentBytes.length === 0) {
      return { ok: false, stage: 'export', error: 'export returned empty body' }
    }
  } catch (e) {
    return { ok: false, stage: 'export', error: (e as Error).message }
  }

  // Stage 3: login to dest qBit.
  const dstLogin = await qbitLogin(destUrl, req.destUsername, req.destPassword)
  if (!dstLogin.ok) {
    return { ok: false, stage: 'login-dest', error: dstLogin.message }
  }
  const dstSid = dstLogin.sid

  // Stage 4: POST /api/v2/torrents/add with the .torrent file + the
  // mapped save_path. skipChecking=true tells qBit to assume the
  // files already exist at savepath and start seeding without re-
  // hashing the whole library (which would take hours for a big
  // archive AND defeat hardlink preservation if the hashes shift the
  // file's location).
  try {
    const form = buildMultipart({
      torrents:      { filename: 'imported.torrent', contentType: 'application/x-bittorrent', data: torrentBytes },
      savepath:      req.destSavePath,
      category:      req.destCategory,
      tags:          req.destTags,
      paused:        req.paused ? 'true' : 'false',
      skip_checking: 'true',
      // autoTMM=false: respect our explicit savepath instead of
      // letting qBit's "Automatic Torrent Management" override it
      // based on category rules.
      autoTMM:       'false',
    })
    const res = await fetch(`${destUrl}/api/v2/torrents/add`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${form.boundary}`,
        'Cookie':       cookieHeader(dstSid),
        'Referer':      destUrl,
        'User-Agent':   'mediarr-installer/1.0',
      },
      body: form.body,
    })
    if (!res.ok) {
      const body = await res.text()
      return { ok: false, stage: 'add', error: `add HTTP ${res.status}: ${body.slice(0, 200)}` }
    }
    // qBit's /torrents/add response shape varies by version:
    //   - qBit 4.x: plain text "Ok." on success, "Fails." on rejection,
    //     and some intermediate builds return empty body on success.
    //   - qBit 5.x: structured JSON object describing the add — e.g.
    //     {"added_torrent_ids":["<hash>"],"failure_count":0,
    //      "pending_count":0,"success_count":1}
    //     With success_count > 0 (or a non-empty added_torrent_ids
    //     array) the add worked. failure_count > 0 means the torrent
    //     was rejected (duplicate hash, malformed .torrent, etc).
    // The old code only accepted "Ok." / empty and treated everything
    // else as failure, so the entire JSON success response was being
    // reported as a per-torrent failure even though the torrents were
    // actually added (`success_count":1`). Handle both shapes here.
    const text = (await res.text()).trim()
    if (text === '' || text === 'Ok.') return { ok: true }
    if (text === 'Fails.') {
      return { ok: false, stage: 'add', error: 'qBit replied "Fails." — torrent rejected (duplicate hash? malformed .torrent?)' }
    }
    // Try JSON parse for qBit 5.x's structured response.
    try {
      const j = JSON.parse(text) as {
        added_torrent_ids?: string[]
        failure_count?: number
        success_count?: number
        pending_count?: number
      }
      if (Array.isArray(j.added_torrent_ids) && j.added_torrent_ids.length > 0) {
        return { ok: true }
      }
      if (typeof j.success_count === 'number' && j.success_count > 0) {
        return { ok: true }
      }
      if (typeof j.failure_count === 'number' && j.failure_count > 0) {
        return { ok: false, stage: 'add', error: `qBit rejected torrent — failure_count=${j.failure_count}` }
      }
      // pending_count > 0 with no success/failure: qBit's still
      // hashing (shouldn't happen with skip_checking=true, but treat
      // as success since the torrent IS in qBit's state).
      if (typeof j.pending_count === 'number' && j.pending_count > 0) {
        return { ok: true }
      }
      // JSON parsed but didn't match any known success/failure signal.
      // Surface the body so the user can see what qBit reported.
      return { ok: false, stage: 'add', error: `add returned unrecognised JSON: ${text.slice(0, 200)}` }
    } catch {
      // Not JSON either — surface the raw text.
      return { ok: false, stage: 'add', error: `add returned: ${text.slice(0, 200)}` }
    }
  } catch (e) {
    return { ok: false, stage: 'add', error: (e as Error).message }
  }
}

// ── Multipart builder ───────────────────────────────────────────────────────
//
// fetch() in Node 18+ can take FormData natively, but FormData's File
// type is browser-only and Node's polyfill is finicky for binary data.
// Building multipart manually is ~25 lines and dependency-free.

interface FilePart {
  filename: string
  contentType: string
  data: Buffer
}

function buildMultipart(fields: Record<string, string | FilePart>): { body: Buffer; boundary: string } {
  // Random boundary that almost certainly won't appear in any binary
  // payload. 16 hex chars after the recommended `--`-prefixed string.
  const boundary = '----mediarr' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  const chunks: Buffer[] = []
  const enc = (s: string) => Buffer.from(s, 'utf8')

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(enc(`--${boundary}\r\n`))
    if (typeof value === 'string') {
      chunks.push(enc(`Content-Disposition: form-data; name="${name}"\r\n\r\n`))
      chunks.push(enc(value))
      chunks.push(enc('\r\n'))
    } else {
      chunks.push(enc(
        `Content-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\n` +
        `Content-Type: ${value.contentType}\r\n\r\n`,
      ))
      chunks.push(value.data)
      chunks.push(enc('\r\n'))
    }
  }
  chunks.push(enc(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), boundary }
}
