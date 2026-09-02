import { useAppStore } from '../store'

export function PreviewPane({ worktreePath, isActive }: { worktreePath: string; isActive: boolean }) {
  const preview = useAppStore((s) => s.previews[worktreePath])
  const closePreview = useAppStore((s) => s.closePreview)
  if (!preview) return null
  return (
    <div className={`pane non-terminal preview-pane ${isActive ? '' : 'terminal-hidden'}`}>
      <div className="pane-toolbar">
        <span className="pane-title">{preview.path}</span>
        {preview.truncated && <span className="preview-truncated">(truncated at 512 KiB)</span>}
        <button className="icon-btn" title="Close preview" onClick={() => closePreview(worktreePath)}>
          ×
        </button>
      </div>
      <pre className="preview-code">{preview.content}</pre>
    </div>
  )
}