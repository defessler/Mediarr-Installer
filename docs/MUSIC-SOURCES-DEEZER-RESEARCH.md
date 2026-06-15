# Deezer (Lidarr plugins) — Phase 2 source-verified research

**Status:** Research complete, implementation-ready (pending one live smoke test).
**Date:** 2026-06-15
**Scope:** Resolves the open questions in `MUSIC-SOURCES-PLAN.md` §2 (Phase 2) and §3
(Risks A/B, PD-2/PD-3/PD-5/PD-6) **from authoritative source code**, so the build is
de-risked before a live `pr-plugins` container is available. Every claim below is cited
to a repo/file or URL and was verified against the actual Lidarr `plugins` branch and the
`TrevTV/Lidarr.Plugin.Deezer` source — *not* from memory.

> **Why this doc exists:** the plan correctly said "do NOT code the plugin endpoints from
> memory — verify live." Reading the source is the next best thing to a live container
> (Lidarr's REST schema is *generated* from these C# classes), and it lets us write almost
> all of Phase 2 now and confirm it with a single smoke test later. It also caught two real
> mistakes in the plan (see **Corrections**).

---

## TL;DR — what changed vs the plan

1. ✅ **Install API resolved (PD-2):** plugin install is a **Lidarr command**, not a REST
   route. `POST /api/v1/command {"name":"InstallPlugin","githubUrl":"<repo>"}` → poll
   `GET /api/v1/command/{id}` to `completed` → **then a separate, mandatory
   `POST /api/v1/command {"name":"Restart"}` + health re-wait.** There is **no**
   `POST /api/v1/system/plugins` route (that controller is GET-only).
2. 🔴 **CORRECTION — the ARL goes on the INDEXER, not the download client.** The plan's
   Step 5(c) is wrong. The plugin registers **both** an Indexer and a Download Client; the
   `arl` field lives on `DeezerIndexerSettings`. The Download Client (`DeezerSettings`) has
   **no ARL** and instead requires a valid `downloadPath`.
3. ✅ **PD-5 resolved → AUTO-SNAPSHOT is mandatory.** Downgrade is *confirmed*
   config-bricking by the Servarr Wiki: stable Lidarr cannot load a DB the plugins build
   migrated. The installer **must** `cp -a` the lidarr config dir before the first plugins
   launch.
4. ✅ **PD-3 resolved → ARL is optional in the schema** (blank is accepted), but in
   practice **effectively required for function** (the plugin's auto-ARL fallback was
   disabled upstream). Collect it as optional; warn that a blank ARL likely yields nothing.
5. ✅ **Image/contract confirmed.** `ghcr.io/hotio/lidarr:pr-plugins` is live on ghcr.io,
   honors PUID/PGID/UMASK, uses `/config`, serves on 8686, and ships **no** Docker
   HEALTHCHECK — so our existing compose healthcheck + wait logic carry over unchanged.
6. ✅ **PD-6 (ToS):** downloading from Deezer violates Deezer's ToU and risks account bans.
   Ship opt-in, off by default, with an explicit honesty banner (copy below).

---

## 1. Plugin install / lifecycle API (Lidarr `plugins` branch — HIGH confidence)

Verified against `Lidarr/Lidarr@refs/heads/plugins` (HEAD `e42a7ca`).

| Operation | Call | Notes |
|---|---|---|
| **Install** | `POST /api/v1/command` body `{"name":"InstallPlugin","githubUrl":"https://github.com/TrevTV/Lidarr.Plugin.Deezer"}` | Returns **HTTP 201** + a `CommandResource` with `.id` + `.status`. Async. |
| **Poll** | `GET /api/v1/command/{id}` | Poll ~0.5–1s until `.status=="completed"`. Terminal-failure statuses: `failed`/`aborted`/`cancelled`/`orphaned`. |
| **Restart (mandatory)** | `POST /api/v1/command` body `{"name":"Restart"}` | Install does **not** auto-restart — it only extracts files and logs "Please restart Lidarr." The plugin's download-client/indexer types are **not registered until after restart**, so a schema POST before restart will 400. |
| **Re-wait** | `GET /api/v1/system/status` until 200 | Reuse the existing post-first-boot health-wait loop; may need a longer timeout for the restart case. |
| **List (idempotency)** | `GET /api/v1/system/plugins` | Returns `[{name, owner, githubUrl, installedVersion, ...}]`. Skip install (and the restart) if the Deezer plugin is already present — match on `owner`+`name` (robust to trailing-slash / `/tree/<branch>`). |
| **Uninstall** | `POST /api/v1/command {"name":"UninstallPlugin","githubUrl":"<same>"}` + Restart | Symmetric; for a future "turn music plugins off" path. |

- **Auth/prefix unchanged:** `/api/v1` + `X-Api-Key` header (config.xml key), exactly as
  stable Lidarr. No client changes needed.
- **JSON casing:** Lidarr uses System.Text.Json **camelCase** for properties *and* enum
  values (`name`, `githubUrl`, `status`, `id`). Compare status case-insensitively to be safe.
- **Install URL = repo root**, not a release zip. Lidarr resolves the latest GitHub release
  asset itself. Pass `https://github.com/TrevTV/Lidarr.Plugin.Deezer`.

*Evidence:* `InstallPluginCommand.cs`, `UninstallPluginCommand.cs`, `RestartCommand.cs`,
`CommandController.cs` (`StartCommand` → `Created(id)`), `PluginController.cs`
(`[V1ApiController("system/plugins")]`, GET-only), `InstallPluginService.cs` ("Please
restart"), `frontend/.../PluginsConnector.js` (RestartRequiredModal),
`PluginFixture.cs` (install → `RestartCommand` → `WaitForRestart`).

---

## 2. The Deezer plugin internals (`TrevTV/Lidarr.Plugin.Deezer`@`e0bd96f` — HIGH confidence)

Actively maintained (release 10.1.0.18, 2025-11-22), targets net8.0 + the Lidarr plugins
branch, README pins `ghcr.io/hotio/lidarr:pr-plugins`.

It registers **two** providers (no ImportList):

### 🔴 Indexer — this is where the ARL lives
- Endpoint to add: `POST /api/v1/indexer?forceSave=true`
- Schema match: `implementation == "Deezer"`, `configContract == "DeezerIndexerSettings"`
- Fields (`DeezerIndexerSettings`):
  - **`arl`** (field 0, label "Arl", Textbox) — **set `LIDARR_DEEZER_ARL` here.** Optional
    (empty validator); blank does **not** 400.
  - `hideAlbumsWithMissing` (bool, default true)
  - `earlyReleaseLimit` (int?, advanced)
  - hidden `baseUrl` (leave `""`)
- `SupportsRss=false`, `SupportsSearch=true` (search-only; no RSS sync).

### Download Client — needs `downloadPath`, NOT the ARL
- Endpoint to add: `POST /api/v1/downloadclient?forceSave=true`
- Schema match: `implementation == "Deezer"`, `configContract == "DeezerSettings"`
- Fields (`DeezerSettings`): **`downloadPath`** (required — `IsValidPath` validator, so a
  blank/invalid path **400s**; set it to the in-container downloads path, e.g. the same
  `/downloads` the rest of the stack uses), `saveSyncedLyrics` (bool), `useLRCLIB` (bool).
  **No `arl` field here.**
- Protocol: custom `DeezerDownloadProtocol` (not torrent/usenet) — `Test()` is a no-op, so
  the client add won't fail on a missing ARL.

> Both providers share `implementation == "Deezer"`, disambiguated by endpoint
> (`/indexer/schema` vs `/downloadclient/schema`), so the schema match is unambiguous.

### Quality / format
No format dropdown. The **indexer** advertises up to three releases per album, gated by the
ARL account's Deezer entitlements, and Lidarr's **Quality Profile** (a manual UI step) picks:
- MP3 128 — always
- MP3 320 — only if account `web_hq`
- **FLAC — only if account `web_lossless` (i.e. a paid Deezer HiFi/Premium tier)**

So **FLAC requires a HiFi ARL**; a free-account ARL yields MP3 only. Document this in the
ARL field help text.

*Evidence:* `Indexers/Deezer/DeezerSettings.cs` (`[FieldDefinition(0, Label="Arl")] Arl`),
`Indexers/Deezer/Deezer.cs` (`HttpIndexerBase`, `Name=>"Deezer"`, `SupportsRss=>false`),
`Download/Clients/Deezer/DeezerSettings.cs` (DownloadPath/SaveSyncedLyrics/UseLRCLIB +
`RuleFor(x=>x.DownloadPath).IsValidPath()`), `Download/Clients/Deezer/Deezer.cs`
(`DownloadClientBase`, `Protocol=>nameof(DeezerDownloadProtocol)`), `DeezerParser.cs`
(`web_hq`/`web_lossless` gating).

---

## 3. The hotio `pr-plugins` image (HIGH confidence)

- **Ref:** `ghcr.io/hotio/lidarr:pr-plugins` — **live on ghcr.io** (registry manifest
  returns HTTP 200; `tags/list` includes `pr-plugins` and pinned `pr-plugins-1.4.1.3564`;
  bare `:pr` is 404). It's *hidden* from hotio.dev docs (`meta.json hide=true`), which is
  expected — not a sign it's gone. The plugin README pins this exact tag.
- **Env contract = drop-in for our lidarr service.** The hotio base honors
  `PUID/PGID/UMASK` (defaults 1000/1000/002), uses `/config`, runs the app as a single
  fixed `hotio` user remapped to PUID/PGID. Our existing lidarr env + volume block (compose
  `PUID/PGID/TZ/UMASK=002`, `/config` + `/data`) transfers **as-is** — no new env keys, no
  `user:`/chown directive (unlike the Jellyseerr gotcha).
- **No Docker HEALTHCHECK** in the image (the base's `service-healthcheck` is a VPN-only
  liveness loop, default-off). Lidarr serves on **8686**, `curl` is present → our
  compose-level healthcheck and `wait_for_services` logic **stay valid unchanged**.
- **Ownership nuance:** hotio chowns only the `/config` mountpoint non-recursively
  (`find -maxdepth 0`), so it won't mass-rewrite an existing lsio config tree; with matching
  uid/gid it's fine.
- **Fallback channel:** if `pr-plugins` is ever retired, the successor is `:nightly`
  (Servarr now ships plugin capability on the nightly branch). Keep `LIDARR_IMAGE` an
  overridable `.env` key (already in the plan) so users can switch without an installer release.

*Evidence:* `hotio/base` alpinevpn Dockerfiles (ENV PUID/PGID/UMASK/CONFIG_DIR, no
`HEALTHCHECK`, `apk add curl`), `hotio/lidarr` pr Dockerfile (`EXPOSE 8686`,
`WEBUI_PORTS=8686/tcp`, `meta.json version_branch=plugins, hide=true`), GHCR
`tags/list`/manifest queries (2026-06-15).

---

## 4. 🔴 Downgrade = confirmed config-bricking → AUTO-SNAPSHOT is mandatory (PD-5)

The Servarr Wiki carries a **danger callout**: *"You can't go back to a mainline Lidarr
branch (master/develop) without restoring a database backup from before the plugins or
nightly branch."* The plugins build runs **forward-only** DB migrations; stable Lidarr then
fails to start (e.g. `Error parsing column 10 (Protocol=TorrentDownloadProtocol - String)`,
broken Delay Profiles).

**Implication for the installer (do this in setup.sh, gated on the stable→plugins image
transition, first time only):**
```sh
# Before the FIRST launch on the plugins image, snapshot the lidarr config so a user who
# later turns ENABLE_MUSIC_PLUGINS back off can recover (plain "pull stable again" BRICKS it).
cp -a "${INSTALL_DIR}/lidarr/config" "${INSTALL_DIR}/lidarr/config.pre-plugins-<timestamp>"
```
- Pass the timestamp in from the wizard (setup.sh has no `date`-free constraint, but keep it
  consistent with how other backups are stamped).
- The honesty banner must say: **toggling plugins back off requires restoring this snapshot;
  it is not a safe round-trip.**

*Evidence:* `wiki.servarr.com/lidarr/plugins` (danger callout) + source
`github.com/Servarr/Wiki/blob/master/lidarr/plugins.md`; real break in
`youegraillot/lidarr-on-steroids#56`.

---

## 5. ARL acquisition (user-facing docs) + lifetime

- **Get it:** log into deezer.com, open DevTools (F12) → **Application/Storage → Cookies →
  deezer.com** → copy the **value of the cookie named `arl`** (~190–200 chars). Per-browser:
  Chrome/Brave (lock icon → Cookies), Firefox (Storage tab), Safari (Develop → Web Inspector
  → Storage). Must be the same logged-in tab.
- **Lifetime:** long-lived but **not permanent** — community-reported ~3–6 months, and it
  dies immediately on **logout / password change / Deezer security rotation**. Renewal is
  manual (re-paste). Frame a dead Deezer client as "expected eventually, re-paste the
  cookie," not a bug.
- **Free vs HiFi:** a free-account ARL is accepted (the plugin only requires `web_streaming`)
  but limited to MP3; **FLAC needs a paid Deezer HiFi account.**
- **Blank ARL:** schema-optional, and the plugin *used* to auto-pick a public ARL from
  `rentry.org/firehawk52` — but that scraping was **disabled upstream** (Firehawk no longer
  maintained), so in practice **a user ARL is effectively required for any results.** Collect
  it as optional in the form, but the help text should say "leave blank only to experiment;
  you'll almost certainly need your own ARL."

*Evidence:* streamrip wiki "Finding Your Deezer ARL Cookie"; `ARLUtilities.cs` (`IsValid`
checks `web_streaming`, `GetFirstValidARL` scrapes firehawk52); plugin release 10.0.1.10
notes "Disabled ARL scraping."

---

## 6. ToS / honesty banner copy (PD-6)

Downloading from Deezer **violates Deezer's Terms of Use** ("undertake not to reproduce or
extract … the Recordings") and risks **account limiting/banning** (the plugin README itself
warns Deezer is "cracking down"). It's a ToU/civil + account-risk matter. Ship it **opt-in,
off by default, never implied to be sanctioned.**

Suggested banner (factual, brief):
> *This uses an unofficial plugin to download from Deezer. It violates Deezer's Terms of Use
> and may get your Deezer account limited or banned. You need your own Deezer account; HiFi
> is required for lossless. Off by default — enable only if you accept that risk. Turning it
> back off later needs a config restore (see docs).*

*Evidence:* `deezer.com/legal/cgu`; plugin README ban warning; TorrentFreak on Deezer
enforcement history.

---

## 7. Corrected implementation recipe (supersedes plan §2 Phase 2 Step 5)

**M2a — plumbing (buildable now, no live container; fully back-compat):**
1. `docker-compose.yml`: `image: ${LIDARR_IMAGE:-lscr.io/linuxserver/lidarr:latest}` (env
   indirection — zero change to lidarr's env/volumes; hotio is drop-in). *Note:* keep the
   default on **lscr.io** (not docker.io) per the stack's no-Docker-Hub rule.
2. Env keys (`env-render.ts` EnvFormValues + emit, `env-schema.ts`, `wizard.ts` default):
   `ENABLE_MUSIC_PLUGINS` (opt-in, default off), `LIDARR_IMAGE` (derived), `LIDARR_DEEZER_ARL`.
   Derive in `renderEnv`: when `isEnabled(ENABLE_MUSIC_PLUGINS) && isEnabled(ENABLE_LIDARR)`
   → `LIDARR_IMAGE=ghcr.io/hotio/lidarr:pr-plugins`, else `''`.
3. Wizard UI (`ConfigureScreen.tsx`): a "Stable vs Plugins+Deezer" radio under the Lidarr
   block, the optional ARL `PasswordInput`, and the **honesty banner** (§6).
4. `setup.sh`: the **auto-snapshot** (§4) on the stable→plugins transition. No reaper (same
   service/profile/container name).

**M2b — auto-wire (needs ONE live smoke test for the schema casing, then code):**
5. In `setup-arr-config.py`, gated on `is_enabled(env,'ENABLE_MUSIC_PLUGINS')`, AFTER Lidarr
   is healthy:
   a. **Idempotency:** `GET /api/v1/system/plugins`; if Deezer plugin absent →
   b. **Install:** `POST /api/v1/command {"name":"InstallPlugin","githubUrl":".../TrevTV/Lidarr.Plugin.Deezer"}`,
      poll `GET /api/v1/command/{id}` to `completed`.
   c. **Restart + re-wait:** `POST /api/v1/command {"name":"Restart"}`, then re-run the
      Lidarr health-wait (`GET /api/v1/system/status`).
   d. **Indexer (ARL):** `GET /api/v1/indexer/schema`, match `implementation=="Deezer"`, set
      field `arl` = `LIDARR_DEEZER_ARL`, `POST /api/v1/indexer?forceSave=true`.
   e. **Download client:** `GET /api/v1/downloadclient/schema`, match `implementation=="Deezer"`,
      set `downloadPath` (valid in-container path), `POST /api/v1/downloadclient?forceSave=true`.
   - Every call **non-fatal / warn-on-failure** — a plugins-branch API change must never break
     the stable arr config.

---

## 8. Residual blockers — the live smoke-test checklist (the ONLY things needing a container)

Everything above is source-verified. Stand up `ghcr.io/hotio/lidarr:pr-plugins` with the
plugin installed and confirm just these (≈15 min), then M2b is safe to finalize:

- [ ] `GET /api/v1/indexer/schema` & `/downloadclient/schema`: exact field `name` casing/order
      (source says `arl`, `downloadPath`, …, camelCase) and whether `?forceSave=true` is needed.
- [ ] `POST /api/v1/command` accepts `{"name":"InstallPlugin"}` casing on the built image; the
      install actually reaches `completed`; schema entries appear only **after** the Restart.
- [ ] Post-restart re-wait window on slow/NAS hardware (tune the health-wait timeout).
- [ ] `GET /api/v1/system/status` returns 200 for the healthcheck on first boot (pre-keygen
      window) under hotio — low risk (identical line works against lsio today).
- [ ] PUID/PGID/UMASK parity + `${INSTALL_DIR}/lidarr/config` ownership after the image swap.
- [ ] (If a HiFi ARL is available) FLAC release actually appears (`web_lossless`).

## 9. Open product decisions for Doug
- **PD pin vs rolling:** ship `:pr-plugins` (rolling, matches the plugin README) or pin
  `:pr-plugins-<ver>`/digest for reproducibility? Recommend rolling + the overridable
  `LIDARR_IMAGE` escape hatch.
- **PD-3:** ARL optional (recommended — schema allows blank) but help-text it as
  effectively-required.
- **PD-6:** confirm comfort shipping the opt-in Deezer feature with the §6 disclosure.
