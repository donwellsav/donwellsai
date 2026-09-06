import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Layout, Model, Actions, DockLocation } from 'flexlayout-react'
import { createDockview } from 'dockview'
import { Terminal } from '@xterm/xterm'
import * as monaco from 'monaco-editor/editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as GhosttyTerminal, init } from 'ghostty-web'
import '@xterm/xterm/css/xterm.css'
import 'flexlayout-react/style/dark.css'
import 'dockview/dist/styles/dockview.css'
import './trial.css'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
const native = typeof window.__trialAttach === 'function'
const query = new URLSearchParams(location.search)
const renderer = query.get('renderer') === 'ghostty' ? 'ghostty' : 'xterm'
const engine = query.get('layout') === 'dockview' ? 'dockview' : 'flexlayout'
const report = { renderer, engine, fixtureOnly: !native, mounts: {}, terminalIds: {}, checks: {} }
window.trialReport = report
const resources = new Map()
await (renderer === 'ghostty' ? init() : Promise.resolve())
for (const id of ['terminal-a', 'terminal-b']) {
  const host = document.createElement('div'); host.className = 'terminal-resource'
  const term = new (renderer === 'ghostty' ? GhosttyTerminal : Terminal)({ cols: 64, rows: 22, fontSize: 14, fontFamily: 'Menlo, monospace', theme: { background: '#16161d', foreground: '#e5e2df', cursor: '#d9ba86' }, allowProposedApi: true, screenReaderMode: true })
  resources.set(id, { host, term, opened: false, sequence: null, pending: [] })
  report.terminalIds[id] = crypto.randomUUID()
}
function attach(id, element) {
  const resource = resources.get(id)
  if (!element || !resource) return
  element.append(resource.host)
  if (!resource.opened) {
    resource.term.open(resource.host); resource.opened = true
    report.mounts[id] = (report.mounts[id] ?? 0) + 1
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) resource.host.addEventListener(type, event => {
      report.composition ??= []; report.composition.push({ id, type, data: event.data }); report.composition = report.composition.slice(-50)
    })
    if (native) {
      resource.term.onData(data => window.__trialInput(id, data))
      resource.term.onResize(size => window.__trialResize(id, size))
      window.__trialAttach(id).then(snapshot => {
        report.nativeSessions ??= {}; report.nativeSessions[id] = snapshot.session
        resource.sequence = snapshot.sequence
        resource.term.write(snapshot.scrollback)
        for (const frame of resource.pending.splice(0)) window.trialNativeOutput(id, frame)
      })
    } else {
    resource.term.onData(data => { report.fixtureInput ??= []; report.fixtureInput.push({ id, data }); report.fixtureInput = report.fixtureInput.slice(-50); resource.term.write(data) })
    resource.term.write('\x1b[2J\x1b[H\x1b[38;5;180mDONWELLS / TERMINAL FIXTURE\x1b[0m\r\n\r\nRenderer and docking trial. No agent is running.\r\n\r\nUnicode: 日本語 café e\u0301 → ✓\r\nTrue color: \x1b[38;2;142;191;167mreadable output\x1b[0m\r\n\r\nMove this tab between groups.\r\nThe terminal object must stay alive.\r\n\r\nFIND_THIS_MARKER\r\n')
    }
    // Exercise the actual addon used by Donwells, including activation-time incompatibility.
    try {
      const search = new SearchAddon(); resource.term.loadAddon(search)
      resource.search = search; report.checks[id + ':searchAddon'] = 'activated'
    } catch (error) { report.checks[id + ':searchAddon'] = error.message }
    try {
      resource.term.loadAddon(new WebLinksAddon((_event, uri) => { report.linkActivated = uri }))
      report.checks[id + ':webLinksAddon'] = 'activated'
    } catch (error) { report.checks[id + ':webLinksAddon'] = error.message }
  }
}
const model = Model.fromJson({ global: { tabEnableClose: false, tabSetEnableMaximize: true }, borders: [], layout: { type: 'row', id: 'root', children: [
  { type: 'tabset', id: 'left', weight: 55, children: [{ type: 'tab', id: 'terminal-a', name: 'Terminal A', component: 'terminal' }, { type: 'tab', id: 'notes', name: 'Scratch file', component: 'editor' }] },
  { type: 'tabset', id: 'right', weight: 45, children: [{ type: 'tab', id: 'terminal-b', name: 'Terminal B', component: 'terminal' }] }
] } })
const scratch = document.createElement('div')
scratch.className = 'scratch'; scratch.setAttribute('aria-label', 'Unsaved scratch file')
const scratchModel = monaco.editor.createModel('A workspace should stay out of the way.\n\nThis unsaved text must survive moving its panel.\n', 'plaintext')
let scratchEditor
function attachScratch(element) {
  element.append(scratch)
  scratchEditor ??= monaco.editor.create(scratch, { model: scratchModel, theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, ariaLabel: 'Unsaved scratch file' })
}
function mount(id, element) { if (id === 'notes' && element) attachScratch(element); else attach(id, element) }
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
    window.trialSelect = id => api.getPanel(id).api.setActive()
    window.trialDockMoveEditor = () => { const panel = api.getPanel('notes'); panel.api.moveTo({ group: groups.find(group => group.id !== panel.api.group.id) }) }
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
    <section className="context"><div><span className="eyebrow">Component trials</span><h1>Terminal & layout</h1></div><p>Terminal rendering & panel continuity<br/><span>{native ? 'Live daemon PTYs · disposable project' : 'Fixture content · no live agents connected'}</span></p></section>
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
  scratch: scratchModel.getValue(),
  scratchModelId: scratchModel.id,
  terminals: [...resources].map(([id, resource]) => ({ id, connected: resource.host.isConnected, alternateScreen: resource.term.buffer.active === resource.term.buffer.alternate, markerPresent: Array.from({ length: resource.term.buffer.active.length }, (_, row) => resource.term.buffer.active.getLine(row)?.translateToString() ?? '').some(line => line.includes('FIND_THIS_MARKER')) }))
})

