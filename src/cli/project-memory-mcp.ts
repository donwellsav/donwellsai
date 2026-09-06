import { validateCommandParams } from '../shared/command-catalog.js'
import { parseCodeGraphFunctionName } from '../shared/project-tools.js'
import type { AgentSessionCredential } from '../shared/agent-runtime.js'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'
import {
  PROJECT_MEMORY_MAX_IDENTIFIER_LENGTH,
  PROJECT_MEMORY_MAX_SOURCE_REF_LENGTH,
  PROJECT_MEMORY_MAX_SOURCE_SESSION_LENGTH,
  PROJECT_MEMORY_KINDS,
  PROJECT_MEMORY_MAX_CONTENT_LENGTH,
  PROJECT_MEMORY_MAX_HISTORY_REVISIONS,
  PROJECT_MEMORY_MAX_QUERY_LENGTH,
  PROJECT_MEMORY_MAX_RESULT_LIMIT,
  PROJECT_MEMORY_MAX_TAG_LENGTH,
  PROJECT_MEMORY_MAX_TAGS,
  PROJECT_MEMORY_MAX_TITLE_LENGTH,
  PROJECT_MEMORY_RPC_METHODS,
  parseProjectMemoryIdentifier,
  parseProjectMemoryArchiveRequest,
  parseProjectMemoryCreateRequest,
  parseProjectMemoryGetRequest,
  parseProjectMemoryHarness,
  parseProjectMemoryHistoryRequest,
  parseProjectMemoryListRequest,
  parseProjectMemoryUpdateRequest,
  parseProjectMemoryWorkspacePath,
  type ProjectMemoryAttributionInput,
  type ProjectMemoryRpcMethod
} from '../shared/project-memory.js'

export const PROJECT_MEMORY_MCP_PROTOCOL_VERSION = '2025-11-25' as const
export const PROJECT_MEMORY_MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  PROJECT_MEMORY_MCP_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05'
] as const
export const PROJECT_MEMORY_MCP_MAX_MESSAGE_BYTES = 1024 * 1024
export const PROJECT_MEMORY_MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const PROJECT_MEMORY_MCP_USAGE = 'donwells memory-mcp --workspace <path> --harness <id>'

const JSON_RPC_PARSE_ERROR = -32700
const JSON_RPC_INVALID_REQUEST = -32600
const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_INVALID_PARAMS = -32602
const JSON_RPC_INTERNAL_ERROR = -32603
const MCP_SERVER_NOT_INITIALIZED = -32002

type JsonRpcId = string | number
type UnknownRecord = Record<string, unknown>
type SessionState = 'new' | 'awaiting-initialized' | 'ready'

type JsonRpcSuccess = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

