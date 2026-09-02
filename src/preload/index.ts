import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi, MainEvents } from '../shared/types'

const api: IpcApi = {
  meta: () => ipcRenderer.invoke('meta'),
  listRepos: () => ipcRenderer.invoke('listRepos'),
  addRepo: (dir) => ipcRenderer.invoke('addRepo', dir),
  removeRepo: (repoId) => ipcRenderer.invoke('removeRepo', repoId),
  refreshRepo: (repoId) => ipcRenderer.invoke('refreshRepo', repoId),
  createWorktree: (repoId, opts) => ipcRenderer.invoke('createWorktree', repoId, opts),
  removeWorktree: (repoId, worktreePath, force) => ipcRenderer.invoke('removeWorktree', repoId, worktreePath, force),
  openTerminal: (worktreePath, cwd) => ipcRenderer.invoke('openTerminal', worktreePath, cwd),
  attachTerminal: (sessionId) => ipcRenderer.invoke('attachTerminal', sessionId),
  closeTerminal: (sessionId) => ipcRenderer.invoke('closeTerminal', sessionId),
  terminalSessions: () => ipcRenderer.invoke('terminalSessions'),
  terminalWrite: (sessionId, data) => ipcRenderer.invoke('terminalWrite', sessionId, data),
  terminalResize: (sessionId, cols, rows) => ipcRenderer.invoke('terminalResize', sessionId, cols, rows),
  terminalInterrupt: (sessionId) => ipcRenderer.invoke('terminalInterrupt', sessionId),
  gitStatus: (worktreePath) => ipcRenderer.invoke('gitStatus', worktreePath),
  listFiles: (worktreePath, prefix) => ipcRenderer.invoke('listFiles', worktreePath, prefix),
  readFile: (worktreePath, relPath) => ipcRenderer.invoke('readFile', worktreePath, relPath),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  getWorkspaceSession: () => ipcRenderer.invoke('getWorkspaceSession'),
  saveWorkspaceSession: (ws) => ipcRenderer.invoke('saveWorkspaceSession', ws),
  setSettings: (patch) => ipcRenderer.invoke('setSettings', patch),
  listAgents: () => ipcRenderer.invoke('listAgents'),
  pickDirectory: () => ipcRenderer.invoke('pickDirectory'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  on: <K extends keyof MainEvents>(channel: K, cb: (payload: MainEvents[K]) => void) => {
    const listener = (_e: unknown, payload: MainEvents[K]) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('orca', api)