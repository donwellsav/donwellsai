import type { TerminalSession } from './types'
import type { ProcessIdentity } from './child-process/process-spec'
import type { InitializeResponse, RequestPermissionRequest, PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'

export type AcpAgentSnapshot = {
  mode: 'acp'
  id: string
  workspacePath: string
  protocolSessionId: string | null
  processIdentity: ProcessIdentity | null
  state: 'starting' | 'ready' | 'working' | 'permission' | 'stopping' | 'exited' | 'uncertain'
  capabilities: InitializeResponse['agentCapabilities']
  permissions: Array<{ id: string; request: RequestPermissionRequest }>
  detail?: string
}
export type AcpPromptRecord = { requestId: string; state: 'accepted' | 'completed' | 'uncertain'; result?: PromptResponse; error?: string }
export type AcpObservation = { snapshot: AcpAgentSnapshot; sequence: number; truncated: boolean; updates: Array<{ sequence: number; notification: SessionNotification }>; requests: AcpPromptRecord[] }
export type AuthenticatedAgentSession = { id: string; sessionId: string; workspacePath: string; liveness: 'live'; mode?: 'native' | 'acp' }
export type AgentModeSwitchReceipt = {
  requestId: string; workspacePath: string; sessionId: string; target: 'native' | 'acp'
  state: 'accepted' | 'completed' | 'uncertain'; continuity: 'same-history' | 'new-session'
  native?: AgentStartResult; acp?: AcpAgentSnapshot; error?: string
}

export const ACP_DAEMON_CAPABILITY = 'agent-acp-v2'

type AcpUnknownRecord = Record<string, unknown>

function acpRecord(value: unknown, label: string): AcpUnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as AcpUnknownRecord
}

function acpExactKeys(value: AcpUnknownRecord, required: readonly string[], optional: readonly string[], label: string): void {
  const expected = new Set([...required, ...optional])
  const extra = Object.keys(value).find(key => !expected.has(key))
  if (extra) throw new Error(`${label} contains unknown field: ${extra}`)
  const missing = required.find(key => !Object.hasOwn(value, key))
  if (missing) throw new Error(`${label} is missing field: ${missing}`)
}

