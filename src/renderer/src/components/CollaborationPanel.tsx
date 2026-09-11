import { useEffect, useState, useCallback } from 'react'
import type { Collaborator } from '@shared/collaboration'

/**
 * Live collaboration panel — shows connected collaborators and presence status.
 * Uses the preload API exposed at window.donwells (Electron contextBridge).
 */

interface StatusInfo {
  roomName: string
  connected: boolean
  reason?: string
}

export function CollaborationPanel() {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([])
  const [status, setStatus] = useState<StatusInfo>({ roomName: 'default', connected: false })
  const [loading, setLoading] = useState(true)

  const fetchState = useCallback(async () => {
    try {
      const [info, collabs] = await Promise.all([
        window.donwells.collaborationInfo(),
        window.donwells.collaborationGetCollaborators(),
      ])
      setStatus({ roomName: info.roomName, connected: info.connected })
      setCollaborators(collabs)
    } catch {
      setStatus((s) => ({ ...s, connected: false }))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchState()

    const cleanupPresence = window.donwells.onCollaborationPresence((event) => {
      setCollaborators(event.collaborators)
    })

    const cleanupStatus = window.donwells.onCollaborationStatus((event) => {
      setStatus({ roomName: event.roomName, connected: event.connected, reason: event.reason })
    })

    return () => {
      cleanupPresence()
      cleanupStatus()
    }
  }, [fetchState])

  if (loading) {
    return (
      <div className="p-3 text-xs text-muted">
        Loading collaborators…
      </div>
    )
  }

  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-3">
        <div
          className={`w-2 h-2 rounded-full ${status.connected ? 'bg-green-500' : 'bg-gray-400'}`}
        />
        <span className="text-xs font-medium text-muted">
          {status.connected ? 'Connected' : 'Offline'}
          {status.reason ? ` (${status.reason})` : ''}
        </span>
      </div>

      {collaborators.length === 0 ? (
        <p className="text-xs text-muted">No collaborators yet</p>
      ) : (
        <ul className="space-y-1">
          {collaborators.map((c) => (
            <li key={c.userId} className="flex items-center gap-2 text-xs">
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: c.color }}
              />
              <span className="text-foreground">{c.userName}</span>
              <span className="text-muted capitalize">{c.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
