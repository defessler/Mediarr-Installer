# Lidarr Music-Source Implementation Plan

**Project:** Mediarr Installer | **Author:** Architect | **Date:** 2026-06-14
**Status:** Plan for review — flags product decisions for Doug inline

---

## 1. Executive Summary & Recommended Scope

The Mediarr stack already ships Lidarr (`docker-compose.yml:381-405`), already wires it Prowlarr→Lidarr with a music-category `fullSync` app (`setup-arr-config.py:4059-4062`, `syncCategories=[3000,3010,3030,3040,3050]`), and already exposes two music trackers (Redacted/Orpheus) end-to-end. What it lacks is (a) a **general-coverage credentialed torrent source** that most users can actually sign up for (RED/OPS are invite-only), and (b) any path to **streaming-service downloads** (Deezer/Tidal), which require a non-stable Lidarr **plugins** image.

The good news, confirmed by reading the code: **adding indexers is a pure data-slice** with no per-indexer logic — everything is driven off lists (`PRIVATE_TORRENT_INDEXERS` tuples → `add_private_indexer`, mirrored by `PRIVATE_TRACKERS` catalog defs). The plugins path is genuinely new code but has a clean precedent in the existing `${SEERR_IMAGE:-default}` env-indirection (`docker-compose.yml:146`).

### Recommended minimum (ship this)
- **Phase 1 — RuTracker** (credentialed torrent, user/pass): the single highest-value add. Largest general-purpose tracker with deep discography coverage, free (Russian-language) registration. **Effort: S.** Zero new architecture — clones the AnimeBytes/HD-Torrents slice exactly.
- **Phase 2 — Deezer plugin** (opt-in `ENABLE_MUSIC_PLUGINS` selecting `ghcr.io/hotio/lidarr:pr-plugins`): unlocks streaming-quality downloads. **Effort: L.** New env-indirection + nightly-image opt-in UI + plugin auto-install API code that must be verified live.

### Optional add-ons (ship later / behind the same opt-in surface)
- **Phase 1b — Usenet music indexers (NZBFinder, NZB.su):** *already 95% shipped.* Only gap is one missing `.env.example` doc line + optionally a `music` filter tag. **Effort: XS.**
- **Phase 3 — Soulseek (slskd + Soularr):** genuinely greenfield (zero references in repo). A second + third container, new profile, reaper/port/wait wiring, and a Lidarr-side or sidecar integration. **Effort: L–XL.** Recommend deferring until Phases 1+2 are proven.

