import { beforeAll, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import type { FileContent, RepoSummary } from '../src/shared/types'

const wt = '/repos/demo'
const KEY = (f: string) => `preview:${f}`

function repoSummary(): RepoSummary {
  return {
    repo: { id: 'demo', path: wt, addedAt: 't0' },
    worktrees: [{ id: 'w0', path: wt, branch: 'main', isMain: true }],
    defaultBranch: 'main'
  }
}

function seed(): void {
  useAppStore.setState({
    repos: [repoSummary()],
    activeRepoId: 'demo',
    activeWorktreePath: wt,
    panes: { [wt]: [{ key: 'term:t1', kind: 'terminal', sessionId: 't1' }] },
    activePane: { [wt]: 'term:t1' },
    activeTerminal: { [wt]: 't1' },
    terminalOrder: { [wt]: ['t1'] },
    layouts: {},
    previews: {},
  })
}

const readFileStub = vi.fn(async (_wt: string, rel: string): Promise<FileContent> => ({
  path: rel,
  content: `content of ${rel}`,
  bytes: 10 + rel.length,
  truncated: false
}))

beforeAll(() => {
  vi.stubGlobal('window', {
    orca: {
      readFile: readFileStub,
      writeFile: async (_wt: string, rel: string, content: string): Promise<FileContent> => ({
        path: rel,
        content,
        bytes: content.length,
        truncated: false
      }),
      saveWorkspaceSession: async () => {},
      closeTerminal: async () => {}
    }
  })
})

describe('editor tabs: multi-file previews', () => {
  it('first open appends a pane and buffers the file', async () => {
    seed()
    await useAppStore.getState().openPreview(wt, 'a.ts')
    const s = useAppStore.getState()
    expect(s.panes[wt]!.map((p) => p.key)).toContain('term:t1')
    expect(s.panes[wt]!.filter((p) => p.kind === 'preview')).toHaveLength(1)
    expect(s.previews[wt]?.['a.ts']?.content).toBe('content of a.ts')
    expect(s.activePane[wt]).toBe(KEY('a.ts'))
  })

  it('opening a second file retargets the active editor pane instead of splitting', async () => {
    seed()
    await useAppStore.getState().openPreview(wt, 'a.ts')
    await useAppStore.getState().openPreview(wt, 'src/deep/b.ts')
    const s = useAppStore.getState()
    const previewPanes = s.panes[wt]!.filter((p) => p.kind === 'preview')
    expect(previewPanes).toHaveLength(1)
    expect(previewPanes[0]!.key).toBe(KEY('src/deep/b.ts'))
    // both buffers stay open as tabs
    expect(Object.keys(s.previews[wt] ?? {}).sort()).toEqual(['a.ts', 'src/deep/b.ts'])
    expect(s.activePane[wt]).toBe(KEY('src/deep/b.ts'))
  })

  it('opening a file already shown by a pane only focuses it', async () => {
    seed()
    await useAppStore.getState().openPreview(wt, 'a.ts')
    await useAppStore.getState().openPreview(wt, 'a.ts')
    expect(useAppStore.getState().panes[wt]!.filter((p) => p.kind === 'preview')).toHaveLength(1)
  })

  it('retarget renames the layout leaf when the pane lives in a split', async () => {
    seed()
    useAppStore.setState({
      layouts: {
        [wt]: { kind: 'split', id: 0, dir: 'row', first: { kind: 'leaf', pane: 'term:t1' }, second: { kind: 'leaf', pane: 'preview:a.ts' }, size: 50 }
      },
      panes: { [wt]: [{ key: 'term:t1', kind: 'terminal', sessionId: 't1' }, { key: 'preview:a.ts', kind: 'preview', file: 'a.ts' }] },
      previews: { [wt]: { 'a.ts': { path: 'a.ts', content: 'x', bytes: 1, truncated: false, v: 1 } } },
      activePane: { [wt]: 'preview:a.ts' }
    })
    await useAppStore.getState().openPreview(wt, 'b.ts')
    const layout = useAppStore.getState().layouts[wt]
    const json = JSON.stringify(layout)
    expect(json).toContain('preview:b.ts')
    expect(json).not.toContain('preview:a.ts')
  })

  it('notePreviewContent updates the buffer without a version bump', () => {
    seed()
    useAppStore.setState({
      previews: { [wt]: { 'a.ts': { path: 'a.ts', content: 'old', bytes: 3, truncated: false, v: 3 } } }
    })
    useAppStore.getState().notePreviewContent(wt, 'a.ts', 'new')
    const buf = useAppStore.getState().previews[wt]?.['a.ts']
    expect(buf?.content).toBe('new')
    expect(buf?.v).toBe(3)
  })

  it('closePreview removes one file: pane, buffer, others survive', async () => {
    seed()
    await useAppStore.getState().openPreview(wt, 'a.ts')
    await useAppStore.getState().openPreview(wt, 'b.ts')
    useAppStore.getState().closePreview(wt, 'a.ts')
    const s = useAppStore.getState()
    expect(Object.keys(s.previews[wt] ?? {})).toEqual(['b.ts'])
    expect(s.panes[wt]!.filter((p) => p.kind === 'preview')).toHaveLength(1)
    expect(s.activePane[wt]).toBe(KEY('b.ts'))
    useAppStore.getState().closePreview(wt)
    expect(useAppStore.getState().previews[wt]).toBeUndefined()
    expect(useAppStore.getState().panes[wt]!.filter((p) => p.kind === 'preview')).toHaveLength(0)
  })

  it('writePreview buffers content for a file with no pane and opens one', async () => {
    seed()
    await useAppStore.getState().writePreview(wt, 'fresh.ts', 'written content')
    const s = useAppStore.getState()
    expect(s.previews[wt]?.['fresh.ts']?.content).toBe('written content')
    expect(s.panes[wt]!.some((p) => p.kind === 'preview' && p.file === 'fresh.ts')).toBe(true)
  })

  it('markdown files default to preview mode when the setting is on', async () => {
    seed()
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, markdownPreviewDefault: true } })
    await useAppStore.getState().openPreview(wt, 'README.md')
    expect(useAppStore.getState().previews[wt]?.['README.md']?.mode).toBe('preview')
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, markdownPreviewDefault: false } })
    await useAppStore.getState().openPreview(wt, 'guide.md')
    expect(useAppStore.getState().previews[wt]?.['guide.md']?.mode).toBe('edit')
    // non-markdown never previews
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, markdownPreviewDefault: true } })
    await useAppStore.getState().openPreview(wt, 'notes.md.ts')
    expect(useAppStore.getState().previews[wt]?.['notes.md.ts']?.mode).toBe('edit')
  })

  it('setPreviewMode flips a buffer and is a no-op for unknown files', async () => {
    seed()
    await useAppStore.getState().openPreview(wt, 'a.md')
    useAppStore.getState().setPreviewMode(wt, 'a.md', 'preview')
    expect(useAppStore.getState().previews[wt]?.['a.md']?.mode).toBe('preview')
    useAppStore.getState().setPreviewMode(wt, 'missing.md', 'preview')
    expect(useAppStore.getState().previews[wt]?.['missing.md']).toBeUndefined()
    // explicit mode survives a re-open of the same file
    await useAppStore.getState().openPreview(wt, 'a.md')
    expect(useAppStore.getState().previews[wt]?.['a.md']?.mode).toBe('preview')
  })
})
