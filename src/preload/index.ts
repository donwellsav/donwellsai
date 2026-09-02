import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi, MainEvents } from '../shared/types'

const api: IpcApi = {
  meta: () => ipcRenderer.invoke('meta'),
  listRepos: () => ipcRenderer.invoke('listRepos'),
  addRepo: (dir) => ipcRenderer.invoke('addRepo', dir),
  removeRepo: (repoId) => ipcRenderer.invoke('removeRepo', repoId),
  refreshRepo: (repoId) => ipcRenderer.invoke('refreshRepo', repoId),
  createWorktree: (repoId, opts) => ipcRenderer.invoke('createWorktree', repoId, opts),
  removeWorktree: (repoId, worktreePath) => ipcRenderer.invoke('removeWorktree', repoId, worktreePath),
  openTerminal: (worktreePath, cwd) => ipcRenderer.invoke('openTerminal', worktreePath, cwd),
  closeTerminal: (sessionId) => ipcRenderer.invoke('closeTerminal', sessionId),
  terminalWrite: (sessionId, data) => ipcRenderer.invoke('terminalWrite', sessionId, data),
  terminalResize: (sessionId, cols, rows) => ipcRenderer.invoke('terminalResize', sessionId, cols, rows),
  listAgents: () => ipcRenderer.invoke('listAgents'),
  pickDirectory: () => ipcRenderer.invoke('pickDirectory'),
  on: <K extends keyof MainEvents>(channel: K, cb: (payload: MainEvents[K]) => void) => {
    const listener = (_e: unknown, payload: MainEvents[K]) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('orca', api)