import { validateSettingsPatch, validateSettingsResetRequest } from './settings'

export type CommandField = {
  name: string
  kind: 'string' | 'text' | 'path' | 'string-list' | 'object' | 'integer' | 'number' | 'boolean' | 'enum' | 'toggle'
  required: boolean
  flag?: string
  min?: number
  max?: number
  options?: readonly string[]
}
export type CommandSpec = {
  name: string
  method: string
  summary: string
  fields: readonly CommandField[]
  effect: 'read' | 'write' | 'delete' | 'execute'
  mode?: 'settings' | 'selector' | 'sidebar'
}

export const RPC_COMMANDS: readonly CommandSpec[] = [
  {"name":"tool-list","method":"tool.list","summary":"List admitted project tools and availability","fields":[{"name":"workspacePath","kind":"path","required":true}],"effect":"read"},
  {"name":"tool-start","method":"tool.start","summary":"Start an admitted project tool","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true}],"effect":"execute"},
  {"name":"tool-stop","method":"tool.stop","summary":"Stop an owned project tool","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true}],"effect":"execute"},
  {"name":"tool-call","method":"tool.call","summary":"Call an admitted project tool operation","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"operation","kind":"string","required":true},{"name":"arguments","kind":"object","required":true}],"effect":"execute"},
  {"name":"status","method":"status.get","summary":"Show application status","fields":[],"effect":"read"},
  {"name":"meta","method":"meta.get","summary":"Show runtime identity and capabilities","fields":[],"effect":"read"},
  {"name":"repo-list","method":"repo.list","summary":"List repositories","fields":[],"effect":"read"},
  {"name":"repo-add","method":"repo.add","summary":"Add a repository or folder","fields":[{"name":"dir","kind":"path","required":true}],"effect":"write"},
  {"name":"repo-remove","method":"repo.remove","summary":"Remove a repository bookmark","fields":[{"name":"repoId","kind":"string","required":true}],"effect":"delete"},
  {"name":"wt-create","method":"worktree.create","summary":"Create a worktree","fields":[{"name":"repoId","kind":"string","required":true},{"name":"name","kind":"string","required":false},{"name":"branch","kind":"string","required":false,"flag":"branch"}],"effect":"write"},
  {"name":"wt-remove","method":"worktree.remove","summary":"Move a worktree to recoverable trash","fields":[{"name":"repoId","kind":"string","required":true},{"name":"worktreePath","kind":"path","required":true},{"name":"force","kind":"boolean","required":false,"flag":"force"}],"effect":"delete"},
  {"name":"term-open","method":"terminal.open","summary":"Open an interactive terminal","fields":[{"name":"cwd","kind":"path","required":true}],"effect":"execute"},
  {"name":"term-write","method":"terminal.write","summary":"Write to an exact terminal","fields":[{"name":"sessionId","kind":"string","required":true},{"name":"data","kind":"text","required":true},{"name":"enter","kind":"boolean","required":false,"flag":"enter"}],"effect":"execute"},
  {"name":"term-list","method":"terminal.list","summary":"List terminal sessions","fields":[],"effect":"read"},
  {"name":"term-close","method":"terminal.close","summary":"Close an exact terminal session","fields":[{"name":"sessionId","kind":"string","required":true}],"effect":"delete"},
  {"name":"term-resize","method":"terminal.resize","summary":"Resize a terminal","fields":[{"name":"sessionId","kind":"string","required":true},{"name":"cols","kind":"integer","required":true,"min":2,"max":1000},{"name":"rows","kind":"integer","required":true,"min":1,"max":1000}],"effect":"write"},
  {"name":"term-interrupt","method":"terminal.interrupt","summary":"Interrupt an exact terminal session","fields":[{"name":"sessionId","kind":"string","required":true}],"effect":"execute"},
  {"name":"git-status","method":"git.status","summary":"Read source-control status","fields":[{"name":"worktreePath","kind":"path","required":true}],"effect":"read"},
  {"name":"file-list","method":"file.list","summary":"List a workspace directory","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"directory","kind":"text","required":false},{"name":"showHidden","kind":"boolean","required":false,"flag":"hidden"},{"name":"includeIgnored","kind":"boolean","required":false,"flag":"ignored"}],"effect":"read"},
  {"name":"file-read","method":"file.read","summary":"Read a confined workspace file","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":true}],"effect":"read"},
  {"name":"file-write","method":"file.write","summary":"Write a full file against an exact source revision","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":true},{"name":"expectedRevision","kind":"string","required":true,"flag":"revision"},{"name":"content","kind":"text","required":true,"flag":"content"}],"effect":"write"},
  {"name":"settings-get","method":"settings.get","summary":"Read effective settings","fields":[],"effect":"read"},
  {"name":"settings-set","method":"settings.set","summary":"Apply a validated JSON settings patch","fields":[],"effect":"write","mode":"settings"},
  {"name":"settings-reset","method":"settings.reset","summary":"Reset exact setting keys or one section from JSON","fields":[],"effect":"write","mode":"settings"},
  {"name":"file-search","method":"file.search","summary":"Search bounded workspace files","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"query","kind":"text","required":false},{"name":"maxResults","kind":"integer","required":false,"flag":"limit","min":1,"max":100},{"name":"showHidden","kind":"boolean","required":false,"flag":"hidden"},{"name":"includeIgnored","kind":"boolean","required":false,"flag":"ignored"}],"effect":"read"},
  {"name":"file-create","method":"file.create","summary":"Create an exact file or directory without overwrite","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"path","kind":"string","required":true},{"name":"kind","kind":"enum","required":false,"flag":"kind","options":["file","dir"]},{"name":"content","kind":"text","required":false,"flag":"content"}],"effect":"write"},
  {"name":"file-move","method":"file.move","summary":"Move a confined file or directory without overwrite","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"sourcePath","kind":"string","required":true},{"name":"destinationPath","kind":"string","required":true}],"effect":"write"},
  {"name":"file-duplicate","method":"file.duplicate","summary":"Duplicate a confined file or directory","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"sourcePath","kind":"string","required":true},{"name":"destinationPath","kind":"string","required":true}],"effect":"write"},
  {"name":"file-delete","method":"file.delete","summary":"Delete an exact confined workspace entry","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"path","kind":"string","required":true}],"effect":"delete"},
  {"name":"git-stage","method":"git.stage","summary":"Stage exact paths with per-path results","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"paths","kind":"string-list","required":true}],"effect":"write"},
  {"name":"git-unstage","method":"git.unstage","summary":"Unstage exact paths with per-path results","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"paths","kind":"string-list","required":true}],"effect":"write"},
  {"name":"git-discard","method":"git.discard","summary":"Discard exact working-tree paths","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"paths","kind":"string-list","required":true}],"effect":"delete"},
  {"name":"git-commit","method":"git.commit","summary":"Commit staged changes","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"message","kind":"text","required":true},{"name":"amend","kind":"boolean","required":false,"flag":"amend"}],"effect":"write"},
  {"name":"git-fetch","method":"git.fetch","summary":"Fetch configured remotes","fields":[{"name":"worktreePath","kind":"path","required":true}],"effect":"write"},
  {"name":"git-push","method":"git.push","summary":"Push the current branch to its configured upstream","fields":[{"name":"worktreePath","kind":"path","required":true}],"effect":"execute"},
  {"name":"git-pull","method":"git.pull","summary":"Fast-forward the current branch from its upstream","fields":[{"name":"worktreePath","kind":"path","required":true}],"effect":"write"},
  {"name":"git-branches","method":"git.branches","summary":"Read authoritative branch state","fields":[{"name":"worktreePath","kind":"path","required":true}],"effect":"read"},
  {"name":"git-checkout","method":"git.checkout","summary":"Switch to an exact branch","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"branch","kind":"string","required":true}],"effect":"write"},
  {"name":"git-branch-create","method":"git.branch.create","summary":"Create and switch to a branch","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"branch","kind":"string","required":true},{"name":"startPoint","kind":"string","required":false,"flag":"from"}],"effect":"write"},
  {"name":"git-history","method":"git.history","summary":"Read a bounded commit history page","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"cursor","kind":"string","required":false,"flag":"cursor"},{"name":"limit","kind":"integer","required":false,"flag":"limit","min":1,"max":100}],"effect":"read"},
  {"name":"git-diff","method":"git.diff","summary":"Read a confined path diff","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":true}],"effect":"read"},
  {"name":"browser-list","method":"browser.list","summary":"List persistent browser panes","fields":[],"effect":"read"},
  {"name":"browser-open","method":"browser.open","summary":"Open an HTTP(S) browser pane","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"url","kind":"string","required":true}],"effect":"write"},
  {"name":"browser-navigate","method":"browser.navigate","summary":"Navigate an exact browser pane","fields":[{"name":"key","kind":"string","required":true},{"name":"url","kind":"string","required":true}],"effect":"write"},
  {"name":"browser-snapshot","method":"browser.snapshot","summary":"Read a browser page snapshot","fields":[{"name":"key","kind":"string","required":true}],"effect":"read"},
  {"name":"browser-eval","method":"browser.eval","summary":"Execute JavaScript in an exact browser pane","fields":[{"name":"key","kind":"string","required":true},{"name":"js","kind":"text","required":true}],"effect":"execute"},
  {"name":"browser-back","method":"browser.back","summary":"Back an exact browser pane","fields":[{"name":"key","kind":"string","required":true}],"effect":"write"},
  {"name":"browser-forward","method":"browser.forward","summary":"Forward an exact browser pane","fields":[{"name":"key","kind":"string","required":true}],"effect":"write"},
  {"name":"browser-reload","method":"browser.reload","summary":"Reload an exact browser pane","fields":[{"name":"key","kind":"string","required":true}],"effect":"write"},
  {"name":"browser-history-list","method":"browser.history.list","summary":"List bounded local browser history","fields":[],"effect":"read"},
  {"name":"browser-history-record","method":"browser.history.record","summary":"Record a successful HTTP(S) browser visit","fields":[{"name":"url","kind":"string","required":true},{"name":"title","kind":"text","required":true}],"effect":"write"},
  {"name":"browser-history-clear","method":"browser.history.clear","summary":"Clear local browser history","fields":[],"effect":"delete"},
  {"name":"ui-state","method":"ui.state","summary":"Read the workspace UI state","fields":[],"effect":"read"},
  {"name":"ui-activate","method":"ui.activate","summary":"Activate an exact workspace path or repository ID","fields":[{"name":"worktreePath","kind":"path","required":false},{"name":"repoId","kind":"string","required":false}],"effect":"write","mode":"selector"},
  {"name":"ui-terminal","method":"ui.terminal.open","summary":"Open a terminal pane","fields":[{"name":"worktreePath","kind":"path","required":true}],"effect":"execute"},
  {"name":"ui-split","method":"ui.split","summary":"Split the active terminal","fields":[{"name":"worktreePath","kind":"path","required":true}],"effect":"execute"},
  {"name":"ui-focus","method":"ui.pane.focus","summary":"Focus an exact pane","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"key","kind":"string","required":true}],"effect":"write"},
  {"name":"ui-close-pane","method":"ui.pane.close","summary":"Hide an exact pane without stopping its process","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"key","kind":"string","required":true}],"effect":"write"},
  {"name":"ui-resize","method":"ui.pane.resize","summary":"Resize a workspace split","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"splitId","kind":"integer","required":true,"min":0,"max":1000},{"name":"pct","kind":"number","required":true,"min":10,"max":90}],"effect":"write"},
  {"name":"ui-preview","method":"ui.preview.open","summary":"Open a file preview","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":true}],"effect":"write"},
  {"name":"ui-preview-close","method":"ui.preview.close","summary":"Close a file preview","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":false}],"effect":"write"},
  {"name":"ui-diff","method":"ui.diff.open","summary":"Open a file comparison","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":true}],"effect":"write"},
  {"name":"ui-sidebar","method":"ui.sidebar","summary":"Control a sidebar","fields":[{"name":"side","kind":"enum","required":true,"options":["left","right"]},{"name":"open","kind":"toggle","required":false},{"name":"tab","kind":"enum","required":false,"options":["explorer","git","memory","recovery"]},{"name":"width","kind":"integer","required":false,"min":160,"max":720}],"effect":"write","mode":"sidebar"},
  {"name":"ui-palette","method":"ui.palette","summary":"Control the command palette","fields":[{"name":"open","kind":"toggle","required":false},{"name":"mode","kind":"enum","required":false,"flag":"mode","options":["commands","files"]}],"effect":"write"},
  {"name":"ui-settings","method":"ui.settings.open","summary":"Open a settings section","fields":[{"name":"section","kind":"enum","required":false,"options":["agents","editor","source-control","browser","appearance","terminal","shortcuts","notifications","privacy","advanced"]}],"effect":"write"},
  {"name":"ui-runs","method":"ui.runs.open","summary":"Open supervision and operational runs","fields":[{"name":"section","kind":"enum","required":false,"options":["agents","automations","orchestration"]}],"effect":"write"},
  {"name":"editor-open","method":"ui.editor.open","summary":"Open an editable file","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":true}],"effect":"write"},
  {"name":"editor-write","method":"ui.editor.write","summary":"Change an editor buffer through guarded saving","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":true},{"name":"content","kind":"text","required":true}],"effect":"write"},
  {"name":"editor-read","method":"ui.editor.read","summary":"Read an editor buffer","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":false}],"effect":"read"},
  {"name":"ui-workspace-flush","method":"ui.workspace.flush","summary":"Explicitly save dirty editor buffers and workspace layout","fields":[],"effect":"write"},
  {"name":"agent-providers","method":"agent.providers","summary":"Discover supported and locally available agent CLIs","fields":[],"effect":"read"},
  {"name":"agent-list","method":"agent.list","summary":"List current and recently observed agent runs","fields":[],"effect":"read"},
  {"name":"agent-start","method":"agent.start","summary":"Start an agent in an authorized local workspace","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"command","kind":"text","required":false},{"name":"launch","kind":"object","required":false,"flag":"launch"}],"effect":"execute"},
  {"name":"agent-interrupt","method":"agent.interrupt","summary":"Interrupt an exact live agent run","fields":[{"name":"sessionId","kind":"string","required":true}],"effect":"execute"},
  {"name":"agent-dismiss","method":"agent.dismiss","summary":"Dismiss an exited agent run","fields":[{"name":"sessionId","kind":"string","required":true}],"effect":"delete"},
  {"name":"agent-deliver","method":"agent.deliver","summary":"Deliver a confirmed plain-text attachment to an exact agent","fields":[{"name":"sessionId","kind":"string","required":true},{"name":"workspacePath","kind":"path","required":true},{"name":"kind","kind":"enum","required":true,"options":["diff-review","design-capture"]},{"name":"title","kind":"string","required":true},{"name":"text","kind":"text","required":true},{"name":"submit","kind":"boolean","required":false,"flag":"submit"},{"name":"confirmed","kind":"boolean","required":true,"flag":"confirm"}],"effect":"execute"},
  {"name":"skill-list","method":"skill.list","summary":"List skill consumers or packages for one exact target","fields":[{"name":"workspacePath","kind":"path","required":false},{"name":"providerId","kind":"enum","required":false,"options":["codex","claude","opencode"]}],"effect":"read"},
  {"name":"skill-prepare","method":"skill.prepare","summary":"Prepare and inspect a skill package install plan","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"providerId","kind":"enum","required":true,"options":["codex","claude","opencode"]},{"name":"localSource","kind":"path","required":false,"flag":"source-path"},{"name":"sourceUrl","kind":"string","required":false,"flag":"source-url"},{"name":"sourceKind","kind":"enum","required":false,"flag":"source-kind","options":["https","git"]},{"name":"revision","kind":"string","required":false,"flag":"revision"},{"name":"subpath","kind":"string","required":false,"flag":"subpath"}],"effect":"execute"},
  {"name":"skill-apply","method":"skill.apply","summary":"Apply an exact confirmed install or update plan","fields":[{"name":"planId","kind":"string","required":true},{"name":"confirmationToken","kind":"string","required":true}],"effect":"write"},
  {"name":"skill-read","method":"skill.read","summary":"Read a bounded managed skill package file","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"providerId","kind":"enum","required":true,"options":["codex","claude","opencode"]},{"name":"name","kind":"string","required":true},{"name":"path","kind":"string","required":false}],"effect":"read"},
  {"name":"skill-read-legacy","method":"skill.readLegacy","summary":"Read a bounded preserved legacy skill document","fields":[{"name":"id","kind":"string","required":true}],"effect":"read"},
  {"name":"skill-prepare-update","method":"skill.prepareUpdate","summary":"Prepare an update plan for one managed skill package","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"providerId","kind":"enum","required":true,"options":["codex","claude","opencode"]},{"name":"name","kind":"string","required":true}],"effect":"execute"},
  {"name":"skill-prepare-remove","method":"skill.prepareRemove","summary":"Prepare a guarded removal plan for one managed skill package","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"providerId","kind":"enum","required":true,"options":["codex","claude","opencode"]},{"name":"name","kind":"string","required":true}],"effect":"read"},
  {"name":"skill-remove","method":"skill.remove","summary":"Apply an exact confirmed skill package removal plan","fields":[{"name":"planId","kind":"string","required":true},{"name":"confirmationToken","kind":"string","required":true}],"effect":"delete"},
  {"name":"scheduled-list","method":"scheduled.list","summary":"List scheduled run definitions","fields":[],"effect":"read"},
  {"name":"scheduled-save","method":"scheduled.save","summary":"Create or update a validated scheduled run","fields":[{"name":"input","kind":"object","required":true}],"effect":"write"},
  {"name":"scheduled-enable","method":"scheduled.enable","summary":"Enable or disable an exact scheduled run","fields":[{"name":"id","kind":"string","required":true},{"name":"enabled","kind":"boolean","required":true,"flag":"enabled"}],"effect":"write"},
  {"name":"scheduled-duplicate","method":"scheduled.duplicate","summary":"Duplicate an exact scheduled run","fields":[{"name":"id","kind":"string","required":true}],"effect":"write"},
  {"name":"scheduled-delete","method":"scheduled.delete","summary":"Delete an exact scheduled run","fields":[{"name":"id","kind":"string","required":true}],"effect":"delete"},
  {"name":"scheduled-run","method":"scheduled.run","summary":"Start an exact scheduled run now","fields":[{"name":"id","kind":"string","required":true}],"effect":"execute"},
  {"name":"scheduled-cancel","method":"scheduled.cancel","summary":"Cancel an exact scheduled execution","fields":[{"name":"executionId","kind":"string","required":true}],"effect":"execute"},
  {"name":"scheduled-history","method":"scheduled.history","summary":"List bounded execution history for a scheduled run","fields":[{"name":"id","kind":"string","required":true}],"effect":"read"},
  {"name":"parallel-list","method":"parallel.list","summary":"List parallel runs","fields":[],"effect":"read"},
  {"name":"parallel-start","method":"parallel.start","summary":"Start a validated bounded parallel run","fields":[{"name":"input","kind":"object","required":true}],"effect":"execute"},
  {"name":"parallel-retry","method":"parallel.retry","summary":"Retry exact tasks from one parallel run","fields":[{"name":"id","kind":"string","required":true},{"name":"taskIds","kind":"string-list","required":true}],"effect":"execute"},
  {"name":"parallel-cancel","method":"parallel.cancel","summary":"Cancel an exact parallel run","fields":[{"name":"id","kind":"string","required":true}],"effect":"execute"},
  {"name":"parallel-delete","method":"parallel.delete","summary":"Delete an exact parallel run","fields":[{"name":"id","kind":"string","required":true}],"effect":"delete"},
  {"name":"diff-review-list","method":"diffReview.list","summary":"List review notes for one exact diff target","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"filePath","kind":"string","required":true},{"name":"comparison","kind":"enum","required":true,"options":["working","staged","unstaged"]}],"effect":"read"},
  {"name":"diff-review-create","method":"diffReview.create","summary":"Create an anchored note against an exact diff snapshot","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"filePath","kind":"string","required":true},{"name":"comparison","kind":"enum","required":true,"options":["working","staged","unstaged"]},{"name":"snapshot","kind":"object","required":true},{"name":"anchor","kind":"object","required":true},{"name":"body","kind":"text","required":true}],"effect":"write"},
  {"name":"diff-review-update","method":"diffReview.update","summary":"Update an exact review note revision","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"expectedRevision","kind":"integer","required":true,"min":1},{"name":"body","kind":"text","required":true}],"effect":"write"},
  {"name":"diff-review-remove","method":"diffReview.remove","summary":"Remove an exact review note revision","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"expectedRevision","kind":"integer","required":true,"min":1}],"effect":"delete"},
  {"name":"memory-list","method":"memory.list","summary":"Search shared project memory","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"query","kind":"text","required":false},{"name":"kinds","kind":"string-list","required":false,"flag":"kinds"},{"name":"includeArchived","kind":"boolean","required":false,"flag":"archived"},{"name":"limit","kind":"integer","required":false,"flag":"limit","min":1,"max":200}],"effect":"read"},
  {"name":"memory-get","method":"memory.get","summary":"Read an exact project memory entry","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true}],"effect":"read"},
  {"name":"memory-create","method":"memory.create","summary":"Record attributed project knowledge","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"kind","kind":"enum","required":true,"options":["fact","decision","convention","procedure","gotcha"]},{"name":"title","kind":"string","required":true,"max":256},{"name":"content","kind":"text","required":true,"max":64000},{"name":"tags","kind":"string-list","required":false,"flag":"tags"},{"name":"attribution","kind":"object","required":true,"flag":"attribution"}],"effect":"write"},
  {"name":"memory-update","method":"memory.update","summary":"Replace project knowledge against its exact revision","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"expectedRevision","kind":"integer","required":true,"flag":"revision","min":1},{"name":"kind","kind":"enum","required":true,"options":["fact","decision","convention","procedure","gotcha"]},{"name":"title","kind":"string","required":true,"max":256},{"name":"content","kind":"text","required":true,"max":64000},{"name":"tags","kind":"string-list","required":false,"flag":"tags"},{"name":"attribution","kind":"object","required":true,"flag":"attribution"}],"effect":"write"},
  {"name":"memory-history","method":"memory.history","summary":"Read bounded memory revision history","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"limit","kind":"integer","required":false,"flag":"limit","min":1,"max":33}],"effect":"read"},
  {"name":"memory-archive","method":"memory.archive","summary":"Archive or restore an exact memory revision","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"expectedRevision","kind":"integer","required":true,"flag":"revision","min":1},{"name":"archived","kind":"boolean","required":true,"flag":"archived"},{"name":"attribution","kind":"object","required":true,"flag":"attribution"}],"effect":"write"}
]

const commandsByName = new Map(RPC_COMMANDS.map(command => [command.name, command]))
const commandsByMethod = new Map(RPC_COMMANDS.map(command => [command.method, command]))
if (commandsByName.size !== RPC_COMMANDS.length || commandsByMethod.size !== RPC_COMMANDS.length) {
  throw new Error('Command catalog contains a duplicate name or method')
}

const forbiddenJsonKeys = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 100_000
const MAX_JSON_ARRAY = 4_096

export function findCommand(name: string): CommandSpec | undefined {
  return commandsByName.get(name) ?? commandsByMethod.get(name)
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateJsonObject(value: unknown, label: string): void {
  if (!isObject(value)) throw new Error('Invalid object parameter: ' + label)
  const seen = new Set<object>()
  let nodes = 0
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_JSON_NODES) throw new Error('Object parameter is too large: ' + label)
    if (candidate === null || typeof candidate === 'boolean') return
    if (typeof candidate === 'string') {
      if (candidate.includes('\0') || candidate.length > 4 * 1024 * 1024) throw new Error('Invalid object text: ' + label)
      return
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('Invalid object number: ' + label)
      return
    }
    if (typeof candidate !== 'object' || depth >= MAX_JSON_DEPTH || seen.has(candidate)) {
      throw new Error('Invalid or excessively nested object parameter: ' + label)
    }
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_JSON_ARRAY) throw new Error('Object array is too large: ' + label)
      for (const item of candidate) visit(item, depth + 1)
      return
    }
    const prototype = Object.getPrototypeOf(candidate)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Object parameter must contain plain JSON: ' + label)
    for (const [key, item] of Object.entries(candidate)) {
      if (!key || key.length > 16 * 1024 || forbiddenJsonKeys.has(key)) throw new Error('Invalid object key: ' + label)
      visit(item, depth + 1)
    }
  }
  visit(value, 0)
}

function validateCrossFields(method: string, params: Record<string, unknown>): void {
  if (method === 'skill.list') {
    const targets = Number(params.workspacePath !== undefined) + Number(params.providerId !== undefined)
    if (targets !== 0 && targets !== 2) throw new Error('workspacePath and providerId must be supplied together')
  }
  if (method === 'skill.prepare') {
    const local = params.localSource !== undefined
    const remote = params.sourceUrl !== undefined
    if (Number(local) + Number(remote) !== 1) throw new Error('Choose exactly one --source-path or --source-url')
    if (local && (params.sourceKind !== undefined || params.revision !== undefined || params.subpath !== undefined)) {
      throw new Error('Local sources do not accept source kind, revision, or subpath')
    }
    if (remote && params.sourceKind === undefined) throw new Error('--source-kind is required with --source-url')
    if (params.sourceKind === 'https' && (params.revision !== undefined || params.subpath !== undefined)) {
      throw new Error('HTTPS sources do not accept revision or subpath')
    }
  }
  if (method === 'agent.deliver' && params.confirmed !== true) {
    throw new Error('Agent delivery requires explicit --confirm')
  }
}

export function validateCommandParams(method: string, input: unknown): Record<string, unknown> {
  const command = commandsByMethod.get(method)
  if (!command) throw new Error('Unknown command: ' + method)
  if (!isObject(input)) throw new Error('Command parameters must be a JSON object')
  if (method === 'settings.set') return validateSettingsPatch(input)
  if (method === 'settings.reset') return { ...validateSettingsResetRequest(input) }

  const params: Record<string, unknown> = {}
  for (const key of Object.keys(input)) {
    if (forbiddenJsonKeys.has(key)) throw new Error('Invalid parameter: ' + key)
    if (!command.fields.some(field => field.name === key)) throw new Error('Unknown parameter: ' + key)
    params[key] = input[key]
  }
  if (method === 'ui.settings.open' && (params.section === 'automations' || params.section === 'orchestration')) {
    throw new Error('Operational runs moved out of settings; use ui.runs.open')
  }
  for (const field of command.fields) {
    let value = params[field.name]
    if (value === undefined) {
      if (field.required) throw new Error('Missing parameter: ' + field.name)
      continue
    }
    switch (field.kind) {
      case 'string':
      case 'text':
      case 'path':
        if (typeof value !== 'string' || (field.kind !== 'text' && !value.trim()) || value.includes('\0') || value.length > (field.kind === 'text' ? 4 * 1024 * 1024 : 16 * 1024)) throw new Error('Invalid text parameter: ' + field.name)
        if (field.kind === 'path' && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) throw new Error('Expected an absolute path: ' + field.name)
        break
      case 'string-list':
        if (!Array.isArray(value) || value.length < (field.min ?? 1) || value.length > (field.max ?? 4096) || value.some(item => typeof item !== 'string' || !item || item.includes('\0') || item.length > 16 * 1024)) throw new Error('Invalid string list: ' + field.name)
        if (new Set(value).size !== value.length) throw new Error('Duplicate value in ' + field.name)
        break
      case 'object':
        validateJsonObject(value, field.name)
        break
      case 'integer':
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value) || (field.kind === 'integer' && !Number.isSafeInteger(value)) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) throw new Error('Invalid numeric parameter: ' + field.name)
        break
      case 'boolean':
        if (typeof value !== 'boolean') throw new Error('Invalid boolean parameter: ' + field.name)
        break
      case 'enum':
        if (typeof value !== 'string' || !field.options?.includes(value)) throw new Error('Invalid ' + field.name + '; expected ' + field.options?.join(', '))
        break
      case 'toggle':
        if (value === 'open') value = true
        if (value === 'close') value = false
        if (value !== true && value !== false && value !== 'toggle') throw new Error('Invalid toggle: ' + field.name)
        params[field.name] = value
        break
    }
  }
  if (command.mode === 'selector' && Number(params.worktreePath !== undefined) + Number(params.repoId !== undefined) !== 1) throw new Error('Choose exactly one worktreePath or repoId')
  validateCrossFields(method, params)
  if (method === 'terminal.write') {
    if (params.enter === true) params.data = String(params.data) + '\r'
    delete params.enter
  }
  return params
}
