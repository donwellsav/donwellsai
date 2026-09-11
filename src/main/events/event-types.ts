import type { DomainEvent } from './event-store'

// ============================================================================
// Domain Event Types
// ============================================================================

export type SessionEventType =
  | 'session:started'
  | 'session:prompt_submitted'
  | 'session:response_started'
  | 'session:response_chunk'
  | 'session:response_completed'
  | 'session:tool_call_started'
  | 'session:tool_call_completed'
  | 'session:error'
  | 'session:completed'
  | 'session:cancelled'

export type ProjectEventType =
  | 'project:created'
  | 'project:opened'
  | 'project:closed'
  | 'project:settings_changed'

export type AgentEventType =
  | 'agent:registered'
  | 'agent:unregistered'
  | 'agent:provider_changed'
  | 'agent:start'
  | 'agent:complete'
  | 'agent:iterate'

/**
 * Autonomous loop events emitted by the daemon-job runner (R4.1).
 */
export type AutonomousEventType = 'autonomous:iteration' | 'autonomous:completed'

export type UIEventType =
  | 'ui:command_executed'
  | 'ui:navigation'
  | 'ui:modal_opened'
  | 'ui:modal_closed'

export type DomainEventType =
  | SessionEventType
  | ProjectEventType
  | AgentEventType
  | UIEventType

// ============================================================================
// Event Payload Types
// ============================================================================

export interface SessionEventPayloads {
  'session:started': { sessionId: string; provider: string; cwd: string }
  'session:prompt_submitted': { sessionId: string; promptLength: number }
  'session:response_started': { sessionId: string }
  'session:response_chunk': { sessionId: string; chunkSize: number }
  'session:response_completed': { sessionId: string; totalTokens: number; durationMs: number }
  'session:tool_call_started': { sessionId: string; toolName: string; callId: string }
  'session:tool_call_completed': { sessionId: string; callId: string; durationMs: number; success: boolean }
  'session:error': { sessionId: string; error: string }
  'session:completed': { sessionId: string; totalTokens: number; totalToolCalls: number; durationMs: number }
  'session:cancelled': { sessionId: string; reason: string }
}

export interface ProjectEventPayloads {
  'project:created': { projectPath: string; name: string }
  'project:opened': { projectPath: string }
  'project:closed': { projectPath: string }
  'project:settings_changed': { projectPath: string; changedKeys: string[] }
}

export interface AgentEventPayloads {
  'agent:registered': { agentId: string; provider: string }
  'agent:unregistered': { agentId: string }
  'agent:provider_changed': { agentId: string; oldProvider: string; newProvider: string }
}

export interface UIEventPayloads {
  'ui:command_executed': { commandId: string; source: 'palette' | 'shortcut' | 'menu' }
  'ui:navigation': { from: string; to: string }
  'ui:modal_opened': { modalId: string }
  'ui:modal_closed': { modalId: string }
}

export type EventPayloads = SessionEventPayloads &
  ProjectEventPayloads &
  AgentEventPayloads &
  UIEventPayloads

// ============================================================================
// Typed Event Creators
// ============================================================================

export function createEvent<T extends DomainEventType>(
  type: T,
  aggregateId: string,
  aggregateType: string,
  payload: Record<string, unknown>,
  version = 1
): DomainEvent {
  return {
    id: `${aggregateId}-${version}-${Date.now()}`,
    type,
    aggregateId,
    aggregateType,
    timestamp: Date.now(),
    version,
    payload: payload as Record<string, unknown>,
  }
}

export function createSessionEvent<T extends SessionEventType>(
  type: T,
  sessionId: string,
  payload: SessionEventPayloads[T],
  version = 1
): DomainEvent {
  return createEvent(type, sessionId, 'session', payload as Record<string, unknown>, version)
}

export function createProjectEvent<T extends ProjectEventType>(
  type: T,
  projectId: string,
  payload: ProjectEventPayloads[T],
  version = 1
): DomainEvent {
  return createEvent(type, projectId, 'project', payload as Record<string, unknown>, version)
}
