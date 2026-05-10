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
      setConfig: (c) => set((s) => ({ config: { ...s.config, ...c } })),

      targetDir: DEFAULT_TARGET,
      setTargetDir: (targetDir) => set({ targetDir }),

      loadFromProfile: (p) => set({
        activeProfileId: p.id,
        activeProfileLabel: p.label,
        connection: { ...defaultConnection, ...p.connection },
        // Plex claim tokens expire 4 minutes after generation. Persisting
        // them in the profile means a stale token from a previous session
        // is restored on app launch — and the countdown widget would
        // optimistically show "4:00 fresh" because mount-time is taken as
        // the entry time. Strip it on load so the field is empty and the
        // user pastes a fresh one.
        config: { ...defaultConfig, ...p.config, PLEX_CLAIM: undefined },
        targetDir: p.targetDir || DEFAULT_TARGET,
        sessionId: null,    // any prior session is dead now
      }),

      reset: () =>
        set({
          step: 'welcome',
          mode: 'install',
          activeProfileId: null,
          activeProfileLabel: null,
          sessionId: null,
          connection: { ...defaultConnection },
          config: defaultConfig,
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