### Non-negotiable design spine (honored throughout)
1. **Additive + opt-in + back-compat.** Every new `.env` key is `optStr`/optional with a default that reproduces today's behavior byte-for-byte. The plugins build is gated behind `ENABLE_MUSIC_PLUGINS=false` (default) and `${LIDARR_IMAGE:-linuxserver/lidarr:latest}` — keyless older `.env` files resolve to the identical lsio image. No default stable-stack change.
2. **Credentials at runtime only.** The wizard builds plumbing; the user types RuTracker user/pass, Usenet keys, optional Deezer ARL. **Account signup + captcha + ARL-cookie harvesting are human-only steps** the wizard cannot perform.
3. **VPN reality, stated honestly (see §3).** Only qBittorrent egresses through gluetun. Prowlarr searches and Lidarr plugin/streaming traffic leave on the host's real public IP. We do **not** silently imply anonymity.
4. **Dual-copy discipline.** Every payload change lands in BOTH `nas\scripts\` (source of truth) and `installer\resources\nas-payload\scripts\` (bundled, shipped). Verified both trees exist.

---

## 2. Per-Phase Implementation

> **Legend.** Files marked **(×2)** must be edited in both `nas\scripts\` and `installer\resources\nas-payload\scripts\`. TS files under `installer\src\` are single-copy.

---

### Phase 1 — RuTracker (credentialed torrent) — **RECOMMENDED, Effort: S**

A private/login Cardigann tracker authenticated by username+password. It **must** go through the `PRIVATE_TORRENT_INDEXERS`/`add_private_indexer` path, **not** `add_newznab` (which only models `baseUrl`+`apiKey` — RuTracker would be added with empty creds and silently rejected). Reaches Lidarr automatically via the existing `fullSync` app; no Lidarr-side code.

**Opt-in design:** no new `ENABLE_*` flag. The opt-in gate *is* the credential presence — the loop at `setup-indexers.py:969-981` skips the indexer unless **both** `RUTRACKER_USER` and `RUTRACKER_PASS` are non-empty, and the wizard card only collects creds when the user toggles it on (`IndexerCard.tsx:68-77` clears both fields on toggle-off, so no partial creds leak to `.env`).

**Exact changes — 5 edits + 1 doc edit:**

| # | File | Change |
|---|------|--------|
| 1 | `setup-indexers.py` **(×2)**, `PRIVATE_TORRENT_INDEXERS` after line 229 | Add tuple: `("RuTracker", "RuTracker", {"username": "RUTRACKER_USER", "password": "RUTRACKER_PASS"})`. The 2nd element must match Prowlarr's bundled Cardigann implementation name — **see PD-1 below; verify live.** |
| 2 | `installer/src/shared/env-render.ts`, `EnvFormValues` private-tracker block (~line 214) | Add `RUTRACKER_USER?: string` and `RUTRACKER_PASS?: string`. |
| 3 | `installer/src/shared/env-render.ts`, `renderEnv()` private-tracker emit block (after `IPTORRENTS_COOKIE`, ~line 432) | Add `line('RUTRACKER_USER', v.RUTRACKER_USER)` and `line('RUTRACKER_PASS', v.RUTRACKER_PASS)`. **A key absent here never reaches `.env` even if typed.** |
| 4 | `installer/src/shared/env-render.ts`, `PRIVATE_TRACKERS` catalog (after AnimeBytes, ~line 777) | Add the `IndexerDef` below. `id` must be a real `keyof EnvFormValues` → use `RUTRACKER_USER`. `category:'tracker-private'` makes `indexerTags()` add `torrent`+`paid` (auto-files under "Private torrent trackers"). `tags:['music',...]` surfaces it under the Music filter chip — the point of the exercise. Because `fields.length>0`, `IndexerBrowser` renders it as a credentials card **with no UI code change**. |
| 5 | `installer/src/shared/env-schema.ts`, indexer block (by AVISTAZ, ~line 164) | Add `RUTRACKER_USER: optStr,` and `RUTRACKER_PASS: optStr,`. **Hard gate:** any key emitted by `renderEnv` but absent here fails validation/round-trip. |
| 6 | `.env.example` **(×2)**, private-tracker section (~219-227) | Add `RUTRACKER_USER=` / `RUTRACKER_PASS=` with a one-line header comment. (Also fixes existing doc drift — RED/Orpheus keys aren't documented there either; add them while in the file.) |

```ts
// Edit #4 — PRIVATE_TRACKERS catalog def
{
  id: 'RUTRACKER_USER', name: 'RuTracker', href: 'https://rutracker.org',
  note: 'Large Russian general tracker — deep music/discography coverage. Free account (registration is in Russian). CloudFlare-gated, so it routes through FlareSolverr.',
  fields: [
    { key: 'RUTRACKER_USER', label: 'Username' },
    { key: 'RUTRACKER_PASS', label: 'Password', password: true },
  ],
  category: 'tracker-private',
  tags: ['music', 'general', 'free-signup'],
},
```

**API-automatable:** the full plumbing (Prowlarr add via `add_private_indexer` → `fullSync` push to Lidarr as a music-scoped Torznab indexer). FlareSolverr tag auto-attaches (`setup-indexers.py:979 → schema['tags'] at 670`) for the CloudFlare gate. Case-insensitive field setter (`_set_field_case_insensitive`, line 677) and silent-reject warning (681-685) handle Prowlarr schema casing.

**Manual (human-only):** RuTracker account registration (Russian-language form, may include captcha). The wizard collects creds; it cannot create the account.

**Defaults:** absent → indexer never added (existing skip-if-missing gate). Fully back-compat; older `.env` files unaffected.

---

### Phase 1b — Usenet music indexers (NZBFinder, NZB.su) — **OPTIONAL, Effort: XS**

**Already shipped end-to-end** since v0.5.x. Both present in `setup-indexers.py` `USENET_INDEXERS` (lines 176, 186), `env-render.ts` catalog (582-588, 633-640) + `EnvFormValues` (154, 161) + `renderEnv` emit (414, 421), and `env-schema.ts` (137, 144). Opt-in already (loop adds only when the API key is non-empty). They already reach Lidarr via the `fullSync` app since both carry 3xxx music caps.

**Exact changes — 2 small edits:**

| # | File | Change |
|---|------|--------|
| 1 | `.env.example` **(×2)**, Usenet section (after line 206) | Add the missing doc line: `NZBSU_API_KEY=         # nzb.su → Profile → API Key`. (`NZBFINDER_API_KEY` is already on line 200; `NZBSU_API_KEY` is the only key missing from this file — it exists everywhere else.) |
| 2 | `installer/src/shared/env-render.ts`, the two catalog defs (optional polish) | Add `'music'` to their `tags` arrays (currently `['general','free-signup']`) so they appear under the Music content-filter chip. Functionally they already serve Lidarr; this is discoverability only. |

