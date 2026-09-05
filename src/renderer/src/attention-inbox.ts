import { useEffect, useSyncExternalStore } from 'react'
import type {
  AttentionEvent,
  AttentionInboxApi,
  AttentionInboxEntry,
  AttentionInboxSnapshot
} from '@shared/attention-inbox'

export type AttentionInboxPhase = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

export type AttentionRevealTarget = {
  eventId: string
  eventVersion: number
  sessionId: string
}

export type AttentionInboxRendererState = {
  phase: AttentionInboxPhase
  snapshot: AttentionInboxSnapshot | null
  overlayOpen: boolean
  error: string | null
  reveals: Readonly<Record<string, AttentionRevealTarget>>
}

export type AttentionTerminalVisibility = {
  sessionId: string
  isActive: boolean
  runsOverlayOpen: boolean
  host: {
    readonly isConnected: boolean
    contains(element: Node | null): boolean
    getBoundingClientRect(): Pick<DOMRect, 'width' | 'height'>
  }
  /** True only for a fresh focus/visibility event, never a snapshot re-render. */
  allowCapture: boolean
}

type FocusAgentSession = (sessionId: string) => Promise<boolean>
type StateListener = (state: AttentionInboxRendererState) => void

const subscribers = new Set<() => void>()
const stateListeners = new Set<StateListener>()
const acknowledgementsInFlight = new Set<string>()
let api: AttentionInboxApi | null = null
let refreshGeneration = 0
let state: AttentionInboxRendererState = {
  phase: 'idle',
  snapshot: null,
  overlayOpen: false,
  error: null,
  reveals: {}
}

function publish(next: AttentionInboxRendererState): void {
  if (next === state) return
  state = next
  for (const listener of subscribers) listener()
  for (const listener of stateListeners) listener(state)
}

function cleanReveals(snapshot: AttentionInboxSnapshot, reveals: Readonly<Record<string, AttentionRevealTarget>>): Readonly<Record<string, AttentionRevealTarget>> {
  const unread = new Set(snapshot.entries.filter((entry) => entry.acknowledgedAt === undefined).map((entry) => `${entry.id}:${entry.version}`))
  const next: Record<string, AttentionRevealTarget> = {}
  for (const sessionId in reveals) {
    const reveal = reveals[sessionId]
    if (reveal && unread.has(`${reveal.eventId}:${reveal.eventVersion}`)) next[sessionId] = reveal
  }
  return next
}

function applySnapshot(snapshot: AttentionInboxSnapshot): void {
  if (state.snapshot && snapshot.revision < state.snapshot.revision) return
  publish({
    ...state,
    phase: 'ready',
    snapshot,
    error: null,
    reveals: cleanReveals(snapshot, state.reveals)
  })
}

export function getAttentionInboxState(): AttentionInboxRendererState {
  return state
}

export function subscribeAttentionInbox(listener: StateListener): () => void {
  stateListeners.add(listener)
  listener(state)
  return () => stateListeners.delete(listener)
}

