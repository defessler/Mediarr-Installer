// Native file-save and file-open dialogs. Lives in main because the
// renderer is sandboxed and can't touch the filesystem directly.

import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'

export async function saveTextToFile(args: {
  defaultName: string
  content: string
  title?: string
  filters?: { name: string; extensions: string[] }[]
}): Promise<{ saved: boolean; path: string | null }> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(win, {
    title: args.title ?? 'Save log',
    defaultPath: args.defaultName,
    filters: args.filters ?? [
      { name: 'Log file', extensions: ['log'] },
      { name: 'Text file', extensions: ['txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (result.canceled || !result.filePath) return { saved: false, path: null }
  await fs.writeFile(result.filePath, args.content, 'utf8')
  return { saved: true, path: result.filePath }
}

export async function openTextFromFile(args: {
  title?: string
  filters?: { name: string; extensions: string[] }[]
}): Promise<{ opened: boolean; path: string | null; content: string | null }> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    title: args.title ?? 'Open file',
    properties: ['openFile'],
    filters: args.filters ?? [
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (result.canceled || !result.filePaths?.length) {
    return { opened: false, path: null, content: null }
  }
  const path = result.filePaths[0]
  try {
    const content = await fs.readFile(path, 'utf8')
    return { opened: true, path, content }
  } catch (e) {
    return { opened: false, path, content: null }
  }
}
