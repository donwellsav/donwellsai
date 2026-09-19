import { PopupMenu } from 'flexlayout-react'
import { guiDraftMap } from '../../gui-drafts'
import { overlappingAgentIntents, type ProjectTasksInspection } from '@shared/agent-runtime'
import { useEffect, useMemo, useState } from 'react'
import {
  agentPresentation,
  agentProviderName,
  type AgentPresentation
} from '@shared/agent-presentation'
import type { AgentMemorySetupResult, RunningAgent } from '@shared/types'
import { pinnedWorktree } from '../../commands'
import { useProviderInstances } from '../../hooks/use-provider-instances'
import { useAppStore } from '../../store'
import { Icon } from '../Icon'
import { CapabilityMatrix } from '../CapabilityMatrix'
import { TemplatePicker } from '../TemplatePicker'
import { AutonomousAgentPanel } from '../AutonomousAgentPanel'
import { ModalDialog } from '../ModalDialog'
import { formatRunTime } from './RunStatus'
import { AcpSessions } from './AcpSessions'
import { switchAgentMode } from '../../agent-mode-switch'

type PresentedAgent = { run: RunningAgent; presentation: AgentPresentation; provider: string }
type AgentConfirmation = { kind: 'stop' | 'dismiss'; run: RunningAgent }

function workspaceName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}

type AgentDraft = { command: string; directLaunch: boolean; args: string[]; commandTouched: boolean; intent: string; files: string }
const agentDrafts = guiDraftMap<AgentDraft>('agent-launches')
const agentTargets = guiDraftMap<string>('agent-targets')

