import { useState, useEffect, useCallback } from 'react'
import type { DomainEvent } from '@shared/event-types'

interface SessionReplayProps {
  events: DomainEvent[]
  sessionId: string
  onClose: () => void
}

/**
 * Session Replay UI
 *
 * Replays a session's events in a timeline view.
 * Users can scrub through the session, pause/resume,
 * and see what happened at each point in time.
 */
export function SessionReplay({ events: initialEvents, sessionId, onClose }: SessionReplayProps) {
  const [events, setEvents] = useState<DomainEvent[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Events are passed as props
    setEvents(initialEvents)
  }, [initialEvents])

  useEffect(() => {
    if (!isPlaying || currentIndex >= events.length - 1) return

    const timeout = setTimeout(() => {
      setCurrentIndex((i) => Math.min(i + 1, events.length - 1))
    }, 1000 / speed)

    return () => clearTimeout(timeout)
  }, [isPlaying, currentIndex, events.length, speed])

  const currentEvent = events[currentIndex]

  const formatTime = useCallback((ts: number) => {
    return new Date(ts).toLocaleTimeString()
  }, [])

  const getEventIcon = (type: string) => {
    switch (type) {
      case 'session:started': return '▶'
      case 'session:prompt_submitted': return '💬'
      case 'session:response_started': return '⚡'
      case 'session:response_chunk': return '📝'
      case 'session:response_completed': return '✅'
      case 'session:tool_call_started': return '🔧'
      case 'session:tool_call_completed': return '✔'
      case 'session:error': return '❌'
      case 'session:completed': return '🏁'
      case 'session:cancelled': return '🚫'
      default: return '•'
    }
  }

  if (error) {
    return (
      <div className="session-replay">
        <div className="session-replay-error">
          <p>Failed to load session replay: {error}</p>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    )
  }

  return (
    <div className="session-replay">
      <div className="session-replay-header">
        <h3>Replay: {sessionId}</h3>
        <button onClick={onClose} aria-label="Close replay">×</button>
      </div>

      <div className="session-replay-controls">
        <button
          onClick={() => setIsPlaying(!isPlaying)}
          disabled={currentIndex >= events.length - 1}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, events.length - 1)}
          value={currentIndex}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setIsPlaying(false)
            setCurrentIndex(Number(e.target.value))
          }}
          aria-label="Seek"
        />
        <span className="session-replay-time">
          {currentEvent ? formatTime(currentEvent.timestamp) : '--:--:--'}
        </span>
        <select
          value={speed}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSpeed(Number(e.target.value))}
          aria-label="Playback speed"
        >
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
        </select>
      </div>

      <div className="session-replay-timeline" role="listbox" aria-label="Session events">
        {events.map((event, idx) => (
          <div
            key={event.id}
            className={`replay-event ${idx === currentIndex ? 'active' : ''} ${idx < currentIndex ? 'past' : ''}`}
            onClick={() => {
              setIsPlaying(false)
              setCurrentIndex(idx)
            }}
            role="option"
            aria-selected={idx === currentIndex}
          >
            <span className="replay-event-icon">{getEventIcon(event.type)}</span>
            <span className="replay-event-type">{event.type}</span>
            <span className="replay-event-time">{formatTime(event.timestamp)}</span>
          </div>
        ))}
      </div>

      {currentEvent && (
        <div className="session-replay-detail" aria-live="polite">
          <h4>{currentEvent.type}</h4>
          <pre>{JSON.stringify(currentEvent.payload, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}