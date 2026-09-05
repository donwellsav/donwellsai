import { useEffect, useMemo, useRef, useState } from 'react'
import type { AttentionEventKind, AttentionInboxEntry } from '@shared/attention-inbox'
import {
  closeAttentionInbox,
  refreshAttentionInbox,
  revealAttentionEntry,
  useAttentionInboxState
} from '../attention-inbox'
import { useAppStore } from '../store'
import { Icon } from './Icon'
import './attention-inbox.css'

const KIND_LABEL: Record<AttentionEventKind, string> = {
  permission: 'Permission needed',
  waiting: 'Waiting for input',
  failed: 'Run failed',
  completed: 'Run completed',
  contact: 'Contact unverified'
}

function workspaceLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function relativeTime(timestamp: string, now: number): string {
  const deltaSeconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1_000))
  if (deltaSeconds < 60) return deltaSeconds < 5 ? 'now' : `${deltaSeconds}s`
  const minutes = Math.floor(deltaSeconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function contactLabel(entry: AttentionInboxEntry): string {
  if (entry.terminalAvailability === 'unavailable') return 'Terminal unavailable'
  if (entry.currentLiveness === 'unknown') return 'Current state unknown'
  if (entry.currentLiveness === 'unverifiable') return 'Liveness unverified'
  if (entry.currentLiveness === 'live' && (entry.kind === 'completed' || entry.kind === 'failed')) {
    return 'Process still live'
  }
  return entry.currentLiveness === 'exited' ? 'Process exited' : 'Live terminal'
}

function matches(entry: AttentionInboxEntry, query: string): boolean {
  if (!query) return true
  const haystack = [
    entry.kind,
    KIND_LABEL[entry.kind],
    entry.detail,
    entry.command,
    entry.providerId ?? '',
    entry.workspacePath,
    contactLabel(entry)
  ].join('\n').toLocaleLowerCase()
  return haystack.includes(query)
}

export function AttentionInbox() {
  const state = useAttentionInboxState()
  const [filter, setFilter] = useState<'unread' | 'all'>('unread')
  const [query, setQuery] = useState('')
  const [openingId, setOpeningId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const entries = useMemo(
    () => (state.snapshot?.entries ?? []).filter((entry) => (
      (filter === 'all' || entry.acknowledgedAt === undefined) && matches(entry, normalizedQuery)
    )),
    [filter, normalizedQuery, state.snapshot]
  )

  useEffect(() => {
    if (!state.overlayOpen) return
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeAttentionInbox()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
    }
  }, [state.overlayOpen])

  if (!state.overlayOpen) return null
  const unreadCount = state.snapshot?.unreadCount ?? 0
  const now = Date.now()

  const openEntry = async (entry: AttentionInboxEntry): Promise<void> => {
    if (entry.terminalAvailability === 'unavailable' || openingId) return
    setOpeningId(entry.id)
    try {
      await revealAttentionEntry(entry, (sessionId) => useAppStore.getState().focusAgentSession(sessionId))
    } finally {
      setOpeningId(null)
    }
  }

  return (
    <div className="attention-inbox-layer">
      <button className="attention-inbox-scrim" aria-label="Close attention inbox" onClick={closeAttentionInbox} />
      <section className="attention-inbox" role="dialog" aria-modal="true" aria-labelledby="attention-inbox-title">
        <header className="attention-inbox-header">
          <div>
            <span className="attention-inbox-eyebrow">Coding sessions</span>
            <h2 id="attention-inbox-title">Attention</h2>
          </div>
          <span className="attention-inbox-unread" aria-label={`${unreadCount} unread`}>{unreadCount}</span>
          <button className="icon-btn" aria-label="Refresh attention inbox" onClick={() => void refreshAttentionInbox()}>
            <Icon name="refresh" size={13} />
          </button>
          <button className="icon-btn" aria-label="Close attention inbox" onClick={closeAttentionInbox}>
            <Icon name="x" size={13} />
          </button>
        </header>

        <div className="attention-inbox-tools">
          <label className="attention-inbox-search">
            <Icon name="search" size={12} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value.slice(0, 256))}
              placeholder="Search sessions, workspaces, details"
              aria-label="Search attention inbox"
            />
            {query && <button aria-label="Clear search" onClick={() => setQuery('')}><Icon name="x" size={11} /></button>}
          </label>
          <div className="attention-inbox-tabs" role="tablist" aria-label="Attention filter">
            <button role="tab" aria-selected={filter === 'unread'} className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>
              Unread <span>{unreadCount}</span>
            </button>
            <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
              All
            </button>
          </div>
        </div>

        <div className="attention-inbox-list">
          {state.phase === 'loading' && !state.snapshot && (
            <p className="attention-inbox-empty">Loading durable activity…</p>
          )}
          {(state.phase === 'unavailable' || state.phase === 'error') && !state.snapshot && (
            <div className="attention-inbox-message" role="status">
              <Icon name="alert" size={14} />
              <p>{state.error}</p>
            </div>
          )}
          {state.snapshot && entries.map((entry) => {
            const unread = entry.acknowledgedAt === undefined
            const unavailable = entry.terminalAvailability === 'unavailable'
            return (
              <button
                key={entry.id}
                type="button"
                className={`attention-inbox-row attention-kind-${entry.kind}${unread ? ' unread' : ''}`}
                disabled={unavailable || openingId !== null}
                onClick={() => void openEntry(entry)}
                aria-label={`${KIND_LABEL[entry.kind]} in ${workspaceLabel(entry.workspacePath)}. ${contactLabel(entry)}`}
              >
                <span className="attention-inbox-state" aria-hidden="true">
                  {entry.kind === 'completed' ? <Icon name="check" size={11} /> : entry.kind === 'waiting' ? <Icon name="clock" size={11} /> : <Icon name="alert" size={11} />}
                </span>
                <span className="attention-inbox-copy">
                  <span className="attention-inbox-primary">
                    <strong>{KIND_LABEL[entry.kind]}</strong>
                    <span>{workspaceLabel(entry.workspacePath)}</span>
                    <time dateTime={entry.occurredAt}>{relativeTime(entry.occurredAt, now)}</time>
                  </span>
                  <span className="attention-inbox-detail">{entry.detail}</span>
                  <span className="attention-inbox-meta">
                    <span>{entry.providerId ?? entry.command.split(/\s/)[0] ?? 'agent'}</span>
                    <span>{contactLabel(entry)}</span>
                  </span>
                </span>
                {unread && <span className="attention-inbox-dot" aria-label="Unread" />}
                {!unavailable && <Icon name="terminal" size={12} className="attention-inbox-open-icon" />}
              </button>
            )
          })}
          {state.snapshot && entries.length === 0 && (
            <p className="attention-inbox-empty">
              {normalizedQuery ? 'No attention events match this search.' : filter === 'unread' ? 'No unread attention.' : 'No retained attention history.'}
            </p>
          )}
        </div>

        {state.error && state.snapshot && <p className="attention-inbox-inline-error" role="alert">{state.error}</p>}
        {state.snapshot && state.snapshot.retention.discardedAcknowledged > 0 && (
          <footer className="attention-inbox-retention">
            {state.snapshot.retention.discardedAcknowledged} older acknowledged events were removed. Unread events are always retained.
          </footer>
        )}
      </section>
    </div>
  )
}
