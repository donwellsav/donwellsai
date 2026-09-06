import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Layout, Model, Actions, DockLocation } from 'flexlayout-react'
import { createDockview } from 'dockview'
import { Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal as GhosttyTerminal, init } from 'ghostty-web'
import '@xterm/xterm/css/xterm.css'
import 'flexlayout-react/style/dark.css'
import 'dockview/dist/styles/dockview.css'
import './trial.css'

const query = new URLSearchParams(location.search)
const renderer = query.get('renderer') === 'ghostty' ? 'ghostty' : 'xterm'
const engine = query.get('layout') === 'dockview' ? 'dockview' : 'flexlayout'
const report = { renderer, engine, fixtureOnly: true, mounts: {}, terminalIds: {}, checks: {} }
window.trialReport = report
const resources = new Map()
await (renderer === 'ghostty' ? init() : Promise.resolve())
for (const id of ['terminal-a', 'terminal-b']) {
  const host = document.createElement('div'); host.className = 'terminal-resource'
  const term = new (renderer === 'ghostty' ? GhosttyTerminal : Terminal)({ cols: 64, rows: 22, fontSize: 14, fontFamily: 'Menlo, monospace', theme: { background: '#16161d', foreground: '#e5e2df', cursor: '#d9ba86' }, allowProposedApi: true })
  resources.set(id, { host, term, opened: false })
  report.terminalIds[id] = crypto.randomUUID()
}
function attach(id, element) {
  const resource = resources.get(id)
  if (!element || !resource) return
  element.append(resource.host)
  if (!resource.opened) {
    resource.term.open(resource.host); resource.opened = true
    report.mounts[id] = (report.mounts[id] ?? 0) + 1
    resource.term.write('\x1b[2J\x1b[H\x1b[38;5;180mDONWELLS / TERMINAL FIXTURE\x1b[0m\r\n\r\nRenderer and docking trial. No agent is running.\r\n\r\nUnicode: 日本語 café e\u0301 → ✓\r\nTrue color: \x1b[38;2;142;191;167mreadable output\x1b[0m\r\n\r\nMove this tab between groups.\r\nThe terminal object must stay alive.\r\n\r\nFIND_THIS_MARKER\r\n')
    // Exercise the actual addon used by Donwells, including activation-time incompatibility.
    try {
      const search = new SearchAddon(); resource.term.loadAddon(search)
      resource.search = search; report.checks[id + ':searchAddon'] = 'activated'
    } catch (error) { report.checks[id + ':searchAddon'] = error.message }
  }
}
const model = Model.fromJson({ global: { tabEnableClose: false, tabSetEnableMaximize: true }, borders: [], layout: { type: 'row', id: 'root', children: [
  { type: 'tabset', id: 'left', weight: 55, children: [{ type: 'tab', id: 'terminal-a', name: 'Terminal A', component: 'terminal' }, { type: 'tab', id: 'notes', name: 'Scratch file', component: 'editor' }] },
  { type: 'tabset', id: 'right', weight: 45, children: [{ type: 'tab', id: 'terminal-b', name: 'Terminal B', component: 'terminal' }] }
] } })
const scratch = document.createElement('textarea')
scratch.className = 'scratch'; scratch.setAttribute('aria-label', 'Unsaved scratch file')
scratch.value = 'A workspace should stay out of the way.\n\nThis unsaved text must survive moving its panel.\n'
function mount(id, element) { if (id === 'notes' && element) element.append(scratch); else attach(id, element) }
function Docking() {
  const ref = useRef(null)
  useEffect(() => {
    if (engine === 'flexlayout') {
      window.trialMove = () => {
        const parent = model.getNodeById('terminal-a').getParent().getId()
        model.doAction(Actions.moveNode('terminal-a', parent === 'left' ? 'right' : 'left', DockLocation.CENTER, -1, true))
      }
      window.trialLayout = () => model.toJson()
      return
    }
    const api = createDockview(ref.current, { createComponent: () => {
      const element = document.createElement('div'); element.className = 'resource-slot'
      return { element, init: params => mount(params.api.id, element) }
    } })
    api.addPanel({ id: 'terminal-a', component: 'resource', title: 'Terminal A' })
    api.addPanel({ id: 'notes', component: 'resource', title: 'Scratch file', position: { referencePanel: 'terminal-a' } })
    api.addPanel({ id: 'terminal-b', component: 'resource', title: 'Terminal B', position: { referencePanel: 'terminal-a', direction: 'right' } })
    const groups = [...api.groups]
    window.trialMove = () => { const panel = api.getPanel('terminal-a'); panel.api.moveTo({ group: groups.find(group => group.id !== panel.api.group.id) }) }
    window.trialLayout = () => api.toJSON()
    return () => api.dispose()
  }, [])
  return engine === 'flexlayout'
    ? <Layout model={model} factory={node => <div className="resource-slot" ref={element => mount(node.getId(), element)} />} />
    : <div ref={ref} className="dockview-theme-dark dock-root" />
}
function App() {
  const [moves, setMoves] = useState(0)
  return <main className="studio">
    <header className="mast"><a className="wordmark" href="/">donwells<span> / </span></a><span className="project-name">Workspace laboratory</span><span className="local-tag">LOCAL TRIAL</span></header>
    <section className="context"><div><span className="eyebrow">Component trials</span><h1>Terminal & layout</h1></div><p>Terminal rendering & panel continuity<br/><span>Fixture content · no live agents connected</span></p></section>
    <nav className="tools" aria-label="Trial configuration"><div className="choice"><span>Layout</span>{['flexlayout','dockview'].map(value => <a key={value} aria-current={engine === value ? 'page' : undefined} href={`?layout=${value}&renderer=${renderer}`}>{value === 'flexlayout' ? 'FlexLayout' : 'Dockview'}</a>)}</div><div className="choice"><span>Terminal</span>{['xterm','ghostty'].map(value => <a key={value} aria-current={renderer === value ? 'page' : undefined} href={`?layout=${engine}&renderer=${value}`}>{value === 'xterm' ? 'xterm.js' : 'Ghostty Web'}</a>)}</div><button onClick={() => { window.trialMove(); setMoves(moves + 1) }}>Move terminal to other group <span>↔</span></button></nav>
    <section className="work-area" aria-label="Movable workspace"><Docking /></section>
    <footer><span className="scope">#16161D · neutral workspace surface</span><span>{moves} moves · terminal identity preserved only if measured</span><button onClick={() => navigator.clipboard.writeText(JSON.stringify(report, null, 2))}>Copy trial evidence</button></footer>
  </main>
}
createRoot(document.getElementById('root')).render(<App />)
window.trialSearch = () => {
  for (const [id, { search }] of resources) {
    try { report.checks[id + ':find'] = search ? search.findNext('FIND_THIS_MARKER') : false }
    catch (error) { report.checks[id + ':find'] = error.message }
  }
  return report
}
window.trialProbe = () => ({
  report,
  scratch: scratch.value,
  terminals: [...resources].map(([id, resource]) => ({ id, connected: resource.host.isConnected, markerPresent: Array.from({ length: resource.term.buffer.active.length }, (_, row) => resource.term.buffer.active.getLine(row)?.translateToString() ?? '').some(line => line.includes('FIND_THIS_MARKER')) }))
})