**API-automatable:** everything (already proven in production). **Manual:** Usenet provider + indexer signup, API-key retrieval. **Defaults:** unchanged. **Back-compat:** the `.env.example` line is cosmetic; the tag change is UI-only.

---

### Phase 2 — Deezer plugin (opt-in plugins Lidarr image) — **RECOMMENDED, Effort: L**

Switches Lidarr to the **plugins** build (`ghcr.io/hotio/lidarr:pr-plugins`) only when the user opts in, then auto-installs the Deezer plugin and (if an ARL is supplied) wires the Deezer download-client/indexer. This is the headline feature and the highest-risk one (nightly image, live-verified API). Greenfield: repo-wide grep for `deezer|pr-plugins|hotio/lidarr|installPlugin` returned **zero** matches.

**Opt-in design — mirrors `MEDIA_SERVER`/`SEERR_IMAGE` exactly:**
- Master flag `ENABLE_MUSIC_PLUGINS=false` (default off).
- `LIDARR_IMAGE` derived from that flag in `renderEnv` (empty when off ⇒ compose default fires).
- Optional `LIDARR_DEEZER_ARL` collected as a password field, required-when-on via `superRefine`.
- A "stable vs plugins build" radio sub-choice in the wizard, shown only when `ENABLE_LIDARR` is on, anchored to the existing Lidarr advisory note (`ConfigureScreen.tsx:401-417`).

**Step-by-step:**

**Step 1 — env-driven image (the back-compat win).** `docker-compose.yml:382` **(×2)**: change
```yaml
image: linuxserver/lidarr:latest
```
to
```yaml
image: ${LIDARR_IMAGE:-linuxserver/lidarr:latest}
```
The `:-default` keeps every existing install byte-identical. **No profile change** — Lidarr stays one service in the `lidarr` profile; `compose up -d` recreates the container in place when the tag changes (compose detects the image diff). **No reaper logic** (the `plex↔jellyfin` reaper at `setup.sh:520-537` exists only because the container name changes; here it does not).