function acpString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes(String.fromCharCode(0))) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters`)
  }
  return value
}

function acpInteger(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) throw new Error(`${label} must be ${positive ? 'a positive' : 'a non-negative'} integer`)
  return value as number
}

function acpJsonValue(value: unknown, label: string): unknown {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new Error(label + ' must contain only JSON values')
  }
  if (encoded === undefined) throw new Error(label + ' must contain only JSON values')
  if (new TextEncoder().encode(encoded).length > 2 * 1024 * 1024) throw new Error(label + ' exceeds the ACP wire limit')
  return JSON.parse(encoded) as unknown
}

function acpJsonRecord(value: unknown, label: string): AcpUnknownRecord {
  return acpRecord(acpJsonValue(value, label), label)
}

function acpWireString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes(String.fromCharCode(0))) throw new Error(label + ' must be a string no longer than ' + maximum + ' characters')
  return value
}

function acpMeta(value: unknown, label: string): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return acpJsonRecord(value, label)
}

function acpOptionalNullableString(input: AcpUnknownRecord, key: string, label: string, maximum: number): string | null | undefined {
  if (!Object.hasOwn(input, key)) return undefined
  const value = input[key]
  if (value === null) return null
  return acpWireString(value, label, maximum)
}

function acpOptionalBoolean(input: AcpUnknownRecord, key: string, label: string): boolean | undefined {
  if (!Object.hasOwn(input, key)) return undefined
  if (typeof input[key] !== 'boolean') throw new Error(label + ' must be a boolean')
  return input[key] as boolean
}

function acpOptionalNumber(input: AcpUnknownRecord, key: string, label: string): number | null | undefined {
  if (!Object.hasOwn(input, key)) return undefined
  if (input[key] !== null && (typeof input[key] !== 'number' || !Number.isFinite(input[key]))) throw new Error(label + ' must be a finite number or null')
  return input[key] as number | null
}

function acpOptionalMeta(input: AcpUnknownRecord, label: string): Record<string, unknown> | null | undefined {
  return acpMeta(input['_meta'], label + '._meta')
}

function acpMarker(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  acpExactKeys(input, [], ['_meta'], label)
  const meta = acpOptionalMeta(input, label)
  return meta === undefined ? {} : { _meta: meta }
}

function acpNullableMarker(input: AcpUnknownRecord, key: string, label: string): AcpUnknownRecord | null | undefined {
  if (!Object.hasOwn(input, key)) return undefined
  return input[key] === null ? null : acpMarker(input[key], label)
}

function acpBooleanCapabilities(value: unknown, label: string, keys: readonly string[]): AcpUnknownRecord {
  const input = acpRecord(value, label)
  acpExactKeys(input, [], [...keys, '_meta'], label)
  const parsed: AcpUnknownRecord = {}
  for (const key of keys) {
    const result = acpOptionalBoolean(input, key, label + '.' + key)
    if (result !== undefined) parsed[key] = result
  }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpCapabilities(value: unknown, label: string): InitializeResponse['agentCapabilities'] {
  const input = acpRecord(value, label)
  acpExactKeys(input, [], ['loadSession', 'promptCapabilities', 'mcpCapabilities', 'sessionCapabilities', 'auth', 'providers', 'nes', 'positionEncoding', '_meta'], label)
  const parsed: AcpUnknownRecord = {}
  const loadSession = acpOptionalBoolean(input, 'loadSession', label + '.loadSession')
  if (loadSession !== undefined) parsed['loadSession'] = loadSession
  if (Object.hasOwn(input, 'promptCapabilities')) parsed['promptCapabilities'] = acpBooleanCapabilities(input['promptCapabilities'], label + '.promptCapabilities', ['image', 'audio', 'embeddedContext'])
  if (Object.hasOwn(input, 'mcpCapabilities')) parsed['mcpCapabilities'] = acpBooleanCapabilities(input['mcpCapabilities'], label + '.mcpCapabilities', ['http', 'sse', 'acp'])
  if (Object.hasOwn(input, 'sessionCapabilities')) {
    const session = acpRecord(input['sessionCapabilities'], label + '.sessionCapabilities')
    acpExactKeys(session, [], ['list', 'delete', 'additionalDirectories', 'fork', 'resume', 'close', '_meta'], label + '.sessionCapabilities')
    const parsedSession: AcpUnknownRecord = {}
    for (const key of ['list', 'delete', 'additionalDirectories', 'fork', 'resume', 'close'] as const) {
      const marker = acpNullableMarker(session, key, label + '.sessionCapabilities.' + key)
      if (marker !== undefined) parsedSession[key] = marker
    }
    const meta = acpOptionalMeta(session, label + '.sessionCapabilities')
    if (meta !== undefined) parsedSession['_meta'] = meta
    parsed['sessionCapabilities'] = parsedSession
  }
  if (Object.hasOwn(input, 'auth')) {
    const auth = acpRecord(input['auth'], label + '.auth')
    acpExactKeys(auth, [], ['logout', '_meta'], label + '.auth')
    const parsedAuth: AcpUnknownRecord = {}
    const logout = acpNullableMarker(auth, 'logout', label + '.auth.logout')
    if (logout !== undefined) parsedAuth['logout'] = logout
    const meta = acpOptionalMeta(auth, label + '.auth')
    if (meta !== undefined) parsedAuth['_meta'] = meta
    parsed['auth'] = parsedAuth
  }
  if (Object.hasOwn(input, 'providers')) parsed['providers'] = input['providers'] === null ? null : acpMarker(input['providers'], label + '.providers')
  if (Object.hasOwn(input, 'positionEncoding')) {
    const encoding = input['positionEncoding']
    if (encoding !== null && encoding !== 'utf-8' && encoding !== 'utf-16' && encoding !== 'utf-32') throw new Error(label + '.positionEncoding is invalid')
    parsed['positionEncoding'] = encoding
  }
  if (Object.hasOwn(input, 'nes')) {
    if (input['nes'] === null) {
      parsed['nes'] = null
    } else {
    const nes = acpRecord(input['nes'], label + '.nes')
    acpExactKeys(nes, [], ['events', 'context', '_meta'], label + '.nes')
    const parsedNes: AcpUnknownRecord = {}
    if (Object.hasOwn(nes, 'events')) {
      if (nes['events'] === null) {
        parsedNes['events'] = null
      } else {
        const events = acpRecord(nes['events'], label + '.nes.events')
        acpExactKeys(events, [], ['document', '_meta'], label + '.nes.events')
        const parsedEvents: AcpUnknownRecord = {}
        if (Object.hasOwn(events, 'document')) {
          if (events['document'] === null) {
            parsedEvents['document'] = null
          } else {
            const document = acpRecord(events['document'], label + '.nes.events.document')
            acpExactKeys(document, [], ['didOpen', 'didChange', 'didClose', 'didSave', 'didFocus', '_meta'], label + '.nes.events.document')
            const parsedDocument: AcpUnknownRecord = {}
            for (const key of ['didOpen', 'didClose', 'didSave', 'didFocus'] as const) {
              const marker = acpNullableMarker(document, key, label + '.nes.events.document.' + key)
              if (marker !== undefined) parsedDocument[key] = marker
            }
            if (Object.hasOwn(document, 'didChange')) {
              if (document['didChange'] === null) {
                parsedDocument['didChange'] = null
              } else {
                const change = acpRecord(document['didChange'], label + '.nes.events.document.didChange')
                acpExactKeys(change, ['syncKind'], ['_meta'], label + '.nes.events.document.didChange')
                if (change['syncKind'] !== 'full' && change['syncKind'] !== 'incremental') throw new Error(label + '.nes.events.document.didChange.syncKind is invalid')
                const changeMeta = acpOptionalMeta(change, label + '.nes.events.document.didChange')
                parsedDocument['didChange'] = { syncKind: change['syncKind'], ...(changeMeta === undefined ? {} : { _meta: changeMeta }) }
              }
            }
            const documentMeta = acpOptionalMeta(document, label + '.nes.events.document')
            if (documentMeta !== undefined) parsedDocument['_meta'] = documentMeta
            parsedEvents['document'] = parsedDocument
          }
        }
        const eventsMeta = acpOptionalMeta(events, label + '.nes.events')
        if (eventsMeta !== undefined) parsedEvents['_meta'] = eventsMeta
        parsedNes['events'] = parsedEvents
      }
    }
    if (Object.hasOwn(nes, 'context')) {
      if (nes['context'] === null) {
        parsedNes['context'] = null
      } else {
        const context = acpRecord(nes['context'], label + '.nes.context')
        acpExactKeys(context, [], ['recentFiles', 'relatedSnippets', 'editHistory', 'userActions', 'openFiles', 'diagnostics', '_meta'], label + '.nes.context')
        const parsedContext: AcpUnknownRecord = {}
        for (const key of ['relatedSnippets', 'openFiles', 'diagnostics'] as const) {
          const marker = acpNullableMarker(context, key, label + '.nes.context.' + key)
          if (marker !== undefined) parsedContext[key] = marker
        }
        for (const key of ['recentFiles', 'editHistory', 'userActions'] as const) {
          if (!Object.hasOwn(context, key)) continue
          if (context[key] === null) {
            parsedContext[key] = null
            continue
          }
          const bounded = acpRecord(context[key], label + '.nes.context.' + key)
          acpExactKeys(bounded, [], ['maxCount', '_meta'], label + '.nes.context.' + key)
          const boundedParsed: AcpUnknownRecord = {}
          if (Object.hasOwn(bounded, 'maxCount')) boundedParsed['maxCount'] = bounded['maxCount'] === null ? null : acpInteger(bounded['maxCount'], label + '.nes.context.' + key + '.maxCount')
          const boundedMeta = acpOptionalMeta(bounded, label + '.nes.context.' + key)
          if (boundedMeta !== undefined) boundedParsed['_meta'] = boundedMeta
          parsedContext[key] = boundedParsed
        }
        const contextMeta = acpOptionalMeta(context, label + '.nes.context')
        if (contextMeta !== undefined) parsedContext['_meta'] = contextMeta
        parsedNes['context'] = parsedContext
      }
    }
    const nesMeta = acpOptionalMeta(nes, label + '.nes')
    if (nesMeta !== undefined) parsedNes['_meta'] = nesMeta
    parsed['nes'] = parsedNes
    }
  }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed as InitializeResponse['agentCapabilities']
}

function parseAcpProcessIdentity(value: unknown, label: string): ProcessIdentity {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['pid', 'bootId', 'startedAt', 'executablePath', 'family', 'capturedAt'], ['generation'], label)
  if (input['family'] !== 'acp-agent') throw new Error(label + '.family must be acp-agent')
  return {
    pid: acpInteger(input['pid'], label + '.pid', true),
    bootId: acpString(input['bootId'], label + '.bootId', 4_096),
    startedAt: acpString(input['startedAt'], label + '.startedAt', 4_096),
    executablePath: acpString(input['executablePath'], label + '.executablePath', 4_096),
    family: 'acp-agent',
    capturedAt: acpString(input['capturedAt'], label + '.capturedAt', 64),
    ...(input['generation'] === undefined ? {} : { generation: acpString(input['generation'], label + '.generation', 4_096) })
  }
}

/** Strict ACP-v2 wire decoder. Old pid-only snapshots are deliberately rejected. */
function acpEnum<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(label + ' is invalid')
  return value as T
}

function acpArray<T>(value: unknown, label: string, maximum: number, parse: (value: unknown, index: number) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(label + ' must be a bounded array')
  return value.map(parse)
}

function acpOptionalString(input: AcpUnknownRecord, key: string, label: string, maximum: number): string | undefined {
  if (!Object.hasOwn(input, key)) return undefined
  return acpWireString(input[key], label, maximum)
}

function acpAnnotations(value: unknown, label: string): AcpUnknownRecord | null | undefined {
  if (value === undefined || value === null) return value as null | undefined
  const input = acpRecord(value, label)
  acpExactKeys(input, [], ['audience', 'lastModified', 'priority', '_meta'], label)
  const parsed: AcpUnknownRecord = {}
  if (Object.hasOwn(input, 'audience')) parsed['audience'] = acpArray(input['audience'], label + '.audience', 2, (entry, index) => acpEnum(entry, label + '.audience[' + index + ']', ['assistant', 'user'] as const))
  const lastModified = acpOptionalNullableString(input, 'lastModified', label + '.lastModified', 128)
  if (lastModified !== undefined) parsed['lastModified'] = lastModified
  const priority = acpOptionalNumber(input, 'priority', label + '.priority')
  if (priority !== undefined) parsed['priority'] = priority
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpDecorations(input: AcpUnknownRecord, label: string, parsed: AcpUnknownRecord): void {
  const annotations = acpAnnotations(input['annotations'], label + '.annotations')
  if (annotations !== undefined) parsed['annotations'] = annotations
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
}

function acpContentBlock(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  const type = acpEnum(input['type'], label + '.type', ['text', 'image', 'audio', 'resource_link', 'resource'] as const)
  const parsed: AcpUnknownRecord = { type }
  if (type === 'text') {
    acpExactKeys(input, ['type', 'text'], ['annotations', '_meta'], label)
    parsed['text'] = acpWireString(input['text'], label + '.text', 2 * 1024 * 1024)
    acpDecorations(input, label, parsed)
  } else if (type === 'image' || type === 'audio') {
    acpExactKeys(input, ['type', 'data', 'mimeType'], ['uri', 'annotations', '_meta'], label)
    parsed['data'] = acpWireString(input['data'], label + '.data', 8 * 1024 * 1024)
    parsed['mimeType'] = acpWireString(input['mimeType'], label + '.mimeType', 256)
    const uri = acpOptionalNullableString(input, 'uri', label + '.uri', 8_192)
    if (uri !== undefined) parsed['uri'] = uri
    acpDecorations(input, label, parsed)
  } else if (type === 'resource_link') {
    acpExactKeys(input, ['type', 'name', 'uri'], ['description', 'mimeType', 'size', 'title', 'annotations', '_meta'], label)
    parsed['name'] = acpWireString(input['name'], label + '.name', 4_096)
    parsed['uri'] = acpWireString(input['uri'], label + '.uri', 8_192)
    for (const key of ['description', 'mimeType', 'title'] as const) {
      const item = acpOptionalNullableString(input, key, label + '.' + key, key === 'mimeType' ? 256 : 4_096)
      if (item !== undefined) parsed[key] = item
    }
    const size = acpOptionalNumber(input, 'size', label + '.size')
    if (size !== undefined) parsed['size'] = size
    acpDecorations(input, label, parsed)
  } else {
    acpExactKeys(input, ['type', 'resource'], ['annotations', '_meta'], label)
    const resource = acpRecord(input['resource'], label + '.resource')
    acpExactKeys(resource, ['uri'], ['text', 'blob', 'mimeType', '_meta'], label + '.resource')
    const parsedResource: AcpUnknownRecord = { uri: acpWireString(resource['uri'], label + '.resource.uri', 8_192) }
    const text = acpOptionalString(resource, 'text', label + '.resource.text', 2 * 1024 * 1024)
    const blob = acpOptionalString(resource, 'blob', label + '.resource.blob', 8 * 1024 * 1024)
    if (text === undefined && blob === undefined) throw new Error(label + '.resource must contain text or blob')
    if (text !== undefined && blob !== undefined) throw new Error(label + '.resource cannot contain both text and blob')
    if (text !== undefined) parsedResource['text'] = text
    if (blob !== undefined) parsedResource['blob'] = blob
    const mimeType = acpOptionalNullableString(resource, 'mimeType', label + '.resource.mimeType', 256)
    if (mimeType !== undefined) parsedResource['mimeType'] = mimeType
    const resourceMeta = acpOptionalMeta(resource, label + '.resource')
    if (resourceMeta !== undefined) parsedResource['_meta'] = resourceMeta
    parsed['resource'] = parsedResource
    acpDecorations(input, label, parsed)
  }
  return parsed
}

function acpToolCallContent(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  const type = acpEnum(input['type'], label + '.type', ['content', 'diff', 'terminal'] as const)
  const parsed: AcpUnknownRecord = { type }
  if (type === 'content') {
    acpExactKeys(input, ['type', 'content'], ['_meta'], label)
    parsed['content'] = acpContentBlock(input['content'], label + '.content')
  } else if (type === 'diff') {
    acpExactKeys(input, ['type', 'path', 'newText'], ['oldText', '_meta'], label)
    parsed['path'] = acpWireString(input['path'], label + '.path', 8_192)
    parsed['newText'] = acpWireString(input['newText'], label + '.newText', 2 * 1024 * 1024)
    const oldText = acpOptionalNullableString(input, 'oldText', label + '.oldText', 2 * 1024 * 1024)
    if (oldText !== undefined) parsed['oldText'] = oldText
  } else {
    acpExactKeys(input, ['type', 'terminalId'], ['_meta'], label)
    parsed['terminalId'] = acpWireString(input['terminalId'], label + '.terminalId', 256)
  }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpToolCallLocation(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['path'], ['line', '_meta'], label)
  const parsed: AcpUnknownRecord = { path: acpWireString(input['path'], label + '.path', 8_192) }
  const line = acpOptionalNumber(input, 'line', label + '.line')
  if (line !== undefined) {
    if (line === null) parsed['line'] = null
    else if (!Number.isSafeInteger(line) || line < 1) throw new Error(label + '.line must be a positive integer or null')
    else parsed['line'] = line
  }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpToolCallFields(value: unknown, label: string, titleRequired: boolean): AcpUnknownRecord {
  const input = acpRecord(value, label)
  const required = titleRequired ? ['toolCallId', 'title'] : ['toolCallId']
  acpExactKeys(input, required, ['kind', 'status', 'title', 'name', 'content', 'locations', 'rawInput', 'rawOutput', '_meta'], label)
  const parsed: AcpUnknownRecord = { toolCallId: acpWireString(input['toolCallId'], label + '.toolCallId', 256) }
  if (Object.hasOwn(input, 'title')) parsed['title'] = input['title'] === null && !titleRequired ? null : acpWireString(input['title'], label + '.title', 4_096)
  if (Object.hasOwn(input, 'kind')) parsed['kind'] = input['kind'] === null && !titleRequired ? null : acpEnum(input['kind'], label + '.kind', ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const)
  if (Object.hasOwn(input, 'status')) parsed['status'] = input['status'] === null && !titleRequired ? null : acpEnum(input['status'], label + '.status', ['pending', 'in_progress', 'completed', 'failed'] as const)
  const name = acpOptionalNullableString(input, 'name', label + '.name', 4_096)
  if (name !== undefined) parsed['name'] = name
  if (Object.hasOwn(input, 'content')) parsed['content'] = input['content'] === null && !titleRequired ? null : acpArray(input['content'], label + '.content', 4_096, (entry, index) => acpToolCallContent(entry, label + '.content[' + index + ']'))
  if (Object.hasOwn(input, 'locations')) parsed['locations'] = input['locations'] === null && !titleRequired ? null : acpArray(input['locations'], label + '.locations', 4_096, (entry, index) => acpToolCallLocation(entry, label + '.locations[' + index + ']'))
  if (Object.hasOwn(input, 'rawInput')) parsed['rawInput'] = acpJsonValue(input['rawInput'], label + '.rawInput')
  if (Object.hasOwn(input, 'rawOutput')) parsed['rawOutput'] = acpJsonValue(input['rawOutput'], label + '.rawOutput')
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpPermissionOption(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['optionId', 'name', 'kind'], ['_meta'], label)
  const parsed: AcpUnknownRecord = {
    optionId: acpWireString(input['optionId'], label + '.optionId', 256),
    name: acpWireString(input['name'], label + '.name', 4_096),
    kind: acpEnum(input['kind'], label + '.kind', ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const)
  }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpPermissionRequest(value: unknown, label: string): RequestPermissionRequest {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['sessionId', 'toolCall', 'options'], ['_meta'], label)
  const parsed: AcpUnknownRecord = {
    sessionId: acpWireString(input['sessionId'], label + '.sessionId', 256),
    toolCall: acpToolCallFields(input['toolCall'], label + '.toolCall', false),
    options: acpArray(input['options'], label + '.options', 64, (entry, index) => acpPermissionOption(entry, label + '.options[' + index + ']'))
  }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed as RequestPermissionRequest
}

function acpUsage(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['totalTokens', 'inputTokens', 'outputTokens'], ['thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens', '_meta'], label)
  const parsed: AcpUnknownRecord = {}
  for (const key of ['totalTokens', 'inputTokens', 'outputTokens'] as const) {
    const number = input[key]
    if (!Number.isSafeInteger(number) || (number as number) < 0) throw new Error(label + '.' + key + ' must be a non-negative safe integer')
    parsed[key] = number
  }
  for (const key of ['thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens'] as const) {
    if (!Object.hasOwn(input, key)) continue
    const number = input[key]
    if (number !== null && (!Number.isSafeInteger(number) || (number as number) < 0)) throw new Error(label + '.' + key + ' must be a non-negative safe integer or null')
    parsed[key] = number
  }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpPromptResponse(value: unknown, label: string): PromptResponse {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['stopReason'], ['usage', '_meta'], label)
  const parsed: AcpUnknownRecord = { stopReason: acpEnum(input['stopReason'], label + '.stopReason', ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const) }
  if (Object.hasOwn(input, 'usage')) parsed['usage'] = input['usage'] === null ? null : acpUsage(input['usage'], label + '.usage')
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed as PromptResponse
}

function acpPlanEntry(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['content', 'priority', 'status'], ['_meta'], label)
  const parsed: AcpUnknownRecord = {
    content: acpWireString(input['content'], label + '.content', 8_192),
    priority: acpEnum(input['priority'], label + '.priority', ['high', 'medium', 'low'] as const),
    status: acpEnum(input['status'], label + '.status', ['pending', 'in_progress', 'completed'] as const)
  }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpPlan(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['entries'], ['_meta'], label)
  const parsed: AcpUnknownRecord = { entries: acpArray(input['entries'], label + '.entries', 4_096, (entry, index) => acpPlanEntry(entry, label + '.entries[' + index + ']')) }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpPlanUpdate(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['plan'], ['_meta'], label)
  const plan = acpRecord(input['plan'], label + '.plan')
  const type = acpEnum(plan['type'], label + '.plan.type', ['items', 'file', 'markdown'] as const)
  const parsedPlan: AcpUnknownRecord = { type, planId: acpWireString(plan['planId'], label + '.plan.planId', 256) }
  if (type === 'items') {
    acpExactKeys(plan, ['type', 'planId', 'entries'], ['_meta'], label + '.plan')
    parsedPlan['entries'] = acpArray(plan['entries'], label + '.plan.entries', 4_096, (entry, index) => acpPlanEntry(entry, label + '.plan.entries[' + index + ']'))
  } else if (type === 'file') {
    acpExactKeys(plan, ['type', 'planId', 'uri'], ['_meta'], label + '.plan')
    parsedPlan['uri'] = acpWireString(plan['uri'], label + '.plan.uri', 8_192)
  } else {
    acpExactKeys(plan, ['type', 'planId', 'content'], ['_meta'], label + '.plan')
    parsedPlan['content'] = acpWireString(plan['content'], label + '.plan.content', 2 * 1024 * 1024)
  }
  const planMeta = acpOptionalMeta(plan, label + '.plan')
  if (planMeta !== undefined) parsedPlan['_meta'] = planMeta
  const parsed: AcpUnknownRecord = { plan: parsedPlan }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpAvailableCommand(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['name', 'description'], ['input', '_meta'], label)
  const parsed: AcpUnknownRecord = {
    name: acpWireString(input['name'], label + '.name', 256),
    description: acpWireString(input['description'], label + '.description', 8_192)
  }
  if (Object.hasOwn(input, 'input')) {
    if (input['input'] === null) parsed['input'] = null
    else {
      const commandInput = acpRecord(input['input'], label + '.input')
      acpExactKeys(commandInput, ['hint'], ['_meta'], label + '.input')
      const parsedInput: AcpUnknownRecord = { hint: acpWireString(commandInput['hint'], label + '.input.hint', 4_096) }
      const inputMeta = acpOptionalMeta(commandInput, label + '.input')
      if (inputMeta !== undefined) parsedInput['_meta'] = inputMeta
      parsed['input'] = parsedInput
    }
  }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpConfigOption(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  const type = acpEnum(input['type'], label + '.type', ['select', 'boolean'] as const)
  const required = type === 'select' ? ['type', 'id', 'name', 'currentValue', 'options'] : ['type', 'id', 'name', 'currentValue']
  acpExactKeys(input, required, ['description', 'category', '_meta'], label)
  const parsed: AcpUnknownRecord = {
    type,
    id: acpWireString(input['id'], label + '.id', 256),
    name: acpWireString(input['name'], label + '.name', 4_096)
  }
  const description = acpOptionalNullableString(input, 'description', label + '.description', 8_192)
  if (description !== undefined) parsed['description'] = description
  const category = acpOptionalNullableString(input, 'category', label + '.category', 128)
  if (category !== undefined) parsed['category'] = category
  if (type === 'boolean') {
    if (typeof input['currentValue'] !== 'boolean') throw new Error(label + '.currentValue must be a boolean')
    parsed['currentValue'] = input['currentValue']
  } else {
    parsed['currentValue'] = acpWireString(input['currentValue'], label + '.currentValue', 256)
    const options = input['options']
    if (!Array.isArray(options) || options.length > 4096) throw new Error(label + '.options must be a bounded array')
    parsed['options'] = options.map((entry, index) => {
      const option = acpRecord(entry, label + '.options[' + index + ']')
      if (Object.hasOwn(option, 'group')) {
        acpExactKeys(option, ['group', 'name', 'options'], ['_meta'], label + '.options[' + index + ']')
        const group: AcpUnknownRecord = { group: acpWireString(option['group'], label + '.options[' + index + '].group', 256), name: acpWireString(option['name'], label + '.options[' + index + '].name', 4_096) }
        group['options'] = acpArray(option['options'], label + '.options[' + index + '].options', 4096, (item, itemIndex) => acpConfigSelectOption(acpRecord(item, label + '.options[' + index + '].options[' + itemIndex + ']'), label + '.options[' + index + '].options[' + itemIndex + ']'))
        const groupMeta = acpOptionalMeta(option, label + '.options[' + index + ']')
        if (groupMeta !== undefined) group['_meta'] = groupMeta
        return group
      }
      return acpConfigSelectOption(option, label + '.options[' + index + ']')
    })
  }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpConfigSelectOption(input: AcpUnknownRecord, label: string): AcpUnknownRecord {
  acpExactKeys(input, ['value', 'name'], ['description', '_meta'], label)
  const parsed: AcpUnknownRecord = { value: acpWireString(input['value'], label + '.value', 256), name: acpWireString(input['name'], label + '.name', 4_096) }
  const description = acpOptionalNullableString(input, 'description', label + '.description', 8_192)
  if (description !== undefined) parsed['description'] = description
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpSessionUpdate(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  const kind = acpEnum(input['sessionUpdate'], label + '.sessionUpdate', ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'plan_update', 'plan_removed', 'available_commands_update', 'current_mode_update', 'config_option_update', 'session_info_update', 'usage_update', 'compaction_update', 'compaction_summary_chunk'] as const)
  if (kind === 'user_message_chunk' || kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    acpExactKeys(input, ['sessionUpdate', 'content'], ['messageId', '_meta'], label)
    const parsed: AcpUnknownRecord = { sessionUpdate: kind, content: acpContentBlock(input['content'], label + '.content') }
    const messageId = acpOptionalNullableString(input, 'messageId', label + '.messageId', 256)
    if (messageId !== undefined) parsed['messageId'] = messageId
    const meta = acpOptionalMeta(input, label)
    if (meta !== undefined) parsed['_meta'] = meta
    return parsed
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const fields = { ...input }
    delete fields['sessionUpdate']
    return { sessionUpdate: kind, ...acpToolCallFields(fields, label, kind === 'tool_call') }
  }
  if (kind === 'plan') {
    acpExactKeys(input, ['sessionUpdate', 'entries'], ['_meta'], label)
    const plan = { ...input }
    delete plan['sessionUpdate']
    return { sessionUpdate: kind, ...acpPlan(plan, label) }
  }
  if (kind === 'plan_update') {
    const planUpdate = { ...input }
    delete planUpdate['sessionUpdate']
    return { sessionUpdate: kind, ...acpPlanUpdate(planUpdate, label) }
  }
  if (kind === 'plan_removed') {
    acpExactKeys(input, ['sessionUpdate', 'planId'], ['_meta'], label)
    const parsed: AcpUnknownRecord = { sessionUpdate: kind, planId: acpWireString(input['planId'], label + '.planId', 256) }
    const meta = acpOptionalMeta(input, label)
    if (meta !== undefined) parsed['_meta'] = meta
    return parsed
  }
  if (kind === 'available_commands_update') {
    acpExactKeys(input, ['sessionUpdate', 'availableCommands'], ['_meta'], label)
    const parsed: AcpUnknownRecord = { sessionUpdate: kind, availableCommands: acpArray(input['availableCommands'], label + '.availableCommands', 4096, (entry, index) => acpAvailableCommand(entry, label + '.availableCommands[' + index + ']')) }
    const meta = acpOptionalMeta(input, label)
    if (meta !== undefined) parsed['_meta'] = meta
    return parsed
  }
  if (kind === 'current_mode_update') {
    acpExactKeys(input, ['sessionUpdate', 'currentModeId'], ['_meta'], label)
    const parsed: AcpUnknownRecord = { sessionUpdate: kind, currentModeId: acpWireString(input['currentModeId'], label + '.currentModeId', 256) }
    const meta = acpOptionalMeta(input, label)
    if (meta !== undefined) parsed['_meta'] = meta
    return parsed
  }
  if (kind === 'config_option_update') {
    acpExactKeys(input, ['sessionUpdate', 'configOptions'], ['_meta'], label)
    const parsed: AcpUnknownRecord = { sessionUpdate: kind, configOptions: acpArray(input['configOptions'], label + '.configOptions', 4096, (entry, index) => acpConfigOption(entry, label + '.configOptions[' + index + ']')) }
    const meta = acpOptionalMeta(input, label)
    if (meta !== undefined) parsed['_meta'] = meta
    return parsed
  }
  if (kind === 'session_info_update') {
    acpExactKeys(input, ['sessionUpdate'], ['title', 'updatedAt', '_meta'], label)
    const parsed: AcpUnknownRecord = { sessionUpdate: kind }
    const title = acpOptionalNullableString(input, 'title', label + '.title', 8_192)
    if (title !== undefined) parsed['title'] = title
    const updatedAt = acpOptionalNullableString(input, 'updatedAt', label + '.updatedAt', 128)
    if (updatedAt !== undefined) parsed['updatedAt'] = updatedAt
    const meta = acpOptionalMeta(input, label)
    if (meta !== undefined) parsed['_meta'] = meta
    return parsed
  }
  if (kind === 'usage_update') {
    acpExactKeys(input, ['sessionUpdate', 'used', 'size'], ['cost', '_meta'], label)
    const parsed: AcpUnknownRecord = { sessionUpdate: kind, used: acpInteger(input['used'], label + '.used'), size: acpInteger(input['size'], label + '.size') }
    if (Object.hasOwn(input, 'cost')) {
      if (input['cost'] === null) parsed['cost'] = null
      else {
        const cost = acpRecord(input['cost'], label + '.cost')
        acpExactKeys(cost, ['amount', 'currency'], ['_meta'], label + '.cost')
        const parsedCost: AcpUnknownRecord = { amount: acpFiniteNumber(cost['amount'], label + '.cost.amount'), currency: acpWireString(cost['currency'], label + '.cost.currency', 16) }
        const costMeta = acpOptionalMeta(cost, label + '.cost')
        if (costMeta !== undefined) parsedCost['_meta'] = costMeta
        parsed['cost'] = parsedCost
      }
    }
    const meta = acpOptionalMeta(input, label)
    if (meta !== undefined) parsed['_meta'] = meta
    return parsed
  }
  if (kind === 'compaction_update') {
    acpExactKeys(input, ['sessionUpdate', 'compactionId', 'status'], ['summary', 'error', '_meta'], label)
    const parsed: AcpUnknownRecord = { sessionUpdate: kind, compactionId: acpWireString(input['compactionId'], label + '.compactionId', 256), status: acpWireString(input['status'], label + '.status', 128) }
    if (Object.hasOwn(input, 'summary')) parsed['summary'] = input['summary'] === null ? null : acpArray(input['summary'], label + '.summary', 4096, (entry, index) => acpContentBlock(entry, label + '.summary[' + index + ']'))
    const error = acpOptionalNullableString(input, 'error', label + '.error', 8_192)
    if (error !== undefined) parsed['error'] = error
    const meta = acpOptionalMeta(input, label)
    if (meta !== undefined) parsed['_meta'] = meta
    return parsed
  }
  acpExactKeys(input, ['sessionUpdate', 'compactionId', 'content'], ['_meta'], label)
  const parsed: AcpUnknownRecord = { sessionUpdate: kind, compactionId: acpWireString(input['compactionId'], label + '.compactionId', 256), content: acpContentBlock(input['content'], label + '.content') }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed
}

function acpFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(label + ' must be a finite number')
  return value
}

function acpSessionNotification(value: unknown, label: string): SessionNotification {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['sessionId', 'update'], ['_meta'], label)
  const parsed: AcpUnknownRecord = { sessionId: acpWireString(input['sessionId'], label + '.sessionId', 256), update: acpSessionUpdate(input['update'], label + '.update') }
  const meta = acpOptionalMeta(input, label)
  if (meta !== undefined) parsed['_meta'] = meta
  return parsed as SessionNotification
}

function decodeAcpAgentSnapshot(value: unknown, label = 'invalid ACP snapshot'): AcpAgentSnapshot {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['mode', 'id', 'workspacePath', 'protocolSessionId', 'processIdentity', 'state', 'capabilities', 'permissions'], ['detail'], label)
  if (input['mode'] !== 'acp') throw new Error(label + '.mode must be acp')
  const state = acpEnum(input['state'], label + '.state', ['starting', 'ready', 'working', 'permission', 'stopping', 'exited', 'uncertain'] as const)
  const processIdentity = input['processIdentity'] === null ? null : parseAcpProcessIdentity(input['processIdentity'], label + '.processIdentity')
  if (processIdentity === null && ['ready', 'working', 'permission', 'stopping'].includes(state)) throw new Error(label + ' cannot be ' + state + ' without processIdentity')
  const protocolSessionId = input['protocolSessionId'] === null ? null : acpWireString(input['protocolSessionId'], label + '.protocolSessionId', 4_096)
  const permissions = acpArray(input['permissions'], label + '.permissions', 8, (entry, index) => {
    const permissionLabel = label + '.permissions[' + index + ']'
    const permission = acpRecord(entry, permissionLabel)
    acpExactKeys(permission, ['id', 'request'], [], permissionLabel)
    return { id: acpWireString(permission['id'], permissionLabel + '.id', 128), request: acpPermissionRequest(permission['request'], permissionLabel + '.request') }
  })
  return {
    mode: 'acp',
    id: acpWireString(input['id'], label + '.id', 128),
    workspacePath: acpWireString(input['workspacePath'], label + '.workspacePath', 4_096),
    protocolSessionId,
    processIdentity,
    state,
    capabilities: acpCapabilities(input['capabilities'], label + '.capabilities'),
    permissions,
    ...(input['detail'] === undefined ? {} : { detail: acpWireString(input['detail'], label + '.detail', 2_048) })
  }
}

function decodeAcpPromptRecord(value: unknown, label = 'invalid ACP prompt record'): AcpPromptRecord {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['requestId', 'state'], ['result', 'error'], label)
  const state = acpEnum(input['state'], label + '.state', ['accepted', 'completed', 'uncertain'] as const)
  const hasResult = Object.hasOwn(input, 'result')
  const hasError = Object.hasOwn(input, 'error')
  if (state === 'accepted' && (hasResult || hasError)) throw new Error(label + ' accepted state cannot contain result or error')
  if (state === 'completed' && (!hasResult || hasError)) throw new Error(label + ' completed state requires result and cannot contain error')
  if (state === 'uncertain' && (hasResult || !hasError)) throw new Error(label + ' uncertain state requires error and cannot contain result')
  return {
    requestId: acpWireString(input['requestId'], label + '.requestId', 128),
    state,
    ...(hasResult ? { result: acpPromptResponse(input['result'], label + '.result') } : {}),
    ...(hasError ? { error: acpWireString(input['error'], label + '.error', 2_048) } : {})
  }
}

function decodeAcpObservation(value: unknown): AcpObservation {
  const label = 'invalid ACP observation'
  const input = acpRecord(value, label)
  acpExactKeys(input, ['snapshot', 'sequence', 'truncated', 'updates', 'requests'], [], label)
  if (typeof input['truncated'] !== 'boolean') throw new Error(label + '.truncated must be boolean')
  const updates = acpArray(input['updates'], label + '.updates', 2_048, (value, index) => {
    const updateLabel = label + '.updates[' + index + ']'
    const update = acpRecord(value, updateLabel)
    acpExactKeys(update, ['sequence', 'notification'], [], updateLabel)
    return { sequence: acpInteger(update['sequence'], updateLabel + '.sequence'), notification: acpSessionNotification(update['notification'], updateLabel + '.notification') }
  })
  return {
    snapshot: decodeAcpAgentSnapshot(input['snapshot']),
    sequence: acpInteger(input['sequence'], label + '.sequence'),
    truncated: input['truncated'],
    updates,
    requests: acpArray(input['requests'], label + '.requests', 4_096, (request, index) => decodeAcpPromptRecord(request, label + '.requests[' + index + ']'))
  }
}

function acpHook(value: unknown, label: string): AcpUnknownRecord {
  const input = acpRecord(value, label)
  const support = acpEnum(input['support'], label + '.support', ['native', 'unavailable'] as const)
  const required = support === 'native' ? ['support', 'adapter', 'events', 'documentationUrl'] : ['support', 'events', 'reason']
  acpExactKeys(input, required, ['connected', 'lastEventAt'], label)
  const parsed: AcpUnknownRecord = { support, events: acpArray(input['events'], label + '.events', 5, (event, index) => acpEnum(event, label + '.events[' + index + ']', ['working', 'waiting', 'permission', 'completed', 'failed'] as const)) }
  if (support === 'native') {
    parsed['adapter'] = acpEnum(input['adapter'], label + '.adapter', ['codex-hooks', 'claude-hooks', 'opencode-plugin'] as const)
    parsed['documentationUrl'] = acpWireString(input['documentationUrl'], label + '.documentationUrl', 8_192)
  } else parsed['reason'] = acpWireString(input['reason'], label + '.reason', 8_192)
  const connected = acpOptionalBoolean(input, 'connected', label + '.connected')
  if (connected !== undefined) parsed['connected'] = connected
  const lastEventAt = acpOptionalString(input, 'lastEventAt', label + '.lastEventAt', 128)
  if (lastEventAt !== undefined) parsed['lastEventAt'] = lastEventAt
  return parsed
}

/**
 * The provider identity a run was admitted for. It is identity and display
 * metadata only: a renderer-safe `RunningAgent` never carries environment
 * credentials, credential refs, or binding generations, and this decoder
 * refuses any record that tries to add one.
 */
function decodeAgentRunProviderIdentity(value: unknown, label: string): AgentRunProviderIdentity {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['driverId', 'providerInstanceId', 'providerInstanceRevision', 'accountId', 'providerAccountRevision'], [], label)
  const accountId = input['accountId']
  if (accountId !== null && typeof accountId !== 'string') throw new Error(label + '.accountId must be null or a string')
  const accountRevision = input['providerAccountRevision']
  if (accountRevision !== null && (typeof accountRevision !== 'number' || !Number.isSafeInteger(accountRevision) || accountRevision < 1)) throw new Error(label + '.providerAccountRevision must be null or a positive integer')
  const instanceRevision = input['providerInstanceRevision']
  if (typeof instanceRevision !== 'number' || !Number.isSafeInteger(instanceRevision) || instanceRevision < 1) throw new Error(label + '.providerInstanceRevision must be a positive integer')
  if ((accountId === null) !== (accountRevision === null)) throw new Error(label + ' must name an account and its revision together')
  return {
    driverId: acpWireString(input['driverId'], label + '.driverId', 128),
    providerInstanceId: acpWireString(input['providerInstanceId'], label + '.providerInstanceId', 128),
    providerInstanceRevision: instanceRevision,
    accountId: accountId === null ? null : acpWireString(accountId, label + '.accountId', 128),
    providerAccountRevision: accountRevision
  }
}

function acpRunningAgent(value: unknown, label: string): RunningAgent {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['id', 'sessionId', 'workspacePath', 'command', 'startedAt', 'updatedAt', 'liveness', 'activity', 'hook'], ['task', 'launch', 'provider', 'detail', 'exitCode', 'stopRequestedAt'], label)
  const parsed: AcpUnknownRecord = {
    id: acpWireString(input['id'], label + '.id', 128),
    sessionId: acpWireString(input['sessionId'], label + '.sessionId', 256),
    workspacePath: acpWireString(input['workspacePath'], label + '.workspacePath', 4_096),
    command: acpWireString(input['command'], label + '.command', 8_192),
    startedAt: acpWireString(input['startedAt'], label + '.startedAt', 128),
    updatedAt: acpWireString(input['updatedAt'], label + '.updatedAt', 128),
    liveness: acpEnum(input['liveness'], label + '.liveness', ['live', 'unverifiable', 'exited'] as const),
    activity: acpEnum(input['activity'], label + '.activity', ['starting', 'working', 'waiting', 'permission', 'stopping', 'completed', 'failed'] as const),
    hook: acpHook(input['hook'], label + '.hook')
  }
  if (Object.hasOwn(input, 'task')) parsed['task'] = parseAgentTaskIntent(input['task'])
  if (Object.hasOwn(input, 'launch')) parsed['launch'] = parseAgentExecutable(input['launch'])
  if (Object.hasOwn(input, 'provider')) parsed['provider'] = decodeAgentRunProviderIdentity(input['provider'], label + '.provider')
  const detail = acpOptionalString(input, 'detail', label + '.detail', 2_048)
  if (detail !== undefined) parsed['detail'] = detail
  const exitCode = acpOptionalNumber(input, 'exitCode', label + '.exitCode')
  if (exitCode !== undefined) parsed['exitCode'] = exitCode
  const stopRequestedAt = acpOptionalString(input, 'stopRequestedAt', label + '.stopRequestedAt', 128)
  if (stopRequestedAt !== undefined) parsed['stopRequestedAt'] = stopRequestedAt
  return parsed as RunningAgent
}

function acpTerminalSession(value: unknown, label: string): TerminalSession {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['id', 'worktreePath', 'title', 'createdAt', 'exited'], [], label)
  if (typeof input['exited'] !== 'boolean') throw new Error(label + '.exited must be a boolean')
  return {
    id: acpWireString(input['id'], label + '.id', 256),
    worktreePath: acpWireString(input['worktreePath'], label + '.worktreePath', 4_096),
    title: acpWireString(input['title'], label + '.title', 8_192),
    createdAt: acpWireString(input['createdAt'], label + '.createdAt', 128),
    exited: input['exited']
  }
}

function acpNativeStartResult(value: unknown, label: string): AgentStartResult {
  const input = acpRecord(value, label)
  acpExactKeys(input, ['run', 'session'], [], label)
  return { run: acpRunningAgent(input['run'], label + '.run'), session: acpTerminalSession(input['session'], label + '.session') }
}

export { decodeAcpAgentSnapshot as parseAcpAgentSnapshot, decodeAcpPromptRecord as parseAcpPromptRecord, decodeAcpObservation as parseAcpObservation }

export function parseAgentModeSwitchReceipt(value: unknown): AgentModeSwitchReceipt {
  const label = 'invalid agent mode switch receipt'
  const input = acpRecord(value, label)
  acpExactKeys(input, ['requestId', 'workspacePath', 'sessionId', 'target', 'state', 'continuity'], ['native', 'acp', 'error'], label)
  const target = acpEnum(input['target'], label + '.target', ['native', 'acp'] as const)
  const state = acpEnum(input['state'], label + '.state', ['accepted', 'completed', 'uncertain'] as const)
  const continuity = acpEnum(input['continuity'], label + '.continuity', ['same-history', 'new-session'] as const)
  if ((target === 'native' && continuity !== 'same-history') || (target === 'acp' && continuity !== 'new-session')) throw new Error(label + '.continuity contradicts target')
  const hasNative = Object.hasOwn(input, 'native')
  const hasAcp = Object.hasOwn(input, 'acp')
  const hasError = Object.hasOwn(input, 'error')
  if (state === 'accepted' && (hasNative || hasAcp || hasError)) throw new Error(label + ' accepted state cannot contain outcome payload')
  if (state === 'completed' && (hasError || (target === 'native' ? !hasNative || hasAcp : !hasAcp || hasNative))) throw new Error(label + ' completed state requires exactly the ' + target + ' target payload')
  if (state === 'uncertain' && (!hasError || hasNative || hasAcp)) throw new Error(label + ' uncertain state requires error and cannot contain a target payload')
  return {
    requestId: acpWireString(input['requestId'], label + '.requestId', 128),
    workspacePath: acpWireString(input['workspacePath'], label + '.workspacePath', 4_096),
    sessionId: acpWireString(input['sessionId'], label + '.sessionId', 256),
    target,
    state,
    continuity,
    ...(hasNative ? { native: acpNativeStartResult(input['native'], label + '.native') } : {}),
    ...(hasAcp ? { acp: decodeAcpAgentSnapshot(input['acp']) } : {}),
    ...(hasError ? { error: acpWireString(input['error'], label + '.error', 2_048) } : {})
  }
}

export const AGENT_PROVIDER_IDS = [
  'codex',
  'claude',
  'pi',
  'opencode',
  'cursor-agent',
  'qwen-code',
  'goose',
  'omp',
  'hermes',
  'kimi',
  'deepseek-harness'
] as const

export const AGENT_HOOK_CAPABILITY = 'agent-hook-events-v1'

export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number]
export type AgentLiveness = 'live' | 'unverifiable' | 'exited'
export type AgentActivity =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'permission'
  | 'stopping'
  | 'completed'
  | 'failed'
export type AgentHookEventKind = 'working' | 'waiting' | 'permission' | 'completed' | 'failed'
export type AgentHookAdapter = 'codex-hooks' | 'claude-hooks' | 'opencode-plugin'

export type AgentHookSupport =
  | {
      support: 'native'
      adapter: AgentHookAdapter
      events: AgentHookEventKind[]
      documentationUrl: string
    }
  | {
      support: 'unavailable'
      events: AgentHookEventKind[]
      reason: string
    }

export type AgentSkillConsumer =
  | {
      supported: true
      /** Workspace-relative native discovery root. */
      root: string
      discovery: 'native'
    }
  | {
      supported: false
      reason: string
    }

/**
 * Declarative mirror of configureAgentMemory's wiring set (R3).
 * direct = native MCP config or launch args; acp = memory arrives via the ACP
 * session launcher; none = no automatic memory wiring exists.
 */
export type AgentMemorySupport = 'direct' | 'acp' | 'none'

export type AgentPreset = {
  id: AgentProviderId
  name: string
  command: string
  available: boolean
  executablePath?: string
  readiness?: { installed: boolean; launchable: 'unverified' | 'unavailable'; authenticated: 'unknown'; memoryConnected: false }
  hookSupport: AgentHookSupport
  skillConsumer: AgentSkillConsumer
  memorySupport: AgentMemorySupport
}

export type RunningAgent = {
  task?: AgentTaskIntent
  launch?: AgentExecutable
  id: string
  sessionId: string
  workspacePath: string
  command: string
  /**
   * The exact provider identity this run was admitted for. Present only for a
   * provider-backed launch; it is identity and display metadata only. A
   * `RunningAgent` never carries environment credentials, credential refs, or
   * binding generations, so it stays renderer-safe.
   */
  provider?: AgentRunProviderIdentity
  startedAt: string
  updatedAt: string
  liveness: AgentLiveness
  activity: AgentActivity
  detail?: string
  hook: AgentHookSupport & {
    connected: boolean
    lastEventAt?: string
  }
  exitCode?: number
  stopRequestedAt?: string
}

/** The renderer-safe provider identity of one admitted agent run. */
export type AgentRunProviderIdentity = {
  driverId: string
  providerInstanceId: string
  providerInstanceRevision: number
  accountId: string | null
  providerAccountRevision: number | null
}

export type AgentStartResult = {
  run: RunningAgent
  session: TerminalSession
}


export const AGENT_HOOK_DETAIL_MAX = 240
export const AGENT_HOOK_INPUT_MAX_BYTES = 64 * 1024

export type AgentHookMessage = {
  kind: AgentHookEventKind
  detail?: string
}

export type AgentProviderDefinition = {
  id: AgentProviderId
  name: string
  command: string
  hookSupport: AgentHookSupport
  skillConsumer: AgentSkillConsumer
  memorySupport: AgentMemorySupport
}

const UNSUPPORTED_HOOK_REASON = 'No documented per-run hook adapter is registered for this CLI.'
const UNSUPPORTED_SKILL_REASON = 'No documented workspace skill discovery root is registered for this CLI.'

export const AGENT_PROVIDER_DEFINITIONS: readonly AgentProviderDefinition[] = [
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    hookSupport: {
      support: 'native',
      adapter: 'codex-hooks',
      events: ['working', 'waiting', 'permission', 'completed'],
      documentationUrl: 'https://developers.openai.com/codex/hooks'
    },
    skillConsumer: { supported: true, root: '.agents/skills', discovery: 'native' },
    memorySupport: 'direct'
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    hookSupport: {
      support: 'native',
      adapter: 'claude-hooks',
      events: ['working', 'waiting', 'permission', 'completed', 'failed'],
      documentationUrl: 'https://code.claude.com/docs/en/hooks'
    },
    skillConsumer: { supported: true, root: '.claude/skills', discovery: 'native' },
    memorySupport: 'direct'
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON },
    memorySupport: 'none'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    hookSupport: {
      support: 'native',
      adapter: 'opencode-plugin',
      events: ['working', 'waiting', 'permission', 'completed', 'failed'],
      documentationUrl: 'https://opencode.ai/docs/plugins/'
    },
    skillConsumer: { supported: true, root: '.opencode/skills', discovery: 'native' },
    memorySupport: 'acp'
  },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    command: 'cursor-agent',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON },
    memorySupport: 'none'
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    command: 'qwen-code',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON },
    memorySupport: 'none'
  },
  {
    id: 'goose',
    name: 'Goose',
    command: 'goose',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON },
    memorySupport: 'none'
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    command: 'omp',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON },
    memorySupport: 'direct'
  },
  {
    id: 'hermes', name: 'Hermes', command: 'hermes',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON },
    memorySupport: 'direct'
  },
  {
    id: 'kimi', name: 'Kimi CLI', command: 'kimi',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON },
    memorySupport: 'direct'
  },
  {
    id: 'deepseek-harness', name: 'DeepSeek Harness', command: 'dsh',
    hookSupport: { support: 'unavailable', events: [], reason: UNSUPPORTED_HOOK_REASON },
    skillConsumer: { supported: false, reason: UNSUPPORTED_SKILL_REASON },
    memorySupport: 'direct'
  },

]

const AGENT_HOOK_KINDS: Record<AgentHookEventKind, true> = {
  working: true,
  waiting: true,
  permission: true,
  completed: true,
  failed: true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAgentHookKind(value: unknown): value is AgentHookEventKind {
  return typeof value === 'string' && Object.hasOwn(AGENT_HOOK_KINDS, value)
}

export function normalizeAgentHookMessage(value: unknown): AgentHookMessage | null {
  if (!isRecord(value) || !isAgentHookKind(value['kind'])) return null
  if (value['detail'] !== undefined && typeof value['detail'] !== 'string') return null
  const detail = typeof value['detail'] === 'string'
    ? value['detail'].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, AGENT_HOOK_DETAIL_MAX)
    : undefined
  return detail ? { kind: value['kind'], detail } : { kind: value['kind'] }
}

export function unavailableAgentHooks(reason: string): AgentHookSupport {
  return { support: 'unavailable', events: [], reason }
}

/** Explicit argv bypasses shell parsing; legacy command strings remain a separate path. */
export type AgentExecutable = { executable: string; args: string[]; hermesHome?: string; dshHome?: string }
export function parseAgentExecutable(value: unknown): AgentExecutable {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'executable' && key !== 'args' && key !== 'hermesHome' && key !== 'dshHome') || typeof value.executable !== 'string' || !value.executable.trim() || value.executable.includes('\0')) throw new Error('Invalid agent executable')
  const args = value.args ?? []
  if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid agent arguments')
  if (new TextEncoder().encode(JSON.stringify([value.executable, args])).length > 16 * 1024) throw new Error('Agent executable and arguments exceed limit')
  for (const [key, provider, label] of [['hermesHome', 'hermes', 'Hermes'], ['dshHome', 'deepseek-harness', 'DSH']] as const) {
    const home = value[key]
    if (home !== undefined && (
      agentProviderForExecutable(value.executable)?.id !== provider ||
      typeof home !== 'string' ||
      home.length > 4096 ||
      !/^(?:\/|[A-Za-z]:[\\/])/.test(home) ||
      /[\x00-\x1f\x7f]/.test(home) ||
      home.split(/[\\/]/).includes('..')
    )) throw new Error(`Invalid ${label} profile home`)
  }
  return {
    executable: value.executable,
    args: [...args],
    ...(typeof value.hermesHome === 'string' ? { hermesHome: value.hermesHome } : {}),
    ...(typeof value.dshHome === 'string' ? { dshHome: value.dshHome } : {})
  }
}

export function agentProviderForExecutable(path: string): AgentProviderDefinition | undefined {
  const name = path.split(/[\\/]/).at(-1)?.replace(/\.(?:cmd|bat|exe)$/i, '').toLowerCase()
  return AGENT_PROVIDER_DEFINITIONS.find(provider => provider.command === name)
}

/** Inherited per-run credential; never include in public RunningAgent records. */
export type AgentSessionCredential = { runId: string; sessionId: string; token: string }

/** Advisory session metadata, never a filesystem lock or a second task ledger. */
export type AgentTaskIntent = { intent: string; files: string[]; externalId?: string; templateId?: string }
export function parseAgentTaskIntent(value: unknown): AgentTaskIntent {
  if (!isRecord(value) || Object.keys(value).some(key => !['intent', 'files', 'externalId', 'templateId'].includes(key))) throw new Error('Invalid task intent')
  if (typeof value.intent !== 'string' || value.intent.length > 2000 || /[\u0000-\u001f]/.test(value.intent)) throw new Error('Invalid task description')
  if (!Array.isArray(value.files) || value.files.length > 64 || value.files.some(file => typeof file !== 'string' || !file || file.length > 4096 || /[\\\u0000-\u001f]/.test(file) || file.startsWith('/') || file.split('/').some(part => part === '..' || part === '.' || part === ''))) throw new Error('Task files must be relative project paths')
  if (value.externalId !== undefined && (typeof value.externalId !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*-[0-9]+(?:\.[0-9]+)*$/.test(value.externalId))) throw new Error('Invalid external task ID')
  return { intent: value.intent, files: [...new Set(value.files as string[])], ...(value.externalId ? {externalId: value.externalId as string} : {}), ...(value.templateId ? {templateId: value.templateId as string} : {}) }
}

export function overlappingAgentIntents(runs: readonly RunningAgent[], workspacePath: string, files: readonly string[]): RunningAgent[] {
  const paths = (root: string, files: readonly string[]) => files.length ? files.map(file => root.replace(/[\\/]+$/, '') + '/' + file) : [root.replace(/[\\/]+$/, '')]
  const targets = paths(workspacePath, files)
  return runs.filter(run => run.liveness !== 'exited' && targets.some(file => paths(run.workspacePath, run.task?.files ?? []).some(other => file === other || file.startsWith(other + '/') || other.startsWith(file + '/'))))
}

export type ProjectTasksInspection = {
  authority: 'backlog.md' | null
  tools: Array<{id:'lazygit'|'backlog';available:boolean;version:string;path?:string;problem?:string}>
  tasks: Array<{id:string;title:string;status:string}>
  problem?: string
}
