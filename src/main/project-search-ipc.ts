import { ipcMain, type WebContents } from 'electron'
import type { GitWorktrees } from './git'
import type { ProjectCodeSearchRequest } from '@shared/project-tools'

export function registerProjectSearchHandlers(git: Pick<GitWorktrees, 'searchWorkspaceContent'>): void {
  const owners = new WeakMap<WebContents, Map<string, AbortController>>()
  const validateId = (id: string): void => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid search request ID')
  }
  ipcMain.handle('searchWorkspaceContent', async (event, path: string, id: string, request: ProjectCodeSearchRequest) => {
    validateId(id)
    let pending = owners.get(event.sender)
    if (!pending) {
      pending = new Map(); owners.set(event.sender, pending)
      const active = pending
      const abortAll = (): void => { for (const controller of active.values()) controller.abort() }
      event.sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) abortAll() })
      event.sender.once('destroyed', abortAll)
    }
    if (pending.has(id) || pending.size >= 4) throw new Error('Search already running; wait for cancellation to finish')
    const controller = new AbortController()
    pending.set(id, controller)
    try {
      return await git.searchWorkspaceContent(path, request, hit => {
        if (!controller.signal.aborted && !event.sender.isDestroyed()) event.sender.send('project-search:hit', { requestId: id, workspacePath: path, hit })
      }, controller.signal)
    } finally { pending.delete(id) }
  })
  ipcMain.handle('cancelWorkspaceContentSearch', (event, id: string) => {
    validateId(id)
    owners.get(event.sender)?.get(id)?.abort()
  })
}
