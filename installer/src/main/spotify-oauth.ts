// ── Spotify OAuth (host-side) ────────────────────────────────────────────────
// Runs Spotify's Authorization Code flow entirely in the main process so the
// wizard can (1) list the user's playlists for a checkbox picker and (2) capture
// a refresh token, which the downloader later uses (sockseek --spotify-refresh)
// to read PRIVATE playlists non-interactively at sync time.
//
// It reuses the user's own free Spotify Developer app (client id + secret) and
// the loopback redirect URI http://127.0.0.1:48721/callback — the SAME URI
// sockseek documents, so the user only ever registers one. A short-lived local
// HTTP server captures the redirect; nothing listens beyond the sign-in.

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { shell } from 'electron'
import type { SpotifyConnectResult, SpotifyPlaylist } from '../shared/ipc.js'

const REDIRECT_PORT = 48721
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`
// Read-only playlist scopes — enough to list + read private/collaborative
// playlists, nothing more.
const SCOPE = 'playlist-read-private playlist-read-collaborative'
const AUTH_TIMEOUT_MS = 180_000 // user has 3 minutes to finish the browser login
const HTTP_TIMEOUT_MS = 15_000

interface ConnectArgs {
  clientId: string
  clientSecret: string
}

// Serializes overlapping sign-ins. The first attempt holds the loopback
// listener (REDIRECT_PORT) for up to AUTH_TIMEOUT_MS while the user finishes
// the browser consent. A second attempt (double-clicked Connect, a retry, or a
// separate window — there's no single-instance lock) would otherwise race the
// first onto the same port and surface a misleading EADDRINUSE. Reject the
// second one up front with an accurate message instead.
let inFlight = false

export async function spotifyConnect(args: ConnectArgs): Promise<SpotifyConnectResult> {
  const clientId = (args?.clientId || '').trim()
  const clientSecret = (args?.clientSecret || '').trim()
  if (!clientId || !clientSecret) {
    throw new Error('Enter your Spotify Client ID and Secret first, then click Connect.')
  }

  if (inFlight) {
    throw new Error('A Spotify sign-in is already in progress — finish (or cancel) the open browser tab, then try again.')
  }

  const state = randomBytes(16).toString('hex')
  inFlight = true
  try {
    const code = await awaitAuthCode(clientId, state)
    const tokens = await exchangeCode(code, clientId, clientSecret)
    const playlists = await fetchAllPlaylists(tokens.access_token)
    return { playlists, refreshToken: tokens.refresh_token }
  } finally {
    inFlight = false
  }
}

/** Start the loopback listener, open the browser to Spotify's consent page, and
 *  resolve with the returned auth code (or reject with a friendly error). */
function awaitAuthCode(clientId: string, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { server.close() } catch { /* already closing */ }
      fn()
    }

    const server = createServer((req, res) => {
      let parsed: URL
      try {
        parsed = new URL(req.url || '', REDIRECT_URI)
      } catch {
        res.statusCode = 400
        res.end('Bad request')
        return
      }
      if (parsed.pathname !== '/callback') {
        res.statusCode = 404
        res.end('Not found')
        return
      }
      const err = parsed.searchParams.get('error')
      const code = parsed.searchParams.get('code')
      const gotState = parsed.searchParams.get('state')
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (err || !code) {
        res.end(closePage('Spotify sign-in was cancelled or failed. You can close this tab and try Connect again.'))
        finish(() => reject(new Error(
          err === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed${err ? ': ' + err : ''}.`)))
        return
      }
      if (gotState !== state) {
        res.end(closePage('Security check failed (state mismatch). Close this tab and try Connect again.'))
        finish(() => reject(new Error('Spotify sign-in failed a security check (state mismatch).')))
        return
      }
      res.end(closePage('Connected! You can close this tab and return to the Mediarr Installer.'))
      finish(() => resolve(code))
    })

    const timer = setTimeout(
      () => finish(() => reject(new Error('Timed out waiting for Spotify sign-in. Click Connect to try again.'))),
      AUTH_TIMEOUT_MS,
    )

    server.on('error', (e: NodeJS.ErrnoException) => {
      finish(() => reject(new Error(
        e.code === 'EADDRINUSE'
          ? `Port ${REDIRECT_PORT} is already in use — a Spotify sign-in may already be in progress (finish or close that browser tab), or close whatever else is using it, then click Connect again.`
          : `Could not start the local sign-in listener: ${e.message}`)))
    })

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state,
      }).toString()
      shell.openExternal(authUrl).catch((e: unknown) =>
        finish(() => reject(new Error('Could not open the browser for Spotify sign-in: ' + (e as Error).message))))
    })
  })
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

async function exchangeCode(code: string, clientId: string, clientSecret: string): Promise<TokenResponse> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = await safeErr(res)
    throw new Error(
      `Spotify token exchange failed (${res.status})${detail}. Check the Client ID/Secret, and that ` +
      `${REDIRECT_URI} is listed as a Redirect URI in your Spotify app settings.`)
  }
  const json = (await res.json()) as TokenResponse
  if (!json.access_token || !json.refresh_token) {
    throw new Error('Spotify did not return the expected tokens — try Connect again.')
  }
  return json
}

interface SpotifyApiPlaylist {
  name: string
  public: boolean | null
  external_urls: { spotify?: string }
  owner: { display_name?: string; id?: string }
  tracks: { total: number }
}

/** Page through /v1/me/playlists and flatten to our slim shape. */
async function fetchAllPlaylists(accessToken: string): Promise<SpotifyPlaylist[]> {
  const out: SpotifyPlaylist[] = []
  let url: string | null = 'https://api.spotify.com/v1/me/playlists?limit=50'
  // Hard page cap so a malformed `next` can never loop forever (50 * 40 = 2000).
  for (let page = 0; url && page < 40; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!res.ok) {
      const detail = await safeErr(res)
      throw new Error(`Could not read your Spotify playlists (${res.status})${detail}.`)
    }
    const json = (await res.json()) as { items: SpotifyApiPlaylist[]; next: string | null }
    for (const p of json.items || []) {
      const purl = p?.external_urls?.spotify
      if (!purl) continue
      out.push({
        name: p.name || 'Untitled playlist',
        url: purl,
        isPublic: p.public === true,
        owner: p.owner?.display_name || p.owner?.id || '',
        trackCount: p.tracks?.total ?? 0,
      })
    }
    url = json.next
  }
  return out
}

/** Best-effort extraction of a human message from a Spotify error body. */
async function safeErr(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string } | string; error_description?: string }
    const msg =
      typeof j.error === 'object' ? j.error?.message
        : j.error_description || (typeof j.error === 'string' ? j.error : '')
    return msg ? ` — ${msg}` : ''
  } catch {
    return ''
  }
}

function closePage(message: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Mediarr · Spotify</title>' +
    '<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
    '.card{max-width:30rem;text-align:center;padding:2rem;border:1px solid #1e293b;border-radius:.75rem;' +
    'background:rgba(30,41,59,.4)}h1{font-size:1.1rem;margin:0 0 .5rem}p{color:#94a3b8;margin:0;line-height:1.5}</style>' +
    '</head><body><div class="card"><h1>Mediarr Installer</h1><p>' + message + '</p></div></body></html>'
  )
}
