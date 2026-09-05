import type { FileContent, RepoSummary, RunningAgent, TerminalSession } from '@shared/types'
import { getEditorDocument } from './editor-models'

type ProjectRemovalBlocker = {
  key: 'editors' | 'agents' | 'terminals' | 'commit-drafts' | 'operations'
  message: string
}

type ProjectRemovalActivity = {
  terminals: Readonly<Record<string, { session: TerminalSession }>>
  runningAgents: Readonly<Record<string, RunningAgent>>
  previews: Readonly<Record<string, Readonly<Record<string, FileContent & { v: number }>>>>
  gitCommitDrafts: Readonly<Record<string, string>>
  busy: Readonly<Record<string, boolean>>
}

export function projectRemovalBlockers(repo: RepoSummary, activity: ProjectRemovalActivity): ProjectRemovalBlocker[] {
  const paths = new Set(repo.worktrees.map((worktree) => worktree.path))
  let unsavedEditors = 0
  for (const worktree of repo.worktrees) {
    for (const relPath of Object.keys(activity.previews[worktree.path] ?? {})) {
      const document = getEditorDocument(worktree.path, relPath)
      if (document && !document.save.canDispose()) unsavedEditors++
    }
  }
  const liveAgents = Object.values(activity.runningAgents).filter(
    (run) => paths.has(run.workspacePath) && run.liveness !== 'exited'
  )
  const agentSessions = new Set(liveAgents.map((run) => run.sessionId))
  const liveTerminals = Object.values(activity.terminals).filter(
    ({ session }) => paths.has(session.worktreePath) && !session.exited && !agentSessions.has(session.id)
  )
  const commitDrafts = repo.worktrees.filter((worktree) => activity.gitCommitDrafts[worktree.path]?.trim())
  const operations = repo.worktrees.filter((worktree) => activity.busy[worktree.path])
  const blockers: ProjectRemovalBlocker[] = []
  if (unsavedEditors > 0) blockers.push({
    key: 'editors', message: `Save or resolve ${unsavedEditors} unsaved editor ${unsavedEditors === 1 ? 'buffer' : 'buffers'}.`
  })
  if (liveAgents.length > 0) blockers.push({
    key: 'agents', message: `Stop and dismiss ${liveAgents.length} active or unreconciled ${liveAgents.length === 1 ? 'agent' : 'agents'}.`
  })
  if (liveTerminals.length > 0) blockers.push({
    key: 'terminals', message: `Close ${liveTerminals.length} live ${liveTerminals.length === 1 ? 'terminal' : 'terminals'}.`
  })
  if (commitDrafts.length > 0) blockers.push({
    key: 'commit-drafts', message: `Commit or clear ${commitDrafts.length} commit ${commitDrafts.length === 1 ? 'draft' : 'drafts'}.`
  })
  if (operations.length > 0) blockers.push({
    key: 'operations', message: `Wait for ${operations.length} workspace ${operations.length === 1 ? 'operation' : 'operations'} to finish.`
  })
  return blockers
}
