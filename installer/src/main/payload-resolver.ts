// Locate the bundled `nas-payload/` directory at runtime. In dev it
// lives in `installer/resources/nas-payload/`; in a packaged build it
// is copied to `process.resourcesPath/nas-payload/` by electron-builder.

import { app } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const __dirname_main = dirname(fileURLToPath(import.meta.url))

export function payloadDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'nas-payload')
  }
  // dev: out/main/index.js is the running file; payload is at ../../resources/nas-payload
  return join(__dirname_main, '..', '..', 'resources', 'nas-payload')
}

export function payloadSha(): string | null {
  const f = join(payloadDir(), '.payload-sha')
  if (!existsSync(f)) return null
  try {
    return readFileSync(f, 'utf8').trim()
  } catch {
    return null
  }
}
