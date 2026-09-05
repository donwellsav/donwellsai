export type AgentAttachmentDraft = {
  kind: 'diff-review' | 'design-capture'
  workspacePath: string
  title: string
  text: string
}

export type AgentDeliveryRequest = {
  sessionId: string
  attachment: AgentAttachmentDraft
  submit: boolean
}

export type AgentDeliveryReceipt = {
  sessionId: string
  bytes: number
  submitted: boolean
}

export interface AgentDeliveryApi {
  agentDeliver(request: AgentDeliveryRequest): Promise<AgentDeliveryReceipt>
}
