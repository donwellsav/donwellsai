import { mediaPreviewDescriptorForPath } from '@shared/media-preview'
import { useAppStore } from '../store'
import { EditorPane } from './EditorPane'
import { Icon } from './Icon'
import { ImagePreview } from './ImagePreview'
import { PdfPreview } from './PdfPreview'

export type MediaPreviewRouterProps = Readonly<{
  worktreePath: string
  relPath: string
}>

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** Preserve the preview pane contract while selecting the safe file consumer. */
export function MediaPreviewRouter({ worktreePath, relPath }: MediaPreviewRouterProps) {
  const descriptor = mediaPreviewDescriptorForPath(relPath)
  const preview = useAppStore((state) => state.previews[worktreePath]?.[relPath])
  if (descriptor?.kind === 'image') {
    return <ImagePreview worktreePath={worktreePath} relPath={relPath} />
  }
  if (descriptor?.kind === 'pdf') {
    return <PdfPreview worktreePath={worktreePath} relPath={relPath} />
  }
  if (preview?.binary) {
    return (
      <div className="media-state" role="region" aria-label="Binary file preview">
        <Icon name="file" size={20} />
        <strong>Binary file — read only</strong>
        <span>This file is protected from text editing because its bytes are not valid UTF-8 text.</span>
        <span>{relPath} · {formatBytes(preview.bytes)}</span>
      </div>
    )
  }
  return <EditorPane worktreePath={worktreePath} relPath={relPath} />
}
