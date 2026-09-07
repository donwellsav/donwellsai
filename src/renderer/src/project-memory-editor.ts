import { create } from 'zustand'
import type { ProjectMemoryEntry, ProjectMemoryKind } from '@shared/project-memory'

type MemoryDraft = { kind: ProjectMemoryKind; title: string; content: string; tags: string; sourceRef: string }
type MemoryEditor = { workspacePath: string; entry: ProjectMemoryEntry | null; draft: MemoryDraft; original: MemoryDraft }
type MemoryEditorState = {
  editor: MemoryEditor | null
  busy: boolean
  error: string | null
  generation: number
  change(patch: Partial<MemoryDraft>): void
  refresh(): void
}

export const useProjectMemoryEditor = create<MemoryEditorState>((set) => ({
  editor: null,
  busy: false,
  error: null,
  generation: 0,
  change: (patch) => set((state) => state.editor && !state.busy
    ? { editor: { ...state.editor, draft: { ...state.editor.draft, ...patch } }, error: null }
    : {}),
  refresh: () => set((state) => ({ generation: state.generation + 1 }))
}))

export function draftFromEntry(entry: ProjectMemoryEntry | null): MemoryDraft {
  return {
    kind: entry?.kind ?? 'convention', title: entry?.title ?? '', content: entry?.content ?? '',
    tags: entry?.tags.join(', ') ?? '', sourceRef: entry?.provenance.sourceRef ?? ''
  }
}

export function openProjectMemoryEditor(workspacePath: string, entry: ProjectMemoryEntry | null = null): void {
  if (useProjectMemoryEditor.getState().editor) return
  const draft = draftFromEntry(entry)
  useProjectMemoryEditor.setState({ editor: { workspacePath, entry, draft, original: draft }, error: null })
}

export function resolveProjectMemoryEditor(editor: MemoryEditor, latest: ProjectMemoryEntry, retainDraft: boolean): void {
  const state = useProjectMemoryEditor.getState()
  if (state.editor !== editor || state.busy || latest.id !== editor.entry?.id || latest.revision < editor.entry.revision || (retainDraft && latest.archivedAt)) return
  const original = draftFromEntry(latest)
  useProjectMemoryEditor.setState({ editor: { ...editor, entry: latest, draft: retainDraft ? editor.draft : original, original }, error: null })
}

export function memoryDraftIsDirty(editor: MemoryEditor | null): boolean {
  if (!editor) return false
  const { draft, original } = editor
  return draft.kind !== original.kind || draft.title !== original.title || draft.content !== original.content
    || draft.tags !== original.tags || draft.sourceRef !== original.sourceRef
}

export function assertProjectMemoryDraftSaved(): void {
  const state = useProjectMemoryEditor.getState()
  if (state.busy || memoryDraftIsDirty(state.editor)) throw new Error('Save or discard the open project memory draft before closing.')
}

export async function saveProjectMemoryEditor(): Promise<void> {
  const { editor, busy } = useProjectMemoryEditor.getState()
  if (!editor || busy) return
  useProjectMemoryEditor.setState({ busy: true, error: null })
  try {
    const input = {
      workspacePath: editor.workspacePath,
      kind: editor.draft.kind, title: editor.draft.title, content: editor.draft.content,
      tags: editor.draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      attribution: { harness: 'human', ...(editor.draft.sourceRef.trim() ? { sourceRef: editor.draft.sourceRef.trim() } : {}) }
    }
    if (editor.entry) await window.donwells.projectMemoryUpdate({ ...input, id: editor.entry.id, expectedRevision: editor.entry.revision })
    else await window.donwells.projectMemoryCreate(input)
    if (useProjectMemoryEditor.getState().editor === editor) useProjectMemoryEditor.setState({ editor: null })
  } catch (error) {
    useProjectMemoryEditor.setState({ error: String(error) })
  } finally {
    useProjectMemoryEditor.setState({ busy: false })
  }
}

export async function archiveProjectMemoryEditor(): Promise<void> {
  const { editor, busy } = useProjectMemoryEditor.getState()
  if (!editor?.entry || busy) return
  if (memoryDraftIsDirty(editor)) {
    useProjectMemoryEditor.setState({ error: 'Save or discard edits before changing archive state.' })
    return
  }
  useProjectMemoryEditor.setState({ busy: true, error: null })
  try {
    await window.donwells.projectMemoryArchive({
      workspacePath: editor.workspacePath, id: editor.entry.id, expectedRevision: editor.entry.revision,
      archived: !editor.entry.archivedAt, attribution: { harness: 'human' }
    })
    if (useProjectMemoryEditor.getState().editor === editor) useProjectMemoryEditor.setState({ editor: null })
  } catch (error) {
    useProjectMemoryEditor.setState({ error: String(error) })
  } finally {
    useProjectMemoryEditor.setState({ busy: false })
  }
}


export async function eraseProjectMemoryEditor(): Promise<void> {
  const { editor, busy } = useProjectMemoryEditor.getState()
  if (!editor?.entry || busy || memoryDraftIsDirty(editor)) return
  useProjectMemoryEditor.setState({ busy: true, error: null })
  try {
    await window.donwells.projectMemoryErase({ workspacePath: editor.workspacePath, id: editor.entry.id, expectedRevision: editor.entry.revision })
    if (useProjectMemoryEditor.getState().editor === editor) useProjectMemoryEditor.setState({ editor: null })
  } catch (error) { useProjectMemoryEditor.setState({ error: String(error) }) }
  finally { useProjectMemoryEditor.setState({ busy: false }) }
}
