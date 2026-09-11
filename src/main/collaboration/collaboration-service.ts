import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebsocketProvider } from 'y-websocket'
import { logger } from '../../shared/logger'
import type { CollaborationConfig, PresenceState, Collaborator } from '@shared/collaboration'

export type { CollaborationConfig, PresenceState, Collaborator }

const COLLABORATOR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
]

/**
 * Real-time collaboration service powered by Yjs.
 *
 * Provides:
 * - Shared text editing (Y.Text)
 * - Shared state (Y.Map, Y.Array)
 * - Presence/awareness (cursor positions, user status)
 * - Offline persistence (IndexedDB)
 * - WebSocket sync for multi-client collaboration
 */
export class CollaborationService {
  private doc: Y.Doc
  private indexeddbProvider?: IndexeddbPersistence
  private wsProvider?: WebsocketProvider
  readonly config: CollaborationConfig
  private awarenessMap: Y.Map<PresenceState>
  private colorMap: Map<string, string> = new Map()
  private _connected = false

  constructor(config: CollaborationConfig) {
    this.config = {
      persist: true,
      sync: true,
      ...config,
    }
    this.doc = new Y.Doc()
    this.awarenessMap = this.doc.getMap('awareness')
    this.setupPersistence()
    this.setupSync()
  }

  /**
   * Gets a shared text object.
   */
  getText(name: string): Y.Text {
    return this.doc.getText(name)
  }

  /**
   * Gets a shared map.
   */
  getMap<T = unknown>(name: string): Y.Map<T> {
    return this.doc.getMap(name)
  }

  /**
   * Gets a shared array.
   */
  getArray<T = unknown>(name: string): Y.Array<T> {
    return this.doc.getArray(name)
  }

  /**
   * Gets connection status.
   */
  getConnected(): boolean {
    return this._connected
  }

  /**
   * Updates local presence state.
   */
  updatePresence(state: Partial<PresenceState>): void {
    const current = this.getOwnPresence()
    const updated = { ...current, ...state, lastActive: Date.now() }
    this.awarenessMap.set(this.config.userId, updated)
    this.broadcastPresence()
  }

  /**
   * Gets all active collaborators.
   */
  getCollaborators(): Collaborator[] {
    const collaborators: Collaborator[] = []
    this.awarenessMap.forEach((state, userId) => {
      if (userId === this.config.userId) return
      collaborators.push({
        userId,
        userName: state.userName,
        status: state.status,
        cursor: state.cursor,
        color: this.getColorForUser(userId),
      })
    })
    return collaborators
  }

  /**
   * Subscribes to presence changes.
   */
  onPresenceChange(callback: (collaborators: Collaborator[]) => void): () => void {
    const handler = () => callback(this.getCollaborators())
    this.awarenessMap.observe(handler)
    return () => this.awarenessMap.unobserve(handler)
  }

  /**
   * Subscribes to document changes.
   */
  onDocumentChange(callback: () => void): () => void {
    this.doc.on('update', callback)
    return () => this.doc.off('update', callback)
  }

  /**
   * Destroys the collaboration session.
   */
  destroy(): void {
    this.wsProvider?.destroy()
    this.indexeddbProvider?.destroy()
    this.doc.destroy()
  }

  private setupPersistence(): void {
    if (!this.config.persist) return

    try {
      this.indexeddbProvider = new IndexeddbPersistence(this.config.roomName, this.doc)
      this.indexeddbProvider.on('synced', () => {
        logger.info({ room: this.config.roomName }, 'collab: indexeddb synced')
      })
    } catch (error) {
      logger.warn({ err: error }, 'collab: indexeddb not available')
    }
  }

  private statusChangeCallbacks: Set<(connected: boolean, reason?: string) => void> = new Set()

  onStatusChange(callback: (connected: boolean, reason?: string) => void): () => void {
    this.statusChangeCallbacks.add(callback)
    return () => this.statusChangeCallbacks.delete(callback)
  }

  private setupSync(): void {
    if (!this.config.sync || !this.config.wsUrl) return

    try {
      this.wsProvider = new WebsocketProvider(this.config.wsUrl, this.config.roomName, this.doc)
      this.wsProvider.on('status', (event: { status: string }) => {
        const wasConnected = this._connected
        this._connected = event.status === 'connected'
        logger.info({ status: event.status }, 'collab: websocket status')
        for (const cb of this.statusChangeCallbacks) {
          cb(this._connected, event.status)
        }
      })
    } catch (error) {
      logger.warn({ err: error }, 'collab: websocket not available')
    }
  }

  private getOwnPresence(): PresenceState {
    return (
      this.awarenessMap.get(this.config.userId) ?? {
        userId: this.config.userId,
        userName: this.config.userName || this.config.userId,
        lastActive: Date.now(),
        status: 'online',
      }
    )
  }

  private broadcastPresence(): void {
    // Yjs awareness would handle this in a full implementation
    // For now, we maintain local presence
    const event = new CustomEvent('presence-update', {
      detail: this.getCollaborators(),
    })
    globalThis.dispatchEvent?.(event)
  }

  private getColorForUser(userId: string): string {
    let color = this.colorMap.get(userId)
    if (!color) {
      color = COLLABORATOR_COLORS[this.colorMap.size % COLLABORATOR_COLORS.length]
      this.colorMap.set(userId, color)
    }
    return color
  }
}

/**
 * Creates a collaboration service for a given project.
 */
export function createCollaboration(config: CollaborationConfig): CollaborationService {
  return new CollaborationService(config)
}