type JsonRpcFailure = {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

export type ProjectMemoryMcpInvoke = (
  method: ProjectMemoryRpcMethod | 'handoff.receive' | 'handoff.acknowledge' | 'file.searchContent' | 'tool.list' | 'tool.call',
  params: Record<string, unknown>
) => Promise<unknown>

export type ProjectMemoryMcpSessionOptions = {
  workspacePath: string
  harness: string
  invoke: ProjectMemoryMcpInvoke
  credential?: AgentSessionCredential
  serverVersion?: string
}

export type ProjectMemoryMcpRunOptions = ProjectMemoryMcpSessionOptions & {
  input?: Readable
  output?: Writable
}

export type ProjectMemoryMcpCliArguments = {
  workspacePath: string
  harness: string
}

type McpTool = {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
}

const HANDOFF_MCP_TOOLS: readonly McpTool[] = ['receive', 'acknowledge'].map(action => ({
  name: `handoff_${action}`,
  title: action === 'receive' ? 'Receive accepted handoff' : 'Acknowledge handoff receipt',
  description: action === 'receive'
    ? 'Retrieve an exact handoff already accepted for this native session. Supply the handoff ID and accepted revision from its sidebar review. Delivery becomes uncertain before this tool returns. After reading the returned context, call handoff_acknowledge with its ID and returned revision before continuing. Do not blindly retry an uncertain delivery; inspect it in the sidebar.'
    : 'Confirm that this native session received and read the saved handoff context. Supply the ID and revision returned by handoff_receive. Confirms receipt only, not task completion. Repeating the same acknowledgment is safe.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 256 }, expectedRevision: { type: 'integer', minimum: 1 } }, required: ['id', 'expectedRevision'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: action === 'acknowledge', openWorldHint: false }
}))

const CODE_MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'code_search', title: 'Search checkout code',
    description: 'Search literal text in the pinned checkout with ripgrep. Returns bounded source paths, line numbers and excerpts. Hidden and ignored files are excluded unless explicitly requested. This is source search, not durable project memory.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 1000 }, maxResults: { type: 'integer', minimum: 1, maximum: 1000, default: 200 }, showHidden: { type: 'boolean', default: false }, includeIgnored: { type: 'boolean', default: false } }, required: ['query'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  ...(['status', 'index', 'callers'] as const).map(action => ({
    name: `code_graph_${action}`,
    title: action === 'status' ? 'Code graph availability' : action === 'index' ? 'Rebuild checkout code index' : 'Find direct callers',
    description: action === 'status' ? 'Check whether the optional code graph is enabled and its service state, without starting it.' : action === 'index' ? 'Explicitly rebuild the derived code index for this pinned checkout. Does not edit source files or project memory. Check freshness and partial-parse coverage in the result. An uncertain failure must be inspected before retrying.' : 'Find direct callers of a function in this pinned checkout. Requires an existing index; does not automatically rebuild. Preserve native confidence and freshness in your answer. Stale or unknown results are not verified-current evidence; dynamic resolution may be incomplete.',
    inputSchema: { type: 'object', additionalProperties: false, properties: action === 'callers' ? { function_name: { type: 'string', minLength: 1, maxLength: 128 } } : {}, ...(action === 'callers' ? { required: ['function_name'] } : {}) },
    annotations: { readOnlyHint: action !== 'index', destructiveHint: false, idempotentHint: action !== 'index', openWorldHint: false }
  }))
]

const KIND_SCHEMA = {
  type: 'string',
  enum: [...PROJECT_MEMORY_KINDS]
}

const TAGS_SCHEMA = {
  type: 'array',
  maxItems: PROJECT_MEMORY_MAX_TAGS,
  uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_TAG_LENGTH }
}

const SOURCE_PROPERTIES = {
  sourceSession: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_SOURCE_SESSION_LENGTH },
  sourceRef: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_SOURCE_REF_LENGTH }
}

