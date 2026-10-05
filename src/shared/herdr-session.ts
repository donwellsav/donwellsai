export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type HerdrWorkspaceSummary = {
  workspaceId: string
  label: string
  checkoutPath?: string
  repoName?: string
  agentStatus: HerdrAgentStatus
}

export type HerdrPaneSummary = {
  paneId: string
  workspaceId: string
  label: string
  cwd?: string
  agent?: string
  agentStatus: HerdrAgentStatus
  focused: boolean
}

export type HerdrSnapshot = {
  workspaces: HerdrWorkspaceSummary[]
  panes: HerdrPaneSummary[]
}

export type HerdrTerminalSource = {
  kind: 'herdr'
  paneId: string
  mode: 'observe' | 'control'
  takeover?: boolean
}
