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
      <div className="session-replay p-3">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-foreground">Session Replay</h3>
          <button className="icon-btn" aria-label="Close replay" onClick={onClose}>✕</button>
        </div>
        <p className="text-xs text-muted">Loading events for session {sessionId.slice(0, 8)}…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="session-replay p-3">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-foreground">Session Replay</h3>
          <button className="icon-btn" aria-label="Close replay" onClick={onClose}>✕</button>
        </div>
        <p className="text-xs text-red-500">{error}</p>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="session-replay p-3">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-foreground">Session Replay</h3>
          <button className="icon-btn" aria-label="Close replay" onClick={onClose}>✕</button>
        </div>
        <p className="text-xs text-muted">No events recorded for this session</p>
      </div>
    )
  }

  return (
    <div className="session-replay p-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-foreground">Session Replay</h3>
        <span className="text-xs text-muted font-mono">{sessionId.slice(0, 8)}</span>
        <button className="icon-btn" aria-label="Close replay" onClick={onClose}>✕</button>
      </div>

      {/* Playback controls */}
      <div className="flex items-center gap-2 mb-3">
        <button className="btn btn-xs" onClick={stepBack} disabled={currentIndex === 0} aria-label="Step back">⏮</button>
        <button className="btn btn-xs" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button className="btn btn-xs" onClick={stepForward} disabled={currentIndex >= events.length - 1} aria-label="Step forward">⏭</button>
        <input
          type="range"
          className="flex-1"
          min={0}
          max={events.length - 1}
          value={currentIndex}
          onChange={(e) => jumpTo(Number(e.target.value))}
          aria-label="Timeline scrubber"
        />
        <select
          className="input-xs"
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
      <ol className="space-y-1 max-h-48 overflow-y-auto">
        {events.map((event, idx) => {
          const color = EVENT_TYPE_COLORS[event.type] ?? EVENT_TYPE_COLORS['default']
          const time = new Date(event.timestamp).toLocaleTimeString()
          return (
            <li
              key={event.id}
              className={`text-xs flex items-center gap-2 px-1 rounded cursor-pointer ${idx === currentIndex ? 'bg-primary/10' : 'hover:bg-muted/10'}`}
              onClick={() => jumpTo(idx)}
            >
              <span className="text-muted font-mono w-14 shrink-0">{time}</span>
              <span className={`font-medium ${color} w-24 truncate`}>{event.type}</span>
              <span className="text-muted truncate">
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
        <details className="mt-3">
          <summary className="text-xs text-muted cursor-pointer">
            Event detail ({currentIndex + 1}/{events.length})
          </summary>
          <pre className="text-xs bg-muted/10 p-2 rounded mt-1 overflow-x-auto max-h-32">
            {JSON.stringify(currentEvent, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}
