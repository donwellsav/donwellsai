import { expect, it } from 'vitest'
import { Model, TabNode, TabSetNode } from 'flexlayout-react'
import { restoreWorkspaceLayout, workspacePreset, moveWorkspacePane, splitWorkspaceLayout, resizeWorkspaceSplit, type WorkspaceLayout } from '../src/renderer/src/workspace-layout'
const panes = [{ key: 'a', kind: 'terminal' }, { key: 'b', kind: 'terminal' }, { key: 'file', kind: 'preview' }, { key: 'web', kind: 'browser' }, { key: 'diff', kind: 'diff' }]
const ids = (layout: WorkspaceLayout) => { const found: string[] = []; Model.fromJson(layout.model).visitNodes(node => { if (node instanceof TabNode) found.push(node.getId()) }); return found }
it('migrates a binary split while retaining panes outside the old visible tree', () => {
  const result = restoreWorkspaceLayout(undefined, panes, { kind: 'split', dir: 'col', size: 35, first: { kind: 'leaf', pane: 'a' }, second: { kind: 'leaf', pane: 'b' } })
  expect(result.layout.version).toBe(1)
  expect(result.layout.model.global?.rootOrientationVertical).toBe(true)
  expect(ids(result.layout).sort()).toEqual(panes.map(p => p.key).sort())
  expect(result.layout.model.layout.children[0]?.weight).toBe(35)
})
it('recovers corrupt layout and discards duplicate or missing references without dropping resources', () => {
  expect(restoreWorkspaceLayout({ version: 999 }, panes).recovered).toBe(true)
  const saved = workspacePreset('pair', panes, 'a')
  saved.model.layout.children.push({ type: 'tabset', children: [{ type: 'tab', id: 'a', component: 'pane' }, { type: 'tab', id: 'gone', component: 'pane' }] })
  const restored = restoreWorkspaceLayout(saved, panes)
  expect(restored.recovered).toBe(true)
  expect(ids(restored.layout).sort()).toEqual(panes.map(p => p.key).sort())
})
it('preserves hidden views across restart and can restore their resources without recreating them', () => {
  const saved = workspacePreset('focus', panes, 'a')
  saved.hidden = ['b']
  const hidden = restoreWorkspaceLayout(saved, panes).layout
  expect(ids(hidden)).not.toContain('b')
  expect(hidden.hidden).toEqual(['b'])
  const reopened = restoreWorkspaceLayout({ ...hidden, hidden: [] }, panes).layout
  expect(ids(reopened)).toContain('b')
  expect(panes[1]).toEqual({ key: 'b', kind: 'terminal' })
})
it('keeps the selected resource when an earlier saved tab is removed', () => {
  const saved = workspacePreset('focus', panes, 'b')
  const restored = restoreWorkspaceLayout(saved, panes.filter(pane => pane.key !== 'a'))
  const model = Model.fromJson(restored.layout.model)
  expect((model.getNodeById('b')?.getParent() as TabSetNode).getSelectedNode()?.getId()).toBe('b')
  expect(restored.recovered).toBe(true)
})
it('reports invalid hidden references and keeps a selected tab when a preceding tab is hidden', () => {
  const saved = workspacePreset('focus', panes, 'b')
  saved.hidden = ['a', 'gone', 'a']
  const restored = restoreWorkspaceLayout(saved, panes)
  expect(restored.recovered).toBe(true)
  expect(restored.layout.hidden).toEqual(['a'])
  const model = Model.fromJson(restored.layout.model)
  expect((model.getNodeById('b')?.getParent() as TabSetNode).getSelectedNode()?.getId()).toBe('b')
})
it.each(['focus','pair','build','review'] as const)('composes %s using every existing resource exactly once', preset => {
  const layout = workspacePreset(preset, panes, 'a')
  expect(ids(layout).sort()).toEqual(panes.map(p => p.key).sort())
  const model = Model.fromJson(layout.model)
  expect(model.getNodeById(preset === 'review' ? 'diff' : preset === 'build' ? 'web' : 'a')).toBeTruthy()
})

it('moves and splits stable resource references without duplication', () => {
  let layout = workspacePreset('focus', panes, 'a')
  for (let i = 0; i < 100; i++) layout = moveWorkspacePane(layout, panes, 'a', i % 2 ? 'left' : 'right')
  expect(ids(layout).sort()).toEqual(panes.map(p => p.key).sort())
  const added = [...panes, { key: 'new', kind: 'terminal' }]
  layout = splitWorkspaceLayout(layout, added, 'a', 'new', 'col')
  expect(ids(layout).sort()).toEqual(added.map(p => p.key).sort())
  const model = Model.fromJson(layout.model)
  expect(model.getNodeById('new')?.getParent()).not.toBe(model.getNodeById('a')?.getParent())
})

it('resizes the current docking boundary and rejects missing or invalid boundaries', () => {
  const layout = workspacePreset('pair', panes, 'a')
  const next = resizeWorkspaceSplit(layout, 0, 25)!
  const weights = next.model.layout.children.map(node => node.weight!)
  expect(weights[0]! / (weights[0]! + weights[1]!)).toBe(.25)
  expect(ids(next).sort()).toEqual(ids(layout).sort())
  expect(resizeWorkspaceSplit(layout, 20, 50)).toBeNull()
  expect(resizeWorkspaceSplit(layout, 0, NaN)).toBeNull()
})
