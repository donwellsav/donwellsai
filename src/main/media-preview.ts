import { ipcMain, type WebContents } from 'electron'
import { validateBinaryPreviewGeneration, validateBinaryPreviewRequest } from '@shared/media-preview'
import type { GitWorktrees } from './git'

export function registerMediaPreviewHandlers(git: GitWorktrees): void {
  const requests = new WeakMap<WebContents, Map<number, AbortController>>()

  function pendingFor(sender: WebContents): Map<number, AbortController> {
    const existing = requests.get(sender)
    if (existing) return existing
    const pending = new Map<number, AbortController>()
    requests.set(sender, pending)
    const abortAll = (): void => {
      for (const controller of pending.values()) controller.abort()
      pending.clear()
    }
    sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) abortAll()
    })
    sender.once('destroyed', () => {
      abortAll()
      requests.delete(sender)
    })
    return pending
  }

  ipcMain.handle('readBinaryPreview', async (event, workspacePath: string, input: unknown) => {
    const request = validateBinaryPreviewRequest(input)
    const pending = pendingFor(event.sender)
    pending.get(request.generation)?.abort()
    const controller = new AbortController()
    pending.set(request.generation, controller)
    try {
      return await git.readBinaryPreview(workspacePath, request, controller.signal)
    } finally {
      if (pending.get(request.generation) === controller) pending.delete(request.generation)
    }
  })

  ipcMain.handle('cancelBinaryPreview', (event, generation: number) => {
    validateBinaryPreviewGeneration(generation)
    const pending = requests.get(event.sender)
    pending?.get(generation)?.abort()
    pending?.delete(generation)
  })
}
