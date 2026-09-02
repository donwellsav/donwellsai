import { useEffect, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { useAppStore } from '../store'
import { Icon } from './Icon'

function Tree({ worktreePath, prefix = '' }: { worktreePath: string; prefix?: string }) {
  const busy = useAppStore((s) => s.busy[`explorer:${worktreePath}:${prefix}`])
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set())
  const openPreview = useAppStore((s) => s.openPreview)

  useEffect(() => {
    void window.orca.listFiles(worktreePath, prefix).then(setEntries).catch(() => setEntries([]))
  }, [worktreePath, prefix])

  if (!entries) return <div className="explorer-loading">Loading…</div>
  if (entries.length === 0) return <div className="explorer-empty">No files</div>

  return (
    <div className="explorer-tree">
      {entries.map((entry) =>
        entry.type === 'dir' ? (
          <div key={entry.path}>
            <button
              className={`explorer-row ${openDirs.has(entry.path) ? 'open' : ''}`}
              onClick={() => {
                setOpenDirs((d) => {
                  const next = new Set(d)
                  if (next.has(entry.path)) next.delete(entry.path)
                  else next.add(entry.path)
                  return next
                })
              }}
            >
              <Icon name="dir" size={12} className="explorer-chevron" />
              <span className="explorer-name">{entry.name}</span>
            </button>
            {openDirs.has(entry.path) && <Tree worktreePath={worktreePath} prefix={entry.path} />}
          </div>
        ) : (
          <button
            key={entry.path}
            className="explorer-row file"
            title={entry.path}
            onClick={() => void openPreview(worktreePath, entry.path)}
          >
            <Icon name="file" size={12} className="explorer-icon" />
            <span className="explorer-name">{entry.name}</span>
          </button>
        )
      )}
      {busy && <div className="explorer-loading">Refreshing…</div>}
    </div>
  )
}

export function ExplorerPane({ worktreePath }: { worktreePath: string }) {
  const loadExplorer = useAppStore((s) => s.loadExplorer)
  return (
    <div className="explorer-pane">
      <div className="pane-toolbar">
        <span className="pane-title">Explorer</span>
        <button className="icon-btn" title="Refresh" onClick={() => void loadExplorer(worktreePath)}>
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <Tree worktreePath={worktreePath} />
    </div>
  )
}