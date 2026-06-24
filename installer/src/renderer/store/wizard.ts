import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ConnectionConfig, MigrateState, NasFamily } from '../../shared/ipc.js'
import type { EnvFormValues } from '../../shared/env-render.js'

export type WizardStep =
  | 'welcome'
  | 'connect'
  | 'detect'
  | 'configure'
  | 'run'
  | 'run-update'
  | 'migrate'
  | 'done'

export type WizardMode = 'install' | 'update' | 'migrate'

/** Steps that absolutely need a live SSH session — they execute remote
 *  commands as soon as you land on them. App.tsx redirects to 'connect'
 *  if any of these is reached without a session.
 *
 *  Configure / detect intentionally NOT in this list: the user can edit
 *  profile settings without being connected. detect skips probing when
 *  there's no session, and Configure's SSH-dependent features (e.g. the
 *  user/group dropdown) fall back to manual input. */
export const STEPS_NEEDING_SESSION: WizardStep[] = [
  'run', 'run-update', 'migrate', 'done',
]

interface WizardState {
  step: WizardStep
  setStep: (s: WizardStep) => void

  /** install (full wizard) vs update (skip detect+configure, just pull+up) */
  mode: WizardMode
  setMode: (m: WizardMode) => void

  /** True while a screen is mid-flight on a long remote operation that
   *  must not be interrupted — a setup.sh install (RunScreen), a stack
   *  update (UpdateRunScreen), or a migrate import (MigrateScreen). The
   *  in-place app updater quits the app and swaps its own binary, so
   *  letting the user trigger a self-update during a live SSH job would
   *  kill it mid-run. App.tsx disables the footer "Install vX" trigger
   *  while this is set. Transient — never persisted; each screen sets it
   *  on start and clears it on done/failed/unmount. */
  busy: boolean
  setBusy: (b: boolean) => void

  /** id of the currently-loaded profile. Required to enter the wizard
   *  past the Welcome screen. */
  activeProfileId: string | null
  setActiveProfileId: (id: string | null) => void

  /** Label of the active profile, displayed in the header. */
  activeProfileLabel: string | null
  setActiveProfileLabel: (label: string | null) => void

  /** Connection: persisted via the active profile (not in localStorage). */
  connection: Partial<ConnectionConfig>
  setConnection: (c: Partial<ConnectionConfig>) => void

  sessionId: string | null
  setSessionId: (id: string | null) => void

  /** The .env form values */
  config: Partial<EnvFormValues>
  setConfig: (c: Partial<EnvFormValues>) => void

  /** Wall-clock timestamp (Date.now()) at which the current PLEX_CLAIM
   *  was pasted. The token expires 4 minutes after Plex GENERATED it
   *  (which we can't observe), so this is a best-effort approximation —
   *  but it's far better than restarting from "now" every time the
   *  PlexClaimRefresh widget remounts. Kept here so it survives nav
   *  between Configure → Run idle → Run failed. */
  plexClaimSetAt: number | null

  /** Where on the NAS we install */
  targetDir: string
  setTargetDir: (d: string) => void

  /** NAS family from the most recent environment detect. Transient (not
   *  persisted) — re-detected each session. Lets family-gated UI outside
   *  the Detect screen (e.g. the Help modal) tailor platform-specific
   *  instructions (Synology Task Scheduler vs UGREEN/Linux cron + systemd). */
  nasFamily: NasFamily | null
  setNasFamily: (f: NasFamily | null) => void

  /** INSTALL_DIR / DATA_ROOT an EXISTING install on the scanned NAS is
   *  using (read from its on-NAS .env at detect time), or null when there's
   *  no prior install / no detect has run this session. Transient (not
   *  persisted) — set alongside setNasFamily when env:detect returns.
   *  Lifted out of EnvDetectScreen's local result state so the Configure
   *  screen can show the SAME "relocating an existing install" warning when
   *  the user edits the path there, not only on Detect. */
  existingInstallDir: string | null
  existingDataRoot: string | null
  setDetectExisting: (e: { installDir: string | null; dataRoot: string | null }) => void

  /** MigrateScreen form state — source arr/qBit URLs + creds the user
   *  pasted. Persisted via the active profile (encrypted blob), NOT
   *  localStorage, so credentials don't sit in plaintext. The hook
   *  `useProfileAutosave` writes back when this changes. */
  migrate: MigrateState
  setMigrate: (m: Partial<MigrateState>) => void

  /** Per-profile snapshot of the most recent install run. Persisted so
   *  Welcome can surface "last install failed at step N" on the relevant
   *  profile card after the user closes and re-opens the app — turning a
   *  surprise "I'll just try again" into a deliberate "this failed last
   *  time, here's where; do I retry or fix something first?". Cleared
   *  per-profile when a fresh install succeeds. */
  lastRuns: Record<string, {
    phase: 'failed' | 'done'
    finishedAt: number          // Date.now()
    failedStep?: number         // 1-10 if phase=failed and we parsed a step marker
    exitCode?: number | null    // setup.sh exit code; null if it never finished cleanly
  }>
  recordRunResult: (
    profileId: string,
    result: { phase: 'failed' | 'done'; failedStep?: number; exitCode?: number | null },
  ) => void
  clearRunResult: (profileId: string) => void

