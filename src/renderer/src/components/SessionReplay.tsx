import { useState, useEffect, useCallback, useMemo } from 'react'
import { logger } from '@shared/logger'

interface SessionReplayProps {
  sessionId: string
  onClose: () => void
}

interface DomainEvent {
  id: string
  type: string
  aggregateId: string
  aggregateType: string
  timestamp: number
  version: number
  payload: Record<string, unknown>
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  'agent:start': 'text-blue-500',
  'agent:complete': 'text-green-500',
  'agent:error': 'text-red-500',
  'autonomous:iteration': 'text-yellow-500',
  'agent:iterate': 'text-yellow-500',
  'default': 'text-gray-500',
}

/**
 * Session Replay UI — fetches event store events for a session and replays
 * them in a timeline view with scrub, pause/resume, and speed controls.
 */
export function SessionReplay({ sessionId, onClose }: SessionReplayProps) {
  const [events, setEvents] = useState<DomainEvent[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    void window.donwells.eventStoreQuery({ sessionId })
      .then((result) => {
        if (cancelled) return
        const sorted = (result as unknown as DomainEvent[]).sort((a, b) => a.timestamp - b.timestamp)
        setEvents(sorted)
        setCurrentIndex(0)
        if (sorted.length > 0) setIsPlaying(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'Failed to load events'
        setError(msg)
        logger.error({ err, sessionId }, 'session-replay: failed to load events')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [sessionId])

  const currentEvent = useMemo(() => events[currentIndex] ?? null, [events, currentIndex])

  // Auto-advance timeline when playing
  useEffect(() => {
    if (!isPlaying || currentIndex >= events.length - 1) return
    const timeout = setTimeout(() => {
      setCurrentIndex((i) => Math.min(i + 1, events.length - 1))
    }, 1000 / speed)
    return () => clearTimeout(timeout)
  }, [isPlaying, currentIndex, events.length, speed])

  const jumpTo = useCallback((idx: number) => {
    setCurrentIndex(Math.max(0, Math.min(idx, events.length - 1)))
  }, [events.length])

  const togglePlay = useCallback(() => setIsPlaying((p) => !p), [])

  const stepForward = useCallback(() => {
    setIsPlaying(false)
    setCurrentIndex((i) => Math.min(i + 1, events.length - 1))
  }, [events.length])

  const stepBack = useCallback(() => {
    setIsPlaying(false)
    setCurrentIndex((i) => Math.max(i - 1, 0))
  }, [])

  if (loading) {
    return (
      <div>
        <div>
          <h3>Session Replay</h3>
          <button className="icon-btn" aria-label="Close replay" onClick={onClose}>✕</button>
        </div>
        <p>Loading events for session {sessionId.slice(0, 8)}…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <div>
          <h3>Session Replay</h3>
          <button className="icon-btn" aria-label="Close replay" onClick={onClose}>✕</button>
        </div>
        <p>{error}</p>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div>
        <div>
          <h3>Session Replay</h3>
          <button className="icon-btn" aria-label="Close replay" onClick={onClose}>✕</button>
        </div>
        <p>No events recorded for this session</p>
      </div>
    )
  }

  return (
    <div>
      <div>
        <h3>Session Replay</h3>
        <span>{sessionId.slice(0, 8)}</span>
        <button className="icon-btn" aria-label="Close replay" onClick={onClose}>✕</button>
      </div>

      {/* Playback controls */}
      <div>
        <button className="btn" onClick={stepBack} disabled={currentIndex === 0} aria-label="Step back">⏮</button>
        <button className="btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button className="btn" onClick={stepForward} disabled={currentIndex >= events.length - 1} aria-label="Step forward">⏭</button>
        <input
          type="range"
          min={0}
          max={events.length - 1}
          value={currentIndex}
          onChange={(e) => jumpTo(Number(e.target.value))}
          aria-label="Timeline scrubber"
        />
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          aria-label="Playback speed"
        >
          <option value={0.5}>0.5x</option>
          <option value={1}>1x</option>
          <option value={2}>2x</option>
          <option value={4}>4x</option>
        </select>
      </div>

      {/* Event timeline */}
      <ol>
        {events.map((event, idx) => {
          const color = EVENT_TYPE_COLORS[event.type] ?? EVENT_TYPE_COLORS['default']
          const time = new Date(event.timestamp).toLocaleTimeString()
          return (
            <li
              key={event.id}
              className={`${idx === currentIndex ? 'bg-primary/10' : 'hover:bg-muted/10'}`}
              onClick={() => jumpTo(idx)}
            >
              <span>{time}</span>
              <span className={`${color}`}>{event.type}</span>
              <span>
                {event.payload && Object.keys(event.payload).length > 0
                  ? JSON.stringify(event.payload).slice(0, 60)
                  : '—'}
              </span>
            </li>
          )
        })}
      </ol>

      {/* Current event detail */}
      {currentEvent && (
        <details>
          <summary>
            Event detail ({currentIndex + 1}/{events.length})
          </summary>
          <pre>
            {JSON.stringify(currentEvent, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}
