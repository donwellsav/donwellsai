import { Actions, DockLocation, Model, RowNode, TabSetNode } from 'flexlayout-react'
import type { IJsonModel, IJsonRowNode, IJsonTabNode, IJsonTabSetNode } from 'flexlayout-react'
import { isObject } from '@shared/command-catalog'
import type { PersistedLayoutNode } from '@shared/types'

export type WorkspaceLayout = { version: 1; model: IJsonModel; hidden: string[] }
export type WorkspacePreset = 'focus' | 'pair' | 'build' | 'review'
type PaneReference = { key: string; kind: string; label?: string; file?: string; url?: string }
type Group = IJsonRowNode | IJsonTabSetNode
const globals = { tabEnableClose: true, tabEnableFloat: false, tabEnablePopout: false, tabEnableRenderOnDemand: false, tabSetEnableClose: false, tabSetEnableMaximize: true, tabSetMinWidth: 120, tabSetMinHeight: 90 }
export function workspacePaneLabel(pane: PaneReference): string {
  return pane.label || ({ explorer: 'Files', 'git-status': 'Changes', memory: 'Project memory', recovery: 'Recover unsaved files', search: 'Project search', computer: 'Computer control', environments: 'Project environments' } as Record<string, string>)[pane.kind] || (pane.file ? pane.file.split('/').pop()! : pane.kind === 'browser' ? 'Preview' : pane.kind === 'terminal' ? 'Terminal' : pane.kind)
}
const tab = (pane: PaneReference): IJsonTabNode => ({ type: 'tab', id: pane.key, name: workspacePaneLabel(pane), component: 'pane' })
const group = (panes: readonly PaneReference[], active?: string): IJsonTabSetNode => ({ type: 'tabset', selected: Math.max(0, panes.findIndex(pane => pane.key === active)), children: panes.map(tab) })

export function workspacePreset(preset: WorkspacePreset, panes: readonly PaneReference[], active?: string): WorkspaceLayout {
  let left = [...panes], right: PaneReference[] = []
  if (preset === 'pair' && panes.length > 1) { right = [panes.find(pane => pane.key !== active && pane.kind === 'terminal') ?? panes[1]!]; left = panes.filter(pane => pane !== right[0]) }
  if (preset === 'build') { right = panes.filter(pane => pane.kind === 'browser'); left = panes.filter(pane => pane.kind !== 'browser') }
  if (preset === 'review') { left = panes.filter(pane => pane.kind === 'diff'); right = panes.filter(pane => pane.kind !== 'diff') }
  const children = [left.length ? group(left, active) : null, right.length ? group(right) : null].filter((node): node is IJsonTabSetNode => node !== null)
  return { version: 1, hidden: [], model: { global: globals, borders: [], layout: { type: 'row', children: children.length ? children : [group([])] } } }
}

/** Load only known pane references and geometry. Saved data cannot supply components, popouts or executable configuration. */
export function restoreWorkspaceLayout(value: unknown, panes: readonly PaneReference[], legacy?: PersistedLayoutNode): { layout: WorkspaceLayout; recovered: boolean } {
  const known = new Map(panes.map(pane => [pane.key, pane])), used = new Set<string>()
  let recovered = false, count = 0
  const modelValue = isObject(value) && isObject(value.model) ? value.model : undefined
  const valid = isObject(value) && value.version === 1 && modelValue && isObject(modelValue.layout)
  if (value !== undefined && !valid) recovered = true
  const hidden = valid && Array.isArray(value.hidden) ? [...new Set(value.hidden.filter((key): key is string => typeof key === 'string' && known.has(key)))] : []
  if (valid && (!Array.isArray(value.hidden) || hidden.length !== value.hidden.length)) recovered = true
  const hiddenKeys = new Set(hidden)
  const weight = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(1000, Math.max(1, value)) : 50
  const clean = (node: unknown, depth = 0): Group | null => {
    if (!isObject(node) || depth > 12 || ++count > 256 || !Array.isArray(node.children)) { recovered = true; return null }
    if (node.type === 'tabset') {
      const children: IJsonTabNode[] = []
      const selected = node.children[Number.isInteger(node.selected) ? Number(node.selected) : 0]
      for (const child of node.children.slice(0, 256)) {
        if (!isObject(child) || child.type !== 'tab' || typeof child.id !== 'string' || !known.has(child.id) || used.has(child.id)) { recovered = true; continue }
        if (hiddenKeys.has(child.id)) continue
        used.add(child.id); children.push(tab(known.get(child.id)!))
      }
      if (node.children.length > 256) recovered = true
      return children.length ? { type: 'tabset', weight: weight(node.weight), selected: Math.max(0, children.findIndex(child => isObject(selected) && child.id === selected.id)), children } : null
    }
    if (node.type !== 'row') { recovered = true; return null }
    if (node.children.length > 256) recovered = true
    return { type: 'row', weight: weight(node.weight), children: node.children.slice(0, 256).map(child => clean(child, depth + 1)).filter((child): child is Group => child !== null) }
  }
  const migrate = (node: unknown, orientation: 'row' | 'col', depth = 0): Group | null => {
    if (!isObject(node) || depth > 12 || ++count > 256) { recovered = true; return null }
    if (node.kind === 'leaf') {
      if (typeof node.pane !== 'string') { recovered = true; return null }
      const pane = known.get(node.pane)
      if (!pane || used.has(node.pane)) { recovered = true; return null }
      used.add(node.pane); return group([pane])
    }
    if (node.kind !== 'split' || !['row', 'col'].includes(String(node.dir))) { recovered = true; return null }
    const opposite = orientation === 'row' ? 'col' : 'row'
    if (node.dir !== orientation) { const child = migrate(node, opposite, depth + 1); return child ? { type: 'row', children: [child] } : null }
    const first = migrate(node.first, opposite, depth + 1), second = migrate(node.second, opposite, depth + 1)
    const size = Math.min(85, Math.max(15, typeof node.size === 'number' && Number.isFinite(node.size) ? node.size : 50))
    if (first) first.weight = size
    if (second) second.weight = 100 - size
    return { type: 'row', children: [first, second].filter((child): child is Group => child !== null) }
  }
  const vertical = valid ? isObject(modelValue?.global) && modelValue.global.rootOrientationVertical === true : legacy?.kind === 'split' && legacy.dir === 'col'
  const restored = valid ? clean(modelValue?.layout) : legacy ? migrate(legacy, vertical ? 'col' : 'row') : null
  const root: IJsonRowNode = restored?.type === 'row' ? restored as IJsonRowNode : { type: 'row', children: restored ? [restored] : [] }
  const missing = panes.filter(pane => !used.has(pane.key) && !hiddenKeys.has(pane.key))
  root.children ??= []
  if (missing.length) root.children.push(group(missing))
  if (!root.children.length) root.children.push(group([]))
  return { recovered, layout: { version: 1, hidden, model: { global: { ...globals, rootOrientationVertical: vertical }, borders: [], layout: root } } }
}