  /** Replace the whole wizard state from a freshly-loaded profile. */
  loadFromProfile: (p: {
    id: string
    label: string
    connection: Partial<ConnectionConfig>
    config: Partial<EnvFormValues>
    targetDir: string
    migrate?: MigrateState
  }) => void

  reset: () => void
}

const defaultConfig: Partial<EnvFormValues> = {
  // Service selection defaults — everything on. Users opt OUT individually
  // on the Configure screen. See env-render.ts for the canonical list +
  // what each gates. Profiles created before this field existed simply
  // omit the keys; env-render's isEnabled() treats missing as enabled.
  ENABLE_PLEX: 'true',
  ENABLE_SONARR: 'true',
  ENABLE_RADARR: 'true',
  ENABLE_LIDARR: 'true',
  ENABLE_BAZARR: 'true',
  ENABLE_QBITTORRENT: 'true',
  ENABLE_SABNZBD: 'true',
  ENABLE_HOMEPAGE: 'true',
  ENABLE_RECYCLARR: 'true',
  ENABLE_UNPACKERR: 'true',
  ENABLE_FLARESOLVERR: 'true',
  // Soulseek is OPT-IN — the only default-OFF service. A fresh wizard run
  // therefore renders ENABLE_SOULSEEK=false; the user turns it on
  // explicitly on the Configure screen (it needs Lidarr).
  ENABLE_SOULSEEK: 'false',
  // soularr scan-loop interval (seconds). Only used when Soulseek is on.
  SOULARR_INTERVAL: '300',
  // Playlist Sync (SiriusXM → Plex) is OPT-IN too — default OFF,
  // like Soulseek. A fresh wizard run renders
  // ENABLE_PLAYLIST_SYNC=false; the user opts in on the Configure screen
  // (it needs Plex + its own 2nd free Soulseek account). Schedule/format
  // pre-seeded to their render defaults so the Optional fields show them.
  ENABLE_PLAYLIST_SYNC: 'false',
  PLAYLIST_SYNC_CRON: '0 4 * * *',
  PLAYLIST_PREF_FORMAT: 'flac',

  PUID: '1026',
  PGID: '100',
  TZ: 'America/New_York',
  // Media server: Plex by default (back-compat — existing profiles have
  // no MEDIA_SERVER key and render as plex). The Configure screen lets
  // the user switch to Jellyfin.
  MEDIA_SERVER: 'plex',
  // NAS-portable path defaults. Synology values match the historical
  // baseline so existing profiles round-trip without changes; non-
  // Synology users get a sensible suggestion from EnvDetect's
  // `suggestedInstallDir` / `suggestedDataRoot` which the Configure
  // screen applies when the field is empty.
  INSTALL_DIR: '/volume1/docker/media',
  DATA_ROOT:   '/volume1/Data',
  // VPN is opt-in. setup.sh applies docker-compose.no-vpn.yml unless the
  // user flips this on, in which case it asks for the WireGuard key etc.
  VPN_ENABLED: 'false',
  VPN_PROVIDER: 'nordvpn',
  VPN_TYPE: 'wireguard',
  VPN_COUNTRIES: 'United States',
  QBITTORRENT_USER: 'admin',
}

const defaultConnection: Partial<ConnectionConfig> = {
  port: 22, user: 'root', authMethod: 'password',
}

const DEFAULT_TARGET = '/volume1/docker/media'

