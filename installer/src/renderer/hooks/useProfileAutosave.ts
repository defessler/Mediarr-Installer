import { useEffect, useRef } from 'react'
import { useWizard } from '../store/wizard.js'
import { reportError } from '../store/errors.js'

/** Mounts at App-level. Whenever the active profile is set and the
 *  user mutates connection/config/targetDir, this hook debounces 600ms
 *  and writes the whole profile back via profile:save. Keeps the
 *  per-NAS settings in sync without the user pressing a Save button.
 */
export function useProfileAutosave() {
  const activeProfileId = useWizard((s) => s.activeProfileId)
  const activeProfileLabel = useWizard((s) => s.activeProfileLabel)
  const connection = useWizard((s) => s.connection)
  const config = useWizard((s) => s.config)
  const targetDir = useWizard((s) => s.targetDir)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstRunRef = useRef(true)

  useEffect(() => {
    if (!activeProfileId) return
    // Skip the very first sync after a profile loads — that "change"
    // is just the load itself, not a user edit.
    if (firstRunRef.current) {
      firstRunRef.current = false
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        // Preserve the user-set label. Only fall back to user@host if
        // the profile somehow lost its label.
        const label = activeProfileLabel ||
          `${connection.user ?? 'root'}@${connection.host ?? '<host>'}`
        await window.installer.profiles.save({
          id: activeProfileId,
          label,
          connection: {
            host: connection.host ?? '',
            port: connection.port ?? 22,
            user: connection.user ?? 'root',
            authMethod: connection.authMethod ?? 'password',
            privateKeyPath: connection.privateKeyPath,
            password: connection.password,
            passphrase: connection.passphrase,
            sudoPassword: connection.sudoPassword,
          },
          targetDir,
          // EnvFormValues is a typed union of optional strings; the
          // profile store accepts a Record<string, string>. Strip
          // undefined entries (so they don't write back as the literal
          // string "undefined") and PLEX_CLAIM specifically (4-min
          // expiry — saving it would restore a stale token next launch).
          config: Object.fromEntries(
            Object.entries(config).filter(
              ([k, v]) => v !== undefined && v !== null && k !== 'PLEX_CLAIM',
            ),
          ) as Record<string, string>,
        })
      } catch (e) {
        reportError('Auto-save profile', e)
      }
    }, 600)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [activeProfileId, activeProfileLabel, connection, config, targetDir])

  // When the active profile changes (user picks a different one), reset
  // the first-run guard so the autosave skips the load.
  useEffect(() => {
    firstRunRef.current = true
  }, [activeProfileId])
}
