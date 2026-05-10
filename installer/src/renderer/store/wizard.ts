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

/** Steps that need an active SSH session. App.tsx redirects to 'connect'
 *  if any of these is reached without a session. */
export const STEPS_NEEDING_SESSION: WizardStep[] = [
  'detect', 'configure', 'run', 'run-update', 'done',
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
        connection: { ...defaultConnection, ...p.connection },
        config: { ...defaultConfig, ...p.config },
        targetDir: p.targetDir || DEFAULT_TARGET,
        sessionId: null,    // any prior session is dead now
      }),

      reset: () =>
        set({
          step: 'welcome',
          mode: 'install',
          activeProfileId: null,
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
      }),
    },
  ),
)
