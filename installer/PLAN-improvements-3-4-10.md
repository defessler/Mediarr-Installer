# Improvement Plan — items #3, #4, #10

(#1 Pre-flight ACL check shipped in `44dc77a`.)

## Theme

Three big-feature changes, scoped around *making the install easier and more
flexible without breaking the unpacked-build constraint we set earlier*.
Detailed research findings inline below each item.

---

## #3 — Easier app updates

### What's there today

`main/index.ts` has a fire-and-forget `checkForUpdate()` that pings
`api.github.com/repos/defessler/Mediarr-Installer/releases/latest`,
compares tag → `app.getVersion()`, and surfaces a tiny emerald
`↑ v0.x available` pill in the footer that opens the release page when
clicked. Notification-only, works for the unpacked build.

### Constraint

`electron-builder.yml` ships `target: dir` (Windows), dmg (macOS),
AppImage (Linux). **`electron-updater` does not work with `target: dir`** —
it needs NSIS / dmg / AppImage installers to swap binaries safely. The
user explicitly removed NSIS earlier ("I dont want it to be an installer").

### Plan — bigger UX, same constraint

We'll keep the unpacked target AND make the existing notification *much
more useful*, without adding electron-updater.

1. **`WhatsNew` banner on the Welcome screen** when an update is
   available. Renders:
   - "v0.2 is out · current v0.1.0" with a tag dot
   - Collapsed-by-default "Release notes" section, lazy-fetched
     from `body` of the GitHub release JSON (Markdown rendered with
     a tiny safe renderer — no inline HTML, no scripts)
   - Three buttons:
     - **Download zip** — fetches the win-unpacked zip directly from
       the release to the user's `Downloads` folder, then opens
       Explorer pointing at the file. (One click instead of: open
       browser, find zip, click download, find file.)
     - **Open release page** — current behaviour, kept as fallback
     - **Skip this version** — sets `skippedVersion` in the wizard
       store so the banner stays dismissed until the *next* release

2. **Footer pill stays** — but turns into a clickable button that
   opens the same WhatsNew banner if the user navigated away from
   Welcome.

3. **CI artifact requirement** — the existing
   `.github/workflows/installer-release.yml` already builds the
   unpacked dir + uploads it as a CI artifact, but uploading to the
   public release page is what the "Download zip" button needs. We'll
   verify that path is wired (the workflow currently has
   `softprops/action-gh-release@v2` pointing at `release-files/*`
   which picks up `*.exe / *.dmg / *.AppImage`; we'll add a `zip` of
   `win-unpacked` to that glob).

### Files to touch

- `installer/src/renderer/components/WhatsNew.tsx` — new component
- `installer/src/renderer/screens/WelcomeScreen.tsx` — render banner
  above profile picker when `info.updateAvailable && !skipped`
- `installer/src/renderer/store/wizard.ts` — add
  `skippedUpdateVersion: string | null`, persisted (not encrypted)
- `installer/src/main/index.ts` — extend `checkForUpdate()` to also
  capture the release `body` and a download URL for the
  `win-unpacked.zip` asset (find by `name.includes('win-unpacked')`)
- `installer/src/shared/ipc.ts` — extend `AppInfo.updateAvailable`
  with `notes: string; downloadUrl: string | null`
- `installer/src/main/ipc-handlers.ts` — new `app:downloadUpdate`
  channel that downloads the zip to `Downloads/` and reveals it
- `installer/src/preload/index.ts` — expose
  `app.downloadUpdate()` and `app.skipUpdateVersion(v)`
- `.github/workflows/installer-release.yml` — zip `win-unpacked` and
  attach to the release alongside the existing artifacts

### Out of scope

Real auto-apply (download → swap files → relaunch). That needs a
sidecar updater process and either a portable build or NSIS. Filed
for later.

---

## #4 — Profile export / import

### What's there today

`profile-store.ts` keeps a v2 schema at `userData/profiles.json` —
plaintext `id` / `label` / `lastUsedAt` / `summary` plus an `encrypted`
base64 blob produced by Electron's `safeStorage.encryptString()`. The
blob is the JSON of `{ connection, targetDir, config }` and is
encrypted with an OS-level key (DPAPI / Keychain / libsecret). This
is *machine-bound* — you cannot decrypt the blob on a different
machine even with the same OS user. There's no `crypto` dep in
`package.json` but Node's `node:crypto` is available in main.

### Plan — passphrase-protected portable export

1. **Export flow** (button on each WelcomeScreen profile card,
   alongside `Edit / Install / Update / ✕`):
   - Click "Export" → modal
   - Modal: "Set an export passphrase" (with strength meter via a
     tiny entropy estimator — zxcvbn is overkill; use char-class +
     length heuristic) + a "What's included?" expander listing
     exactly what fields go into the file
   - On confirm:
     - PBKDF2-SHA256, 100k iters, 16-byte salt → 32-byte key
     - AES-256-GCM with 12-byte IV → ciphertext + 16-byte tag
     - Write a JSON envelope: `{ format: "mediarr-profile/v1",
       label, exportedAt, kdf: { name, iters, salt }, cipher: {
       name, iv, tag, ct } }`
   - Native save dialog (existing `dialog:save-text` channel can be
     extended to handle binary-safe base64), default filename
     `<label>.mediarr-profile.json`

2. **Import flow** (button at the bottom of the profile list, next
   to "+ New profile"):
   - Native open dialog filtered to `.mediarr-profile.json`
   - Read + validate envelope format
   - Modal: "Enter the passphrase used at export"
     - Show source label + exportedAt timestamp
     - On wrong passphrase: AES-GCM tag verify fails → "passphrase
       didn't match"
   - On success: pass through `profileSave` as a brand-new profile
     (new UUID, lastUsedAt = now). Label gets `(imported)` suffix
     if a profile with the same label already exists.

3. **Carries**: connection (incl. password / passphrase /
   sudoPassword), targetDir, full config (incl. PLEX_CLAIM,
   ARR_USERNAME, ARR_PASSWORD, NORDVPN_PRIVATE_KEY, QBITTORRENT_USER,
   QBITTORRENT_PASS, every indexer API key the user pasted).
4. **Strips**: id (machine-local), `plexClaimSetAt` (Plex tokens
   expire in 4 minutes — meaningless to import). New on the import
   side, the user gets a fresh claim widget.

### Files to touch

- `installer/src/main/profile-crypto.ts` — **new**: pure node:crypto
  PBKDF2 + AES-GCM helpers. ~60 lines.
- `installer/src/main/profile-store.ts` — add `exportProfile(id,
  passphrase)` and `importProfile(envelope, passphrase)`
- `installer/src/shared/ipc.ts` — new channels:
  `profile:export` → returns the envelope as a string,
  `profile:import` → takes `{ envelopeJson, passphrase }`, returns
  the new `SavedProfile`
- `installer/src/preload/index.ts` — expose both
- `installer/src/main/ipc-handlers.ts` — wire the handlers; reuse
  `dialog-service.ts` for native save/open file pickers
- `installer/src/renderer/components/ExportProfileDialog.tsx` — new
- `installer/src/renderer/components/ImportProfileDialog.tsx` — new
- `installer/src/renderer/screens/WelcomeScreen.tsx` — add Export
  button per card, Import button beside "+ New profile"

### Out of scope

QR-code / sharing-via-URL flows. Cloud sync. Bulk import.

---

## #10 — Multi-provider VPN

### What's there today

Gluetun runs every VPN inside the same container but with
provider-specific env vars. Today the wizard hardcodes NordVPN
everywhere:

- `docker-compose.yml` line 211: `WIREGUARD_PRIVATE_KEY=${NORDVPN_PRIVATE_KEY}` — maps the NordVPN-named var into Gluetun's generic WireGuard slot
- `vpn-service.ts` `fetchVpnKey()` calls `api.nordvpn.com` directly
- `ConfigureScreen.tsx` shows a "NordVPN access token" field + a
  "Fetch key" button
- `setup-nordvpn.sh` shell-fallback calls the same API
- `env-render.ts` + `env-schema.ts` validate `NORDVPN_PRIVATE_KEY` as required

Gluetun itself supports ProtonVPN, Mullvad, AirVPN, Surfshark,
PIA, IVPN, Windscribe, ExpressVPN, and ~20 others; each uses a
different combination of `OPENVPN_USER` / `OPENVPN_PASSWORD` /
`WIREGUARD_PRIVATE_KEY` / `WIREGUARD_ADDRESSES` / `WIREGUARD_PRESHARED_KEY` /
provider-specific account IDs.

### Plan — provider registry + dynamic Configure UI

1. **New shared `vpn-providers.ts`** declares each supported provider
   as a config object the wizard, env-renderer, and validator can all
   read. Example shape:

   ```ts
   export interface VpnProvider {
     id: 'nordvpn' | 'protonvpn' | 'mullvad' | 'airvpn' | 'surfshark' | 'custom'
     label: string                             // "NordVPN"
     helpUrl: string                           // where to find the key
     vpnType: 'wireguard' | 'openvpn'          // most are wireguard now
     fields: VpnField[]                        // dynamic Configure form
     toGluetunEnv(values: Record<string, string>): Record<string, string>
     fetchKey?: (token: string) => Promise<VpnFetchResult>
   }
   export interface VpnField {
     envKey: string         // e.g. 'WIREGUARD_PRIVATE_KEY' or 'OPENVPN_USER'
     label: string          // "WireGuard private key"
     type: 'text' | 'password' | 'textarea'
     helpHint?: string      // "Get it from app.protonvpn.com → ..."
     validate?: (v: string) => string | null
   }
   ```

   First-tier providers shipped:
   - **NordVPN** — keeps the existing fetch-via-API flow
   - **ProtonVPN** — WireGuard private key + addresses (paste from
     Proton's "WireGuard Configuration" dashboard)
   - **Mullvad** — Account number + WireGuard private key
   - **AirVPN** — WireGuard private key + addresses
   - **Surfshark** — OpenVPN username + password
   - **Custom** — escape hatch: paste a raw `gluetun.env` block; the
     wizard just renders it verbatim into .env

2. **Configure screen rewrite of the VPN section** (lines 272–348 of
   `ConfigureScreen.tsx`):
   - Provider radio/dropdown (visual: row of provider logos / labels,
     keyboard-pickable)
   - Render the picked provider's `fields[]` dynamically with the
     existing `<Field>` component
   - "Fetch key" button only renders when
     `provider.fetchKey !== undefined` (today: NordVPN only)
   - Inline help link: "Where do I find this?" → opens
     `provider.helpUrl` externally
   - When the user switches provider, **clear** the previous
     provider's secret fields from `config` to avoid stale Mullvad
     keys leaking into a NordVPN profile

3. **`env-render.ts`** — replace the hardcoded NordVPN block with
   `currentProvider.toGluetunEnv(values)`, which emits exactly the
   env vars Gluetun expects (e.g. for Mullvad:
   `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES`,
   `OPENVPN_USER=<account_number>`).

4. **`docker-compose.yml`** — generalize. Replace the line:
   ```
   - WIREGUARD_PRIVATE_KEY=${NORDVPN_PRIVATE_KEY}
   ```
   with a set of conditional env vars sourced from `.env`. Gluetun
   ignores env vars that don't apply to the selected provider, so
   we can simply list all of them:
   ```
   - WIREGUARD_PRIVATE_KEY=${WIREGUARD_PRIVATE_KEY:-}
   - WIREGUARD_ADDRESSES=${WIREGUARD_ADDRESSES:-}
   - WIREGUARD_PRESHARED_KEY=${WIREGUARD_PRESHARED_KEY:-}
   - OPENVPN_USER=${OPENVPN_USER:-}
   - OPENVPN_PASSWORD=${OPENVPN_PASSWORD:-}
   ```
   `VPN_SERVICE_PROVIDER=${VPN_PROVIDER}` and
   `VPN_TYPE=${VPN_TYPE}` stay as-is.

5. **`setup-nordvpn.sh`** — rename to `setup-vpn-key.sh`, detect
   provider from .env, only call the NordVPN API path when
   `VPN_PROVIDER=nordvpn`. For other providers, skip cleanly with a
   "key was provided in .env; nothing to do" log line. Update step 4
   label in `setup.sh` accordingly.

6. **`env-schema.ts`** — replace the NordVPN-specific cross-validation
   block with a provider-aware one that pulls
   `provider.fields[].validate` and runs each. Custom-provider path
   skips validation (user knows what they're doing).

7. **Backward compatibility** — existing profiles with
   `VPN_PROVIDER='nordvpn'` and `NORDVPN_PRIVATE_KEY=...` continue to
   work without re-prompting. The migration is: on profile load, if
   `NORDVPN_PRIVATE_KEY` is set and `WIREGUARD_PRIVATE_KEY` is not,
   alias it over. Trivial in `setConfig`.

### Files to touch

- `installer/src/shared/vpn-providers.ts` — **new** (the registry)
- `installer/src/shared/env-render.ts` — provider-aware rendering
- `installer/src/shared/env-schema.ts` — provider-aware validation
- `installer/src/renderer/screens/ConfigureScreen.tsx` — new VPN block
- `installer/src/main/vpn-service.ts` — accept `provider` parameter,
  call the right API (today: just NordVPN; expandable later)
- `installer/src/shared/ipc.ts` — extend `VpnFetchResult` /
  `vpn:fetchKey` to take `{ provider, token }`
- `nas/docker-compose.yml` — generic env vars
- `nas/setup-nordvpn.sh` → rename `nas/setup-vpn-key.sh`, refactor
- `nas/setup.sh` — update step 4 reference
- `nas/setup-validate.sh` — provider-aware presence checks
- `installer/src/renderer/store/wizard.ts` — add config migration on
  profile load so old NordVPN profiles work

### Out of scope

API-based key fetching for non-NordVPN providers (ProtonVPN has an
official OpenAPI, Mullvad has one too, but each is several days of
work). Custom DNS leak tests. Server-list pickers per provider —
gluetun handles country selection generically.

---

## Suggested order

1. **#4 Profile export/import** — smallest, fully self-contained,
   pure crypto + UI. Lands as a polished standalone feature.
2. **#10 VPN provider abstraction** — biggest refactor but
   user-visible win for anyone not on NordVPN. Backward-compatible
   so existing profiles keep working.
3. **#3 Update-experience polish** — the WhatsNew banner +
   download-to-folder. Smaller than #10, but depends on a CI tweak
   to upload the win-unpacked zip to releases.

Each is independently shippable / revertable. Verification per item:

- **#4**: round-trip a profile (export → delete → import), confirm
  every secret is restored intact and Plex claim is correctly
  stripped.
- **#10**: load an existing NordVPN profile — still works without
  edits. Create a fresh Mullvad profile, run install end-to-end,
  confirm gluetun comes up healthy.
- **#3**: with `package.json` version temporarily bumped down, see
  the WhatsNew banner on Welcome with rendered release notes; click
  "Download zip" → file lands in `Downloads`, Explorer opens at it.
