import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ConnectionConfig } from '../../shared/ipc.js'
import type { EnvFormValues } from '../../shared/env-render.js'

export type WizardStep =
  | 'welcome'
  | 'connect'
  | 'detect'
  | 'configure'
  | 'run'
  | 'run-update'
  | 'done'

export type WizardMode = 'install' | 'update'

/** Steps that absolutely need a live SSH session — they execute remote
 *  commands as soon as you land on them. App.tsx redirects to 'connect'
 *  if any of these is reached without a session.
 *
 *  Configure / detect intentionally NOT in this list: the user can edit
 *  profile settings without being connected. detect skips probing when
 *  there's no session, and Configure's SSH-dependent features (e.g. the
 *  user/group dropdown) fall back to manual input. */
export const STEPS_NEEDING_SESSION: WizardStep[] = [
  'run', 'run-update', 'done',
]

interface WizardState {
  step: WizardStep
  setStep: (s: WizardStep) => void

  /** install (full wizard) vs update (skip detect+configure, just pull+up) */
  mode: WizardMode
  setMode: (m: WizardMode) => void

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

  /** Replace the whole wizard state from a freshly-loaded profile. */
  loadFromProfile: (p: {
    id: string
    label: string
    connection: Partial<ConnectionConfig>
    config: Partial<EnvFormValues>
    targetDir: string
  }) => void

  reset: () => void
}

const defaultConfig: Partial<EnvFormValues> = {
  PUID: '1026',
  PGID: '100',
  TZ: 'America/New_York',
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
        }),
    }),
    {
      name: 'nas-installer-wizard',
      // Profiles are now the source of truth for connection + config.
      // We only persist the lightweight bits: which step the user was on,
      // which mode, and which profile was active. Connection / config
      // come back via profile:load when the wizard re-launches.
      partialize: (s) => ({
        step: s.step,
        mode: s.mode,
        activeProfileId: s.activeProfileId,
        activeProfileLabel: s.activeProfileLabel,
      }),
    },
  ),
)
