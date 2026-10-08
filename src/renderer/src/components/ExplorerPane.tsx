import { contextMenuKey, focusContextMenu } from '../context-menu'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { FileEntry } from '@shared/types'
import { useAppStore, type ExplorerWorkspaceState, type ExplorerEntryDialog } from '../store'
import { Icon } from './Icon'
import { ModalDialog } from './ModalDialog'

type ExplorerRow = { entry: FileEntry; depth: number }
type EntryDialog = ExplorerEntryDialog
type ContextMenu = { entry?: FileEntry; x: number; y: number }

const EMPTY_WORKSPACE: ExplorerWorkspaceState = {
  directories: {},
  expanded: [],
  selected: null,

  showHidden: false,
  includeIgnored: false
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function duplicatePath(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const hasExtension = dot > slash + 1
  return hasExtension ? path.slice(0, dot) + ' copy' + path.slice(dot) : path + ' copy'
}

function flattenExplorer(workspace: ExplorerWorkspaceState): ExplorerRow[] {
  const rows: ExplorerRow[] = []
  const root = workspace.directories['']?.entries ?? []
  const stack = [...root].reverse().map((entry) => ({ entry, depth: 0 }))
  while (stack.length > 0) {
    const row = stack.pop()
    if (!row) continue
    rows.push(row)
    if (row.entry.type !== 'dir' || !workspace.expanded.includes(row.entry.path)) continue
    const children = workspace.directories[row.entry.path]?.entries ?? []
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const entry = children[index]
      if (entry) stack.push({ entry, depth: row.depth + 1 })
    }
  }
  return rows
}

function dialogTitle(dialog: EntryDialog): string {
  if (dialog.kind === 'create-file') return 'New file'
  if (dialog.kind === 'create-directory') return 'New folder'
  if (dialog.kind === 'rename') return 'Rename or move'
  if (dialog.kind === 'duplicate') return 'Duplicate'
  return 'Move to Trash'
}