export const useWizard = create<WizardState>()(
  persist(
    (set) => ({
      step: 'welcome',
      setStep: (step) => set({ step }),

      mode: 'install',
      setMode: (mode) => set({ mode }),

      busy: false,
      setBusy: (busy) => set({ busy }),

      activeProfileId: null,
      setActiveProfileId: (activeProfileId) => set({ activeProfileId }),

      activeProfileLabel: null,
      setActiveProfileLabel: (activeProfileLabel) => set({ activeProfileLabel }),

      connection: { ...defaultConnection },
      setConnection: (c) => set((s) => ({ connection: { ...s.connection, ...c } })),

      sessionId: null,
      setSessionId: (sessionId) => set({ sessionId }),

      config: defaultConfig,
      setConfig: (c) => set((s) => {
        // Whenever PLEX_CLAIM changes (typed/pasted/cleared), reset
        // its first-seen timestamp so the countdown widget tracks
        // age from THAT moment instead of from component mount.
        const claimChanged =
          Object.prototype.hasOwnProperty.call(c, 'PLEX_CLAIM') &&
          (c as Partial<EnvFormValues>).PLEX_CLAIM !== s.config.PLEX_CLAIM
        const newConfig = { ...s.config, ...c }
        return claimChanged
          ? {
              config: newConfig,
              plexClaimSetAt: (c as Partial<EnvFormValues>).PLEX_CLAIM ? Date.now() : null,
            }
          : { config: newConfig }
      }),
      plexClaimSetAt: null,

      targetDir: DEFAULT_TARGET,
      setTargetDir: (targetDir) => set({ targetDir }),

      nasFamily: null,
      setNasFamily: (nasFamily) => set({ nasFamily }),

      existingInstallDir: null,
      existingDataRoot: null,
      setDetectExisting: ({ installDir, dataRoot }) =>
        set({ existingInstallDir: installDir, existingDataRoot: dataRoot }),

      migrate: {},
      setMigrate: (m) => set((s) => ({ migrate: { ...s.migrate, ...m } })),

      lastRuns: {},
      recordRunResult: (profileId, result) =>
        set((s) => ({
          lastRuns: {
            ...s.lastRuns,
            [profileId]: { ...result, finishedAt: Date.now() },
          },
        })),
      clearRunResult: (profileId) =>
        set((s) => {
          const next = { ...s.lastRuns }
          delete next[profileId]
          return { lastRuns: next }
        }),

      loadFromProfile: (p) => {
        // Backward-compat migration: profiles created before the
        // multi-provider VPN refactor only had NORDVPN_PRIVATE_KEY.
        // Mirror that into the generic WIREGUARD_PRIVATE_KEY slot
        // (and set VPN_PROVIDER=nordvpn if missing) so the new
        // Configure UI shows the key in the right spot and gluetun
        // gets the key under both names. Idempotent: only fires when
        // the new field is empty.
        const incomingConfig: Record<string, string> = { ...p.config }
        if (
          incomingConfig.NORDVPN_PRIVATE_KEY &&
          !incomingConfig.WIREGUARD_PRIVATE_KEY
        ) {
          incomingConfig.WIREGUARD_PRIVATE_KEY = incomingConfig.NORDVPN_PRIVATE_KEY
        }
        if (!incomingConfig.VPN_PROVIDER) {
          incomingConfig.VPN_PROVIDER = 'nordvpn'
        }
        return set({
          activeProfileId: p.id,
          activeProfileLabel: p.label,
          connection: { ...defaultConnection, ...p.connection },
          // Plex claim tokens expire 4 minutes after generation. Persisting
          // them in the profile means a stale token from a previous session
          // is restored on app launch — and the countdown widget would
          // optimistically show "4:00 fresh" because mount-time is taken as
          // the entry time. Strip it on load so the field is empty and the
          // user pastes a fresh one.
          config: { ...defaultConfig, ...incomingConfig, PLEX_CLAIM: undefined },
          plexClaimSetAt: null,
          targetDir: p.targetDir || DEFAULT_TARGET,
          nasFamily: null,    // re-detected when this profile's NAS is scanned
          existingInstallDir: null,  // re-read from the NAS on next detect
          existingDataRoot: null,
          migrate: p.migrate ?? {},
          sessionId: null,    // any prior session is dead now
        })
      },

      reset: () =>
        set({
          step: 'welcome',
          mode: 'install',
          activeProfileId: null,
          activeProfileLabel: null,
          sessionId: null,
          connection: { ...defaultConnection },
          config: defaultConfig,
          plexClaimSetAt: null,
          targetDir: DEFAULT_TARGET,
          nasFamily: null,
          existingInstallDir: null,
          existingDataRoot: null,
          migrate: {},
        }),
    }),
    {
      name: 'nas-installer-wizard',
      // Profiles are now the source of truth for connection + config.
      // We persist only the lightweight bits: which profile was active
      // (so it re-hydrates) and the per-profile run-result map.
      // Connection / config come back via profile:load when the wizard
      // re-launches. We deliberately DON'T persist `step` or `mode` —
      // the app always opens on the Welcome (Start) tab so the user picks
      // a profile + Install/Update/Migrate fresh each launch, rather than
      // being dropped mid-flow into a stale step with no SSH session.
      partialize: (s) => ({
        activeProfileId: s.activeProfileId,
        activeProfileLabel: s.activeProfileLabel,
        // Persist the per-profile run result map so the WelcomeScreen
        // can flag "last install failed at step N" on the affected
        // profile card after an app restart. Small bounded shape: one
        // tiny object per profile, cleared when a fresh install
        // succeeds — no risk of unbounded growth.
        lastRuns: s.lastRuns,
      }),
      // Force the entry point on every rehydrate. Belt-and-suspenders:
      // even a localStorage blob written by an OLDER app version (which
      // DID persist step/mode) gets normalised back to the Start tab in
      // install mode, so "always start at the start tab" holds across the
      // upgrade boundary too.
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<WizardState>),
        step: 'welcome',
        mode: 'install',
        busy: false,
      }),
    },
  ),
)
