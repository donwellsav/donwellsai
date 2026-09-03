import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { useAppStore } from '../store'
import { dispatchAction } from '../App'
import { fuzzyMatch } from '../fuzzy'

type PaletteItem = {
  id: string
  label: string
  hint?: string
  run: () => void
}

export function CommandPalette({ open }: { open: boolean }) {
  const setOpen = useAppStore((s) => s.setPaletteOpen)
  const repos = useAppStore((s) => s.repos)
  const setActiveRepo = useAppStore((s) => s.setActiveRepo)
  const agents = useAppStore((s) => s.agents)
  const activeWorktreePath = useAppStore((s) => s.activeWorktreePath)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const [files, setFiles] = useState<FileEntry[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // Worktree file inventory for QuickOpen: one recursive git ls-files per open.
  useEffect(() => {
    if (!open || !activeWorktreePath) {
      setFiles([])
      return
    }
    let alive = true
    window.orca
      .listAllFiles(activeWorktreePath)
      .then((f) => {
        if (alive) setFiles(f)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, activeWorktreePath])
  // Reset query each time the palette opens, focus the input.
  useEffect(() => {
    if (open) {
      setQ('')
      setCursor(0)
      // focus on next frame once the overlay is mounted
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    const s = useAppStore.getState()
    const out: PaletteItem[] = []

    for (const repo of repos) {
      for (const wt of repo.worktrees) {
        out.push({
          id: `wt:${wt.id}`,
          label: `${wt.branch} — ${wt.path.split('/').filter(Boolean).pop()}`,
          hint: 'open',
          run: () => {
            setActiveRepo(repo.repo.id)
            useAppStore.getState().setActiveWorktree(wt.path)
            void useAppStore.getState().openTerminal(wt.path)
          }
        })
      }
    }
    out.push({ id: 'act:add-repo', label: 'Add repository…', hint: '⌘O', run: () => dispatchAction('add-repo') })
    out.push({ id: 'act:new-worktree', label: 'New worktree', hint: '⌘N', run: () => dispatchAction('new-worktree') })
    out.push({ id: 'act:new-terminal', label: 'New terminal', hint: '⌘T', run: () => dispatchAction('new-terminal') })
    out.push({ id: 'act:close-tab', label: 'Close active tab', hint: '⌘W', run: () => dispatchAction('close-active-pane') })
    out.push({ id: 'act:split', label: 'Split terminal', hint: '⌘⇧5', run: () => dispatchAction('split-terminal') })
    out.push({ id: 'act:explorer', label: 'Toggle explorer', hint: '⌘⇧E', run: () => dispatchAction('toggle-explorer') })
    out.push({ id: 'act:git', label: 'Toggle git status', hint: '⌘⇧G', run: () => dispatchAction('toggle-git-status') })
    out.push({ id: 'act:refresh', label: 'Refresh worktrees & status', run: () => void useAppStore.getState().refresh() })
    out.push({ id: 'act:settings', label: 'Settings', hint: '⌘,', run: () => dispatchAction('settings') })
    for (const a of agents) {
      out.push({
        id: `act:run:${a.name}`,
        label: `Run ${a.name} in active worktree`,
        hint: a.command,
        run: () => {
          const target = useAppStore.getState().activeWorktreePath
          const repo = useAppStore.getState().repos.find((r) => r.repo.id === useAppStore.getState().activeRepoId)
          const path = target ?? repo?.worktrees.find((w) => !w.isMain)?.path ?? repo?.worktrees[0]?.path
          if (path) void useAppStore.getState().runAgent(path, a.command)
        }
      })
    }
    return out
  }, [repos, agents, setActiveRepo])
  const filtered = useMemo(() => {
    const needle = q.trim()
    if (!needle) return items.map((item) => ({ item, hits: [] as number[] }))
    const scored = items
      .map((item) => {
        const m = fuzzyMatch(item.label, needle) ?? (item.hint ? fuzzyMatch(item.hint, needle) : null)
        return m ? { item, hits: m.hits, score: m.score } : null
      })
      .filter((x): x is { item: PaletteItem; hits: number[]; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
    return scored
  }, [items, q])

  /** QuickOpen: fuzzy file hits under the command hits (query-gated, capped). */
  const fileHits = useMemo(() => {
    const needle = q.trim()
    if (!needle || !activeWorktreePath) return []
    return files
      .map((f) => {
        const m = fuzzyMatch(f.path, needle)
        return m ? { f, hits: m.hits, score: m.score } : null
      })
      .filter((x): x is { f: FileEntry; hits: number[]; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ f }) => ({
        item: {
          id: `file:${f.path}`,
          label: f.name,
          hint: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : activeWorktreePath.split('/').pop(),
          run: () => {
            useAppStore.getState().setPaletteOpen(false)
            void useAppStore.getState().openPreview(activeWorktreePath, f.path)
          }
        },
        hits: [] as number[]
      }))
  }, [files, q, activeWorktreePath])

  const combined = useMemo(() => [...filtered, ...fileHits], [filtered, fileHits])

  if (!open) return null

  const run = (entry: { item: PaletteItem } | undefined): void => {
    if (!entry) return
    setOpen(false)
    entry.item.run()
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, combined.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(combined[cursor])
    }
  }

  /** Render the label with fuzzy-matched characters emphasized. */
  const Highlighted = ({ label, hits }: { label: string; hits: number[] }): React.ReactNode => {
    if (!hits.length) return <>{label}</>
    const set = new Set(hits)
    return (
      <>
        {label.split('').map((ch, i) => (set.has(i) ? <b key={i}>{ch}</b> : <span key={i}>{ch}</span>))}
      </>
    )
  }

  return (
    <div className="palette-overlay" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Run a command — worktree, terminal, agent, settings…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="palette-list">
          {combined.length === 0 && <div className="palette-empty">No matches for “{q}”</div>}
          {filtered.map((entry, i) => (
            <button
              key={entry.item.id}
              className={`palette-item ${i === cursor ? 'selected' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => run(entry)}
            >
              <span className="palette-label">
                <Highlighted label={entry.item.label} hits={entry.hits} />
              </span>
              {entry.item.hint && <span className="palette-hint">{entry.item.hint}</span>}
            </button>
          ))}
          {fileHits.length > 0 && <div className="palette-group">Files</div>}
          {fileHits.map((entry, i) => (
            <button
              key={entry.item.id}
              className={`palette-item ${i + filtered.length === cursor ? 'selected' : ''}`}
              onMouseEnter={() => setCursor(i + filtered.length)}
              onClick={() => run(entry)}
            >
              <span className="palette-label">
                <Highlighted label={entry.item.label} hits={entry.hits} />
              </span>
              {entry.item.hint && <span className="palette-hint">{entry.item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}