export const PROJECT_MEMORY_MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'memory_search',
    title: 'Search project memory',
    description: 'Lexically search shared memory for the pinned registered project. Returns entries with full content, id, revision and provenance; content is the saved knowledge, not an ID. Answer directly from matching entries.content. Use only entries.id for follow-up reads or updates. Title and tags rank above content.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_QUERY_LENGTH },
        kinds: { type: 'array', minItems: 1, maxItems: PROJECT_MEMORY_KINDS.length, uniqueItems: true, items: KIND_SCHEMA },
        includeArchived: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: PROJECT_MEMORY_MAX_RESULT_LIMIT, default: 50 }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'memory_read',
    title: 'Read project memory',
    description: 'Read one memory entry using its exact id returned by memory_search or memory_record. Never use its content or title as the id. Search already returns full content; a second read is usually unnecessary.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_IDENTIFIER_LENGTH } },
      required: ['id']
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'memory_record',
    title: 'Record project memory',
    description: 'Create a shared project memory with self-reported harness provenance.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: KIND_SCHEMA,
        title: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_TITLE_LENGTH },
        content: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_CONTENT_LENGTH },
        tags: TAGS_SCHEMA,
        ...SOURCE_PROPERTIES
      },
      required: ['kind', 'title', 'content']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'memory_replace',
    title: 'Replace project memory',
    description: 'Replace an active memory using revision compare-and-swap. A stale revision is rejected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_IDENTIFIER_LENGTH },
        expectedRevision: { type: 'integer', minimum: 1 },
        kind: KIND_SCHEMA,
        title: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_TITLE_LENGTH },
        content: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_CONTENT_LENGTH },
        tags: TAGS_SCHEMA,
        ...SOURCE_PROPERTIES
      },
      required: ['id', 'expectedRevision', 'kind', 'title', 'content']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'memory_archive',
    title: 'Archive or restore project memory',
    description: 'Archive a memory, or restore it with archived=false, using revision compare-and-swap.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_IDENTIFIER_LENGTH },
        expectedRevision: { type: 'integer', minimum: 1 },
        archived: { type: 'boolean', default: true },
        ...SOURCE_PROPERTIES
      },
      required: ['id', 'expectedRevision']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'memory_history',
    title: 'Read project memory history',
    description: 'Read newest-first immutable revisions retained for one memory.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1, maxLength: PROJECT_MEMORY_MAX_IDENTIFIER_LENGTH },
        limit: { type: 'integer', minimum: 1, maximum: PROJECT_MEMORY_MAX_HISTORY_REVISIONS + 1 }
      },
      required: ['id']
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
]

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as UnknownRecord
}

function allowedKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra) throw new Error(`${label} contains unknown field: ${extra}`)
}

function validateMeta(value: UnknownRecord, label: string): void {
  if (value._meta !== undefined) record(value._meta, `${label}._meta`)
}

function optionalSource(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be a trimmed, single-line string no longer than ${maximum} characters`)
  }
  return value
}

function attribution(argumentsValue: UnknownRecord, harness: string): ProjectMemoryAttributionInput {
  const sourceSession = optionalSource(argumentsValue.sourceSession, 'sourceSession', PROJECT_MEMORY_MAX_SOURCE_SESSION_LENGTH)
  const sourceRef = optionalSource(argumentsValue.sourceRef, 'sourceRef', PROJECT_MEMORY_MAX_SOURCE_REF_LENGTH)
  return {
    harness,
    ...(sourceSession === undefined ? {} : { sourceSession }),
    ...(sourceRef === undefined ? {} : { sourceRef })
  }
}

function rpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

function rpcFailure(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) }
  }
}

function requestId(value: unknown): JsonRpcId | undefined {
  if (typeof value === 'string' && value.length <= 256) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  return undefined
}

function toolError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  let message = error instanceof Error ? error.message : String(error)
  let code: string | undefined
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    code = error.code
  }
  if (message.length > 2_000) message = `${message.slice(0, 2_000)}…`
  const text = JSON.stringify({ ok: false, ...(code === undefined ? {} : { code }), error: message })
  return { content: [{ type: 'text', text }], isError: true }
}

function toolSuccess(result: unknown): { content: Array<{ type: 'text'; text: string }>; isError: false } {
  const text = JSON.stringify(result ?? null, null, 2)
  if (Buffer.byteLength(text) > PROJECT_MEMORY_MCP_MAX_RESPONSE_BYTES) {
    throw new Error('Project memory result exceeds the MCP response limit; narrow the query or lower the limit')
  }
  return { content: [{ type: 'text', text }], isError: false }
}

function parseInitializeParams(value: unknown): { protocolVersion: string } {
  const input = record(value, 'initialize params')
  allowedKeys(input, ['protocolVersion', 'capabilities', 'clientInfo', '_meta'], 'initialize params')
  validateMeta(input, 'initialize params')
  if (typeof input.protocolVersion !== 'string' || input.protocolVersion.length > 32) {
    throw new Error('protocolVersion must be a bounded string')
  }
  record(input.capabilities, 'initialize params.capabilities')
  const clientInfo = record(input.clientInfo, 'initialize params.clientInfo')
  if (typeof clientInfo.name !== 'string' || clientInfo.name.length === 0 || clientInfo.name.length > 256) {
    throw new Error('clientInfo.name must be a bounded string')
  }
  if (typeof clientInfo.version !== 'string' || clientInfo.version.length === 0 || clientInfo.version.length > 128) {
    throw new Error('clientInfo.version must be a bounded string')
  }
  return { protocolVersion: input.protocolVersion }
}

function validateEmptyParams(value: unknown, label: string): void {
  if (value === undefined) return
  const input = record(value, label)
  allowedKeys(input, ['_meta'], label)
  validateMeta(input, label)
}

export function parseProjectMemoryMcpArguments(argv: readonly string[]): ProjectMemoryMcpCliArguments {
  let workspacePath: string | undefined
  let harness: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    let flag = argument
    let inlineValue: string | undefined
    const equals = argument.indexOf('=')
    if (equals >= 0) {
      flag = argument.slice(0, equals)
      inlineValue = argument.slice(equals + 1)
    }
    if (flag !== '--workspace' && flag !== '--harness') {
      throw new Error(`Unknown memory-mcp argument: ${argument}`)
    }
    const value = inlineValue ?? argv[index + 1]
    if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`)
    if (inlineValue === undefined) index += 1
    if (flag === '--workspace') {
      if (workspacePath !== undefined) throw new Error('--workspace may only be specified once')
      workspacePath = parseProjectMemoryWorkspacePath(resolve(value), '--workspace')
    } else {
      if (harness !== undefined) throw new Error('--harness may only be specified once')
      harness = parseProjectMemoryHarness(value, '--harness')
    }
  }
  if (workspacePath === undefined) throw new Error('--workspace is required')
  if (harness === undefined) throw new Error('--harness is required')
  return { workspacePath, harness }
}

