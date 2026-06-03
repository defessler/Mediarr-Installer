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

/** Save-dialog for a binary artifact that's written by the CALLER (e.g. an
 *  SFTP download), not by this helper. Returns the chosen path so the caller
 *  can stream bytes into it. Cancels return { saved:false, path:null }. */
export async function chooseSavePath(args: {
  defaultName: string
  title?: string
  filters?: { name: string; extensions: string[] }[]
}): Promise<{ saved: boolean; path: string | null }> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(win, {
    title: args.title ?? 'Save file',
    defaultPath: args.defaultName,
    filters: args.filters ?? [{ name: 'All files', extensions: ['*'] }],
  })
  if (result.canceled || !result.filePath) return { saved: false, path: null }
  return { saved: true, path: result.filePath }
}

/** Cap how large a file we'll ever slurp into memory through this
 *  helper. 10 MB is wildly more than any text config we read here
 *  (profile exports are a few KB), so this only matters if the user
 *  picked the wrong file by mistake — better to fail fast than OOM
 *  the main process trying to load their 8 GB ISO. */
const MAX_OPEN_TEXT_BYTES = 10 * 1024 * 1024

export async function openTextFromFile(args: {
  title?: string
  filters?: { name: string; extensions: string[] }[]
}): Promise<{ opened: boolean; path: string | null; content: string | null; error?: string }> {
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
    const stat = await fs.stat(path)
    if (stat.size > MAX_OPEN_TEXT_BYTES) {
      return {
        opened: false,
        path,
        content: null,
        error: `File is ${(stat.size / (1024 * 1024)).toFixed(1)} MB — too large (cap is ${MAX_OPEN_TEXT_BYTES / (1024 * 1024)} MB).`,
      }
    }
    const content = await fs.readFile(path, 'utf8')
    return { opened: true, path, content }
  } catch (e) {
    return { opened: false, path, content: null, error: (e as Error).message }
  }
}