export function ExplorerPane({ worktreePath, active = true, location = 'sidebar' }: { worktreePath: string; active?: boolean; location?: 'sidebar' | 'workspace' }) {
  const workspace = useAppStore((state) => state.explorer[worktreePath] ?? EMPTY_WORKSPACE)
  const refreshExplorer = useAppStore((state) => state.refreshExplorer)
  const setExpanded = useAppStore((state) => state.setExplorerExpanded)
  const setSelected = useAppStore((state) => state.setExplorerSelected)
  const setVisibility = useAppStore((state) => state.setExplorerVisibility)
  const collapseExplorer = useAppStore((state) => state.collapseExplorer)
  const openPreview = useAppStore((state) => state.openPreview)
  const dialog = workspace.entryDialog ?? null
  const setDialog = (value: EntryDialog | null): void => useAppStore.getState().setExplorerEntryDialog(worktreePath, value)
  const sidebarOwnsDialog = useAppStore(state => state.rightSidebarOpen && state.rightSidebarTab === 'explorer' && state.activeWorktreePath === worktreePath)
  const viewOptionsId = useId()
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const mutationError = dialog?.error ?? ''
  const mutating = dialog?.pending ?? false
  const treeRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => flattenExplorer(workspace), [workspace])
  const selectedIndex = rows.findIndex((row) => row.entry.path === workspace.selected)
  const selectedEntry = selectedIndex >= 0 ? rows[selectedIndex]?.entry : undefined
  const root = workspace.directories['']

  useEffect(() => {
    if (!root || root.phase === 'idle') void refreshExplorer(worktreePath)
  }, [refreshExplorer, root, worktreePath])

  useEffect(() => {
    if (!contextMenu) return
    focusContextMenu(contextMenuRef.current)
    const dismiss = (): void => setContextMenu(null)
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [contextMenu])

  useEffect(() => {
    if (selectedIndex < 0) return
    treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, workspace.selected])

  const openEntryDialog = (kind: EntryDialog['kind'], entry?: FileEntry): void => {
    if (useAppStore.getState().explorer[worktreePath]?.entryDialog?.pending) return
    const base = entry?.type === 'dir' ? entry.path : directoryOf(entry?.path ?? '')
    let value = base ? base + '/' : ''
    if (kind === 'rename' && entry) value = entry.path
    if (kind === 'duplicate' && entry) value = duplicatePath(entry.path)
    if (kind === 'delete' && entry) value = entry.path
    setContextMenu(null)
    setDialog({ kind, entry, value })
  }

  const activate = (entry: FileEntry): void => {
    setSelected(worktreePath, entry.path)
    if (entry.type === 'dir') setExpanded(worktreePath, entry.path, !workspace.expanded.includes(entry.path))
    else void openPreview(worktreePath, entry.path)
  }

  const openExternalEntry = async (entry: FileEntry, browser: boolean): Promise<void> => {
    setContextMenu(null)
    try {
      if (browser) await useAppStore.getState().openBrowser(worktreePath, await window.donwells.workspacePreviewUrl(worktreePath, entry.path))
      else await window.donwells.revealWorkspaceEntry(worktreePath, entry.path)
    } catch (error) { useAppStore.setState({ error: String(error) }) }
  }

  const openContextMenu = (entry: FileEntry | undefined, x: number, y: number): void => {
    if (entry) setSelected(worktreePath, entry.path)
    const inset = 8
    setContextMenu({
      entry,
      x: Math.min(Math.max(inset, x), Math.max(inset, window.innerWidth - 208)),
      y: Math.min(Math.max(inset, y), Math.max(inset, window.innerHeight - 320))
    })
  }

  const refreshLoaded = async (): Promise<void> => {
    await refreshExplorer(worktreePath)
    await Promise.all(workspace.expanded.map((directory) => refreshExplorer(worktreePath, directory)))
  }

  const submitDialog = async (): Promise<void> => {
    const current = useAppStore.getState().explorer[worktreePath]?.entryDialog
    if (!current || current.pending) return
    const submitted = { ...current, pending: true, error: undefined }
    setDialog(submitted)
    const store = useAppStore.getState()
    let succeeded = false, error: string | undefined
    try {
      if (current.kind === 'create-file') succeeded = await store.createWorkspaceEntry(worktreePath, current.value, 'file')
      else if (current.kind === 'create-directory') succeeded = await store.createWorkspaceEntry(worktreePath, current.value, 'directory')
      else if (current.kind === 'rename' && current.entry) succeeded = await store.moveWorkspaceEntry(worktreePath, current.entry.path, current.value)
      else if (current.kind === 'duplicate' && current.entry) succeeded = await store.duplicateWorkspaceEntry(worktreePath, current.entry.path, current.value)
      else if (current.kind === 'delete' && current.entry) succeeded = await store.deleteWorkspaceEntry(worktreePath, current.entry.path)
    } catch (cause) { error = String(cause) }
    if (useAppStore.getState().explorer[worktreePath]?.entryDialog !== submitted) return
    setDialog(succeeded ? null : { ...current, pending: false, error: error ?? useAppStore.getState().error ?? 'The workspace operation failed.' })
  }

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = selectedIndex >= 0 ? selectedIndex : 0
    const row = rows[index]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const offset = event.key === 'ArrowDown' ? 1 : -1
      const next = selectedIndex < 0
        ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
        : Math.min(rows.length - 1, Math.max(0, index + offset))
      const entry = rows[next]?.entry
      if (entry) setSelected(worktreePath, entry.path)
      return
    }
    if (!row) return
    if (event.key === 'ArrowRight' && row.entry.type === 'dir') {
      event.preventDefault()
      setExpanded(worktreePath, row.entry.path, true)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (row.entry.type === 'dir' && workspace.expanded.includes(row.entry.path)) {
        setExpanded(worktreePath, row.entry.path, false)
      } else {
        for (let parent = index - 1; parent >= 0; parent -= 1) {
          const candidate = rows[parent]
          if (candidate && candidate.depth < row.depth) {
            setSelected(worktreePath, candidate.entry.path)
            break
          }
        }
      }
    } else if (event.key === 'Enter') {
      event.preventDefault()
      activate(row.entry)
    } else if (event.key === 'F2') {
      event.preventDefault()
      openEntryDialog('rename', row.entry)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      openEntryDialog('delete', row.entry)
    } else if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault()
      const element = treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[index]
      const bounds = element?.getBoundingClientRect()
      openContextMenu(row.entry, bounds?.left ?? 20, bounds?.bottom ?? 80)
    }
  }

  return (
    <div className="explorer-pane">
      <div className="pane-header explorer-toolbar">
        <button type="button" className="icon-btn" title="Create a file in the selected folder" aria-label="New file" onClick={() => openEntryDialog('create-file', selectedEntry)}><Icon name="filePlus" /></button>
        <button type="button" className="icon-btn" title="Create a folder in the selected folder" aria-label="New folder" onClick={() => openEntryDialog('create-directory', selectedEntry)}><Icon name="folderPlus" /></button>
        <button type="button" className="icon-btn" title={workspace.expanded.length === 0 ? 'No expanded folders to collapse' : 'Collapse all expanded folders'} aria-label="Collapse folders" disabled={workspace.expanded.length === 0} onClick={() => collapseExplorer(worktreePath)}><Icon name="up" /></button>
        <button type="button" className="icon-btn" title="Show hidden or ignored files, or refresh the file list" aria-label="Files display options" popoverTarget={viewOptionsId}><Icon name="more" /></button>
        <div id={viewOptionsId} popover="auto" className="explorer-view-options" onToggle={event => {
          if (event.newState !== 'open') return
          const panel = event.currentTarget, anchor = panel.previousElementSibling!.getBoundingClientRect()
          panel.style.left = `${anchor.left}px`; panel.style.top = `${anchor.bottom + 4}px`
          focusContextMenu(panel, 'input')
        }}>
          <label><input type="checkbox" checked={workspace.showHidden} onChange={event => setVisibility(worktreePath, { showHidden: event.target.checked })} />Show hidden files</label>
          <label><input type="checkbox" checked={workspace.includeIgnored} onChange={event => setVisibility(worktreePath, { includeIgnored: event.target.checked })} />Include ignored files</label>
          <button type="button" className="btn btn-secondary btn-sm" onClick={event => { event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover(); void refreshLoaded() }}><Icon name="refresh" />Refresh files</button>
        </div>
      </div>
      {root?.phase === 'loading' && root.entries.length === 0 ? <div className="explorer-loading">Loading workspace…</div> : null}
      {root?.phase === 'error' ? (
        <div className="explorer-error" role="alert">
          <span>{root.error}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshExplorer(worktreePath)}>Retry</button>
        </div>
      ) : null}
      {root?.phase === 'ready' && rows.length === 0 ? (
        <div className="explorer-empty">
          <strong>This workspace is empty</strong>
          <span>Create a file or folder to start working here.</span>
        </div>
      ) : null}
      {root?.truncated ? <div className="explorer-notice">Showing the first 4,096 entries.</div> : null}
      <div
        ref={treeRef}
        className="explorer-tree"
        role="tree"
        tabIndex={0}
        aria-label="Workspace files"
        aria-activedescendant={selectedIndex >= 0 ? 'explorer-row-' + selectedIndex : undefined}
        onKeyDown={handleTreeKeyDown}
        onContextMenu={(event) => {
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          openContextMenu(undefined, event.clientX, event.clientY)
        }}
      >
        {rows.map((row, index) => {
          const expanded = row.entry.type === 'dir' && workspace.expanded.includes(row.entry.path)
          const directory = row.entry.type === 'dir' ? workspace.directories[row.entry.path] : undefined
          return (
            <div key={row.entry.path} role="none">
              <button
                id={'explorer-row-' + index}
                type="button"
                role="treeitem"
                tabIndex={-1}
                aria-level={row.depth + 1}
                aria-expanded={row.entry.type === 'dir' ? expanded : undefined}
                aria-selected={workspace.selected === row.entry.path}
                className={'explorer-row' + (row.entry.type === 'file' ? 'file' : '') + (expanded ? 'open' : '') + (workspace.selected === row.entry.path ? 'selected' : '')}
                style={{ paddingInlineStart: 8 + row.depth * 14 }}
                title={row.entry.path}
                onClick={() => { treeRef.current?.focus(); activate(row.entry) }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  openContextMenu(row.entry, event.clientX, event.clientY)
                }}
              >
                <Icon name={row.entry.type === 'dir' ? 'dir' : 'file'} size={12} className={row.entry.type === 'dir' ? 'explorer-chevron' : 'explorer-icon'} />
                <span className="explorer-name">{row.entry.name}</span>
              </button>
              {expanded && directory?.phase === 'loading' && directory.entries.length === 0 ? (
                <div className="explorer-loading" style={{ paddingInlineStart: 28 + row.depth * 14 }}>Loading…</div>
              ) : null}
              {expanded && directory?.phase === 'error' ? (
                <div className="explorer-error" style={{ paddingInlineStart: 28 + row.depth * 14 }}>
                  <span>{directory.error}</span>
                  <button type="button" onClick={() => void refreshExplorer(worktreePath, row.entry.path)}>Retry</button>
                </div>
              ) : null}
              {expanded && directory?.truncated ? <div className="explorer-notice">Folder results truncated.</div> : null}
            </div>
          )
        })}
      </div>
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="explorer-context-menu"
          role="menu"
          aria-label="Files actions"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setContextMenu(null)
          }}
          onKeyDown={event => contextMenuKey(event, () => { setContextMenu(null); treeRef.current?.focus() })}
        >
          {contextMenu.entry && <>
            <button type="button" role="menuitem" onClick={() => { activate(contextMenu.entry!); setContextMenu(null) }}>Open</button>
            <button type="button" role="menuitem" title="Reveal this item in the system file manager" onClick={() => void openExternalEntry(contextMenu.entry!, false)}>Open in Finder</button>
            {contextMenu.entry.type !== 'dir' && <button type="button" role="menuitem" title="Preview this file and its assets in the built-in browser" onClick={() => void openExternalEntry(contextMenu.entry!, true)}>Open in browser</button>}
            <hr role="separator" />
          </>}
          <button type="button" role="menuitem" onClick={() => openEntryDialog('create-file', contextMenu.entry)}>New file…</button>
          <button type="button" role="menuitem" onClick={() => openEntryDialog('create-directory', contextMenu.entry)}>New folder…</button>
          {contextMenu.entry ? <button type="button" role="menuitem" onClick={() => openEntryDialog('rename', contextMenu.entry)}>Rename or move…</button> : null}
          {contextMenu.entry ? <button type="button" role="menuitem" onClick={() => openEntryDialog('duplicate', contextMenu.entry)}>Duplicate…</button> : null}
          {contextMenu.entry ? <button type="button" role="menuitem" className="danger" onClick={() => openEntryDialog('delete', contextMenu.entry)}>Move to Trash…</button> : null}
        </div>
      ) : null}
      {dialog && active && (location === 'sidebar' || !sidebarOwnsDialog) ? (
        <ModalDialog labelledBy="explorer-dialog-title" onClose={() => !mutating && setDialog(null)}>
          <h2 id="explorer-dialog-title">{dialogTitle(dialog)}</h2>
          {dialog.kind === 'delete' ? (
            <p>Move <strong>{dialog.entry?.path}</strong> to the system Trash? You can recover it from there.</p>
          ) : (
            <label className="field modal-field">
              <span>Workspace-relative path</span>
              <input
                className="input"
                autoFocus
                disabled={mutating}
                value={dialog.value}
                onChange={(event) => setDialog({ ...dialog, value: event.currentTarget.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void submitDialog()
                  }
                }}
              />
            </label>
          )}
          {mutationError ? <div role="alert">{mutationError}</div> : null}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" disabled={mutating} onClick={() => setDialog(null)}>Cancel</button>
            <button
              type="button"
              className={dialog.kind === 'delete' ? 'btn btn-danger' : 'btn btn-primary'}
              disabled={mutating || (dialog.kind !== 'delete' && !dialog.value.trim())}
              onClick={() => void submitDialog()}
            >
              {mutating ? 'Working…' : dialog.kind === 'delete' ? 'Move to Trash' : 'Apply'}
            </button>
          </div>
        </ModalDialog>
      ) : null}
    </div>
  )
}