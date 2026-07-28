import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASH, NAS_SCRIPTS, extractShellFunc, runBash, withEnvFile } from '../helpers/shell.js'

// recyclarr-trigger and librarian are a stock python image plus one
// bind-mounted .py file. `docker compose up -d` does NOT recreate a container
// when the CONTENTS of a bind mount change, because that isn't part of the
// container's config — so a wizard run uploaded a new librarian.py and the
// running python carried on executing the copy it read at startup.
//
// That shipped, and it pinned a live install several releases behind: the page
// still rendered the v0.21 layout while the file on disk was current, with
// nothing anywhere reporting a problem. setup.sh now restarts these services
// after uploading scripts, and this pins that it keeps doing so.

const SETUP_SH = join(NAS_SCRIPTS, 'setup.sh')

/** Run the REAL reload_script_sidecars with docker + compose stubbed out, and
 *  report which services it tried to restart. */
function reload(env: Record<string, string>, opts: { present?: string[]; failOn?: string } = {}) {
  const present = opts.present ?? ['recyclarr-trigger', 'librarian']
  const program = [
    extractShellFunc(SETUP_SH, 'env_val'),
    extractShellFunc(SETUP_SH, 'is_optin_enabled'),
    extractShellFunc(SETUP_SH, 'reload_script_sidecars'),
    // Stubs stand in for docker/compose. `inspect` succeeds only for the
    // containers we say exist; `restart` records what it was asked to bounce.
    `fake_runtime() {`,
    `  if [ "$1" = "inspect" ]; then`,
    `    case " ${present.join(' ')} " in *" $2 "*) return 0 ;; *) return 1 ;; esac`,
    `  fi`,
    `}`,
    // The real call is silenced with >/dev/null 2>&1, so the stub has to
    // record what it saw out-of-band rather than by printing.
    `RESTART_LOG=$(mktemp)`,
    `fake_compose() {`,
    `  shift $(( $# - 2 ))   # drop the compose flags, leaving: restart <svc>`,
    `  echo "RESTART:$2" >> "$RESTART_LOG"`,
    opts.failOn ? `  [ "$2" != "${opts.failOn}" ]` : `  :`,
    `}`,
    `CONTAINER_RUNTIME=fake_runtime`,
    `COMPOSE=fake_compose`,
    `COMPOSE_QUIET_FLAGS=--quiet`,
    `COMPOSE_FILES="-f docker-compose.yml"`,
    `reload_script_sidecars`,
    `cat "$RESTART_LOG"`,
  ].join('\n')

  const rendered = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  const { path, cleanup } = withEnvFile(rendered)
  try {
    const r = runBash(program, { env: { ENV_FILE: path } })
    const restarted = [...r.stdout.matchAll(/RESTART:(\S+)/g)].map((m) => m[1])
    return { restarted, stdout: r.stdout }
  } finally {
    cleanup()
  }
}

// The tests below drive the function directly, which proves it works but not
// that anything calls it. That's the half that would regress silently, so pin
// the wiring too: it has to run inside start_stack, AFTER `up -d` (restarting
// before compose brings the container up would just bounce the old one).
describe('reload_script_sidecars is wired into the startup path', () => {
  it('is called from start_stack, after up -d', () => {
    const src = readFileSync(SETUP_SH, 'utf8').replace(/\r\n/g, '\n')
    const body = src.slice(src.indexOf('\nstart_stack() {'))
    const upAt = body.indexOf('up -d')
    const callAt = body.indexOf('\n    reload_script_sidecars')
    expect(upAt, 'no `up -d` inside start_stack').toBeGreaterThan(-1)
    expect(callAt, 'start_stack never calls reload_script_sidecars').toBeGreaterThan(-1)
    expect(callAt, 'the reload must come after `up -d`').toBeGreaterThan(upAt)
  })
})

describe.skipIf(!BASH)('setup.sh reloads the bind-mounted script sidecars', () => {
  it('restarts librarian when the storage report is enabled', () => {
    const { restarted, stdout } = reload({ ENABLE_LIBRARIAN: 'true' })
    expect(restarted).toContain('librarian')
    expect(restarted).toContain('recyclarr-trigger')
    expect(stdout).toMatch(/Reloaded librarian/)
  })

  it('leaves librarian alone when it is not installed', () => {
    // Opt-in semantics: absent and explicit-false both mean off, and
    // restarting a service that isn't in the project would just error.
    for (const env of [{}, { ENABLE_LIBRARIAN: 'false' }, { ENABLE_LIBRARIAN: '0' }]) {
      const { restarted } = reload(env)
      expect(restarted, `for ${JSON.stringify(env)}`).not.toContain('librarian')
      expect(restarted, `for ${JSON.stringify(env)}`).toContain('recyclarr-trigger')
    }
  })

  it('skips a container that does not exist yet', () => {
    const { restarted } = reload({ ENABLE_LIBRARIAN: 'true' }, { present: ['recyclarr-trigger'] })
    expect(restarted).toEqual(['recyclarr-trigger'])
  })

  it('a sidecar that will not restart warns and does not abort the run', () => {
    const { restarted, stdout } = reload({ ENABLE_LIBRARIAN: 'true' }, { failOn: 'recyclarr-trigger' })
    expect(stdout).toMatch(/Couldn't restart recyclarr-trigger/)
    // The failure must not stop librarian from being reloaded too.
    expect(restarted).toContain('librarian')
    expect(stdout).toMatch(/Reloaded librarian/)
  })
})
