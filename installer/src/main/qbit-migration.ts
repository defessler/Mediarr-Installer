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

/** Try POST /api/v2/auth/login with the given creds; on success return
 *  the SID cookie value. qBit returns "Ok." / "Fails." as the response
 *  body; non-Ok or any network/HTTP error returns null.
 *
 *  When username is empty we treat that as "no auth required" — qBit
 *  exposes the API to unauthenticated callers if WebUI auth is fully
 *  off, in which case subsequent API calls succeed without SID. */
async function qbitLogin(url: string, username: string, password: string): Promise<string | null | 'noauth'> {
  if (!username) return 'noauth'
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
  } catch {
    return null
  }
  if (!res.ok) return null
  const text = await res.text()
  if (text.trim() !== 'Ok.') return null
  // qBit returns Set-Cookie: SID=...; HttpOnly; path=/
  // Node's fetch exposes Set-Cookie via response.headers.get('set-cookie')
  // (combined value when multiple). Parse the SID=value out.
  const setCookie = res.headers.get('set-cookie') || ''
  const m = setCookie.match(/SID=([^;]+)/)
  return m ? m[1] : null
}

/** Build the Cookie header for authenticated qBit requests. Empty
 *  when sid is 'noauth' (qBit is wide open). */
function cookieHeader(sid: string | 'noauth'): string {
  return sid === 'noauth' ? '' : `SID=${sid}`
}

export async function qbitFetchList(req: QbitFetchListRequest): Promise<QbitFetchListResult> {
  if (!req.url) return { ok: false, error: 'missing source URL' }
  const sid = await qbitLogin(req.url, req.username, req.password)
  if (sid === null) {
    return { ok: false, error: 'qBittorrent login failed — check URL, username, password' }
  }
  try {
    const res = await fetch(`${req.url}/api/v2/torrents/info`, {
      headers: {
        'Cookie':     cookieHeader(sid),
        'Referer':    req.url,
        'User-Agent': 'mediarr-installer/1.0',
      },
    })
    if (!res.ok) {
      return { ok: false, error: `torrents/info HTTP ${res.status}` }
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
  // Stage 1: login to source qBit.
  const srcSid = await qbitLogin(req.sourceUrl, req.sourceUsername, req.sourcePassword)
  if (srcSid === null) {
    return { ok: false, stage: 'login-source', error: 'Source qBit login failed' }
  }

  // Stage 2: export the .torrent file from source. qBit returns the
  // raw .torrent file bytes — pass them along to dest's /add as a
  // file part in multipart/form-data.
  let torrentBytes: Buffer
  try {
    const res = await fetch(`${req.sourceUrl}/api/v2/torrents/export?hash=${encodeURIComponent(req.sourceHash)}`, {
      headers: {
        'Cookie':     cookieHeader(srcSid),
        'Referer':    req.sourceUrl,
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
  const dstSid = await qbitLogin(req.destUrl, req.destUsername, req.destPassword)
  if (dstSid === null) {
    return { ok: false, stage: 'login-dest', error: 'Destination qBit login failed' }
  }

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
    const res = await fetch(`${req.destUrl}/api/v2/torrents/add`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${form.boundary}`,
        'Cookie':       cookieHeader(dstSid),
        'Referer':      req.destUrl,
        'User-Agent':   'mediarr-installer/1.0',
      },
      body: form.body,
    })
    if (!res.ok) {
      const body = await res.text()
      return { ok: false, stage: 'add', error: `add HTTP ${res.status}: ${body.slice(0, 200)}` }
    }
    // qBit returns "Ok." on success; some versions return empty body.
    const text = await res.text()
    if (text && text.trim() !== 'Ok.') {
      return { ok: false, stage: 'add', error: `add returned: ${text.slice(0, 200)}` }
    }
    return { ok: true }
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
