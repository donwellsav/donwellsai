import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROJECT_MEMORY_RPC_METHODS,
  parseProjectMemoryArchiveRequest,
  parseProjectMemoryCreateRequest,
  parseProjectMemoryGetRequest,
  parseProjectMemoryHistoryRequest,
  parseProjectMemoryListRequest,
  parseProjectMemoryUpdateRequest
} from '../src/shared/project-memory'
import { validateCommandParams } from '../src/shared/command-catalog'
import { ProjectMemoryService } from '../src/main/project-memory'
import {
  PROJECT_MEMORY_MCP_MAX_MESSAGE_BYTES,
  PROJECT_MEMORY_MCP_PROTOCOL_VERSION,
  ProjectMemoryMcpSession,
  parseProjectMemoryMcpArguments,
  runProjectMemoryMcp,
  type ProjectMemoryMcpInvoke
} from '../src/cli/project-memory-mcp'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-mcp-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`)
  return value as Record<string, unknown>
}

async function exchange(session: ProjectMemoryMcpSession, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const line = await session.handleLine(JSON.stringify(message))
  if (line === undefined) throw new Error('Expected an MCP response')
  return object(JSON.parse(line), 'MCP response')
}

async function initialize(session: ProjectMemoryMcpSession, id: number): Promise<void> {
  const response = await exchange(session, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: PROJECT_MEMORY_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'memory-test-client', version: '1.0.0' }
    }
  })
  expect(response).toMatchObject({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: PROJECT_MEMORY_MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'donwells-project-memory' }
    }
  })
  await expect(session.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  }))).resolves.toBeUndefined()
}

function toolValue(response: Record<string, unknown>): unknown {
  const result = object(response.result, 'tools/call result')
  const content = result.content
  if (!Array.isArray(content) || content.length !== 1) throw new Error('Tool result has invalid content')
  const block = object(content[0], 'tool content')
  if (block.type !== 'text' || typeof block.text !== 'string') throw new Error('Tool result is not text')
  return JSON.parse(block.text)
}

function serviceInvoker(service: ProjectMemoryService): ProjectMemoryMcpInvoke {
  return async (method, params) => {
    params = validateCommandParams(method, params)
    switch (method) {
      case PROJECT_MEMORY_RPC_METHODS.list:
        return service.projectMemoryList(parseProjectMemoryListRequest(params))
      case PROJECT_MEMORY_RPC_METHODS.get:
        return service.projectMemoryGet(parseProjectMemoryGetRequest(params))
      case PROJECT_MEMORY_RPC_METHODS.create:
        return service.projectMemoryCreate(parseProjectMemoryCreateRequest(params))
      case PROJECT_MEMORY_RPC_METHODS.update:
        return service.projectMemoryUpdate(parseProjectMemoryUpdateRequest(params))
      case PROJECT_MEMORY_RPC_METHODS.history:
        return service.projectMemoryHistory(parseProjectMemoryHistoryRequest(params))
      case PROJECT_MEMORY_RPC_METHODS.archive:
        return service.projectMemoryArchive(parseProjectMemoryArchiveRequest(params))
    }
  }
}

const primaryWorkspace = '/projects/main'
const worktreeWorkspace = '/projects/worktrees/feature'
const project = {
  projectKey: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  projectPath: primaryWorkspace
}

describe('project memory MCP protocol', () => {
  it('pins handoff tools to an inherited credential and never advertises its secret', async () => {
    const credential = { runId: 'native-run', sessionId: 'native-session', token: 'private-fixture-token' }
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const session = new ProjectMemoryMcpSession({ workspacePath: primaryWorkspace, harness: 'omp', credential, invoke: async (method, params) => { calls.push({ method, params: validateCommandParams(method, params) }); return { delivery: 'uncertain', revision: 3 } } })
    await initialize(session, 1)
    const listed = await exchange(session, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(JSON.stringify(listed)).toContain('handoff_receive')
    expect(JSON.stringify(listed)).not.toContain(credential.token)
    const call = (args: Record<string, unknown>, name = 'handoff_receive') => exchange(session, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })
    expect(toolValue(await call({ id: 'handoff', expectedRevision: 2 }))).toMatchObject({ delivery: 'uncertain' })
    expect(calls).toEqual([{ method: 'handoff.receive', params: { workspacePath: primaryWorkspace, credential, id: 'handoff', expectedRevision: 2 } }])
    for (const extra of [{ credential: { ...credential, sessionId: 'other' } }, { workspacePath: '/other' }, { sessionId: 'other' }]) {
      expect(await call({ id: 'handoff', expectedRevision: 2, ...extra })).toMatchObject({ result: { isError: true } })
    }
    expect(calls).toHaveLength(1)
    await call({ id: 'handoff', expectedRevision: 3 }, 'handoff_acknowledge')
    expect(calls[1]?.method).toBe('handoff.acknowledge')
    const unbound = new ProjectMemoryMcpSession({ workspacePath: primaryWorkspace, harness: 'omp', invoke: async () => { throw new Error('Must not invoke') } })
    await initialize(unbound, 1)
    expect(JSON.stringify(await exchange(unbound, { jsonrpc: '2.0', id: 2, method: 'tools/list' }))).not.toContain('handoff_receive')
    expect(await exchange(unbound, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'handoff_receive', arguments: { id: 'handoff', expectedRevision: 2 } } })).toHaveProperty('error')
  })

  it('implements lifecycle, ping, tool discovery, notifications, and JSON-RPC errors', async () => {
    const session = new ProjectMemoryMcpSession({
      workspacePath: primaryWorkspace,
      harness: 'codex',
      invoke: async () => ({})
    })
    await expect(session.handleLine('{')).resolves.toBe(JSON.stringify({
      jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' }
    }))
    await expect(exchange(session, { jsonrpc: '2.0', id: 1, method: 'ping' })).resolves.toMatchObject({
      id: 1,
      result: {}
    })
    await expect(exchange(session, {
      jsonrpc: '2.0',
      id: 'invalid-meta',
      method: 'ping',
      params: { _meta: null }
    })).resolves.toMatchObject({ error: { code: -32602 } })
    await expect(exchange(session, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).resolves.toMatchObject({
      error: { code: -32002 }
    })
    await expect(exchange(session, {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {
        protocolVersion: '1999-01-01',
        capabilities: {},
        clientInfo: { name: 'old-client', version: '1.0.0' }
      }
    })).resolves.toMatchObject({
      error: {
        code: -32602,
        data: { requested: '1999-01-01', supported: expect.arrayContaining([PROJECT_MEMORY_MCP_PROTOCOL_VERSION]) }
      }
    })

    const initialized = await exchange(session, {
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: {
        protocolVersion: PROJECT_MEMORY_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'modern-client', version: '2.0.0' }
      }
    })
    expect(initialized).toMatchObject({ result: { protocolVersion: '2025-11-25' } })
    await expect(exchange(session, { jsonrpc: '2.0', id: 5, method: 'tools/list' })).resolves.toMatchObject({
      error: { code: -32002 }
    })
    await expect(session.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    }))).resolves.toBeUndefined()
    const tools = await exchange(session, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} })
    expect(tools).toMatchObject({
      result: {
        tools: [
          { name: 'project_engines' },
          { name: 'memory_search' },
          { name: 'memory_read' },
          { name: 'memory_record' },
          { name: 'memory_replace' },
          { name: 'memory_archive' },
          { name: 'memory_history' },
          { name: 'code_search' },
          { name: 'code_graph_status' },
          { name: 'code_graph_index' },
          { name: 'code_graph_callers' },
          ...['status', 'index', 'search', 'get', 'multi_get', 'pause'].map(action => ({ name: `documents_${action}` })),
          ...['status','open','snapshot','click','type','screenshot','console','network','layout','trace_start','trace_stop','stop'].map(action => ({name:`browser_test_${action}`})),
          ...['status','permissions','windows','attach','observe','screenshot','click','type','pixel_click','pixel_type','hotkey','stop'].map(action=>({name:`computer_${action}`}))
        ]
      }
    })
    await expect(exchange(session, { jsonrpc: '2.0', id: 7, method: 'unknown/method' })).resolves.toMatchObject({
      error: { code: -32601 }
    })
    await expect(session.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 99, reason: 'client stopped waiting' }
    }))).resolves.toBeUndefined()
    await expect(session.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/unknown'
    }))).resolves.toBeUndefined()
  })

  it('pins workspace and harness while sharing CRUD, CAS, archive, restore, and history through one authority', async () => {
    const userData = temporaryRoot()
    let milliseconds = Date.parse('2026-09-05T14:00:00.000Z')
    const service = new ProjectMemoryService(
      userData,
      async (workspacePath) => {
        if (workspacePath === primaryWorkspace || workspacePath === worktreeWorkspace) return project
        throw new Error('Workspace is not registered')
      },
      {
        now: () => new Date(milliseconds++),
        createId: () => 'shared-memory'
      }
    )
    const calls: Array<{ method: Parameters<ProjectMemoryMcpInvoke>[0]; params: Record<string, unknown> }> = []
    const invokeService = serviceInvoker(service)
    const invoke: ProjectMemoryMcpInvoke = async (method, params) => {
      calls.push({ method, params })
      return invokeService(method, params)
    }
    const codex = new ProjectMemoryMcpSession({ workspacePath: primaryWorkspace, harness: 'codex', invoke })
    const claude = new ProjectMemoryMcpSession({ workspacePath: worktreeWorkspace, harness: 'claude-code', invoke })
    await initialize(codex, 1)
    await initialize(claude, 2)

    const recordedResponse = await exchange(codex, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'memory_record',
        arguments: {
          kind: 'decision',
          title: 'Use shared memory',
          content: 'Every harness uses the app authority.',
          tags: ['memory', 'authority'],
          sourceSession: 'codex-session'
        }
      }
    })
    expect(recordedResponse).toMatchObject({ result: { isError: false } })
    const recorded = object(toolValue(recordedResponse), 'recorded memory')
    expect(recorded).toMatchObject({
      id: 'shared-memory',
      revision: 1,
      provenance: { harness: 'codex', workspace: primaryWorkspace, sourceSession: 'codex-session' }
    })
    expect(calls[0]).toMatchObject({
      method: 'memory.create',
      params: {
        workspacePath: primaryWorkspace,
        attribution: { harness: 'codex', sourceSession: 'codex-session' }
      }
    })

    const override = await exchange(codex, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'memory_record',
        arguments: {
          workspacePath: '/folders/other',
          kind: 'fact',
          title: 'Attempted override',
          content: 'This must not cross the pinned boundary.'
        }
      }
    })
    expect(override).toMatchObject({ result: { isError: true } })
    expect(toolValue(override)).toMatchObject({ error: expect.stringContaining('unknown field: workspacePath') })

    const searchResponse = await exchange(claude, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'shared memory' } }
    })
    expect(toolValue(searchResponse)).toMatchObject({
      project,
      total: 1,
      entries: [{ id: 'shared-memory' }]
    })

    const replacedResponse = await exchange(claude, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'memory_replace',
        arguments: {
          id: 'shared-memory',
          expectedRevision: 1,
          kind: 'convention',
          title: 'Use shared project memory',
          content: 'Every harness reads and writes through authenticated runtime RPC.',
          tags: ['memory', 'rpc'],
          sourceRef: 'agent://claude'
        }
      }
    })
    expect(toolValue(replacedResponse)).toMatchObject({
      revision: 2,
      provenance: { harness: 'claude-code', workspace: worktreeWorkspace, sourceRef: 'agent://claude' }
    })
    const stale = await exchange(codex, {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'memory_replace',
        arguments: {
          id: 'shared-memory',
          expectedRevision: 1,
          kind: 'fact',
          title: 'Lost update',
          content: 'A stale writer must fail.'
        }
      }
    })
    expect(stale).toMatchObject({ result: { isError: true } })
    expect(toolValue(stale)).toMatchObject({ code: 'PROJECT_MEMORY_CONFLICT' })

    const archivedResponse = await exchange(claude, {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'memory_archive',
        arguments: { id: 'shared-memory', expectedRevision: 2 }
      }
    })
    expect(toolValue(archivedResponse)).toMatchObject({ revision: 3, archivedAt: expect.any(String) })
    const hiddenResponse = await exchange(codex, {
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: {} }
    })
    expect(toolValue(hiddenResponse)).toMatchObject({ total: 0, entries: [] })

    const restoredResponse = await exchange(codex, {
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'memory_archive',
        arguments: { id: 'shared-memory', expectedRevision: 3, archived: false }
      }
    })
    expect(toolValue(restoredResponse)).toMatchObject({ revision: 4, archivedAt: null })
    const historyResponse = await exchange(codex, {
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'memory_history', arguments: { id: 'shared-memory' } }
    })
    expect(toolValue(historyResponse)).toMatchObject({
      entryId: 'shared-memory',
      revisions: [
        { revision: 4, provenance: { harness: 'codex' }, archivedAt: null },
        { revision: 3, provenance: { harness: 'claude-code' }, archivedAt: expect.any(String) },
        { revision: 2, provenance: { harness: 'claude-code' } },
        { revision: 1, provenance: { harness: 'codex' } }
      ]
    })
  })

  it('runs bounded newline-delimited stdio with responses only on stdout', async () => {
    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROJECT_MEMORY_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'stdio-client', version: '1.0.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' }
    ]
    const input = Readable.from([`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`])
    let stdout = ''
    const output = new Writable({
      write(chunk, _encoding, callback) {
        stdout += chunk.toString()
        callback()
      }
    })
    await runProjectMemoryMcp({
      workspacePath: primaryWorkspace,
      harness: 'stdio-harness',
      invoke: async () => ({}),
      input,
      output
    })
    const responses = stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(responses.map((response) => response.id)).toEqual([1, 2, 3])
    expect(responses[0]).toMatchObject({ result: { protocolVersion: PROJECT_MEMORY_MCP_PROTOCOL_VERSION } })
    expect(responses[1]).toMatchObject({ result: {} })
    expect(responses[2]).toMatchObject({ result: { tools: expect.any(Array) } })

    expect(parseProjectMemoryMcpArguments([
      '--harness=codex',
      '--workspace',
      primaryWorkspace
    ])).toEqual({ workspacePath: primaryWorkspace, harness: 'codex' })
    expect(parseProjectMemoryMcpArguments([
      '--workspace', 'relative-project',
      '--harness', 'codex'
    ]).workspacePath).toBe(join(process.cwd(), 'relative-project'))
    expect(() => parseProjectMemoryMcpArguments(['--workspace', primaryWorkspace])).toThrow('--harness is required')
    expect(() => parseProjectMemoryMcpArguments([
      '--workspace', primaryWorkspace,
      '--harness', 'codex',
      '--config', 'somewhere'
    ])).toThrow('Unknown memory-mcp argument')

    let invoked = false
    const bounded = new ProjectMemoryMcpSession({
      workspacePath: primaryWorkspace,
      harness: 'bounded-client',
      invoke: async () => {
        invoked = true
        return {}
      }
    })
    const oversized = await bounded.handleLine('x'.repeat(PROJECT_MEMORY_MCP_MAX_MESSAGE_BYTES + 1))
    expect(JSON.parse(oversized!)).toMatchObject({ error: { code: -32600 } })
    expect(invoked).toBe(false)
  })
})

it('pins code tools to the MCP checkout and preserves native graph errors and freshness', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let graphError = false
  const native = { content: [{ type: 'text', text: '{"freshness":{"state":"stale"}}' }], structuredContent: { freshness: { state: 'stale' } } }
  const session = new ProjectMemoryMcpSession({ workspacePath: primaryWorkspace, harness: 'kimi', invoke: async (method, params) => {
    calls.push({ method, params })
    if (method === 'tool.list') return []
    if (method === 'tool.call') return graphError ? { isError: true, content: [{ type: 'text', text: 'Missing index' }] } : native
    return { hits: [], truncated: false, skipped: 0 }
  } })
  await initialize(session, 1)
  const call = (name: string, args: Record<string, unknown> = {}) => exchange(session, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
  expect(toolValue(await call('code_search', { query: 'needle', maxResults: 10 }))).toMatchObject({ hits: [] })
  expect(calls.at(-1)).toEqual({ method: 'file.searchContent', params: { workspacePath: primaryWorkspace, query: 'needle', maxResults: 10, showHidden: false, includeIgnored: false } })
  expect(toolValue(await call('code_search', { query: 'console.log($A)', language: 'typescript' }))).toMatchObject({ hits: [] })
  expect(calls.at(-1)).toEqual({ method: 'file.searchContent', params: { workspacePath: primaryWorkspace, query: 'console.log($A)', language: 'typescript', showHidden: false, includeIgnored: false } })
  await call('browser_test_click',{target:'e3',revision:2})
  expect(calls.at(-1)).toEqual({method:'tool.call',params:{workspacePath:primaryWorkspace,id:'browser-testing',operation:'click',arguments:{target:'e3',revision:2}}})
  await call('computer_attach',{pid:123,window:456,foreground:false})
  const computerCall=calls.at(-1) as any
  expect(computerCall.params).toMatchObject({workspacePath:primaryWorkspace,id:'computer-control',operation:'attach',arguments:{pid:123,window:456,foreground:false,owner:expect.any(String)}})
  const owner=computerCall.params.arguments.owner
  await call('computer_click',{element:'s1:0',generation:1,revision:1})
  expect((calls.at(-1) as any).params.arguments.owner).toBe(owner)
  const beforeComputer=calls.length
  expect(await call('computer_click',{element:'s1:0',generation:1,revision:1,owner:'spoof'})).toMatchObject({result:{isError:true}})
  expect(calls).toHaveLength(beforeComputer)
  const beforeBrowser=calls.length
  expect(await call('browser_test_open',{workspacePath:'/foreign',url:'https://example.com'})).toMatchObject({result:{isError:true}})
  expect(calls).toHaveLength(beforeBrowser)
  expect(toolValue(await call('code_graph_status'))).toEqual({ available: false, service: null })
  expect(await call('code_graph_callers', { function_name: 'target' })).toMatchObject({ result: native })
  expect(calls.at(-1)).toEqual({ method: 'tool.call', params: { workspacePath: primaryWorkspace, id: 'code-graph', operation: 'callers', arguments: { function_name: 'target' } } })
  await call('code_graph_index')
  expect(calls.at(-1)?.params.operation).toBe('index')
  expect(toolValue(await call('documents_status'))).toEqual({ available: false, service: null })
  const engines = toolValue(await call('project_engines'))
  expect(engines).toMatchObject({ workspacePath: primaryWorkspace, engines: [{ engine: 'SQLite / FTS5' }, { id: 'documents', available: false }, { id: 'code-graph' }] })
  expect(calls.at(-1)).toEqual({ method: 'tool.list', params: { workspacePath: primaryWorkspace } })
  expect(await call('documents_search', { query: 'needle' })).toMatchObject({ result: native })
  expect(calls.at(-1)).toEqual({ method: 'tool.call', params: { workspacePath: primaryWorkspace, id: 'documents', operation: 'query', arguments: { query: 'needle' } } })
  await call('documents_pause')
  expect(calls.at(-1)).toEqual({ method: 'tool.stop', params: { workspacePath: primaryWorkspace, id: 'documents' } })
  const count = calls.length
  for (const [name, args] of [
    ['code_search', { query: 'needle', workspacePath: '/other' }],
    ['code_search', { query: 'needle', maxResults: 1001 }],
    ['code_graph_callers', { function_name: 'target', project: 'other' }],
    ['code_graph_callers', { function_name: 'a\nb' }],
    ['code_graph_index', { repo_path: '/other' }],
    ['code_graph_status', { id: 'other' }],
    ['documents_search', { query: 'needle', workspacePath: '/other' }],
    ['documents_get', { id: 'reference', root: '/other' }],
    ['documents_pause', { id: 'other' }],
    ['project_engines', { workspacePath: '/other' }]
  ] as const) expect(await call(name, args)).toMatchObject({ result: { isError: true } })
  expect(calls).toHaveLength(count)
  graphError = true
  expect(await call('documents_get', { id: 'reference' })).toMatchObject({ result: { isError: true, content: [{ text: 'Missing index' }] } })
  expect(await call('code_graph_callers', { function_name: 'target' })).toMatchObject({ result: { isError: true, content: [{ text: 'Missing index' }] } })
})