export class ProjectMemoryMcpSession {
  private readonly workspacePath: string
  private readonly harness: string
  private readonly invoke: ProjectMemoryMcpInvoke
  private readonly serverVersion: string
  private readonly credential?: AgentSessionCredential
  private state: SessionState = 'new'

  constructor(options: ProjectMemoryMcpSessionOptions) {
    this.workspacePath = parseProjectMemoryWorkspacePath(options.workspacePath, 'pinned workspace')
    this.harness = parseProjectMemoryHarness(options.harness, 'pinned harness')
    this.credential = options.credential ? { ...options.credential } : undefined
    this.invoke = options.invoke
    this.serverVersion = options.serverVersion ?? '1.0.0'
    if (this.serverVersion.length === 0 || this.serverVersion.length > 128) {
      throw new Error('MCP server version must be a bounded string')
    }
  }

  async handleLine(line: string): Promise<string | undefined> {
    if (Buffer.byteLength(line) > PROJECT_MEMORY_MCP_MAX_MESSAGE_BYTES) {
      return JSON.stringify(rpcFailure(null, JSON_RPC_INVALID_REQUEST, 'MCP message exceeds the 1 MiB limit'))
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      return JSON.stringify(rpcFailure(null, JSON_RPC_PARSE_ERROR, 'Parse error'))
    }
    const response = await this.handleMessage(decoded)
    return response === undefined ? undefined : JSON.stringify(response)
  }

