import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectMemoryEntry } from '../src/shared/project-memory'
import { memoryDraftIsDirty, openProjectMemoryEditor, resolveProjectMemoryEditor, saveProjectMemoryEditor, useProjectMemoryEditor } from '../src/renderer/src/project-memory-editor'

afterEach(() => { useProjectMemoryEditor.setState({ editor: null, busy: false, error: null }); vi.unstubAllGlobals() })

it('retains authored fields when rebasing, saves only explicitly, and preserves them after another CAS conflict', async () => {
  const original: ProjectMemoryEntry = {
    id: 'fact', revision: 1, kind: 'fact', title: 'Original', content: 'Before', tags: [],
    provenance: { harness: 'human', sourceSession: null, sourceRef: null, workspace: '/project' },
    updatedAt: '2026-09-07T00:00:00.000Z', createdAt: '2026-09-07T00:00:00.000Z', archivedAt: null
  }
  const update = vi.fn().mockRejectedValue(new Error('revision conflict'))
  vi.stubGlobal('window', { donwells: { projectMemoryUpdate: update } })
  openProjectMemoryEditor('/project', original)
  useProjectMemoryEditor.getState().change({ title: 'Authored title', content: 'Authored correction', tags: 'keep', sourceRef: 'source.ts' })
  const editor = useProjectMemoryEditor.getState().editor!
  const latest = { ...original, revision: 2, content: 'Other writer correction' }
  resolveProjectMemoryEditor(editor, { ...latest, archivedAt: latest.updatedAt }, true)
  expect(useProjectMemoryEditor.getState().editor).toBe(editor)
  resolveProjectMemoryEditor(editor, latest, true)
  const rebased = useProjectMemoryEditor.getState().editor!
  expect(rebased.draft).toBe(editor.draft)
  expect(rebased.original.content).toBe(latest.content)
  expect(memoryDraftIsDirty(rebased)).toBe(true)
  expect(update).not.toHaveBeenCalled()
  await saveProjectMemoryEditor()
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2, title: 'Authored title', content: 'Authored correction', tags: ['keep'], attribution: { harness: 'human', sourceRef: 'source.ts' } }))
  expect(useProjectMemoryEditor.getState().editor?.draft).toBe(editor.draft)
  expect(useProjectMemoryEditor.getState().error).toContain('revision conflict')
  resolveProjectMemoryEditor(editor, { ...latest, revision: 3 }, true)
  expect(useProjectMemoryEditor.getState().editor).toBe(rebased)
})
