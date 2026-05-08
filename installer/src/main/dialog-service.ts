// Native file-save dialog. Lives in main because the renderer is sandboxed
// and can't touch the filesystem directly.

import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'

export async function saveTextToFile(args: {
  defaultName: string
  content: string
  title?: string
}): Promise<{ saved: boolean; path: string | null }> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(win, {
    title: args.title ?? 'Save log',
    defaultPath: args.defaultName,
    filters: [
      { name: 'Log file', extensions: ['log'] },
      { name: 'Text file', extensions: ['txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (result.canceled || !result.filePath) return { saved: false, path: null }
  await fs.writeFile(result.filePath, args.content, 'utf8')
  return { saved: true, path: result.filePath }
}
