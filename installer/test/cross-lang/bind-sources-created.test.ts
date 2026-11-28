import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { NAS_SCRIPTS } from '../helpers/shell.js'

// Every host folder docker-compose.yml bind-mounts has to exist before
// `compose up`, because Synology's Docker refuses a missing bind source
// instead of creating it:
//
//   Error response from daemon: Bind mount failed:
//   '/volume1/docker/media/readmeabook/redis' does not exist
//
// v0.33.0 shipped exactly that, twice over (redis, then cache), and the
// install stopped at Step 6. Docker Desktop and most other NAS builds DO
// create the folder, so no dev box ever showed it.
//
// The rule this pins: each ${INSTALL_DIR}/... or ${DATA_ROOT}/... source in
// compose is created by setup-folders.sh, either named outright or as a
// parent of a folder it names (mkdir -p makes the parents). Files under
// scripts/ are the uploaded payload itself, not folders, so they're exempt.

const compose = readFileSync(resolve(NAS_SCRIPTS, 'docker-compose.yml'), 'utf8')
const folders = readFileSync(resolve(NAS_SCRIPTS, 'setup-folders.sh'), 'utf8')

function composeSources(): string[] {
  const out = new Set<string>()
  // `      - ${INSTALL_DIR}/x/config:/config` and the DATA_ROOT form. Comment
  // lines are skipped so an example in prose can't satisfy or fail the rule.
  for (const line of compose.split('\n')) {
    if (/^\s*#/.test(line)) continue
    const m = line.match(/^\s*-\s*\$\{(INSTALL_DIR|DATA_ROOT)\}(\/[^:\s]*)?:/)
    if (m) out.add(`$${m[1]}${m[2] ?? ''}`)
  }
  return [...out]
}

function createdFolders(): string[] {
  return [...folders.matchAll(/"(\$(?:INSTALL_DIR|DATA_ROOT)\/[^"]+)"/g)].map((m) => m[1])
}

describe('compose bind sources are created by setup-folders.sh', () => {
  const sources = composeSources()
  const created = createdFolders()

  it('finds the mounts it is meant to check', () => {
    // Guards the regex. If compose changes shape and nothing matches, every
    // assertion below would pass against an empty list.
    expect(sources.length).toBeGreaterThan(30)
    expect(sources).toContain('$INSTALL_DIR/readmeabook/redis')
    expect(created.length).toBeGreaterThan(30)
  })

  it.each(sources.filter((s) => !s.startsWith('$INSTALL_DIR/scripts/')))('%s exists before compose up', (src) => {
    const made = created.some((c) => c === src || c.startsWith(src + '/'))
    expect(made, `${src} is bind-mounted in docker-compose.yml but setup-folders.sh never creates it. Synology will refuse to start the container.`).toBe(true)
  })

  it('the scripts/ files it skips really are payload files', () => {
    for (const src of sources.filter((s) => s.startsWith('$INSTALL_DIR/scripts/'))) {
      const name = src.slice('$INSTALL_DIR/scripts/'.length)
      expect(existsSync(resolve(NAS_SCRIPTS, name)), `${name} is mounted from scripts/ but isn't in nas/scripts`).toBe(true)
    }
  })
})
