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
  scanWorktree: (worktreePath) => ipcRenderer.invoke('scanWorktree', worktreePath),
  terminalResize: (sessionId, cols, rows) => ipcRenderer.invoke('terminalResize', sessionId, cols, rows),
  terminalInterrupt: (sessionId) => ipcRenderer.invoke('terminalInterrupt', sessionId),
  gitStatus: (worktreePath) => ipcRenderer.invoke('gitStatus', worktreePath),
  gitStage: (worktreePath, paths) => ipcRenderer.invoke('gitStage', worktreePath, paths),
  gitUnstage: (worktreePath, paths) => ipcRenderer.invoke('gitUnstage', worktreePath, paths),
  gitDiscard: (worktreePath, paths) => ipcRenderer.invoke('gitDiscard', worktreePath, paths),
  gitCommit: (worktreePath, message) => ipcRenderer.invoke('gitCommit', worktreePath, message),
  gitPush: (worktreePath) => ipcRenderer.invoke('gitPush', worktreePath),
  gitPull: (worktreePath) => ipcRenderer.invoke('gitPull', worktreePath),
  gitBranches: (worktreePath) => ipcRenderer.invoke('gitBranches', worktreePath),
  gitCheckout: (worktreePath, branch) => ipcRenderer.invoke('gitCheckout', worktreePath, branch),
  gitDiff: (worktreePath, relPath) => ipcRenderer.invoke('gitDiff', worktreePath, relPath),
  listFiles: (worktreePath, prefix) => ipcRenderer.invoke('listFiles', worktreePath, prefix),
  listAllFiles: (worktreePath) => ipcRenderer.invoke('listAllFiles', worktreePath),
  readFile: (worktreePath, relPath) => ipcRenderer.invoke('readFile', worktreePath, relPath),
  writeFile: (worktreePath, relPath, content) => ipcRenderer.invoke('writeFile', worktreePath, relPath, content),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  getWorkspaceSession: () => ipcRenderer.invoke('getWorkspaceSession'),
  saveWorkspaceSession: (ws) => ipcRenderer.invoke('saveWorkspaceSession', ws),
  setSettings: (patch) => ipcRenderer.invoke('setSettings', patch),
  listAgents: () => ipcRenderer.invoke('listAgents'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  pickDirectory: () => ipcRenderer.invoke('pickDirectory'),
  secretSet: (key, value) => ipcRenderer.invoke('secretSet', key, value),
  secretGet: (key) => ipcRenderer.invoke('secretGet', key),
  secretDelete: (key) => ipcRenderer.invoke('secretDelete', key),
  secretAvailable: () => ipcRenderer.invoke('secretAvailable'),
  skillsList: () => ipcRenderer.invoke('skillsList'),
  skillsInstall: (source) => ipcRenderer.invoke('skillsInstall', source),
  skillsRemove: (name) => ipcRenderer.invoke('skillsRemove', name),
  automationsList: () => ipcRenderer.invoke('automationsList'),
  automationSave: (a) => ipcRenderer.invoke('automationSave', a),
  automationRemove: (id) => ipcRenderer.invoke('automationRemove', id),
  automationRunNow: (id) => ipcRenderer.invoke('automationRunNow', id),
  automationRuns: (id) => ipcRenderer.invoke('automationRuns', id),
  orchestrationList: () => ipcRenderer.invoke('orchestrationList'),
  orchestrationStart: (name, command, paths, parallel) => ipcRenderer.invoke('orchestrationStart', name, command, paths, parallel),
  orchestrationCancel: (id) => ipcRenderer.invoke('orchestrationCancel', id),
  setAttention: (on) => ipcRenderer.send('attention', on),
  onBrowserCommand: (cb) => {
    const listener = (_e: unknown, env: { id: string; cmd: import('@shared/types').BrowserCommand }) => cb(env)
    ipcRenderer.on('browser:command', listener)
    return () => ipcRenderer.removeListener('browser:command', listener)
  },
  resolveBrowserCommand: (id, result) => ipcRenderer.send('browser:command:result', id, result),
  browserRegisterPanes: (keys) => ipcRenderer.send('browser:register-panes', keys),
  onUiCommand: (cb) => {
    const listener = (_e: unknown, env: { id: string; cmd: import('@shared/types').UiCommand }) => cb(env)
    ipcRenderer.on('ui:command', listener)
    return () => ipcRenderer.removeListener('ui:command', listener)
  },
  resolveUiCommand: (id, result) => ipcRenderer.send('ui:command:result', id, result),
  on: <K extends keyof MainEvents>(channel: K, cb: (payload: MainEvents[K]) => void) => {
    const listener = (_e: unknown, payload: MainEvents[K]) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('orca', api)