export function useAttentionInboxState(): AttentionInboxRendererState {
  return useSyncExternalStore(
    (listener) => {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    getAttentionInboxState,
    getAttentionInboxState
  )
}

export function openAttentionInbox(): void {
  publish({ ...state, overlayOpen: true, error: null })
  void refreshAttentionInbox()
}

export function closeAttentionInbox(): void {
  publish({ ...state, overlayOpen: false })
}

export async function refreshAttentionInbox(): Promise<void> {
  const currentApi = api
  if (!currentApi) return
  const generation = ++refreshGeneration
  if (!state.snapshot) publish({ ...state, phase: 'loading', error: null })
  try {
    const result = await currentApi.attentionInboxList()
    if (generation !== refreshGeneration || currentApi !== api) return
    if (!result.available) {
      publish({
        ...state,
        phase: 'unavailable',
        snapshot: null,
        error: 'Attention inbox requires the current terminal daemon. Existing sessions were left running.',
        reveals: {}
      })
      return
    }
    applySnapshot(result.snapshot)
  } catch (error) {
    if (generation !== refreshGeneration || currentApi !== api) return
    publish({
      ...state,
      phase: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * Mounts the daemon-backed controller. App focus only refreshes unread state;
 * it never acknowledges an event.
 */
export function mountAttentionInbox(
  attentionApi: AttentionInboxApi,
  onState?: StateListener
): () => void {
  api = attentionApi
  if (onState) stateListeners.add(onState)
  const onWindowFocus = (): void => { void refreshAttentionInbox() }
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') void refreshAttentionInbox()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibility)
  }
  void refreshAttentionInbox()
  return () => {
    if (onState) stateListeners.delete(onState)
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    if (api === attentionApi) api = null
    refreshGeneration++
  }
}

/** Parent App mount hook; agent event handlers should call refreshAttentionInbox after applying the run. */
export function useAttentionInboxMount(
  attentionApi: AttentionInboxApi,
  onState?: StateListener
): AttentionInboxRendererState {
  const current = useAttentionInboxState()
  useEffect(() => mountAttentionInbox(attentionApi, onState), [attentionApi, onState])
  return current
}

export function requestAttentionReveal(event: Pick<AttentionEvent, 'id' | 'version' | 'sessionId'>): void {
  const reveal: AttentionRevealTarget = {
    eventId: event.id,
    eventVersion: event.version,
    sessionId: event.sessionId
  }
  publish({ ...state, reveals: { ...state.reveals, [event.sessionId]: reveal } })
}

export function pendingAttentionReveal(sessionId: string): AttentionRevealTarget | undefined {
  return state.reveals[sessionId]
}

/**
 * Deep-links to the exact retained terminal. A failed lookup leaves the inbox
 * open and creates no acknowledgement intent.
 */
export async function revealAttentionEntry(
  entry: AttentionInboxEntry,
  focusAgentSession: FocusAgentSession
): Promise<boolean> {
  const focused = await focusAgentSession(entry.sessionId)
  if (!focused) {
    publish({ ...state, error: 'The retained terminal for this attention event is no longer available.' })
    return false
  }
  closeAttentionInbox()
  if (entry.acknowledgedAt === undefined) requestAttentionReveal(entry)
  return true
}

/**
 * Acknowledge only after the exact xterm owns DOM focus in a visible active
 * pane. The immutable id/version is captured before the request, so a newer
 * event arriving during a late activation remains unread.
 */
export async function acknowledgeVisibleAttention(visibility: AttentionTerminalVisibility): Promise<boolean> {
  if (!api || !visibility.isActive || visibility.runsOverlayOpen || state.overlayOpen) return false
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false
  if (!visibility.host.isConnected || !visibility.host.contains(document.activeElement)) return false
  const bounds = visibility.host.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return false

  const reveal = state.reveals[visibility.sessionId]
  if (!reveal && !visibility.allowCapture) return false
  const entry = reveal
    ? undefined
    : state.snapshot?.entries.find((candidate) => (
        candidate.sessionId === visibility.sessionId && candidate.acknowledgedAt === undefined
      ))
  if (!reveal && !entry) return false
  const target: AttentionRevealTarget = reveal
    ? reveal
    : {
        eventId: entry!.id,
        eventVersion: entry!.version,
        sessionId: entry!.sessionId
      }
  const key = `${target.eventId}:${target.eventVersion}`
  if (acknowledgementsInFlight.has(key)) return false
  acknowledgementsInFlight.add(key)
  const currentApi = api
  try {
    // Invalidate an older list response before issuing this exact mutation.
    refreshGeneration++
    const result = await currentApi.attentionInboxAcknowledge({
      eventId: target.eventId,
      eventVersion: target.eventVersion
    })
    if (currentApi !== api) return false
    if (!result.available) {
      publish({
        ...state,
        phase: 'unavailable',
        snapshot: null,
        error: 'Attention inbox requires the current terminal daemon. Existing sessions were left running.',
        reveals: {}
      })
      return false
    }
    applySnapshot(result.snapshot)
    return result.outcome === 'acknowledged' || result.outcome === 'already-acknowledged'
  } catch (error) {
    if (currentApi === api) {
      publish({ ...state, phase: 'error', error: error instanceof Error ? error.message : String(error) })
    }
    return false
  } finally {
    acknowledgementsInFlight.delete(key)
  }
}
