export type ProjectToolScope = {
  projectKey: string
  projectPath: string
  checkoutPath: string
  indexKey: string
}

export type ToolServiceState = {
  id: string
  status: 'stopped' | 'starting' | 'ready' | 'failed'
  version: string | null
  detail: string | null
}