**Step 2 — env keys (4 files):**
- `.env.example` **(×2)**, near line 17 / after the music note: add `ENABLE_MUSIC_PLUGINS=false`, a commented `LIDARR_IMAGE=`, and a commented `LIDARR_DEEZER_ARL=`. Document that the plugins build is `ghcr.io/hotio/lidarr:pr-plugins`, that it is **nightly/PR / not stable**, and that hotio's env contract differs subtly from lsio (PUID/PGID/UMASK still honored).
- `env-schema.ts`: add `ENABLE_MUSIC_PLUGINS: optStr`, `LIDARR_IMAGE: optStr`, `LIDARR_DEEZER_ARL: optStr`. Add a `superRefine` branch cloning the qBit block (lines 212-222) requiring `LIDARR_DEEZER_ARL` only when `flagOn(ENABLE_MUSIC_PLUGINS) && flagOn(ENABLE_LIDARR)`. **PD-3: confirm ARL should be mandatory-when-on vs optional** (a user may want the plugin installed but configure Deezer later in the UI).
- `env-render.ts`: in `renderEnv`, derive `LIDARR_IMAGE` from the flag exactly as `SEERR_IMAGE` is derived from `MEDIA_SERVER` (lines 358-364):
  ```ts
  const musicPlugins = isEnabled(v.ENABLE_MUSIC_PLUGINS) && isEnabled(v.ENABLE_LIDARR)
  // ...
  line('ENABLE_MUSIC_PLUGINS', musicPlugins ? 'true' : 'false'),
  line('LIDARR_IMAGE', musicPlugins ? 'ghcr.io/hotio/lidarr:pr-plugins' : ''),
  line('LIDARR_DEEZER_ARL', musicPlugins ? v.LIDARR_DEEZER_ARL : ''),
  ```
  Add `ENABLE_MUSIC_PLUGINS?`, `LIDARR_IMAGE?`, `LIDARR_DEEZER_ARL?` to `EnvFormValues`.
- `wizard.ts:115` `defaultConfig`: add `ENABLE_MUSIC_PLUGINS: 'false'`.

**Step 3 — wizard UI (`ConfigureScreen.tsx`).** Under the Lidarr advisory block (gated by `isEnabled(config.ENABLE_LIDARR)`, ~line 401), add a sub-section cloning the media-server radio-group widget (lines 1041-1066):
- Two options: **"Stable (no streaming)"** vs **"Plugins build + Deezer"**, writing `update('ENABLE_MUSIC_PLUGINS', ...)`.
- When plugins selected: reveal a `PasswordInput` for `LIDARR_DEEZER_ARL` (component already imported, ~line 87) with copy explaining the ARL is a Deezer account cookie harvested from the browser.
- A prominent **"uses a non-stable nightly/PR image — see warnings"** banner. **This honesty banner is the key UX requirement.**

**Step 4 — setup.sh: nothing structural.** Lidarr stays one service/one profile; the `${LIDARR_IMAGE}` indirection handles the swap. Optional: a one-line notice in the summary block. **Do not** add reaper logic.

**Step 5 — plugin auto-install (the genuinely new code).** Insert in the Lidarr block of `setup-arr-config.py` **(×2)** after the warmup-touch (~line 3976) and **before** the profile poll (3979), gated on `is_enabled(env,'ENABLE_MUSIC_PLUGINS')`:

- **(a) Install the Deezer plugin from GitHub.** New helper `install_lidarr_plugin(LIDARR, LIDARR_KEY, github_url)` modeled on `add_prowlarr_app` (GET to check existing → POST if absent), reusing `POST_status` (line 525). Source repo: `https://github.com/TrevTV/Lidarr.Plugin.Deezer`. **PD-2/RISK: the exact endpoint (`POST /api/v1/system/plugins` vs `POST /api/v1/command {name:"InstallPlugin", githubUrl:...}`) is version-dependent on the plugins branch and MUST be verified live against the running `pr-plugins` image — do NOT code from memory.**
- **(b) Re-wait after install.** Plugin install **triggers a Lidarr restart.** The step must `wait_ready("Lidarr", ...)` **again** before the profile poll, or root-folder/client adds hit a cycling API. The codebase already tolerates session-cycles (PUT-no-response verify loops at 1127-1135, 833-849) — reuse that pattern.
- **(c) Wire the Deezer client/indexer (only if `LIDARR_DEEZER_ARL` set).** After restart the plugin registers a new download-client + indexer *implementation* inside Lidarr. Add them the **same way the wizard already adds clients**: GET `/api/v1/downloadclient/schema`, match the schema whose `implementation` is the Deezer plugin's name, fill its ARL field from `LIDARR_DEEZER_ARL`, POST with `?forceSave=true` (the `add_download_client` idiom at 796+). The ARL is just a field value, settable like any other (cf. `apiKey` at `add_prowlarr_app:1398). **RISK: the Deezer schema's `implementation`/`configContract` + ARL field name are only knowable by hitting the live schema endpoint — verify, don't guess.**
- **Failure handling:** every new API call must be **non-fatal / warn-on-failure** (mirror the `warn(...)` downgrade at 849, 1138). A plugins-branch API change must **not** break the stable-arr config — Sonarr/Radarr/Lidarr core must still configure even if the plugin step fails.

