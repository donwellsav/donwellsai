/**
 * Shared collaboration types and API contracts.
 * 
 * Collaboration provides real-time presence and shared state
 * powered by Yjs, with WebSocket sync and IndexedDB persistence.
 */

/**
 * Presence state for a single user in a collaboration session.
 */
export interface PresenceState {
  userId: string
  userName: string
  cursor?: { line: number; ch: number }
  selection?: { anchor: { line: number; ch: number }; head: { line: number; ch: number } }
  lastActive: number
  status: 'online' | 'idle' | 'offline'
}

/**
 * A collaborator in a collaboration session.
 */
export interface Collaborator {
  userId: string
  userName: string
  status: 'online' | 'idle' | 'offline'
  cursor?: { line: number; ch: number }
  color: string
}

/**
 * Configuration for a collaboration session.
 */
export interface CollaborationConfig {
  wsUrl?: string
  roomName: string
  userId: string
  userName?: string
  persist?: boolean
  sync?: boolean
}

/**
 * Collaboration session info (main process state).
 */
export interface CollaborationSessionInfo {
  roomName: string
  userId: string
  userName: string
  connected: boolean
  wsUrl?: string
}

/**
 * IPC event: collaboration presence updated.
 */
export interface CollaborationPresenceEvent {
  roomName: string
  collaborators: Collaborator[]
}

/**
 * IPC event: collaboration status changed.
 */
export interface CollaborationStatusEvent {
  roomName: string
  connected: boolean
  reason?: string
}

/**
 * Main-process collaboration bridge.
 * The renderer queries and subscribes to collaboration state.
 */
export interface CollaborationApi {
  /** Get current collaboration session info. */
  collaborationInfo(): Promise<CollaborationSessionInfo>
  /** Get current list of collaborators. */
  collaborationGetCollaborators(): Promise<Collaborator[]>
  /** Update local presence state. */
  collaborationUpdatePresence(
    state: Partial<Pick<PresenceState, 'cursor' | 'selection' | 'status'>>
  ): Promise<void>
  /** Subscribe to presence updates. */
  onCollaborationPresence(cb: (event: CollaborationPresenceEvent) => void): () => void
  /** Subscribe to status changes. */
  onCollaborationStatus(cb: (event: CollaborationStatusEvent) => void): () => void
}
