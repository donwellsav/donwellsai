import { expect, it } from 'vitest'
import { normalizeHerdrSnapshot } from './herdr-session'

it('normalizes Herdr snapshots and drops panes outside known workspaces', () => {
  const snapshot = normalizeHerdrSnapshot({ result: { type: 'session_snapshot', snapshot: {
    workspaces: [{ workspace_id: 'workspace-1', label: 'Don project', agent_status: 'working', worktree: { checkout_path: '/tmp/project', repo_name: 'project' } }],
    panes: [
      { pane_id: 'pane-1', workspace_id: 'workspace-1', title: 'Coding', cwd: '/tmp/project/src', agent: 'Don', agent_status: 'working', focused: true },
      { pane_id: 'orphan', workspace_id: 'missing', title: 'Ignore me' }
    ]
  } } })
  expect(snapshot).toEqual({
    workspaces: [{ workspaceId: 'workspace-1', label: 'Don project', checkoutPath: '/tmp/project', repoName: 'project', agentStatus: 'working' }],
    panes: [{ paneId: 'pane-1', workspaceId: 'workspace-1', label: 'Coding', cwd: '/tmp/project/src', agent: 'Don', agentStatus: 'working', focused: true }]
  })
  expect(() => normalizeHerdrSnapshot({ result: { type: 'error' } })).toThrow('unsupported session snapshot')
})