export function splitWorkspaceLayout(layout: WorkspaceLayout, panes: readonly PaneReference[], active: string, added: string, direction: 'row' | 'col'): WorkspaceLayout {
  const clean = restoreWorkspaceLayout(layout, panes.filter(pane => pane.key !== added)).layout
  const model = Model.fromJson(clean.model), pane = panes.find(pane => pane.key === added)
  if (pane) model.doAction(Actions.addNode(tab(pane), model.getNodeById(active)?.getParent()?.getId() ?? model.getRootRow()!.getId(), direction === 'row' ? DockLocation.RIGHT : DockLocation.BOTTOM, -1, true))
  return { ...clean, model: model.toJson() }
}

export function moveWorkspacePane(layout: WorkspaceLayout, panes: readonly PaneReference[], key: string, direction: 'left' | 'right' | 'up' | 'down'): WorkspaceLayout {
  const clean = restoreWorkspaceLayout(layout, panes).layout
  const model = Model.fromJson(clean.model), node = model.getNodeById(key), parent = node?.getParent()
  if (!(parent instanceof TabSetNode)) return clean
  const groups: TabSetNode[] = []
  model.visitNodes(item => { if (item instanceof TabSetNode) groups.push(item) })
  const delta = direction === 'left' || direction === 'up' ? -1 : 1
  const target = groups[groups.indexOf(parent) + delta]
  if (target) model.doAction(Actions.moveNode(key, target.getId(), DockLocation.CENTER, -1, true))
  else if (parent.getChildren().length > 1) model.doAction(Actions.moveNode(key, parent.getId(), { left: DockLocation.LEFT, right: DockLocation.RIGHT, up: DockLocation.TOP, down: DockLocation.BOTTOM }[direction], -1, true))
  return { ...clean, model: model.toJson() }
}

export function resizeWorkspaceSplit(layout: WorkspaceLayout, index: number, percent: number): WorkspaceLayout | null {
  if (!Number.isInteger(index) || index < 0 || !Number.isFinite(percent)) return null
  const model = Model.fromJson(layout.model)
  const boundaries: { row: RowNode; index: number }[] = []
  model.visitNodes(node => { if (node instanceof RowNode) for (let i = 0; i < node.getChildren().length - 1; i++) boundaries.push({ row: node, index: i }) })
  const boundary = boundaries[index]
  if (!boundary) return null
  const weights = boundary.row.getChildren().map(node => (node as RowNode | TabSetNode).getWeight())
  const total = weights[boundary.index]! + weights[boundary.index + 1]!
  weights[boundary.index] = total * Math.min(85, Math.max(15, percent)) / 100
  weights[boundary.index + 1] = total - weights[boundary.index]!
  model.doAction(Actions.adjustWeights(boundary.row.getId(), weights))
  return { ...layout, model: model.toJson() }
}