**API-automatable:** plugin install, restart-wait, Deezer client/indexer add, ARL field-set — **all automatable end-to-end IF the user supplies the ARL.** **Manual (human-only):** obtaining the ARL (log into deezer.com, read the `arl` cookie in DevTools) — the wizard can only collect it. Music quality profiles remain a manual UI step (Recyclarr still doesn't support Lidarr — the existing note at `ConfigureScreen:401-417` stays true).

**Defaults:** off → identical lsio image, no plugin code runs. **Back-compat:** keyless `.env` ⇒ stable image; all keys `optStr`.

---

### Phase 3 — Soulseek (slskd + Soularr) — **OPTIONAL, Effort: L–XL, DEFER**

Genuinely greenfield (zero repo references, confirmed). slskd is a Soulseek daemon; Soularr bridges Lidarr "wanted" lists → slskd searches/downloads → import. This is **two new service containers**, touching every layer of the 3-layer `ENABLE_*` contract. Unlike Phases 1/1b/2 there is no existing slice to clone — it's the full "new service" recipe.

**Opt-in design:** new master flag `ENABLE_SOULSEEK=false` plus credential keys `SLSKD_USER` / `SLSKD_PASS` (Soulseek network login). A `SERVICE_TOGGLES` entry in `ConfigureScreen.tsx` (~line 171).

**Exact changes (full new-service recipe — all the 3-layer drift points must agree on key name + disable-set `{false,0,no,off}`):**

| Layer | File | Change |
|-------|------|--------|
| Renderer | `env-render.ts` | `ENABLE_SOULSEEK?`, `SLSKD_USER?`, `SLSKD_PASS?` in `EnvFormValues`; emit all three in `renderEnv` (ENABLE line by 326; creds with the trackers). |
| Schema | `env-schema.ts` | `ENABLE_SOULSEEK: optStr` (~line 37); `SLSKD_USER`/`SLSKD_PASS` `optStr`; `superRefine` branch requiring creds when `flagOn(ENABLE_SOULSEEK)`. |
| Store | `wizard.ts` | `ENABLE_SOULSEEK: 'false'` in `defaultConfig`. |
| UI | `ConfigureScreen.tsx` | `SERVICE_TOGGLES` entry (~line 171) + a credentials sub-section/field group. |
| Compose | `docker-compose.yml` **(×2)** | Two services. **slskd** + **soularr**, `profiles:["soulseek"]`, `networks:[media]`, port `${LAN_IP}:<port>:<port>` for slskd's WebUI, volumes under `${INSTALL_DIR}/slskd/config` + `${DATA_ROOT}`. Clone the `lidarr` block (381-405) as the template. |
| Orchestration | `setup.sh` **(×2)** | `is_enabled ENABLE_SOULSEEK && PROFILES+=("soulseek")` (~line 360); reaper pairs `"slskd:ENABLE_SOULSEEK"` + `"soularr:ENABLE_SOULSEEK"` (~line 503); port pair in `check_port_conflicts` (~line 617); `wait_for_services` entry (~line 702) if a configurator depends on slskd. |
| Config (optional) | `setup-arr-config.py` **(×2)** | Wire slskd as a Lidarr download client via `add_download_client`, OR configure Soularr's `config.ini` to point at Lidarr + slskd. **PD-4: decide slskd-as-Lidarr-client vs Soularr-bridge — they're different integration shapes.** |

**API-automatable:** container provisioning, slskd WebUI bring-up, Lidarr download-client wiring. Soularr is config-file driven (write its `config.ini`), not API — automatable but a different mechanism. **Manual (human-only):** Soulseek account creation (in-client); slskd shares-directory policy (Soulseek is share-to-download — a **PD/ToS consideration**). **VPN: slskd peer traffic is NOT VPN-protected** unless slskd is put in gluetun's namespace (`network_mode:"container:gluetun"` + WebUI port added to `FIREWALL_INPUT_PORTS`) — a larger change; **flag to Doug, document the default as un-VPN'd.**

---

## 3. Risks & Unknowns

### A. Nightly-Lidarr stability + rollback (Phase 2) — **HEADLINE RISK**
- `ghcr.io/hotio/lidarr:pr-plugins` tracks an **unmerged** Lidarr branch. It can break on any pull and its **DB schema may diverge** from stable lsio Lidarr.
- **Downgrade is not safe.** Both image variants reuse the **same** `${INSTALL_DIR}/lidarr/config`. A plugins-branch Lidarr may write a DB the stable build won't downgrade-load → **risk of bricking Lidarr's config** when a user flips `ENABLE_MUSIC_PLUGINS` back off. This is materially riskier than the seerr↔jellyseerr swap (those forks share a compatible config) and the plex↔jellyfin swap (separate config dirs + reaper).
- **Mitigations to ship:** (1) loud, explicit consent copy in the UI banner; (2) **snapshot/back up the lidarr config dir before first plugins launch** (a `cp -a` of `${INSTALL_DIR}/lidarr/config` to a timestamped sibling in setup.sh when the image transitions to plugins, gated on first-time). **PD-5: do we auto-snapshot, or just warn?** Auto-snapshot is the safer default and cheap.

### B. Plugin-API availability (Phase 2) — **must verify live, do NOT code from memory**
1. Install endpoint: `POST /api/v1/system/plugins` vs `POST /api/v1/command {name:"InstallPlugin", githubUrl:...}` — has changed across plugins-branch revisions.
2. Deezer plugin's download-client/indexer `implementation` + `configContract` + ARL field name — only knowable from the live `/api/v1/downloadclient/schema` (and `/api/v1/indexer/schema`) on the running `pr-plugins` container.
3. hotio's image env contract differs subtly from lsio — confirm the healthcheck (`docker-compose.yml:399`) still passes and config-dir ownership is correct under hotio (cf. the Seerr `user:`/chown gotcha at compose 154-160).
   **All three require a dev session hitting a live `pr-plugins` container** (`http://<NAS>:49154/api/v1/system/plugins?apikey=...`, etc.) before any endpoint is hardcoded.

### C. VPN egress (all phases) — **state honestly, do not imply anonymity**
- Only **qBittorrent** egresses through gluetun (`network_mode:"container:gluetun"`). So **RuTracker torrent grabs/peer traffic ARE VPN-protected** (inherited at the qBit layer — Phase 1 needs zero VPN work).
- **Prowlarr indexer searches** (RuTracker page fetches, tracker announces) egress on the **real public IP** — Prowlarr is on the plain `media` bridge. If hiding *searches* is a requirement, that's a much bigger change (Prowlarr into gluetun + DNS + generalized `QB_HOST` indirection) — **out of scope; flag it.**
- **Lidarr plugin / Deezer traffic** (Phase 2) egresses on the **real public IP** — Lidarr is on the bridge. Moving Lidarr into gluetun would break the wizard's control channel (setup-arr-config.py reaches arrs over `http://LAN_IP:<port>`; an arr inside gluetun has no published bridge port) and the Homepage tiles. **Recommendation: keep Lidarr on the bridge; document that plugin/Deezer/Soulseek traffic is NOT VPN-protected.**
- **VPN is OFF by default** (`VPN_ENABLED=false`). When off, even qBit uses the real public IP (no-vpn override). **Any "private tracker" copy must not imply anonymity** on the default install.

### D. Indexer reliability (Phases 1, 1b)
- **RuTracker schema-name resolution:** `add_private_indexer` hard-`fail()`s if `_find_schema` (line 661-663) can't resolve the implementation — the private path has **no** `skip_if_missing`/alias fallback (`INDEXER_OVERRIDES` is only read by the public `add_indexer`). Prowlarr ships the def as `"RuTracker.org"` / `"RuTracker RU"`; the fuzzy `startswith` (474-485) requires exactly **one** candidate (`len==1`). **PD-1: verify against live `GET /api/v1/indexer/schema` and, if ambiguous, set the tuple's 2nd element to the exact schema name.** Until verified, this is the one thing that can make Phase 1 throw rather than skip.
- **No base_url override for RuTracker:** mirror domains (`rutracker.org` vs `.net`) can't be pinned via `INDEXER_OVERRIDES` on the private path — rely on Prowlarr's bundled URL or a manual Prowlarr-UI fix.
- **CloudFlare/ISP blocking:** RuTracker is frequently blocked. FlareSolverr tag auto-attaches, but `ENABLE_FLARESOLVERR` is **default-off on arm64** (`env-render.ts:29`); without it the add can fail the reachability test. `_post_indexer`'s `forceSave` fallback (411-429) still persists it (red "unreachable" badge) and the install **doesn't fail** the step (always exits 0) — acceptable, but the user may see an info line. **Consider: when RuTracker is enabled, nudge `ENABLE_FLARESOLVERR=true`.**
- **Music-caps assumption:** `fullSync` filters by indexer caps ∩ Lidarr `syncCategories=[3000…3050]`. RuTracker + the NZB indexers carry 3xxx caps (low risk), but this is the mechanism to check if music results don't appear in Lidarr.

### E. Cross-cutting correctness
- **3-layer `ENABLE_*` drift (Phase 3):** `isEnabled` (env-render 300-302), `is_enabled` (setup.sh 305-312), and the Python `is_enabled` all hardcode `{false,0,no,off}`. A new flag must land in **all** of: `EnvFormValues`, `env-schema` `ENABLE_*`, `renderEnv` emit, `SERVICE_TOGGLES`, setup.sh PROFILES build, reaper, port-check, wait-list. Missing one ⇒ half-installed service. (Phases 1/1b/2 mostly avoid this — Phase 1 adds **no** flag; Phase 2's flag never gates a separate container.)
- **`env-schema.ts` hard gate:** every new key emitted by `renderEnv` MUST have an `env-schema` entry or validation/round-trip breaks. The most common omission — call it out in review.
- **Latent bug to respect, not "fix" casually:** `docker-compose.yml:445` reads `FIREWALL_OUTBOUND_SUBNETS=${LAN_SUBNETS:-…}` (**plural**) while every other layer uses `LAN_SUBNET` (**singular**). Benign today (default covers all RFC1918). **Phase 3 is the only phase that could be affected** (if a VPN-namespaced slskd must reach qBit through gluetun). Don't bundle the rename into this work — it changes behavior for non-RFC1918 LANs and deserves its own coordinated change.
- **Lidarr first-run fragility:** the existing 120s profile poll (`setup-arr-config.py:3979-3998`) sometimes still needs a manual UI visit on Synology spinning rust. Phase 2's plugin install adds a **second** restart-and-rewait into this already-fragile window — sequence carefully (install+rewait **before** the profile poll).
- **ARL secret handling:** `LIDARR_DEEZER_ARL` is a long-lived Deezer session cookie in plaintext `.env` (same exposure class as `QBITTORRENT_PASS`/`WIREGUARD_PRIVATE_KEY`). Acceptable by convention, but it grants full Deezer-account access.
- **ToS/legal gray area (product call, not a code blocker):** Deezer streaming-rip (Phase 2) and Soulseek share-to-download (Phase 3). **PD-6: confirm the project is comfortable shipping these as opt-in features.**

---

## 4. Recommended Build Order, Milestones & What Doug Must Provide

### Build order (ascending risk; each milestone independently shippable)

**Milestone M1 — v0.6.0 "Music sources, part 1" (Phases 1 + 1b).** Low risk, no new architecture, no nightly image.
- Phase 1b first (XS): add the `NZBSU_API_KEY` `.env.example` line + optional `music` tags. Zero-risk warm-up.
- Phase 1 (S): the RuTracker 6-edit slice.
- **Ship gate:** RuTracker schema name verified live (PD-1); a real round-trip test (toggle RuTracker on in the wizard → render `.env` → run `setup-indexers.py` → confirm it appears in Prowlarr and syncs to Lidarr).

**Milestone M2 — v0.7.0 "Music streaming (advanced/opt-in)" (Phase 2).** The big one. Split into two PRs:
- **M2a (plumbing, mergeable without a live container):** Steps 1-4 — `${LIDARR_IMAGE}` indirection, env keys, schema, `renderEnv`, defaults, wizard radio + ARL field + honesty banner, config snapshot-on-transition. This alone lets a user run the plugins image manually; fully back-compat.
- **M2b (auto-install code):** Step 5 — `install_lidarr_plugin` + Deezer client/indexer wiring, **after** the live-verification dev session (Risk B). All calls non-fatal.
- **Ship gate:** verified install endpoint + Deezer schema field names against a live `pr-plugins` container; confirmed plugins→stable downgrade behavior (informs whether snapshot is mandatory — PD-5); honesty banner reviewed.

**Milestone M3 — v0.8.0 "Soulseek (optional)" (Phase 3).** Only after M1+M2 are proven. Full new-service recipe; product decisions PD-4/PD-6 resolved; VPN posture documented.

### What Doug must provide

**Product decisions (block specific phases):**
- **PD-1 (M1):** Confirm RuTracker's exact Prowlarr Cardigann implementation name from a live `GET /api/v1/indexer/schema` (likely `"RuTracker.org"`). Architect can do this if given Prowlarr access; otherwise Doug confirms.
- **PD-2 (M2b):** Same for the plugins-branch **install endpoint** + **Deezer plugin schema** — requires a live `pr-plugins` container. **Doug to stand one up (or grant NAS access) for the verification session.**
- **PD-3 (M2):** Should `LIDARR_DEEZER_ARL` be **mandatory-when-plugins-on**, or optional (install plugin, configure Deezer later in UI)? Architect recommends **optional** — less brittle, lets users adopt the plugin build without immediately committing an ARL.
- **PD-4 (M3):** slskd-as-Lidarr-download-client **vs** Soularr-bridge integration shape.
- **PD-5 (M2):** Auto-snapshot the lidarr config dir on first plugins launch, **or** warn-only? Architect recommends **auto-snapshot** (cheap, prevents bricking).
- **PD-6 (M2/M3):** Sign-off on shipping Deezer streaming-rip and Soulseek as opt-in features (ToS/legal posture).
- **Scope confirmation:** Architect recommends shipping **M1 + M2** as the "recommended minimum" per the brief, with **M3 deferred**. Confirm.

**Runtime inputs (the user/operator provides at wizard time — never the wizard):**
- RuTracker username + password (after registering — Russian-language signup, possible captcha).
- (1b) NZBFinder / NZB.su API keys (after Usenet-indexer signup).
- (2) Deezer ARL cookie (logged into deezer.com → DevTools → `arl` cookie) — optional, collected only if supplied.
- (3) Soulseek account credentials.

**Verification access:** for M1 (PD-1) and M2b (PD-2), a reachable live Prowlarr and a live `ghcr.io/hotio/lidarr:pr-plugins` container so endpoint/schema names are confirmed from reality, not memory.

---

### Files touched (quick index, all verified to exist)
- **Payload (×2 — `nas\scripts\` + `installer\resources\nas-payload\scripts\`):** `docker-compose.yml`, `setup.sh`, `setup-arr-config.py`, `indexers/setup-indexers.py`, `.env.example`
- **Installer TS (single-copy):** `installer\src\shared\env-render.ts`, `installer\src\shared\env-schema.ts`, `installer\src\renderer\store\wizard.ts`, `installer\src\renderer\screens\ConfigureScreen.tsx`
- **No change needed (generic, auto-renders):** `installer\src\renderer\components\IndexerBrowser.tsx`, `IndexerCard.tsx`