export function AgentsSection({ onReplaySession }: { onReplaySession?: (sessionId: string) => void }) {
  const runningAgents = useAppStore((state) => state.runningAgents)
  const presets = useAppStore((state) => state.agents)
  const repos = useAppStore((state) => state.repos)
  const activeRepoId = useAppStore((state) => state.activeRepoId)
  const activeWorktreePath = useAppStore((state) => state.activeWorktreePath)
  // The provider instance is the launch target; the command field is the
  // advanced escape hatch and no longer seeds from a retired global setting.
  const defaultCommand = ''
  const focusAgentSession = useAppStore((state) => state.focusAgentSession)
  const openNativeTerminal = useAppStore((state) => state.openNativeTerminal)
  const launchProviderInstance = useAppStore((state) => state.launchProviderInstance)
  // The provider catalog is the launch authority after the Stage 3 cutover.
  const { snapshot: providerCatalog } = useProviderInstances()
  const providerInstances = useMemo(
    () => (providerCatalog?.instances ?? []).filter(instance => instance.enabled),
    [providerCatalog]
  )
  const [providerInstanceId, setProviderInstanceId] = useState('')
  const stopAgent = useAppStore((state) => state.stopAgent)
  const dismissAgent = useAppStore((state) => state.dismissAgent)
  const invokingKey = activeWorktreePath ?? activeRepoId ?? ''
  const pinnedPath = useMemo(
    () => pinnedWorktree(useAppStore.getState()),
    [activeRepoId, activeWorktreePath, repos]
  )
  const [chosenPath, setChosenPath] = useState(agentTargets.get(invokingKey) ?? '')
  const targetPath = chosenPath || pinnedPath
  const draftKey = targetPath ?? ''
  const draft = agentDrafts.get(draftKey)
  const [command, setCommand] = useState(draft?.command ?? defaultCommand)
  const composerOpen = useAppStore(state => state.agentComposerOpen)
  useEffect(() => { if (composerOpen) document.querySelector<HTMLSelectElement>('[aria-label="Agent type"]')?.focus() }, [composerOpen])
  const [acpOpen, setAcpOpen] = useState(false)
  const [expandedSession, setExpandedSession] = useState<string | null>(null)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [directLaunch, setDirectLaunch] = useState(draft?.directLaunch ?? false)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [args, setArgs] = useState<string[]>(draft?.args ?? [])
  const [commandTouched, setCommandTouched] = useState(draft?.commandTouched ?? false)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [taskError, setTaskError] = useState<string | null>(null)
  const [memorySetup, setMemorySetup] = useState<{ target: string; message: string; launchArgs?: string[] } | null>(null)
  const [memoryReplacement, setMemoryReplacement] = useState<{ target: string; provider: string; args: string[]; setup: AgentMemorySetupResult; error?: string } | null>(null)
  const [configuringMemory, setConfiguringMemory] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [operation, setOperation] = useState<string | null>(null)
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({})
  const [sessionMenu, setSessionMenu] = useState<{ anchor: HTMLElement; sessionId: string } | null>(null)
  const menuRun = Object.values(runningAgents).find(run => run.sessionId === sessionMenu?.sessionId)
  const [switchConfirmation, setSwitchConfirmation] = useState<RunningAgent | null>(null)
  const [confirmation, setConfirmation] = useState<AgentConfirmation | null>(null)
  const [confirmationError, setConfirmationError] = useState<string | null>(null)

  const [intent, setIntent] = useState(draft?.intent ?? '')
  const [files, setFiles] = useState(draft?.files ?? '')
  const [taskState, setTaskState] = useState<ProjectTasksInspection | null>(null)
  const [taskRefresh, setTaskRefresh] = useState(0)
  const [taskSaving, setTaskSaving] = useState(false)
  useEffect(() => {setTaskState(null)}, [targetPath])
  useEffect(() => { agentDrafts.set(draftKey, { command, directLaunch, args, commandTouched, intent, files }) }, [draftKey, command, directLaunch, args, commandTouched, intent, files])
  const chooseTarget = (path: string): void => {
    const next = agentDrafts.get(path)
    setCommand(next?.command ?? defaultCommand); setDirectLaunch(next?.directLaunch ?? false)
    setArgs(next?.args ?? []); setCommandTouched(next?.commandTouched ?? false)
    setIntent(next?.intent ?? ''); setFiles(next?.files ?? '')
    setLaunchError(null); setChosenPath(path); agentTargets.set(invokingKey, path)
  }
  useEffect(() => {
    let live = true
    setTaskState(null); setTaskError(null)
    if (targetPath) void window.donwells.projectTasksInspect(targetPath).then(result => {if (live) setTaskState(result)}).catch(error => {if (live) setTaskError(String(error))})
    return () => {live = false}
  }, [targetPath, taskRefresh])
  const targetRepo = repos.find(repo => repo.worktrees.some(worktree => worktree.path === targetPath))
  const intendedFiles = files.split('\n').map(file => file.trim()).filter(Boolean)
  const overlaps = overlappingAgentIntents(Object.values(runningAgents), targetPath ?? '', intendedFiles)
  const availablePresets = useMemo(
    () => presets.filter((preset) => preset.available).sort((left, right) => left.name.localeCompare(right.name)),
    [presets]
  )
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
  const visibleAgents = agents.filter(({ run, provider, presentation }) =>
    (filter === 'all' || (filter === 'attention' ? presentation.needsAttention : filter === 'history' ? run.liveness === 'exited' : run.liveness !== 'exited')) &&
    `${run.task?.intent ?? ''} ${provider} ${run.workspacePath} ${run.command}`.toLowerCase().includes(query.trim().toLowerCase()))

  const setSessionError = (sessionId: string, error: string | null): void => {
    setSessionErrors((current) => {
      if (error) return { ...current, [sessionId]: error }
      if (!(sessionId in current)) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }

  const reviewSessionWork = (run: RunningAgent, tab: 'git' | 'memory'): void => {
    const state = useAppStore.getState()
    if (!state.repos.some(repo => repo.worktrees.some(worktree => worktree.path === run.workspacePath))) {
      setSessionError(run.sessionId, 'This checkout is no longer registered. Keep the retained output or dismiss the session after review.')
      return
    }
    state.setActiveWorktree(run.workspacePath)
    state.setRightSidebarTab(tab)
  }

  const launch = async (): Promise<void> => {
    const trimmed = command.trim()
    if (!targetPath || launching || configuringMemory) return
    // A provider instance is the launch authority. The daemon admits the exact
    // instance, its revision, and its account; a command string cannot be
    // admitted at all, so it is no longer a way to start an agent.
    if (providerInstanceId !== '') {
      setLaunching(true)
      setLaunchError(null)
      try {
        const result = await launchProviderInstance(targetPath, providerInstanceId, {
          intent: intent || '',
          files: intendedFiles,
          // No task reference: an interactive launch mints its own task and the
          // daemon refuses a caller's, so the composer does not send one.
          ...(selectedTemplateId ? { templateId: selectedTemplateId } : {})
        })
        if (!result.ok) {
          setLaunchError(result.error)
          return
        }
        useAppStore.setState({ agentComposerOpen: false })
        agentDrafts.delete(draftKey)
        setIntent(''); setFiles('')
      } finally {
        setLaunching(false)
      }
      return
    }
    if (launchDirect) {
      // The advanced escape hatch opens one explicitly addressed local tool. It
      // is not a provider launch: the run records no driver or instance identity,
      // and the memory MCP arguments stay exactly the ones typed here.
      if (!trimmed) return
      setLaunching(true)
      setLaunchError(null)
      try {
        const result = await openNativeTerminal(targetPath, { executable: trimmed, args: [...memoryLaunchArgs, ...args] })
        if (!result.ok) {
          setLaunchError(result.error)
          return
        }
        useAppStore.setState({ agentComposerOpen: false })
        agentDrafts.delete(draftKey)
        setIntent(''); setFiles('')
      } finally {
        setLaunching(false)
      }
      return
    }
    setLaunchError('Select a provider instance, or use Advanced to open a local tool.')
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
      // A run admitted for a provider instance is retried against that exact
      // instance. A run recorded before provider instances existed has no
      // instance to admit, and its command text is no longer launch authority,
      // so retrying it would be a command launch by another name.
      const instanceId = run.provider?.providerInstanceId
      if (instanceId === undefined) {
        setSessionError(run.sessionId, 'This session predates provider instances and cannot be retried. Start a new agent from a provider instance.')
        return
      }
      const result = await launchProviderInstance(run.workspacePath, instanceId, run.task)
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
      chooseTarget(run.workspacePath); setAcpOpen(true)
    } catch (error) { setSessionError(run.sessionId, String(error)) }
    finally { setOperation(null) }
  }

  return (
    <div className="op-section agents-section">
      <div className="op-section-heading">
        <div className="agent-totals" aria-label="Agent status totals">
          {agents.length > 0 ? <><span>{activeCount} running</span><span className={attentionCount > 0 ? 'attention' : ''}>{attentionCount} need attention</span></> : <span>Start an agent, then return here to its terminal and progress.</span>}
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => useAppStore.setState({ agentComposerOpen: true })}><Icon name="plus" size={14} />New agent</button>
      </div>
      {agents.length > 0 && <div className="op-toolbar agent-toolbar">
        <input className="input" type="search" aria-label="Search agent sessions" placeholder="Search sessions or projects" value={query} onChange={event => setQuery(event.target.value)} />
        <select className="input" aria-label="Filter agent sessions" value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="all">All sessions</option><option value="active">Active</option><option value="attention">Needs attention</option><option value="history">Finished</option>
        </select>
      </div>}
      {agents.length > 0 && visibleAgents.length === 0 && <p className="op-empty" role="status">No sessions match this view.</p>}

      <div className="agent-list" aria-live="polite">
        {visibleAgents.map(({ run, presentation, provider }) => {
          const openingThis = opening === run.sessionId
          return (
            <article key={run.id} className={`agent-card agent-card-${presentation.tone}`}>
              <div className="agent-card-head">
                <button type="button" className="agent-identity" aria-expanded={expandedSession === run.sessionId} title="Show session details" onClick={() => setExpandedSession(expandedSession === run.sessionId ? null : run.sessionId)}>
                  <span className={`agent-state-mark agent-state-mark-${presentation.tone}`} aria-hidden="true" />
                  <span>
                    <strong title={run.task?.intent || provider}>{run.task?.intent || provider}</strong>
                    <small title={`${presentation.description} · ${run.workspacePath}`}><span className={`agent-status agent-status-${presentation.tone}`}>{presentation.label}</span> · {run.task?.intent ? `${provider} · ` : ''}{workspaceName(run.workspacePath)}</small>
                  </span>
                </button>
                <div className="agent-card-actions">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={openingThis || operation !== null} onClick={() => void openTerminal(run)}>
                    <Icon name="terminal" size={13} />
                    {openingThis ? 'Opening…' : run.liveness === 'exited' ? 'Open output' : 'Open terminal'}
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Actions for ${run.task?.intent || provider}`} title="Session actions: retry, stop, or dismiss history" aria-haspopup="menu" aria-expanded={sessionMenu?.sessionId === run.sessionId} disabled={operation !== null} onClick={event => setSessionMenu({ anchor: event.currentTarget, sessionId: run.sessionId })}><Icon name="more" size={14} /></button>
                </div>
              </div>

              {expandedSession === run.sessionId && <div className="agent-session-details">
              <div className="agent-detail-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => reviewSessionWork(run, 'git')}>Review Git</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => reviewSessionWork(run, 'memory')}>Handoffs</button>
                  <button type="button" className="btn btn-secondary btn-sm" title="Stop this owner and start a new OpenCode ACP conversation; use a reviewed handoff to transfer context" disabled={operation !== null || !(run.liveness === 'exited' || ['waiting', 'completed'].includes(run.activity))} onClick={() => setSwitchConfirmation(run)}>Switch to OpenCode chat…</button>
              </div>
              <dl className="agent-facts">
                <div><dt>Workspace</dt><dd title={run.workspacePath}>{run.workspacePath}</dd></div>
                {run.task && <div><dt>Task intent</dt><dd>{run.task.externalId && <strong>{run.task.externalId} · </strong>}{run.task.intent || 'Unspecified'}<span>{run.task.files.join(', ') || 'File scope unspecified'}</span></dd></div>}
                <div><dt>Agent</dt><dd><strong>{provider}</strong><code title={run.command}>{run.command}</code></dd></div>
                <div><dt>Activity</dt><dd><strong>{presentation.label}</strong><span>{presentation.description}</span></dd></div>
                <div><dt>Liveness</dt><dd><strong>{run.liveness}</strong><span>{run.hook.connected ? 'Activity hook connected' : run.hook.support === 'native' ? 'Hook not connected' : 'Process observation only'}</span></dd></div>
              </dl>

              <div className="agent-card-foot">
                <span>Started {formatRunTime(run.startedAt)}</span>
                <span>Updated {formatRunTime(run.updatedAt)}</span>
                {run.exitCode !== undefined && <span>Exit code {run.exitCode}</span>}
              </div>
              </div>}
              {sessionErrors[run.sessionId] && <p className="agent-row-error" role="alert">{sessionErrors[run.sessionId]}</p>}
            </article>
          )
        })}

      </div>

      <details className="agent-command-field"><summary>Autonomous agent</summary><AutonomousAgentPanel onReplaySession={onReplaySession} /></details>

      {composerOpen && <ModalDialog className="modal op-setup-dialog" labelledBy="agent-launcher-title" onClose={() => { if (!launching && !configuringMemory) useAppStore.setState({ agentComposerOpen: false }) }}>
      <div className="op-composer-title"><h3 id="agent-launcher-title" className="modal-title">New agent</h3><button type="button" className="icon-btn" aria-label="Close agent setup" title="Close setup and keep your draft" disabled={launching || configuringMemory} onClick={() => useAppStore.setState({ agentComposerOpen: false })}><Icon name="x" size={14} /></button></div>
      <form className="agent-launcher" aria-labelledby="agent-launcher-title" onSubmit={(event) => {
        event.preventDefault()
        void launch()
      }}>
        <label className="modal-field">Checkout
          <select className="input" aria-label="Agent checkout" title={targetPath ?? undefined} value={targetPath ?? ''} disabled={launching} onChange={event => chooseTarget(event.target.value)}>
            {!targetPath && <option value="">Select a checkout</option>}
            {repos.flatMap(repo => repo.worktrees.map(worktree => <option key={worktree.path} value={worktree.path}>{workspaceName(repo.repo.path)} · {worktree.isMain ? 'Main checkout' : workspaceName(worktree.path)}{worktree.branch ? ` (${worktree.branch})` : ''}</option>))}
          </select>
        </label>

        {overlaps.length > 0 && <section aria-label="Overlapping session ownership"><p role="status"><strong>{overlaps.length} session(s) may overlap.</strong></p>{overlaps.map(run => <div key={run.sessionId}><p>{agentProviderName(run)}: {run.task?.intent || 'Intent unspecified'} · {run.task?.files.join(', ') || 'File scope unspecified'}</p><button type="button" className="btn btn-secondary btn-sm" onClick={() => void openTerminal(run)}>Open owner terminal</button><button type="button" className="btn btn-secondary btn-sm" onClick={() => reviewSessionWork(run, 'git')}>Review checkout changes</button><button type="button" className="btn btn-secondary btn-sm" onClick={() => reviewSessionWork(run, 'memory')}>Review or save handoff</button></div>)}</section>}

        {/* The provider selector is the launch authority, so it is offered
            regardless of whether a built-in preset was found: a custom-command
            instance is a valid target on a machine with no agent CLI installed. */}
        <label className="modal-field">Provider instance
          <select className="input" aria-label="Provider instance" value={providerInstanceId} disabled={launching || providerInstances.length === 0} onChange={event => { setProviderInstanceId(event.target.value); setLaunchError(null) }}>
            {/* The empty option is what makes this state honest: without it the
                browser displays the first instance while application state stays
                empty, and with a single instance there is no other choice to
                trigger a change. */}
            <option value="">{providerInstances.length === 0 ? 'No provider instance is configured' : 'Select a provider instance'}</option>
            {providerInstances.map(instance => (
              <option key={instance.id} value={instance.id}>
                {instance.displayName} · {instance.credentialMode}{providerCatalog?.defaultInstanceId === instance.id ? ' · default' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="agent-launcher-note" role="status">
          <span>Instances are managed in Settings → Agents. A launch is admitted against the exact instance, its revision, and its account.</span>
        </p>

        {availablePresets.length > 0 ? (
          <>
            <label className="modal-field">Agent
              <select className="input" aria-label="Agent type" value={selectedPreset?.id ?? ''} onChange={event => {
                const preset = availablePresets.find(item => item.id === event.target.value)
                if (!preset) return
                setCommand(preset.executablePath ?? preset.command); setDirectLaunch(true); setArgs([]); setCommandTouched(true); setLaunchError(null)
              }}><option value="" disabled>Custom command (Advanced)</option>{availablePresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>
            </label>
            <CapabilityMatrix />
          </>
        ) : (
          <div className="agent-launcher-note" role="status">
            <strong>No supported agent was found.</strong>
            <span>Install an agent or choose its command in Advanced.</span>
          </div>
        )}
            <div className="modal-field" role="group" aria-label="Session template">
              <span>Session template</span>
              <TemplatePicker onSelect={setSelectedTemplateId} selectedId={selectedTemplateId ?? undefined} />
            </div>



        {targetPath && selectedPreset && ['omp', 'kimi', 'deepseek-harness', 'hermes'].includes(selectedPreset.id) && <div className="agent-command-field">
          <button type="button" className="btn btn-secondary" disabled={configuringMemory || launching} onClick={async () => {
            const target = `${targetPath}:${selectedPreset.id}`
            setConfiguringMemory(true)
            try {
              const setup = await window.donwells.agentConfigureMemory(targetPath, selectedPreset.id, args, { action: 'preview' })
              if (setup.replacement) { setMemoryReplacement({ target: targetPath, provider: selectedPreset.id, args: [...args], setup }); return }
              if (setup.setupArgs) {
                const result = await openNativeTerminal(targetPath, { executable: selectedPreset.executablePath ?? selectedPreset.command, args: setup.setupArgs })
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
        {launchError && <p className="op-inline-error" role="alert"><strong>Agent did not start.</strong><span>{launchError}</span></p>}
        <div className="agent-launcher-actions">
          <button type="submit" className="btn btn-primary" disabled={!targetPath || (providerInstanceId === '' && !(launchDirect && command.trim())) || launching || configuringMemory}>
            <Icon name="terminal" size={14} />
            {launching ? 'Starting agent…' : 'Start agent & open terminal'}
          </button>
        </div>
        <details className="agent-command-field"><summary>Task and file scope</summary>
        <p>Sessions in this checkout share its files.</p>
        {targetRepo?.repo.kind !== 'folder' && targetRepo && <button type="button" className="btn btn-secondary" onClick={() => {useAppStore.setState({activeRepoId:targetRepo.repo.id, runsOpen:false, createOpen:true})}}>Create isolated worktree…</button>}
        {targetPath && <details className="agent-command-field"><summary>Project tasks and tools</summary>
          {taskError && <p role="alert">Could not load project tasks: {taskError}</p>}
          <label><input type="checkbox" checked={taskState?.authority === 'backlog.md'} disabled={!taskState || launching || taskSaving} onChange={event => {const enabled=event.target.checked;setTaskSaving(true);setTaskState(state=>state?{...state,authority:enabled?'backlog.md':null}:state);void window.donwells.projectTaskAuthority(targetPath,enabled).catch(error=>setTaskError(String(error))).finally(()=>{setTaskSaving(false);setTaskRefresh(value=>value+1)})}}/> Import Backlog.md tasks into daemon authority</label>
          <p>Task projections are daemon-owned after activation; the retired Backlog board is not opened from this screen.</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={()=>setTaskRefresh(value=>value+1)}>Refresh task projection</button>
          {taskState?.tools.filter(tool=>tool.id!=='backlog').map(tool=><div key={tool.id}><button type="button" className="btn btn-secondary btn-sm" disabled={!tool.available} onClick={()=>void useAppStore.getState().openProjectTaskTool(targetPath,tool.id).catch(error=>setTaskError(String(error)))}>Open Lazygit</button><span> {tool.version} · {tool.available?'available':tool.problem}</span></div>)}
          {taskState?.problem && <p role="status">{taskState.problem}</p>}
        </details>}
        {taskState?.authority && <p className="agent-launcher-note" role="status"><strong>Task-linked agents run through the scheduled/task lane.</strong><span> An interactive session cannot adopt a daemon task reference, so none is offered here. Task intent and files below are still recorded on this session.</span></p>}
        <label className="modal-field">Task intent<input className="input" value={intent} maxLength={2000} onChange={event => setIntent(event.target.value)} placeholder="What this session will work on"/></label>
        <label className="modal-field">Intended files or directories<textarea className="input" value={files} onChange={event => setFiles(event.target.value)} rows={2} placeholder="Project-relative paths, one per line"/></label>

        <p>File intent is advisory. Native agents can edit other files; this does not lock the checkout.</p>
        </details>
        <details className="agent-command-field"><summary>Advanced launch and integrations</summary>
          <button type="button" className="btn btn-secondary" onClick={() => useAppStore.getState().openSettings('agents')}>Agent settings</button>

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
            <button type="button" className="btn btn-secondary" aria-label={`Remove argument ${index + 1}`} title="Remove this argument from the launch command" onClick={() => setArgs((current) => current.filter((_, at) => at !== index))}>Remove</button>
          </div>)}
          <button type="button" className="btn btn-secondary" disabled={args.length >= 256} onClick={() => setArgs((current) => [...current, ''])}>Add argument</button>
        </div>}

        </details>
      </form>
      <button type="button" className="op-text-action" onClick={() => { useAppStore.setState({ agentComposerOpen: false }); setAcpOpen(true) }}>OpenCode chat…</button>
      </ModalDialog>}

      {targetPath && acpOpen && <ModalDialog className="modal op-setup-dialog" labelledBy="agent-chat-title" onClose={() => setAcpOpen(false)}><div className="op-composer-title"><h3 id="agent-chat-title" className="modal-title">OpenCode chat</h3><button className="icon-btn" aria-label="Close OpenCode chat" title="Return to agent sessions" onClick={() => setAcpOpen(false)}><Icon name="x" size={14} /></button></div><AcpSessions key={targetPath} workspacePath={targetPath} /></ModalDialog>}


      {sessionMenu && menuRun && <PopupMenu anchor={sessionMenu.anchor} title="Session actions" onClose={() => setSessionMenu(null)} items={menuRun.liveness === 'exited' ? [
        { key: 'retry', label: agentPresentation(menuRun).status === 'failed' ? 'Retry' : 'Run again', disabled: operation !== null, onSelect: () => { void retry(menuRun) } },
        { key: 'replay', label: 'Replay session', disabled: operation !== null || !onReplaySession, onSelect: () => { setSessionMenu(null); if (onReplaySession) onReplaySession(menuRun.sessionId) } },
        { key: 'dismiss', label: 'Dismiss history…', disabled: operation !== null, onSelect: () => { setConfirmationError(null); setConfirmation({ kind: 'dismiss', run: menuRun }) } }
      ] : [
        { key: 'stop', label: menuRun.activity === 'stopping' ? 'Stopping…' : menuRun.liveness === 'unverifiable' ? 'Try to stop…' : 'Stop agent…', disabled: operation !== null || menuRun.activity === 'stopping', onSelect: () => { setConfirmationError(null); setConfirmation({ kind: 'stop', run: menuRun }) } }
      ]} />}

      {switchConfirmation && <ModalDialog className="modal op-confirm" labelledBy="agent-switch-title" onClose={() => setSwitchConfirmation(null)}>
        <h3 id="agent-switch-title" className="modal-title">Switch to OpenCode chat?</h3>
        <p>This stops {agentProviderName(switchConfirmation)} in {workspaceName(switchConfirmation.workspacePath)} and starts a new OpenCode conversation. The existing conversation is not transferred automatically. Review or save a handoff first if you need its context.</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setSwitchConfirmation(null)}>Keep current session</button>
          <button type="button" className="btn btn-primary" onClick={() => { setSwitchConfirmation(null); void switchToAcp(switchConfirmation) }}>Switch agent</button>
        </div>
      </ModalDialog>}

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
      {memoryReplacement?.setup.replacement && (
        <ModalDialog className="modal op-confirm agent-confirm" labelledBy="agent-memory-replace-title" onClose={() => { if (!configuringMemory) setMemoryReplacement(null) }}>
          <span className="op-eyebrow">Review project configuration</span>
          <h3 id="agent-memory-replace-title" className="modal-title">Replace the shared-memory entry?</h3>
          <p>{memoryReplacement.provider === 'deepseek-harness' ? 'The existing managed DSH patch differs. Review the entire patch that will replace it.' : 'The existing entry points somewhere else. Review the exact entry change before replacing it. Other configuration entries are preserved.'}</p>
          <dl className="agent-confirm-facts"><div><dt>Project</dt><dd>{memoryReplacement.target}</dd></div><div><dt>File</dt><dd>{memoryReplacement.setup.path}</dd></div></dl>
          <pre className="op-confirm-command" tabIndex={0}>{`Current\n${JSON.stringify(memoryReplacement.setup.replacement.current, null, 2)}\n\nReplacement\n${JSON.stringify(memoryReplacement.setup.replacement.proposed, null, 2)}`}</pre>
          {memoryReplacement.error && <p className="op-inline-error" role="alert"><strong>Replacement did not complete.</strong><span>{memoryReplacement.error} Close this review and prepare it again if the file changed.</span></p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" disabled={configuringMemory} onClick={() => setMemoryReplacement(null)}>Keep existing entry</button>
            <button type="button" className="btn btn-danger" disabled={configuringMemory} onClick={() => void (async () => {
              setConfiguringMemory(true)
              try {
                const result = await window.donwells.agentConfigureMemory(memoryReplacement.target, memoryReplacement.provider, memoryReplacement.args, { action: 'apply', revision: memoryReplacement.setup.replacement!.revision })
                const target = `${memoryReplacement.target}:${memoryReplacement.provider}`
                setMemorySetup({ target, launchArgs: result.launchArgs, message: result.launchArgs ? 'Reviewed project memory patch replaced. Keep your native profile arguments below.' : 'Reviewed project memory entry replaced. New agent sessions will load it.' })
                setMemoryReplacement(null)
              } catch (error) { setMemoryReplacement(current => current ? { ...current, error: error instanceof Error ? error.message : String(error) } : current) }
              finally { setConfiguringMemory(false) }
            })()}>{configuringMemory ? 'Replacing…' : 'Replace reviewed entry'}</button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