window.trialNativeOutput = (id, frame) => {
  const resource = resources.get(id)
  if (!resource) return
  if (resource.sequence === null) { resource.pending.push(frame); return }
  if (frame.sequence <= resource.sequence) return
  resource.sequence = frame.sequence
  resource.term.write(frame.data)
  resource.observeOutput?.(frame.data)
}
window.trialMeasureEcho = async id => {
  const resource = resources.get(id), samples = []
  for (const condition of ['idle', '4KiB-output']) for (let index = 0; index < 200; index++) {
    const marker = `MEASURE_${engine}_${condition}_${index}_END`, start = performance.now()
    let timer, output = ''
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native echo timeout')), 5000)
        resource.observeOutput = data => { output = (output + data).slice(-8192); if (output.includes(marker)) resolve() }
        const load = condition === '4KiB-output' ? "printf '%4096s\\n' x; " : ''
        window.__trialInput(id, `${load}printf '\\115${marker.slice(1)}\\n'\r`).catch(reject)
      })
      const outputMs = performance.now() - start
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      samples.push({ condition, outputMs, nextFrameMs: performance.now() - start })
    } finally { clearTimeout(timer); delete resource.observeOutput }
  }
  return samples
}
window.trialFocusedElement = () => document.activeElement?.className
window.trialText = id => {
  const terminal = resources.get(id).term
  return Array.from({ length: terminal.buffer.active.length }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString() ?? '').join('\n')
}
window.trialFocus = async id => {
  if (engine === 'flexlayout') model.doAction(Actions.selectTab(id))
  else window.trialSelect(id)
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  resources.get(id).term.focus()
}
window.trialResize = (id, cols, rows) => resources.get(id).term.resize(cols, rows)
window.trialPaste = (id, text) => resources.get(id).term.paste(text)
window.trialLink = async id => {
  const { term, host } = resources.get(id)
  await new Promise(resolve => term.write('\r\nhttps://example.test/terminal', resolve))
  const screen = host.querySelector('.xterm-screen').getBoundingClientRect()
  return { x: screen.x + screen.width / term.cols * 10, y: screen.y + screen.height / term.rows * (term.buffer.active.cursorY + .5) }
}
window.trialSelectMarker = id => {
  const terminal = resources.get(id).term
  const row = Array.from({ length: terminal.buffer.active.length }, (_, i) => i).find(i => terminal.buffer.active.getLine(i)?.translateToString().includes('FIND_THIS_MARKER'))
  if (row === undefined) throw new Error('Selection marker missing')
  const column = terminal.buffer.active.getLine(row).translateToString().indexOf('FIND_THIS_MARKER')
  terminal.select(column, row, 'FIND_THIS_MARKER'.length)
  return terminal.getSelection()
}
window.trialMoveEditor = () => {
  if (engine === 'flexlayout') {
    const parent = model.getNodeById('notes').getParent().getId()
    model.doAction(Actions.moveNode('notes', parent === 'left' ? 'right' : 'left', DockLocation.CENTER, -1, true))
  } else window.trialDockMoveEditor()
}

window.trialFocusEditor = async () => { await new Promise(requestAnimationFrame); scratchEditor.focus() }
