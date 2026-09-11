export interface DomainEvent {
  id: string
  type: string
  aggregateId: string
  aggregateType: string
  timestamp: number
  version: number
  payload: Record<string, unknown>
  metadata?: Record<string, string>
}
