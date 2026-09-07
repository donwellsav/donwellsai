import { overlappingAgentIntents, type ProjectTasksInspection } from '@shared/agent-runtime'
import { useEffect, useMemo, useState } from 'react'
import {
  agentPresentation,
  agentProviderName,
  type AgentPresentation
} from '@shared/agent-presentation'
import type { RunningAgent } from '@shared/types'
import { pinnedWorktree } from '../../commands'
import { useAppStore } from '../../store'
import { Icon } from '../Icon'
import { ModalDialog } from '../ModalDialog'
import { formatRunTime } from './RunStatus'
import { AcpSessions } from './AcpSessions'
import { switchAgentMode } from '../../agent-mode-switch'

type PresentedAgent = { run: RunningAgent; presentation: AgentPresentation; provider: string }
type AgentConfirmation = { kind: 'stop' | 'dismiss'; run: RunningAgent }

function workspaceName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}

export function AgentsSection() {
  const runningAgents = useAppStore((state) => state.runningAgents)
  const presets = useAppStore((state) => state.agents)
  const repos = useAppStore((state) => state.repos)
  const activeRepoId = useAppStore((state) => state.activeRepoId)
  const activeWorktreePath = useAppStore((state) => state.activeWorktreePath)
  const defaultCommand = useAppStore((state) => state.settings.agentCommand)
  const focusAgentSession = useAppStore((state) => state.focusAgentSession)
  const runAgent = useAppStore((state) => state.runAgent)
  const stopAgent = useAppStore((state) => state.stopAgent)
  const dismissAgent = useAppStore((state) => state.dismissAgent)
  const [command, setCommand] = useState(defaultCommand)
  const [acpOpen, setAcpOpen] = useState(false)
  const [directLaunch, setDirectLaunch] = useState(false)
  const [args, setArgs] = useState<string[]>([])
  const [commandTouched, setCommandTouched] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [memorySetup, setMemorySetup] = useState<{ target: string; message: string; launchArgs?: string[] } | null>(null)
  const [configuringMemory, setConfiguringMemory] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [operation, setOperation] = useState<string | null>(null)
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({})
  const [confirmation, setConfirmation] = useState<AgentConfirmation | null>(null)
  const [confirmationError, setConfirmationError] = useState<string | null>(null)

  const [chosenPath, setChosenPath] = useState('')
  const [intent, setIntent] = useState('')
  const [files, setFiles] = useState('')
  const [externalId, setExternalId] = useState('')
  const [taskState, setTaskState] = useState<ProjectTasksInspection | null>(null)
  const [taskRefresh, setTaskRefresh] = useState(0)
  const [taskSaving, setTaskSaving] = useState(false)
  const pinnedPath = useMemo(
    () => pinnedWorktree(useAppStore.getState()),
    [activeRepoId, activeWorktreePath, repos]
  )
  const targetPath = chosenPath || pinnedPath
  useEffect(() => {setTaskState(null); setExternalId('')}, [targetPath])
  useEffect(() => {
    let live = true
    if (targetPath) void window.donwells.projectTasksInspect(targetPath).then(result => {if (live) setTaskState(result)}).catch(error => {if (live) setLaunchError(String(error))})
    return () => {live = false}
  }, [targetPath, taskRefresh])
  const targetRepo = repos.find(repo => repo.worktrees.some(worktree => worktree.path === targetPath))
  const targetBranch = targetRepo?.worktrees.find(worktree => worktree.path === targetPath)?.branch
  const intendedFiles = files.split('\n').map(file => file.trim()).filter(Boolean)
  const overlaps = overlappingAgentIntents(Object.values(runningAgents), targetPath ?? '', intendedFiles)
  const availablePresets = useMemo(
    () => presets.filter((preset) => preset.available).sort((left, right) => left.name.localeCompare(right.name)),
    [presets]
  )
  const unavailablePresets = useMemo(() => presets.filter((preset) => !preset.available), [presets])
  const selectedPreset = availablePresets.find((preset) => preset.command === command.trim() || preset.executablePath === command.trim())
  const memoryLaunchArgs = memorySetup?.target === `${targetPath}:${selectedPreset?.id}` ? memorySetup.launchArgs ?? [] : []
  const launchDirect = directLaunch || memoryLaunchArgs.length > 0

  useEffect(() => {
    if (!commandTouched) setCommand(defaultCommand)
  }, [commandTouched, defaultCommand])

  const agents = useMemo<PresentedAgent[]>(() => Object.values(runningAgents)
    .map((run) => ({ run, presentation: agentPresentation(run), provider: agentProviderName(run) }))
    .sort((left, right) => {
      const leftRank = left.presentation.needsAttention ? 0 : left.presentation.inProgress ? 1 : 2
      const rightRank = right.presentation.needsAttention ? 0 : right.presentation.inProgress ? 1 : 2
      return leftRank - rightRank || right.run.updatedAt.localeCompare(left.run.updatedAt)
    }), [runningAgents])


  const attentionCount = agents.filter((agent) => agent.presentation.needsAttention).length
  const activeCount = agents.filter((agent) => agent.presentation.inProgress).length

  const setSessionError = (sessionId: string, error: string | null): void => {
    setSessionErrors((current) => {
      if (error) return { ...current, [sessionId]: error }
      if (!(sessionId in current)) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }

  const launch = async (): Promise<void> => {
    const trimmed = command.trim()
    if (!targetPath || !trimmed || launching || configuringMemory) return
    setLaunching(true)
    setLaunchError(null)
    try {
      const result = await runAgent(targetPath, launchDirect ? { executable: trimmed, args: [...memoryLaunchArgs, ...args] } : trimmed, intent || intendedFiles.length || externalId ? { intent, files: intendedFiles, ...(externalId ? {externalId} : {}) } : undefined)
      if (!result.ok) {
        setLaunchError(result.error)
        return
      }
    } finally {
      setLaunching(false)
    }
  }

  const openTerminal = async (run: RunningAgent): Promise<void> => {
    if (opening) return
    setOpening(run.sessionId)
    setSessionError(run.sessionId, null)
    try {
      const focused = await focusAgentSession(run.sessionId)
      if (!focused) setSessionError(run.sessionId, 'The retained terminal is no longer available in this workspace.')
    } catch (error) {
      setSessionError(run.sessionId, error instanceof Error ? error.message : String(error))
    } finally {
      setOpening(null)
    }
  }

  const retry = async (run: RunningAgent): Promise<void> => {
    const key = `retry:${run.sessionId}`
    if (operation) return
    setOperation(key)
    setSessionError(run.sessionId, null)
    try {
      const result = await runAgent(run.workspacePath, run.launch ?? run.command, run.task)
      if (!result.ok) {
        setSessionError(run.sessionId, result.error)
        return
      }
    } finally {
      setOperation(null)
    }
  }

  const confirmAgentAction = async (): Promise<void> => {
    if (!confirmation || operation) return
    const { kind, run } = confirmation
    const key = `${kind}:${run.sessionId}`
    setOperation(key)
    setConfirmationError(null)
    setSessionError(run.sessionId, null)
    try {
      const result = kind === 'stop' ? await stopAgent(run.sessionId) : await dismissAgent(run.sessionId)
      if (!result.ok) {
        setConfirmationError(result.error)
        return
      }
      setConfirmation(null)
    } finally {
      setOperation(null)
    }
  }
  const switchToAcp = async (run: RunningAgent): Promise<void> => {
    if (operation) return
    setOperation(`switch:${run.sessionId}`); setSessionError(run.sessionId, null)
    try {
      await switchAgentMode(run.workspacePath, run.sessionId, 'acp')
      setChosenPath(run.workspacePath); setAcpOpen(true)
    } catch (error) { setSessionError(run.sessionId, String(error)) }
    finally { setOperation(null) }
  }

  return (
    <div className="op-section agents-section">
      <form className="agent-launcher" aria-labelledby="agent-launcher-title" onSubmit={(event) => {
        event.preventDefault()
        void launch()
      }}>
        <div className="agent-launcher-heading">
          <div>
            <span className="op-eyebrow">New agent session</span>
            <h3 id="agent-launcher-title">Start an agent</h3>
            <p>Choose an installed harness, verify the exact project, then start it in a real retained terminal.</p>
          </div>
          <span className="agent-harness-count">{availablePresets.length} installed</span>
        </div>

        <label className="modal-field">Checkout
          <select className="input" aria-label="Agent checkout" value={targetPath ?? ''} disabled={launching} onChange={event => setChosenPath(event.target.value)}>
            {!targetPath && <option value="">Select a checkout</option>}
            {repos.flatMap(repo => repo.worktrees.map(worktree => <option key={worktree.path} value={worktree.path}>{worktree.isMain ? 'Shared checkout' : 'Existing worktree'} · {workspaceName(repo.repo.path)} · {worktree.branch ?? 'detached'} · {worktree.path}</option>))}
          </select>
        </label>
        <p>Branch: {targetBranch ?? 'No Git branch'} · Other sessions in this checkout share its files.</p>
        {targetRepo?.repo.kind !== 'folder' && targetRepo && <button type="button" className="btn btn-secondary" onClick={() => {useAppStore.setState({activeRepoId:targetRepo.repo.id, runsOpen:false, createOpen:true})}}>Create isolated worktree…</button>}
        <details className="agent-command-field"><summary>Task and file scope</summary>
        {targetPath && <details className="agent-command-field"><summary>Project tasks and native tools</summary>
          <label><input type="checkbox" checked={taskState?.authority === 'backlog.md'} disabled={!taskState || launching || taskSaving} onChange={event => {const enabled=event.target.checked;setTaskSaving(true);setTaskState(state=>state?{...state,authority:enabled?'backlog.md':null}:state);void window.donwells.projectTaskAuthority(targetPath,enabled).catch(error=>setLaunchError(String(error))).finally(()=>{setTaskSaving(false);setTaskRefresh(value=>value+1)})}}/> Use Backlog.md as this project's task authority</label>
          <p>Native task files stay authoritative. This choice stores no editable copy of the board.</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={()=>setTaskRefresh(value=>value+1)}>Refresh native tasks</button>
          {taskState?.tools.map(tool=><div key={tool.id}><button type="button" className="btn btn-secondary btn-sm" disabled={!tool.available || (tool.id==='backlog' && (!taskState.authority || !!taskState.problem))} onClick={()=>void useAppStore.getState().openProjectTaskTool(targetPath,tool.id).catch(error=>setLaunchError(String(error)))}>Open {tool.id==='backlog'?'Backlog board':'Lazygit'}</button><span> {tool.version} · {tool.available?'available':tool.problem}</span></div>)}
          {taskState?.problem && <p role="status">{taskState.problem}</p>}
        </details>}
        {taskState?.authority && <label className="modal-field">Native task reference<select className="input" value={externalId} onChange={event=>setExternalId(event.target.value)}><option value="">No task reference</option>{taskState.tasks.map(task=><option key={task.id} value={task.id}>{task.id} · {task.title} · {task.status}</option>)}</select><small>Showing up to 100 native tasks; use the native board for the full project.</small></label>}
        <label className="modal-field">Task intent<input className="input" value={intent} maxLength={2000} onChange={event => setIntent(event.target.value)} placeholder="What this session will work on"/></label>
        <label className="modal-field">Intended files or directories<textarea className="input" value={files} onChange={event => setFiles(event.target.value)} rows={2} placeholder="Project-relative paths, one per line"/></label>

        <p>File intent is advisory. Native agents can edit other files; this does not lock the checkout.</p>
        </details>
        {overlaps.length > 0 && <div role="status"><strong>{overlaps.length} session(s) may overlap.</strong>{overlaps.map(run => <p key={run.sessionId}>{agentProviderName(run)}: {run.task?.intent || 'Intent unspecified'} · {run.task?.files.join(', ') || 'File scope unspecified'}</p>)}</div>}

        {availablePresets.length > 0 ? (
          <div className="agent-harness-grid" role="radiogroup" aria-label="Available agent harnesses">
            {availablePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selectedPreset?.id === preset.id}
                className={selectedPreset?.id === preset.id ? 'is-selected' : ''}
                onClick={() => {
                  setCommand(preset.executablePath ?? preset.command)
                  setDirectLaunch(true)
                  setArgs([])
                  setCommandTouched(true)
                  setLaunchError(null)
                }}
              >
                <span><strong>{preset.name}</strong><small>{preset.hookSupport.support === 'native' ? 'Hook adapter available' : 'Process status only'}</small></span>
                <code>{preset.command}</code>
              </button>
            ))}
          </div>
        ) : (
          <div className="agent-launcher-note" role="status">
            <strong>No registered harness was found on PATH.</strong>
            <span>You can still enter an executable command or configure the default in Settings.</span>
          </div>
        )}

        {unavailablePresets.length > 0 && (
          <p className="agent-unavailable">Not found on PATH: {unavailablePresets.map((preset) => preset.name).join(', ')}</p>
        )}

        {selectedPreset && <p className="agent-unavailable">Installed · Launch unverified · Authentication unverified · Memory connection unverified</p>}
        {targetPath && selectedPreset && ['omp', 'kimi', 'deepseek-harness', 'hermes'].includes(selectedPreset.id) && <div className="agent-command-field">
          <button type="button" className="btn btn-secondary" disabled={configuringMemory || launching} onClick={async () => {
            const target = `${targetPath}:${selectedPreset.id}`
            setConfiguringMemory(true)
            try {
              const setup = await window.donwells.agentConfigureMemory(targetPath, selectedPreset.id, args)
              if (setup.setupArgs) {
                const result = await runAgent(targetPath, { executable: selectedPreset.executablePath ?? selectedPreset.command, args: setup.setupArgs })
                if (!result.ok) throw new Error(result.error)
                setMemorySetup({ target, message: 'Complete the Hermes setup in its terminal, then start a new session.' })
                return
              }
              setMemorySetup({ target, launchArgs: setup.launchArgs, message: setup.launchArgs ? 'Project memory patch ready for this launch. Keep your native profile arguments below.' : 'Project memory setup saved. New agent sessions will load it.' })
            } catch (error) {
              setMemorySetup({ target, message: error instanceof Error ? error.message : String(error) })
            } finally { setConfiguringMemory(false) }
          }}>Set up shared project memory</button>
          {memorySetup?.target === `${targetPath}:${selectedPreset.id}` && <p role="status">{memorySetup.message}</p>}
        </div>}
        {selectedPreset?.id === 'hermes' && <p className="agent-unavailable">Memory setup opens Hermes’s native tool selection in a terminal. It updates the selected Hermes profile; each session resolves its own registered project. Existing servers stay under Hermes’s controls.</p>}
        <label><input type="checkbox" disabled={memoryLaunchArgs.length > 0} checked={launchDirect} onChange={(event) => setDirectLaunch(event.currentTarget.checked)} /> Pass arguments separately</label>
        <label className="agent-command-field" htmlFor="agent-launch-command">
          <span>{launchDirect ? 'Executable' : 'Shell command'}</span>
          <input
            id="agent-launch-command"
            className="input"
            value={command}
            maxLength={4096}
            spellCheck={false}
            autoComplete="off"
            placeholder={launchDirect ? 'Executable name or full path' : 'Agent executable and arguments'}
            onChange={(event) => {
              setCommand(event.currentTarget.value)
              setCommandTouched(true)
              setLaunchError(null)
            }}
          />
        </label>
        {launchDirect && <div className="agent-command-field">
          <span>Arguments — one per field, no shell quoting</span>
          {args.map((arg, index) => <div key={index} className="agent-launcher-actions">
            <input className="input" aria-label={`Argument ${index + 1}`} value={arg} maxLength={4096} spellCheck={false} autoComplete="off" onChange={(event) => {
              const value = event.currentTarget.value
              setArgs((current) => current.map((item, at) => at === index ? value : item))
            }} />
            <button type="button" className="btn btn-secondary" aria-label={`Remove argument ${index + 1}`} onClick={() => setArgs((current) => current.filter((_, at) => at !== index))}>Remove</button>
          </div>)}
          <button type="button" className="btn btn-secondary" disabled={args.length >= 256} onClick={() => setArgs((current) => [...current, ''])}>Add argument</button>
        </div>}

        {launchError && <p className="op-inline-error" role="alert"><strong>Agent did not start.</strong><span>{launchError}</span></p>}
        <div className="agent-launcher-actions">
          <button type="button" className="btn btn-secondary" onClick={() => useAppStore.getState().openSettings('agents')}>Agent settings</button>
          <button type="submit" className="btn btn-primary" disabled={!targetPath || !command.trim() || launching || configuringMemory}>
            <Icon name="robot" size={14} />
            {launching ? 'Starting agent…' : 'Start agent & open terminal'}
          </button>
        </div>
      </form>

      {targetPath && <details open={acpOpen} onToggle={event => setAcpOpen(event.currentTarget.open)}><summary>ACP sessions</summary>{acpOpen && <AcpSessions key={targetPath} workspacePath={targetPath} />}</details>}

      <div className="op-section-heading agent-supervision-heading">
        <div>
          <span className="op-eyebrow">Daemon-observed sessions</span>
          <h3>Supervise agents</h3>
          <p>Open retained output, retry exited work, or stop and dismiss sessions with explicit confirmation.</p>
        </div>
        <div className="agent-totals" aria-label="Agent status totals">
          <span><strong>{activeCount}</strong> running</span>
          <span className={attentionCount > 0 ? 'attention' : ''}><strong>{attentionCount}</strong> need attention</span>
        </div>
      </div>

      <div className="agent-list" aria-live="polite">
        {agents.map(({ run, presentation, provider }) => {
          const openingThis = opening === run.sessionId
          const retrying = operation === `retry:${run.sessionId}`
          const stopping = operation === `stop:${run.sessionId}` || run.activity === 'stopping'
          const canStop = run.liveness !== 'exited'
          const canDismiss = run.liveness === 'exited'
          return (
            <article key={run.id} className={`agent-card agent-card-${presentation.tone}`}>
              <div className="agent-card-head">
                <div className="agent-identity">
                  <span className={`agent-state-mark agent-state-mark-${presentation.tone}`} aria-hidden="true" />
                  <span>
                    <strong>{provider}</strong>
                    <small title={run.workspacePath}>{workspaceName(run.workspacePath)}</small>
                  </span>
                </div>
                <span className={`agent-status agent-status-${presentation.tone}`}>{presentation.label}</span>
                <div className="agent-card-actions">
                  <button type="button" className="btn btn-secondary btn-sm" title="Stop this owner and start a new OpenCode ACP conversation; use a reviewed handoff to transfer context" disabled={operation !== null || !(run.liveness === 'exited' || ['waiting', 'completed'].includes(run.activity))} onClick={() => void switchToAcp(run)}>Switch to new ACP</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={openingThis || operation !== null} onClick={() => void openTerminal(run)}>
                    <Icon name="terminal" size={13} />
                    {openingThis ? 'Opening…' : run.liveness === 'exited' ? 'Open output' : 'Open terminal'}
                  </button>
                  {canDismiss && (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={operation !== null} onClick={() => void retry(run)}>
                      {retrying ? 'Starting…' : presentation.status === 'failed' ? 'Retry' : 'Run again'}
                    </button>
                  )}
                  {canStop && (
                    <button type="button" className="btn btn-danger btn-sm" disabled={operation !== null || run.activity === 'stopping'} onClick={() => {
                      setConfirmationError(null)
                      setConfirmation({ kind: 'stop', run })
                    }}>{stopping ? 'Stopping…' : run.liveness === 'unverifiable' ? 'Try to stop…' : 'Stop…'}</button>
                  )}
                  {canDismiss && (
                    <button type="button" className="btn btn-danger btn-sm" disabled={operation !== null} onClick={() => {
                      setConfirmationError(null)
                      setConfirmation({ kind: 'dismiss', run })
                    }}>Dismiss…</button>
                  )}
                </div>
              </div>

              <dl className="agent-facts">
                <div><dt>Workspace</dt><dd title={run.workspacePath}>{run.workspacePath}</dd></div>
                {run.task && <div><dt>Task intent</dt><dd>{run.task.externalId && <strong>{run.task.externalId} · </strong>}{run.task.intent || 'Unspecified'}<span>{run.task.files.join(', ') || 'File scope unspecified'}</span></dd></div>}
                <div><dt>Harness</dt><dd><strong>{provider}</strong><code title={run.command}>{run.command}</code></dd></div>
                <div><dt>Activity</dt><dd><strong>{presentation.label}</strong><span>{presentation.description}</span></dd></div>
                <div><dt>Liveness</dt><dd><strong>{run.liveness}</strong><span>{run.hook.connected ? 'Activity hook connected' : run.hook.support === 'native' ? 'Hook not connected' : 'Process observation only'}</span></dd></div>
              </dl>

              <div className="agent-card-foot">
                <span>Started {formatRunTime(run.startedAt)}</span>
                <span>Updated {formatRunTime(run.updatedAt)}</span>
                {run.exitCode !== undefined && <span>Exit code {run.exitCode}</span>}
              </div>
              {sessionErrors[run.sessionId] && <p className="agent-row-error" role="alert">{sessionErrors[run.sessionId]}</p>}
            </article>
          )
        })}
        {agents.length === 0 && (
          <div className="op-empty agent-empty">
            <Icon name="robot" size={20} />
            <strong>No retained sessions</strong>
            <span>Use Start agent above. New sessions appear here with daemon-backed liveness and activity.</span>
          </div>
        )}
      </div>

      {confirmation && (
        <ModalDialog className="modal op-confirm agent-confirm" labelledBy="agent-confirm-title" onClose={() => {
          if (!operation) setConfirmation(null)
        }}>
          <span className="op-eyebrow">Confirm agent operation</span>
          <h3 id="agent-confirm-title" className="modal-title">
            {confirmation.kind === 'stop' ? `Stop ${agentProviderName(confirmation.run)}?` : `Dismiss ${agentProviderName(confirmation.run)} history?`}
          </h3>
          <p>
            {confirmation.kind === 'stop'
              ? confirmation.run.liveness === 'unverifiable'
                ? 'The daemon cannot currently prove whether this process is live. A stop will be attempted, but the session remains Unverifiable unless the daemon acknowledges the result.'
                : 'This ends the agent process. Its terminal output stays available until you dismiss it.'
              : 'This removes the exited session, retained terminal output, and agent history. The working project is not changed.'}
          </p>
          <dl className="agent-confirm-facts">
            <div><dt>Project</dt><dd>{confirmation.run.workspacePath}</dd></div>
            <div><dt>Command</dt><dd>{confirmation.run.command}</dd></div>
          </dl>
          {confirmationError && <p className="op-inline-error" role="alert"><strong>Operation did not complete.</strong><span>{confirmationError}</span></p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" disabled={operation !== null} onClick={() => setConfirmation(null)}>Keep session</button>
            <button type="button" className="btn btn-danger" disabled={operation !== null} onClick={() => void confirmAgentAction()}>
              {operation ? confirmation.kind === 'stop' ? 'Stopping…' : 'Dismissing…' : confirmation.kind === 'stop' ? 'Stop agent' : 'Dismiss history'}
            </button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
