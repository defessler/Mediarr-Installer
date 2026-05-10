// SSH non-interactive shells on Synology DSM use a stripped-down PATH
// that doesn't include /usr/local/bin or the Docker package install
// dirs. Every command we run remotely needs to prepend these for
// `docker`, `docker compose`, and `docker-compose` to be findable.
//
// Both the renderer (RunScreen, UpdateRunScreen, DoneScreen) and the
// main process (env-detector) compose this in front of their commands.

export const SYNOLOGY_DOCKER_PATH =
  '/usr/local/bin:/usr/local/sbin:' +
  '/var/packages/ContainerManager/target/usr/bin:' +
  '/var/packages/Docker/target/usr/bin'

/** Bash snippet that prepends Synology Docker dirs to PATH. Suitable
 *  for prefixing any remote bash command. */
export const PATH_PREFIX =
  `export PATH="${SYNOLOGY_DOCKER_PATH}:$PATH" && `
