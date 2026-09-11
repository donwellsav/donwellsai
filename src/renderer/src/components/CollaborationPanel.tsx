/**
 * CollaborationPanel — shows live collaboration status and presence.
 */

import { useEffect, useState } from 'react'
import { logger } from '@shared/logger'

export function CollaborationPanel() {
  const [info, setInfo] = useState<{ connected: boolean; roomName: string; userName: string } | null>(null)

  useEffect(() => {
    let unsubStatus: (() => void) | undefined

    async function init() {
      try {
        const info = await window.donwells.collaborationInfo()
        setInfo(info)
        unsubStatus = window.donwells.onCollaborationStatus((event) => {
          setInfo((prev) => prev ? { ...prev, connected: event.connected } : null)
        })
      } catch (err) {
        logger.error({ err }, 'collaboration: failed to init')
      }
    }
    init()
    return () => { unsubStatus?.() }
  }, [])

  return (
    <section className="collaboration-panel" aria-label="Collaboration status">
      <h3>Collaboration</h3>
      {info ? (
        <div className="collab-status">
          <span className={`status-indicator ${info.connected ? 'online' : 'offline'}`} />
          <span>{info.connected ? 'Connected' : 'Disconnected'}</span>
          <span className="room-name">{info.roomName}</span>
        </div>
      ) : (
        <div className="collab-status">Loading...</div>
      )}
    </section>
  )
}
