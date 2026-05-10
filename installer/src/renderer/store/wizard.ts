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

interface WizardState {
  step: WizardStep
  setStep: (s: WizardStep) => void

  /** install (full wizard) vs update (skip detect+configure, just pull+up) */
  mode: WizardMode
  setMode: (m: WizardMode) => void

  /** Connection: persisted minus the password */
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

export const useWizard = create<WizardState>()(
  persist(
    (set) => ({
      step: 'welcome',
      setStep: (step) => set({ step }),

      mode: 'install',
      setMode: (mode) => set({ mode }),

      connection: { port: 22, user: 'root', authMethod: 'password' },
      setConnection: (c) => set((s) => ({ connection: { ...s.connection, ...c } })),

      sessionId: null,
      setSessionId: (sessionId) => set({ sessionId }),

      config: defaultConfig,
      setConfig: (c) => set((s) => ({ config: { ...s.config, ...c } })),

      targetDir: '/volume1/docker/media',
      setTargetDir: (targetDir) => set({ targetDir }),

      reset: () =>
        set({
          step: 'welcome',
          mode: 'install',
          sessionId: null,
          connection: { port: 22, user: 'root', authMethod: 'password' },
          config: defaultConfig,
          targetDir: '/volume1/docker/media',
        }),
    }),
    {
      name: 'nas-installer-wizard',
      // Persist EVERYTHING the user typed — including passwords, API
      // keys, and the SSH password. Per user request: "save all the
      // information I type in, including passwords."
      //
      // SECURITY TRADEOFF: Zustand persist writes to localStorage,
      // which is plaintext on disk inside the app's userData folder
      // (%APPDATA%/nas-arr-installer/Local Storage/...). Anyone with
      // read access to the user's profile directory can read these
      // values. Since this is a personal-use installer running on the
      // user's own machine, that's acceptable — but DON'T copy the
      // userData folder around or share it.
      //
      // For SSH credentials, the connection-profile feature in
      // ConnectScreen offers a separately encrypted store (via
      // Electron safeStorage). That's the right home for long-term
      // creds. This in-store persistence is only the "remember what I
      // typed last time" convenience.
      partialize: (s) => ({
        step: s.step,
        mode: s.mode,
        connection: s.connection,   // includes password, passphrase, sudoPassword
        config: s.config,           // includes all secrets
        targetDir: s.targetDir,
      }),
    },
  ),
)
