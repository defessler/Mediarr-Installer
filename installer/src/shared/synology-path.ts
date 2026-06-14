// SSH non-interactive shells on NAS units use a stripped-down PATH that
// doesn't include /usr/local/bin or the Docker package install dirs. Every
// command we run remotely needs to prepend these for `docker`, `docker
// compose`, and `docker-compose` to be findable.
//
// Both the renderer (RunScreen, UpdateRunScreen, DoneScreen) and the main
// process (env-detector) compose this in front of their commands — keep
// this in sync with the detect-time PATH in env-detector.ts. It MUST cover
// QNAP's Container Station bin dirs too, otherwise a QNAP box passes the
// detect probe (which uses the wider PATH) but then setup.sh can't find
// docker under a narrower deploy PATH.

export const SYNOLOGY_DOCKER_PATH =
  '/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin:' +
  '/var/packages/ContainerManager/target/usr/bin:' +
  '/var/packages/Docker/target/usr/bin:' +
  '/share/CACHEDEV1_DATA/.qpkg/container-station/bin:' +
  '/share/.qpkg/container-station/bin'

/** Bash snippet that prepends Synology Docker dirs to PATH. Suitable
 *  for prefixing any remote bash command. */
export const PATH_PREFIX =
  `export PATH="${SYNOLOGY_DOCKER_PATH}:$PATH" && `
