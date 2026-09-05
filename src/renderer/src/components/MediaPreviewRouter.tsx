import { mediaPreviewDescriptorForPath } from '@shared/media-preview'
import { EditorPane } from './EditorPane'
import { ImagePreview } from './ImagePreview'
import { PdfPreview } from './PdfPreview'

export type MediaPreviewRouterProps = Readonly<{
  worktreePath: string
  relPath: string
}>

/** Preserve the preview pane contract while selecting the safe file consumer. */
export function MediaPreviewRouter({ worktreePath, relPath }: MediaPreviewRouterProps) {
  const descriptor = mediaPreviewDescriptorForPath(relPath)
  if (descriptor?.kind === 'image') {
    return <ImagePreview worktreePath={worktreePath} relPath={relPath} />
  }
  if (descriptor?.kind === 'pdf') {
    return <PdfPreview worktreePath={worktreePath} relPath={relPath} />
  }
  return <EditorPane worktreePath={worktreePath} relPath={relPath} />
}
