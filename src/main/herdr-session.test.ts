import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { isTrustedExecutable, normalizeHerdrSnapshot } from './herdr-session'

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

it.skipIf(process.platform === 'win32')('refuses to spawn a session service another account could replace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'donwells-herdr-trust-'))
  try {
    const ownerOnly = join(directory, 'owner-only')
    const groupWritable = join(directory, 'group-writable')
    const worldWritable = join(directory, 'world-writable')
    for (const file of [ownerOnly, groupWritable, worldWritable]) writeFileSync(file, '', { mode: 0o700 })
    chmodSync(ownerOnly, 0o755)
    chmodSync(groupWritable, 0o775)
    chmodSync(worldWritable, 0o757)

    expect(isTrustedExecutable(ownerOnly)).toBe(true)
    expect(isTrustedExecutable(groupWritable)).toBe(false)
    expect(isTrustedExecutable(worldWritable)).toBe(false)
    // A candidate that vanished between discovery and spawn must also fail closed.
    expect(isTrustedExecutable(join(directory, 'missing'))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
