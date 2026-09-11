/**
 * Shared session template types and IPC contracts.
 */

export interface SessionTemplate {
  id: string
  name: string
  description: string
  category: string
  icon?: string
  systemPrompt?: string
  initialPrompt?: string
  provider?: string
  model?: string
  allowedTools?: string[]
  deniedTools?: string[]
  env?: Record<string, string>
  tags?: string[]
  author?: string
  builtin?: boolean
}

export type SessionTemplateList = SessionTemplate[]

/**
 * IPC API for session templates.
 */
export interface SessionTemplateApi {
  list(): Promise<SessionTemplateList>
  get(id: string): Promise<SessionTemplate | null>
  create(template: Omit<SessionTemplate, 'id'>): Promise<SessionTemplate>
  update(id: string, template: Partial<SessionTemplate>): Promise<SessionTemplate>
  delete(id: string): Promise<void>
  import(file: string): Promise<SessionTemplate>
  export(id: string, file: string): Promise<void>
}