  private async handleMessage(value: unknown): Promise<JsonRpcResponse | undefined> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return rpcFailure(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request')
    }
    const message = value as UnknownRecord
    const id = requestId(message.id)
    const hasId = Object.hasOwn(message, 'id')
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcFailure(id ?? null, JSON_RPC_INVALID_REQUEST, 'Invalid Request')
    }
    const extra = Object.keys(message).find((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key))
    if (extra || (hasId && id === undefined)) {
      return rpcFailure(id ?? null, JSON_RPC_INVALID_REQUEST, 'Invalid Request')
    }
    if (!hasId) {
      this.handleNotification(message.method, message.params)
      return undefined
    }

    if (message.method === 'ping') {
      try {
        validateEmptyParams(message.params, 'ping params')
        return rpcSuccess(id!, {})
      } catch (error) {
        return rpcFailure(id!, JSON_RPC_INVALID_PARAMS, error instanceof Error ? error.message : 'Invalid ping params')
      }
    }
    if (message.method === 'initialize') return this.initialize(id!, message.params)
    if (this.state !== 'ready') {
      return rpcFailure(id!, MCP_SERVER_NOT_INITIALIZED, 'Server is not initialized')
    }
    if (message.method === 'tools/list') return this.listTools(id!, message.params)
    if (message.method === 'tools/call') return this.callTool(id!, message.params)
    return rpcFailure(id!, JSON_RPC_METHOD_NOT_FOUND, 'Method not found')
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'notifications/initialized' && this.state === 'awaiting-initialized') {
      try {
        validateEmptyParams(params, 'initialized notification params')
        this.state = 'ready'
      } catch {
        // Invalid notifications do not receive responses and do not advance the lifecycle.
      }
    }
    // Unknown and cancellation notifications intentionally receive no response.
  }

  private initialize(id: JsonRpcId, params: unknown): JsonRpcResponse {
    if (this.state !== 'new') return rpcFailure(id, JSON_RPC_INVALID_REQUEST, 'Server is already initialized')
    let protocolVersion: string
    try {
      protocolVersion = parseInitializeParams(params).protocolVersion
    } catch (error) {
      return rpcFailure(id, JSON_RPC_INVALID_PARAMS, error instanceof Error ? error.message : 'Invalid initialize params')
    }
    if (!(PROJECT_MEMORY_MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) {
      return rpcFailure(id, JSON_RPC_INVALID_PARAMS, 'Unsupported protocol version', {
        requested: protocolVersion,
        supported: [...PROJECT_MEMORY_MCP_SUPPORTED_PROTOCOL_VERSIONS]
      })
    }
    this.state = 'awaiting-initialized'
    return rpcSuccess(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: 'donwells-project-memory',
        title: 'donwells.ai Project Memory',
        version: this.serverVersion
      },
      instructions: 'Memory belongs to the pinned registered project; code search and graph tools use its pinned checkout. Tool availability and freshness must be checked. Harness provenance is self-reported attribution, not authentication.'
    })
  }

  private listTools(id: JsonRpcId, params: unknown): JsonRpcResponse {
    try {
      if (params !== undefined) {
        const input = record(params, 'tools/list params')
        allowedKeys(input, ['cursor', '_meta'], 'tools/list params')
        validateMeta(input, 'tools/list params')
        if (input.cursor !== undefined) throw new Error('This static tool list does not accept a cursor')
      }
      return rpcSuccess(id, { tools: this.tools() })
    } catch (error) {
      return rpcFailure(id, JSON_RPC_INVALID_PARAMS, error instanceof Error ? error.message : 'Invalid tools/list params')
    }
  }

  private tools(): readonly McpTool[] { return [...PROJECT_MEMORY_MCP_TOOLS, ...CODE_MCP_TOOLS, ...(this.credential ? HANDOFF_MCP_TOOLS : [])] }

  private async callTool(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    let name: string
    let argumentsValue: UnknownRecord
    try {
      const input = record(params, 'tools/call params')
      allowedKeys(input, ['name', 'arguments', '_meta'], 'tools/call params')
      validateMeta(input, 'tools/call params')
      if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > 128) {
        throw new Error('tools/call name must be a bounded string')
      }
      name = input.name
      argumentsValue = input.arguments === undefined ? {} : record(input.arguments, 'tool arguments')
    } catch (error) {
      return rpcFailure(id, JSON_RPC_INVALID_PARAMS, error instanceof Error ? error.message : 'Invalid tools/call params')
    }
    if (!this.tools().some((tool) => tool.name === name)) {
      return rpcFailure(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`)
    }
    try {
      const result = await this.executeTool(name, argumentsValue)
      if (name === 'code_graph_index' || name === 'code_graph_callers') {
        const native = record(result, 'graph result')
        if (!Array.isArray(native.content)) throw new Error('Malformed graph result')
        if (Buffer.byteLength(JSON.stringify(native)) > PROJECT_MEMORY_MCP_MAX_RESPONSE_BYTES) throw new Error('Graph response exceeds the MCP limit; narrow the query')
        return rpcSuccess(id, native)
      }
      return rpcSuccess(id, toolSuccess(result))
    } catch (error) {
      return rpcSuccess(id, toolError(error))
    }
  }

  private async executeTool(name: string, input: UnknownRecord): Promise<unknown> {
    switch (name) {
      case 'code_search': {
        allowedKeys(input, ['query', 'maxResults', 'showHidden', 'includeIgnored'], 'code_search arguments')
        return this.invoke('file.searchContent', validateCommandParams('file.searchContent', { workspacePath: this.workspacePath, showHidden: false, includeIgnored: false, ...input }))
      }
      case 'code_graph_status': {
        allowedKeys(input, [], 'code graph status arguments')
        const tools = await this.invoke('tool.list', { workspacePath: this.workspacePath })
        if (!Array.isArray(tools)) throw new Error('Invalid project tool list')
        const service = tools.find(tool => tool?.id === 'code-graph') ?? null
        return { available: service !== null, service }
      }
      case 'code_graph_index':
      case 'code_graph_callers': {
        const callers = name === 'code_graph_callers'
        allowedKeys(input, callers ? ['function_name'] : [], 'code graph arguments')
        const args = callers ? { function_name: parseCodeGraphFunctionName(input.function_name) } : {}
        return this.invoke('tool.call', { workspacePath: this.workspacePath, id: 'code-graph', operation: callers ? 'callers' : 'index', arguments: args })
      }
      case 'handoff_receive':
      case 'handoff_acknowledge': {
        allowedKeys(input, ['id', 'expectedRevision'], 'handoff arguments')
        const id = parseProjectMemoryIdentifier(input.id, 'handoff id')
        if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) throw new Error('Invalid handoff revision')
        if (!this.credential) throw new Error('Handoffs require a native session credential')
        return this.invoke(name === 'handoff_receive' ? 'handoff.receive' : 'handoff.acknowledge', { workspacePath: this.workspacePath, credential: this.credential, id, expectedRevision: input.expectedRevision })
      }
      case 'memory_search': {
        allowedKeys(input, ['query', 'kinds', 'includeArchived', 'limit'], 'memory_search arguments')
        const request = parseProjectMemoryListRequest({ workspacePath: this.workspacePath, ...input })
        return this.invoke(PROJECT_MEMORY_RPC_METHODS.list, { ...request })
      }
      case 'memory_read': {
        allowedKeys(input, ['id'], 'memory_read arguments')
        const request = parseProjectMemoryGetRequest({ workspacePath: this.workspacePath, ...input })
        return this.invoke(PROJECT_MEMORY_RPC_METHODS.get, { ...request })
      }
      case 'memory_record': {
        allowedKeys(input, ['kind', 'title', 'content', 'tags', 'sourceSession', 'sourceRef'], 'memory_record arguments')
        const request = parseProjectMemoryCreateRequest({
          workspacePath: this.workspacePath,
          kind: input.kind,
          title: input.title,
          content: input.content,
          tags: input.tags,
          attribution: attribution(input, this.harness)
        })
        return this.invoke(PROJECT_MEMORY_RPC_METHODS.create, { ...request })
      }
      case 'memory_replace': {
        allowedKeys(input, ['id', 'expectedRevision', 'kind', 'title', 'content', 'tags', 'sourceSession', 'sourceRef'], 'memory_replace arguments')
        const request = parseProjectMemoryUpdateRequest({
          workspacePath: this.workspacePath,
          id: input.id,
          expectedRevision: input.expectedRevision,
          kind: input.kind,
          title: input.title,
          content: input.content,
          tags: input.tags,
          attribution: attribution(input, this.harness)
        })
        return this.invoke(PROJECT_MEMORY_RPC_METHODS.update, { ...request })
      }
      case 'memory_archive': {
        allowedKeys(input, ['id', 'expectedRevision', 'archived', 'sourceSession', 'sourceRef'], 'memory_archive arguments')
        const request = parseProjectMemoryArchiveRequest({
          workspacePath: this.workspacePath,
          id: input.id,
          expectedRevision: input.expectedRevision,
          archived: input.archived ?? true,
          attribution: attribution(input, this.harness)
        })
        return this.invoke(PROJECT_MEMORY_RPC_METHODS.archive, { ...request })
      }
      case 'memory_history': {
        allowedKeys(input, ['id', 'limit'], 'memory_history arguments')
        const request = parseProjectMemoryHistoryRequest({ workspacePath: this.workspacePath, ...input })
        return this.invoke(PROJECT_MEMORY_RPC_METHODS.history, { ...request })
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }
}

async function writeResponse(output: Writable, line: string): Promise<void> {
  if (Buffer.byteLength(line) > PROJECT_MEMORY_MCP_MAX_RESPONSE_BYTES) {
    line = JSON.stringify(rpcFailure(null, JSON_RPC_INTERNAL_ERROR, 'MCP response exceeds the 8 MiB limit'))
  }
  if (!output.write(`${line}\n`, 'utf8')) await once(output, 'drain')
}

/** Runs a newline-delimited UTF-8 MCP stdio session without writing logs to stdout. */
export async function runProjectMemoryMcp(options: ProjectMemoryMcpRunOptions): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const session = new ProjectMemoryMcpSession(options)
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  let bufferedBytes = 0
  let discardingOversizedLine = false

  const consume = async (text: string): Promise<void> => {
    let offset = 0
    let newline = text.indexOf('\n', offset)
    while (newline >= 0) {
      let segment = text.slice(offset, newline)
      if (segment.endsWith('\r')) segment = segment.slice(0, -1)
      if (discardingOversizedLine) {
        discardingOversizedLine = false
      } else if (bufferedBytes + Buffer.byteLength(segment) > PROJECT_MEMORY_MCP_MAX_MESSAGE_BYTES) {
        await writeResponse(output, JSON.stringify(rpcFailure(null, JSON_RPC_INVALID_REQUEST, 'MCP message exceeds the 1 MiB limit')))
      } else {
        const response = await session.handleLine(buffered + segment)
        if (response !== undefined) await writeResponse(output, response)
      }
      buffered = ''
      bufferedBytes = 0
      offset = newline + 1
      newline = text.indexOf('\n', offset)
    }

    const remainder = text.slice(offset)
    if (discardingOversizedLine) return
    const remainderBytes = Buffer.byteLength(remainder)
    if (bufferedBytes + remainderBytes > PROJECT_MEMORY_MCP_MAX_MESSAGE_BYTES) {
      buffered = ''
      bufferedBytes = 0
      discardingOversizedLine = true
      await writeResponse(output, JSON.stringify(rpcFailure(null, JSON_RPC_INVALID_REQUEST, 'MCP message exceeds the 1 MiB limit')))
      return
    }
    buffered += remainder
    bufferedBytes += remainderBytes
  }

  for await (const chunk of input) {
    await consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
  }
  await consume(decoder.end())
  if (!discardingOversizedLine && buffered.length > 0) {
    const response = await session.handleLine(buffered)
    if (response !== undefined) await writeResponse(output, response)
  }
}
