import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import type { BrowserWindow } from 'electron'
import type { DaemonClient } from '../src/main/daemon-client'

const native = vi.hoisted(() => ({ request: vi.fn(), listen: vi.fn(), emit: (_json: string) => {} }))
vi.mock('node:module', () => ({ createRequire: () => () => native }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/test' }, shell: {} }))
import { NativeTerminals, nativeTerminalConfiguration } from '../src/main/native-terminals'

it('maps native line spacing, line-based history and explicit clipboard selection', () => {
  const config = nativeTerminalConfiguration({ ...DEFAULT_SETTINGS, terminalLineHeight: 1.25, scrollback: 5000, copyOnSelect: true })
  expect(config).toContain('adjust-cell-height = 25%')
  expect(config).toContain('scrollback-limit-lines = 5000')
  expect(config).toContain('copy-on-select = clipboard')
  expect(nativeTerminalConfiguration(DEFAULT_SETTINGS)).toContain('copy-on-select = false')
})

beforeEach(() => {
  vi.clearAllMocks()
  native.request.mockReturnValue('{}')
  native.listen.mockImplementation(callback => { native.emit = callback })
})

function fixture() {
  const contents = Object.assign(new EventEmitter(), { send: vi.fn(), getZoomFactor: () => 1 })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8), getContentSize: () => [1200, 800]
  })
  const daemon = {
    attach: vi.fn().mockResolvedValue({ session: { exited: false }, scrollback: 'retained', sequence: 1, truncated: false }),
    resize: vi.fn(), write: vi.fn()
  }
  const terminals = new NativeTerminals(window as unknown as BrowserWindow, daemon as unknown as DaemonClient, () => ({ ...DEFAULT_SETTINGS }))
  const create = (sessionId = 'session', instance = 'first') => terminals.request({ op: 'create', sessionId, instance })
  const operations = () => native.request.mock.calls.map(([json]) => JSON.parse(json))
  return { terminals, daemon, contents, create, operations }
}

it('retries initial attach on the same native surface and daemon session', async () => {
  const f = fixture()
  f.daemon.attach.mockRejectedValueOnce(new Error('daemon unavailable'))
  await expect(f.create()).rejects.toThrow('daemon unavailable')
  await expect(f.create()).resolves.toEqual({ connected: true, truncated: false })
  expect(f.operations().filter(op => op.op === 'create')).toHaveLength(1)
  expect(f.daemon.attach.mock.calls).toEqual([['session'], ['session']])
  expect(f.daemon.write).not.toHaveBeenCalled()
  f.contents.emit('render-process-gone')
})

it('ignores an old resize failure after a surface has been replaced', async () => {
  const f = fixture()
  await f.create()
  let reject!: (error: Error) => void
  f.daemon.resize.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
  await f.terminals.request({ op: 'bounds', sessionId: 'session', instance: 'first', rect: { x: 0, y: 0, width: 1000, height: 700 } })
  native.emit(JSON.stringify({ id: 'session/first', type: 'resize', cols: 90, rows: 25 }))
  await f.create('session', 'second')
  const count = f.operations().length
  reject(new Error('late resize failure'))
  await Promise.resolve()
  await Promise.resolve()
  expect(f.operations()).toHaveLength(count)
  expect(f.contents.send).not.toHaveBeenCalled()
  f.contents.emit('render-process-gone')
})

it('waits for viewport geometry and replays dimensioned history before queued live output', async () => {
  const f = fixture()
  const chunks = [{ data: 'old prompt', cols: 100, rows: 30 }, { data: 'wide prompt', cols: 140, rows: 40 }]
  f.daemon.attach.mockResolvedValueOnce({ session: { exited: false }, scrollback: 'old promptwide prompt', sequence: 1, truncated: false, replay: chunks })
  f.daemon.resize.mockResolvedValue({})
  await f.create()
  f.terminals.data('session', 'live', 2)
  expect(f.operations().some(op => op.op === 'write' || op.op === 'snapshot')).toBe(false)
  await f.terminals.request({ op: 'bounds', sessionId: 'session', instance: 'first', rect: { x: 0, y: 0, width: 1000, height: 700 } })
  native.emit(JSON.stringify({ id: 'session/first', type: 'resize', cols: 120, rows: 35 }))
  const output = f.operations().filter(op => op.op === 'write' || op.op === 'snapshot')
  expect(output.map(op => op.op)).toEqual(['snapshot', 'write'])
  expect(output[0]).toMatchObject({ chunks, cols: 120, rows: 35 })
  expect(output[1].data).toBe('live')
  expect(f.daemon.write).not.toHaveBeenCalled()
  f.contents.emit('render-process-gone')
})

it('releases all stream subscriptions even if one native destroy fails', async () => {
  const f = fixture()
  await f.create('a')
  await f.create('b')
  native.request.mockImplementation(json => JSON.parse(json).op === 'destroy' ? '{"error":"destroy failed"}' : '{}')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(() => f.contents.emit('render-process-gone')).not.toThrow()
    expect(f.operations().filter(op => op.op === 'destroy')).toHaveLength(2)
    const count = f.operations().length
    f.terminals.data('a', 'late data', 2)
    f.terminals.data('b', 'late data', 2)
    expect(f.operations()).toHaveLength(count)
    await expect(f.terminals.request({ op: 'reattach', sessionId: 'a', instance: 'first' })).rejects.toThrow('ownership changed')
  } finally { log.mockRestore() }
})
