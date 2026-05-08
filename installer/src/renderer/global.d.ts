import type { InstallerApi } from '../preload/index.js'

declare global {
  interface Window {
    installer: InstallerApi
  }
}

export {}
