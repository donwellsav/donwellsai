import { expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runRemoteComputerController } from '../src/main/project-remote-computer-entry'
import { remoteComputerRequest } from '../src/main/project-remote-computer'
import { createComputerToolDefinition } from '../src/main/project-computer-tools'
import type { ProjectToolDefinition } from '../src/main/project-tools'

const driverSource = `
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'notifications/initialized') continue
    const respond = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
    const tool = message.method === 'tools/call' ? message.params.name : ''
    if (message.method === 'initialize') respond({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '0.23.2' }, capabilities: { tools: {} } })
    else if (message.method === 'tools/list') respond({ tools: ['check_permissions', 'list_windows', 'get_window_state', 'click', 'type_text', 'hotkey'].map(name => ({ name })) })
    else if (tool === 'check_permissions') respond({ content: [{ type: 'text', text: 'ok' }], structuredContent: { accessibility: true, screen_recording: true } })
    else if (tool === 'list_windows') respond({ content: [], structuredContent: { windows: [{ pid: 4242, window_id: 7, app_name: 'Fake', title: 'Fake window', bounds: { x: 0, y: 0, width: 100, height: 100 } }] } })
    else if (tool === 'get_window_state') respond({ content: [], structuredContent: { pid: message.params.arguments.pid, window_id: message.params.arguments.window_id, elements: [{ element_token: 'e1' }] } })
    else if (tool === 'hotkey') process.exit(1)
    else respond({ content: [{ type: 'text', text: 'unhandled' }], structuredContent: {} })
  }
})
`

function setup() {
  const root = realpathSync(mkdtempSync(join('/tmp', 'dwrc-'))), project = join(root, 'project')
  mkdirSync(project)
  const driver = join(root, 'fake-driver.cjs'); writeFileSync(driver, driverSource)
  const { prepare: _prepare, launch: _launch, ...rest } = createComputerToolDefinition('/unused')
  const definition: ProjectToolDefinition = { ...rest, launch: () => ({ program: process.execPath, args: [driver], env: {} }) }
  const mapping = { version: 1 as const, environmentId: 'guest', generation: 1, projectId: 'project', root: project, stateDirectory: join(root, 'state'), computerExecutable: '/unused' }
  return { root, definition, mapping, socketPath: join(mapping.stateDirectory, 'computer.sock') }
}

it('serves computer operations over its private socket until an acknowledged stop', async () => {
  const { root, definition, mapping, socketPath } = setup()
  try {
    const controller = runRemoteComputerController(mapping, definition)
    await vi.waitFor(() => expect(existsSync(socketPath)).toBe(true), { timeout: 10000 })
    expect(await remoteComputerRequest(socketPath, 'permissions', {})).toMatchObject({ structuredContent: { accessibility: true } })
    expect(await remoteComputerRequest(socketPath, 'windows', {})).toMatchObject({ structuredContent: { windows: [{ pid: 4242, window_id: 7 }] } })
    await expect(remoteComputerRequest(socketPath, 'format', {})).rejects.toThrow('Unsupported computer operation')
    await expect(remoteComputerRequest(socketPath, 'click', { bogus: 1 })).rejects.toThrow('not permitted')
    await expect(remoteComputerRequest(socketPath, 'click', { owner: 't', generation: 1, revision: 1, element: 'e1' })).rejects.toThrow('attach')
    const stopped = await remoteComputerRequest(socketPath, 'stop', {}) as { pid: number }
    expect(Number.isSafeInteger(stopped.pid)).toBe(true)
    await controller
    expect(existsSync(socketPath)).toBe(false)
    await expect(remoteComputerRequest(socketPath, 'permissions', {}, undefined, 500)).rejects.toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 30000)

it('clears its lease and exits when the driver process is lost', async () => {
  const { root, definition, mapping, socketPath } = setup()
  try {
    const controller = runRemoteComputerController(mapping, definition)
    const exited = expect(controller).rejects.toThrow('driver process exited')
    await vi.waitFor(() => expect(existsSync(socketPath)).toBe(true), { timeout: 10000 })
    const attached = await remoteComputerRequest(socketPath, 'attach', { owner: 't', pid: 4242, window: 7, foreground: false }) as { structuredContent: { attachment: { generation: number; revision: number } } }
    const action = { owner: 't', generation: attached.structuredContent.attachment.generation, revision: attached.structuredContent.attachment.revision, element: 'e1', keys: ['Enter'] }
    await expect(remoteComputerRequest(socketPath, 'hotkey', action)).rejects.toThrow()
    await exited
    expect(existsSync(socketPath)).toBe(false)
    await expect(remoteComputerRequest(socketPath, 'status', {}, undefined, 500)).rejects.toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 30000)
