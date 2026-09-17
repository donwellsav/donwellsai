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
  ...(['status', 'query', 'reconcile', 'stop'] as const).map(action => ({ name: `temporal-${action}`, method: `temporal.${action}`, summary: `${action} selected project temporal relationships`, fields: [{ name: 'workspacePath', kind: 'path' as const, required: true }, ...(action === 'query' ? [{ name: 'query', kind: 'text' as const, required: true }, { name: 'asOf', kind: 'string' as const, required: false }] : action === 'reconcile' ? [{ name: 'selection', kind: 'object' as const, required: true }] : [])], effect: action === 'status' || action === 'query' ? 'read' as const : 'execute' as const })),
  ...(['status', 'recall', 'reflect', 'reconcile', 'stop'] as const).map(action => ({ name: `knowledge-${action}`, method: `knowledge.${action}`, summary: `${action} selected project learned knowledge`, fields: [{ name: 'workspacePath', kind: 'path' as const, required: true }, ...(['recall', 'reflect'].includes(action) ? [{ name: 'query', kind: 'text' as const, required: true }] : action === 'reconcile' ? [{ name: 'selection', kind: 'object' as const, required: true }] : [])], effect: action === 'status' || action === 'recall' ? 'read' as const : 'execute' as const })),

  { name: 'agent-authenticate', method: 'agent.authenticate', summary: 'Validate a live agent credential for its exact workspace', fields: [{ name: 'workspacePath', kind: 'path', required: true }, { name: 'credential', kind: 'object', required: true }], effect: 'read' },
  { name: 'agent-switch', method: 'agent.switch', summary: 'Explicitly stop the current owner and switch OpenCode interface', fields: [{ name: 'workspacePath', kind: 'path', required: true }, { name: 'sessionId', kind: 'string', required: true }, { name: 'target', kind: 'enum', required: true, options: ['native', 'acp'] }, { name: 'requestId', kind: 'string', required: true }, { name: 'context', kind: 'text', required: false }], effect: 'execute' },
  { name: 'agent-switch-get', method: 'agent.switch.get', summary: 'Read a persisted mode switch outcome without replaying work', fields: [{ name: 'workspacePath', kind: 'path', required: true }, { name: 'requestId', kind: 'string', required: true }], effect: 'read' },
  { name: 'acp-start', method: 'agent.acp.start', summary: 'Start an explicit OpenCode ACP owner in a registered project', fields: [{ name: 'workspacePath', kind: 'path', required: true }, { name: 'requestId', kind: 'string', required: true }, { name: 'loadRunId', kind: 'string', required: false }], effect: 'execute' },
  { name: 'acp-list', method: 'agent.acp.list', summary: 'List project ACP owners', fields: [{ name: 'workspacePath', kind: 'path', required: true }], effect: 'read' },
  { name: 'acp-observe', method: 'agent.acp.observe', summary: 'Read ACP updates and recorded request outcomes', fields: [{ name: 'workspacePath', kind: 'path', required: true }, { name: 'sessionId', kind: 'string', required: true }, { name: 'afterSequence', kind: 'integer', required: false, min: 0 }], effect: 'read' },
  { name: 'acp-prompt', method: 'agent.acp.prompt', summary: 'Dispatch one journaled ACP prompt without automatic replay', fields: [{ name: 'workspacePath', kind: 'path', required: true }, { name: 'sessionId', kind: 'string', required: true }, { name: 'requestId', kind: 'string', required: true }, { name: 'text', kind: 'text', required: true }], effect: 'execute' },
  { name: 'acp-permission', method: 'agent.acp.permission', summary: 'Answer a currently pending ACP permission; omitted option denies', fields: [{ name: 'workspacePath', kind: 'path', required: true }, { name: 'sessionId', kind: 'string', required: true }, { name: 'permissionId', kind: 'string', required: true }, { name: 'optionId', kind: 'string', required: false }], effect: 'execute' },
  ...(['cancel', 'stop', 'dismiss'] as const).map(operation => ({ name: `acp-${operation}`, method: `agent.acp.${operation}`, summary: `${operation} one project-owned ACP session`, fields: [{ name: 'workspacePath', kind: 'path' as const, required: true }, { name: 'sessionId', kind: 'string' as const, required: true }], effect: operation === 'dismiss' ? 'delete' as const : 'execute' as const })),
  { name: 'history-index', method: 'history.index', summary: 'Index selected native sessions for this project', fields: [{ name: 'workspacePath', kind: 'path', required: true }], effect: 'execute' },
  { name: 'history-analytics', method: 'history.analytics', summary: 'Read project usage coverage and optional DuckDB decision comparison', fields: [{ name: 'workspacePath', kind: 'path', required: true }, { name: 'engine', kind: 'enum', required: false, options: ['sqlite', 'duckdb'] }, { name: 'requestId', kind: 'string', required: false }, { name: 'decisionAt', kind: 'string', required: false }], effect: 'read' },
  ...(['cancel', 'progress'] as const).map(action => ({ name: `history-analytics-${action}`, method: `history.analytics.${action}`, summary: `${action} a scoped analytics request`, fields: [{ name: 'workspacePath', kind: 'path' as const, required: true }, { name: 'requestId', kind: 'string' as const, required: true }], effect: action === 'cancel' ? 'execute' as const : 'read' as const })),
  { name: 'history-search', method: 'history.search', summary: 'Search the derived project session archive', fields: [{ name: 'workspacePath', kind: 'path', required: true }, { name: 'query', kind: 'text', required: true }], effect: 'read' },
  { name: 'history-get', method: 'history.get', summary: 'Read a scoped native session excerpt', fields: [{ name: 'workspacePath', kind: 'path', required: true }, { name: 'id', kind: 'string', required: true }], effect: 'read' },
  {"name":"file-search-content","method":"file.searchContent","summary":"Search workspace text; use --language for an ast-grep syntax pattern","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"query","kind":"text","required":true},{"name":"language","kind":"string","required":false},{"name":"maxResults","kind":"integer","required":false,"flag":"limit","min":1,"max":1000},{"name":"showHidden","kind":"boolean","required":false,"flag":"hidden"},{"name":"includeIgnored","kind":"boolean","required":false,"flag":"ignored"}],"effect":"read"},
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
  { name: 'browser-open-file', method: 'browser.openFile', summary: 'Serve a workspace file and its assets automatically and open it in the built-in browser', fields: [{ name: 'worktreePath', kind: 'path', required: true }, { name: 'relPath', kind: 'string', required: true }], effect: 'write' },
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
  {"name":"ui-sidebar","method":"ui.sidebar","summary":"Control a sidebar","fields":[{"name":"side","kind":"enum","required":true,"options":["left","right"]},{"name":"open","kind":"toggle","required":false},{"name":"tab","kind":"enum","required":false,"options":["explorer","git","memory","recovery","search","computer"]},{"name":"width","kind":"integer","required":false,"min":160,"max":720}],"effect":"write","mode":"sidebar"},
  {"name":"ui-palette","method":"ui.palette","summary":"Control the command palette","fields":[{"name":"open","kind":"toggle","required":false},{"name":"mode","kind":"enum","required":false,"flag":"mode","options":["commands","files"]}],"effect":"write"},
  {"name":"ui-settings","method":"ui.settings.open","summary":"Open a settings section","fields":[{"name":"section","kind":"enum","required":false,"options":["agents","editor","source-control","browser","appearance","terminal","shortcuts","notifications","privacy","advanced"]}],"effect":"write"},
  {"name":"ui-runs","method":"ui.runs.open","summary":"Open supervision and operational runs","fields":[{"name":"section","kind":"enum","required":false,"options":["agents","automations","orchestration"]}],"effect":"write"},
  {"name":"editor-open","method":"ui.editor.open","summary":"Open an editable file","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":true}],"effect":"write"},
  {"name":"editor-write","method":"ui.editor.write","summary":"Change an editor buffer through guarded saving","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":true},{"name":"content","kind":"text","required":true}],"effect":"write"},
  {"name":"editor-read","method":"ui.editor.read","summary":"Read an editor buffer","fields":[{"name":"worktreePath","kind":"path","required":true},{"name":"relPath","kind":"string","required":false}],"effect":"read"},
  {"name":"ui-workspace-flush","method":"ui.workspace.flush","summary":"Explicitly save dirty editor buffers and workspace layout","fields":[],"effect":"write"},
  {"name":"agent-providers","method":"agent.providers","summary":"Discover supported and locally available agent CLIs","fields":[],"effect":"read"},
  {"name":"agent-list","method":"agent.list","summary":"List current and recently observed agent runs","fields":[],"effect":"read"},
  {"name":"project-kit-export","method":"project.kit.export","summary":"Write a private portable project kit","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"outputPath","kind":"path","required":true},{"name":"artifacts","kind":"text","required":false},{"name":"includeLearned","kind":"boolean","required":false,"flag":"include-learned"}],"effect":"write"},
  {"name":"project-kit-preview","method":"project.kit.preview","summary":"Validate a portable project kit before restore","fields":[{"name":"archivePath","kind":"path","required":true}],"effect":"read"},
  {"name":"project-kit-import","method":"project.kit.import","summary":"Restore a reviewed kit into a new project","fields":[{"name":"archivePath","kind":"path","required":true},{"name":"destinationPath","kind":"path","required":true},{"name":"expectedSha256","kind":"string","required":true},{"name":"sourceProjectKey","kind":"string","required":true}],"effect":"write"},
  {"name":"project-kit-report","method":"project.kit.report","summary":"Read portable restore warnings and identity mapping","fields":[{"name":"workspacePath","kind":"path","required":true}],"effect":"read"},
  {"name":"project-tasks","method":"project.tasks","summary":"Read native project tasks and optional tools","fields":[{"name":"workspacePath","kind":"path","required":true}],"effect":"read"},
  {"name":"task-migration-status","method":"task.migration.status","summary":"Read the durable Task Authority migration phase and frozen sources","fields":[],"effect":"read"},
  {"name":"task-migration-import","method":"task.migration.import","summary":"Record exact sources and import normalized legacy records (resumable)","fields":[],"effect":"write"},
  {"name":"task-migration-shadow","method":"task.migration.shadow","summary":"Compare authority projections against legacy readers without repair","fields":[],"effect":"read"},
  {"name":"task-migration-export","method":"task.migration.export","summary":"Write a read-only Backlog-compatible export for one repository","fields":[{"name":"repositoryId","kind":"string","required":true}],"effect":"write"},
  {"name":"maintenance-state","method":"maintenance.state","summary":"Read the durable profile maintenance gate state","fields":[],"effect":"read"},
  {"name":"project-task-authority","method":"project.task-authority","summary":"Choose native Backlog.md as project task authority","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"enabled","kind":"boolean","required":true}],"effect":"write"},
  {"name":"project-task-tool","method":"project.task-tool","summary":"Open native task or Git terminal","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"tool","kind":"string","required":true}],"effect":"write"},
  {"name":"agent-native-open","method":"agent.native.open","summary":"Open a native terminal for an explicitly addressed local tool (not a provider launch)","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"launch","kind":"object","required":true,"flag":"launch"},{"name":"task","kind":"object","required":false}],"effect":"execute"},
  {"name":"agent-interrupt","method":"agent.interrupt","summary":"Interrupt an exact live agent run","fields":[{"name":"sessionId","kind":"string","required":true}],"effect":"execute"},
  {"name":"agent-stop","method":"agent.stop","summary":"Stop an exact agent process and retain its output","fields":[{"name":"sessionId","kind":"string","required":true}],"effect":"execute"},
  {"name":"agent-dismiss","method":"agent.dismiss","summary":"Dismiss an exited agent run","fields":[{"name":"sessionId","kind":"string","required":true}],"effect":"delete"},
  {"name":"agent-deliver","method":"agent.deliver","summary":"Deliver a confirmed plain-text attachment to an exact agent","fields":[{"name":"requestId","kind":"string","required":false},{"name":"sessionId","kind":"string","required":true},{"name":"workspacePath","kind":"path","required":true},{"name":"kind","kind":"enum","required":true,"options":["diff-review","design-capture"]},{"name":"title","kind":"string","required":true},{"name":"text","kind":"text","required":true},{"name":"submit","kind":"boolean","required":false,"flag":"submit"},{"name":"confirmed","kind":"boolean","required":true,"flag":"confirm"}],"effect":"execute"},
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
  {"name":"verification-scripts","method":"verification.scripts","summary":"List existing package scripts for verification","fields":[{"name":"workspacePath","kind":"path","required":true}],"effect":"read"},
  {"name":"verification-run","method":"verification.run","summary":"Run an existing package script with source evidence","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"script","kind":"string","required":true},{"name":"options","kind":"object","required":false}],"effect":"execute"},
  {"name":"verification-list","method":"verification.list","summary":"Read source-bound verification and optionally recheck artifacts","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"verifyArtifacts","kind":"boolean","required":false}],"effect":"read"},
  {"name":"verification-attach","method":"verification.attach","summary":"Attach a checkout or owned browser artifact reference","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"runId","kind":"string","required":true},{"name":"taskId","kind":"string","required":true},{"name":"path","kind":"path","required":true}],"effect":"write"},
  {"name":"parallel-list","method":"parallel.list","summary":"List parallel runs","fields":[],"effect":"read"},
  {"name":"parallel-start","method":"parallel.start","summary":"Start a validated bounded parallel run","fields":[{"name":"input","kind":"object","required":true},{"name":"options","kind":"object","required":false}],"effect":"execute"},
  {"name":"parallel-retry","method":"parallel.retry","summary":"Retry exact tasks from one parallel run","fields":[{"name":"id","kind":"string","required":true},{"name":"taskIds","kind":"string-list","required":true}],"effect":"execute"},
  {"name":"parallel-cancel","method":"parallel.cancel","summary":"Cancel an exact parallel run","fields":[{"name":"id","kind":"string","required":true}],"effect":"execute"},
  {"name":"parallel-delete","method":"parallel.delete","summary":"Delete an exact parallel run","fields":[{"name":"id","kind":"string","required":true}],"effect":"delete"},
  {"name":"diff-review-list","method":"diffReview.list","summary":"List review notes for one exact diff target","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"filePath","kind":"string","required":true},{"name":"comparison","kind":"enum","required":true,"options":["working","staged","unstaged"]}],"effect":"read"},
  {"name":"diff-review-create","method":"diffReview.create","summary":"Create an anchored note against an exact diff snapshot","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"filePath","kind":"string","required":true},{"name":"comparison","kind":"enum","required":true,"options":["working","staged","unstaged"]},{"name":"snapshot","kind":"object","required":true},{"name":"anchor","kind":"object","required":true},{"name":"body","kind":"text","required":true},{"name":"runLink","kind":"object","required":false}],"effect":"write"},
  {"name":"diff-review-update","method":"diffReview.update","summary":"Update an exact review note revision","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"expectedRevision","kind":"integer","required":true,"min":1},{"name":"body","kind":"text","required":true}],"effect":"write"},
  {"name":"diff-review-remove","method":"diffReview.remove","summary":"Remove an exact review note revision","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"expectedRevision","kind":"integer","required":true,"min":1}],"effect":"delete"},
  {"name":"handoff-receive","method":"handoff.receive","summary":"Receive an accepted handoff using the native session credential","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"credential","kind":"object","required":true},{"name":"id","kind":"string","required":true},{"name":"expectedRevision","kind":"integer","required":true,"min":1}],"effect":"write"},
  {"name":"handoff-acknowledge","method":"handoff.acknowledge","summary":"Acknowledge receipt of an exact handoff delivery","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"credential","kind":"object","required":true},{"name":"id","kind":"string","required":true},{"name":"expectedRevision","kind":"integer","required":true,"min":1}],"effect":"write"},
  {"name":"memory-list","method":"memory.list","summary":"Search shared project memory","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"query","kind":"text","required":false},{"name":"kinds","kind":"string-list","required":false,"flag":"kinds"},{"name":"includeArchived","kind":"boolean","required":false,"flag":"archived"},{"name":"limit","kind":"integer","required":false,"flag":"limit","min":1,"max":200}],"effect":"read"},
  {"name":"memory-get","method":"memory.get","summary":"Read an exact project memory entry","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true}],"effect":"read"},
  {"name":"memory-create","method":"memory.create","summary":"Record attributed project knowledge","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"kind","kind":"enum","required":true,"options":["fact","decision","convention","procedure","gotcha"]},{"name":"title","kind":"string","required":true,"max":256},{"name":"content","kind":"text","required":true,"max":64000},{"name":"tags","kind":"string-list","required":false,"flag":"tags","min":0,"max":24},{"name":"attribution","kind":"object","required":true,"flag":"attribution"}],"effect":"write"},
  {"name":"memory-update","method":"memory.update","summary":"Replace project knowledge against its exact revision","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"expectedRevision","kind":"integer","required":true,"flag":"revision","min":1},{"name":"kind","kind":"enum","required":true,"options":["fact","decision","convention","procedure","gotcha"]},{"name":"title","kind":"string","required":true,"max":256},{"name":"content","kind":"text","required":true,"max":64000},{"name":"tags","kind":"string-list","required":false,"flag":"tags","min":0,"max":24},{"name":"attribution","kind":"object","required":true,"flag":"attribution"}],"effect":"write"},
  {"name":"memory-history","method":"memory.history","summary":"Read bounded memory revision history","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"limit","kind":"integer","required":false,"flag":"limit","min":1,"max":33}],"effect":"read"},
  {"name":"memory-archive","method":"memory.archive","summary":"Archive or restore an exact memory revision","fields":[{"name":"workspacePath","kind":"path","required":true},{"name":"id","kind":"string","required":true},{"name":"expectedRevision","kind":"integer","required":true,"flag":"revision","min":1},{"name":"archived","kind":"boolean","required":true,"flag":"archived"},{"name":"attribution","kind":"object","required":true,"flag":"attribution"}],"effect":"write"},
  { name: 'task-query', method: 'task.query', summary: 'Query daemon task authority snapshots', fields: [{ name: 'projectId', kind: 'string', required: false, flag: 'project' }, { name: 'status', kind: 'string', required: false, flag: 'status' }, { name: 'runnableOnly', kind: 'boolean', required: false, flag: 'runnable' }, { name: 'cursor', kind: 'string', required: false, flag: 'cursor' }, { name: 'limit', kind: 'integer', required: false, flag: 'limit', min: 1, max: 500 }, { name: 'credential', kind: 'object', required: false, flag: 'credential' }], effect: 'read' },
  { name: 'task-create', method: 'task.create', summary: 'Create a task in the daemon task authority', fields: [{ name: 'projectId', kind: 'string', required: true, flag: 'project' }, { name: 'externalTaskId', kind: 'string', required: true, flag: 'external-id' }, { name: 'title', kind: 'string', required: true, flag: 'title' }, { name: 'body', kind: 'text', required: false, flag: 'body' }, { name: 'priority', kind: 'integer', required: false, flag: 'priority', min: 0, max: 1000000 }, { name: 'status', kind: 'enum', required: false, flag: 'status', options: ['todo', 'blocked'] }, { name: 'credential', kind: 'object', required: false, flag: 'credential' }], effect: 'write' },
  { name: 'task-cancel', method: 'task.cancel', summary: 'Request cancellation of one task', fields: [{ name: 'projectId', kind: 'string', required: true, flag: 'project' }, { name: 'taskId', kind: 'string', required: true, flag: 'task' }, { name: 'expectedEntityVersion', kind: 'integer', required: true, flag: 'version', min: 1 }, { name: 'credential', kind: 'object', required: false, flag: 'credential' }], effect: 'write' },
  { name: 'task-credential-issue', method: 'task.credential.issue', summary: 'Issue a daemon-scoped task worker credential for one project', fields: [{ name: 'projectId', kind: 'string', required: true, flag: 'project' }], effect: 'read' },
  { name: 'task-claim', method: 'task.claim', summary: 'Claim one task as a worker and let the daemon coordinate execution', fields: [{ name: 'projectId', kind: 'string', required: true, flag: 'project' }, { name: 'externalTaskId', kind: 'string', required: false, flag: 'external-id' }, { name: 'taskId', kind: 'string', required: false, flag: 'task' }, { name: 'specification', kind: 'object', required: true, flag: 'specification' }, { name: 'credential', kind: 'object', required: false, flag: 'credential' }, { name: 'credentialFile', kind: 'path', required: false, flag: 'credential-file' }, { name: 'leaseTtlMs', kind: 'integer', required: false, flag: 'lease-ttl', min: 1000, max: 600000 }], effect: 'execute' },
  { name: 'task-progress', method: 'task.progress', summary: 'Record bounded progress for one claimed task', fields: [{ name: 'token', kind: 'object', required: true, flag: 'token' }, { name: 'detail', kind: 'text', required: true, flag: 'detail' }, { name: 'credential', kind: 'object', required: false, flag: 'credential' }, { name: 'credentialFile', kind: 'path', required: false, flag: 'credential-file' }], effect: 'write' }
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
