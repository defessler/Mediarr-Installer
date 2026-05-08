import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ConnectionConfig } from '../../shared/ipc.js'
import type { EnvFormValues } from '../../shared/env-render.js'

export type WizardStep = 'connect' | 'detect' | 'configure' | 'run' | 'done'

interface WizardState {
  step: WizardStep
  setStep: (s: WizardStep) => void

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
  VPN_PROVIDER: 'nordvpn',
  VPN_TYPE: 'wireguard',
  VPN_COUNTRIES: 'United States',
  QBITTORRENT_USER: 'admin',
}

export const useWizard = create<WizardState>()(
  persist(
    (set) => ({
      step: 'connect',
      setStep: (step) => set({ step }),

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
          step: 'connect',
          sessionId: null,
          connection: { port: 22, user: 'root', authMethod: 'password' },
          config: defaultConfig,
          targetDir: '/volume1/docker/media',
        }),
    }),
    {
      name: 'nas-installer-wizard',
      // Never persist secrets or session-bound state.
      partialize: (s) => ({
        connection: {
          host: s.connection.host,
          port: s.connection.port,
          user: s.connection.user,
          authMethod: s.connection.authMethod,
          privateKeyPath: s.connection.privateKeyPath,
        },
        // Drop ALL secret fields from persistence — they live in memory
        // only. We keep only PUID/PGID/TZ/LAN_IP/VPN_PROVIDER/VPN_TYPE/
        // VPN_COUNTRIES/QBITTORRENT_USER/ARR_USERNAME, which are
        // non-sensitive convenience defaults.
        config: {
          PUID: s.config.PUID,
          PGID: s.config.PGID,
          TZ: s.config.TZ,
          LAN_IP: s.config.LAN_IP,
          VPN_PROVIDER: s.config.VPN_PROVIDER,
          VPN_TYPE: s.config.VPN_TYPE,
          VPN_COUNTRIES: s.config.VPN_COUNTRIES,
          QBITTORRENT_USER: s.config.QBITTORRENT_USER,
          ARR_USERNAME: s.config.ARR_USERNAME,
        },
        targetDir: s.targetDir,
      }),
    },
  ),
)
