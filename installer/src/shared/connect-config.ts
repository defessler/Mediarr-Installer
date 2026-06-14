import type { ConnectionConfig } from './ipc.js'

/** Build the argument for ssh.connect() / ssh.testConnect() from a persisted,
 *  possibly-partial connection record.
 *
 *  Single source of truth shared by the INITIAL connect (ConnectScreen) and the
 *  RECONNECT-and-resume flow (RunScreen) so the two can never drift apart.
 *
 *  Semantics (unchanged from the original ConnectScreen.commonConfig):
 *   - password is only sent in 'password' auth mode;
 *   - private key path / passphrase only in 'privateKey' mode;
 *   - sudoPassword only matters for a non-root user, and falls back to the SSH
 *     password (most Synology boxes share one for login + sudo). */
export function toConnectConfig(connection: Partial<ConnectionConfig>) {
  const user = connection.user ?? 'root'
  const authMethod = connection.authMethod ?? 'password'
  const password = connection.password ?? ''
  const passphrase = connection.passphrase ?? ''
  const sudoPassword = connection.sudoPassword ?? ''
  return {
    host: connection.host ?? '',
    port: connection.port ?? 22,
    user,
    authMethod,
    password: authMethod === 'password' ? password : undefined,
    privateKeyPath: authMethod === 'privateKey' ? connection.privateKeyPath : undefined,
    passphrase: authMethod === 'privateKey' ? passphrase : undefined,
    sudoPassword: user !== 'root'
      ? (sudoPassword || (authMethod === 'password' ? password : undefined))
      : undefined,
  } as const
}
