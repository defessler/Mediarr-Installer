# Design: Always-on broadcast radio stations (AzuraCast)

Date: 2026-06-15
Status: approved (brainstorm), implementing

## Goal

Let the user create named 24/7 broadcast "stations" ("The Pulse", "Chill",
"90s") that auto-DJ their own NAS music library with crossfades and tune in like
SiriusXM. Chosen tool (researched, both agents agreed): **AzuraCast** — the only
single-container option with a web UI for the user to build stations themselves
(auto-DJ, crossfade, Icecast streams, web player). Honest tradeoff: heavy
(~1.4 GB image, 2 GB RAM floor / 4 GB recommended, bundles its own
MariaDB/Redis/Nginx/Liquidsoap). Therefore: **OFF by default, opt-in**, gated
behind a clear "heavier service" notice. The installer stands the container up +
wires library access/ports/permissions/Homepage/firewall + a wiki guide; the
**user builds the actual stations in AzuraCast's own web UI** (exactly like they
set up Plex).

## CANONICAL VALUES (every file MUST use these exact values — consistency is the whole game)

- Opt-in flag: **`ENABLE_AZURACAST`** — explicit-true ONLY (`is_optin_enabled` /
  `isOptInEnabled`), missing key = OFF, default `'false'`. Mirror `ENABLE_SOULSEEK`
  EXACTLY in all four layers (setup.sh, setup-arr-config.py, env-render.ts,
  env-schema.ts) + wizard.ts default + ConfigureScreen toggle. This is the
  load-bearing invariant — a pre-AzuraCast `.env` must stay OFF everywhere.
- Compose profile: **`radio`** (added to COMPOSE_PROFILES only when the flag is
  explicit-true). NOT coupled to `vpn` (AzuraCast must be LAN-reachable for
  listeners — it does NOT go in gluetun's namespace).
- Image: **`ghcr.io/azuracast/azuracast:stable`** (off Docker Hub, per convention;
  pinned `stable`, NOT `latest`/rolling). Omit the `updater` sidecar.
- Web UI port: **`${AZURACAST_HTTP_PORT:-49157}`**, bound `${LAN_IP}:49157`.
  Also set `AZURACAST_HTTPS_PORT=49158` to keep it off 80/443.
- Stream ports: **`${LAN_IP}:8000-8029:8000-8029`** (trimmed range — ~3 stations
  of Icecast+Liquidsoap triplets; deliberately clear of Jellyfin's 8096 and
  FlareSolverr's 8191).
- Container runs as **UID/GID 1000** (its own; does NOT honor PUID/PGID).
- Persistence (bind mounts, NOT anon volumes, so the Update flow can't wipe the
  DB/stations): `${INSTALL_DIR}/azuracast/{station_data,db_data,www_uploads,backups}`
  mapped to AzuraCast's official container paths (use the upstream
  docker-compose.sample.yml as the source of truth for the exact targets —
  station_data→/var/azuracast/stations, db_data→/var/lib/mysql, plus the rest).
- Library mount (read-only, neutral path so it's not station-name-coupled):
  **`${DATA_ROOT}/Media/Music:/mnt/music:ro`**. The user adds a *Storage Location*
  in AzuraCast pointing at `/mnt/music` and assigns a station to it.
- `ulimits: nofile 65536/65536`; `networks: [media]`; `restart: unless-stopped`;
  `logging: *logging`.

## Per-file changes (mirror the shipped Soulseek "new service recipe")

1. **docker-compose.yml** — one `azuracast` service from the canonical values,
   based on AzuraCast's official single-`web`-service sample (omit `updater`).
   `docker-compose.no-vpn.yml`: NO change (AzuraCast isn't VPN-coupled).
2. **setup.sh** — `is_optin_enabled ENABLE_AZURACAST` → `PROFILES+=("radio")`
   (no vpn coupling); `stop_disabled_services` pair `azuracast:ENABLE_AZURACAST`;
   `wait_for_services` += azuracast (opt-in gated); `check_port_conflicts` +=
   azuracast:49157 (+ 8000) gated on the opt-in.
3. **setup-folders.sh** — create `${INSTALL_DIR}/azuracast/{station_data,db_data,www_uploads,backups}`
   and **chown 1000:1000** (NOT PUID/PGID — AzuraCast's own UID), gated on the
   opt-in. Document the divergence.
4. **setup-firewall.sh** — open 49157 + the 8000-8029 stream range on the LAN
   subnet, gated on explicit-true ENABLE_AZURACAST; mirror in the remove path.
5. **setup-arr-config.py** — Homepage tile in `render_homepage_services`:
   "AzuraCast" → `http://{ip}:49157`, "Internet radio (your stations)", gated
   `is_optin_enabled(env, 'ENABLE_AZURACAST')`.
6. **env-render.ts** — `ENABLE_AZURACAST` + `AZURACAST_HTTP_PORT` in EnvFormValues;
   renderEnv emits `ENABLE_AZURACAST` via `isOptInEnabled` (NOT isEnabled) + the port.
7. **env-schema.ts** — `ENABLE_AZURACAST: optStr`, `AZURACAST_HTTP_PORT: optStr`.
8. **wizard.ts** — `defaultConfig`: `ENABLE_AZURACAST: 'false'`, `AZURACAST_HTTP_PORT: '49157'`.
9. **ConfigureScreen.tsx** — `SERVICE_TOGGLES` entry (key ENABLE_AZURACAST, label
   "AzuraCast", hint "24/7 radio stations from your library — heavier service",
   a Radio/broadcast icon). Use `isOptInEnabled` for its on-state (it's opt-in,
   like Soulseek). A short "heavier service (~1.4 GB, wants 2–4 GB RAM)" note.
10. **.env.example** — `ENABLE_AZURACAST=false` (in the opt-in area) + an
    `AZURACAST_HTTP_PORT=49157` + a dedicated section explaining it.
11. **docs/MUSIC-RADIO.md** — the user guide: what it is + the weight heads-up;
    first-run (create the admin account in the web UI at :49157); add a Storage
    Location at `/mnt/music` (read-only); create a station ("The Pulse"), set
    AutoDJ + crossfade, build a playlist; tune in (web player / `http://NAS:8000/radio.mp3`);
    troubleshooting (re-scan after mount, the UID-1000 permission note, ports).
    Cross-link from MUSIC-PLAYBACK.md.

## Non-negotiables

- **Never default-on.** Missing `ENABLE_AZURACAST` = OFF in every layer. Verified
  before ship (the same adversarial opt-in check used for Soulseek).
- **Never break the install.** It's an opt-in profile; nothing changes for users
  who don't enable it.
- **Dual-copy discipline** is handled by the build's copy-payload step.
- **Idempotent + gated**; ports/paths/flag identical across all files.

## User-facing reality (documented, not hidden)

- The installer brings AzuraCast up; the USER creates the admin + stations +
  playlists in AzuraCast's web UI (no headless pre-seed of the admin).
- AzuraCast ignores PUID/PGID (runs UID 1000); its install dir is chown'd 1000.
- Heavy: ~1.4 GB image, 2 GB RAM floor; best on a 4–8 GB NAS.
- External read-only library mounts can need a manual re-scan + occasionally hit
  "Nonexistent file" errors — documented with the fix.
