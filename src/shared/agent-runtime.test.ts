// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAcpAgentSnapshot, parseAcpObservation, parseAcpPromptRecord, parseAgentModeSwitchReceipt, type RunningAgent } from './agent-runtime'
import { agentProviderName } from './agent-presentation'

const processIdentity = {
  pid: 1234,
  bootId: 'boot-test',
  startedAt: 'started-test',
  executablePath: process.execPath,
  family: 'acp-agent' as const,
  capturedAt: '2026-09-13T00:00:00.000Z',
  generation: 'run-test:1'
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'acp',
    id: 'run-test',
    workspacePath: '/tmp/acp-test',
    protocolSessionId: 'session-test',
    processIdentity,
    state: 'ready',
    capabilities: {},
    permissions: [],
    ...overrides
  }
}

function observation(update: Record<string, unknown>): Record<string, unknown> {
  return {
    snapshot: snapshot(),
    sequence: 1,
    truncated: false,
    updates: [{ sequence: 1, notification: { sessionId: 'session-test', update } }],
    requests: []
  }
}

function nativeRun(): RunningAgent {
  return {
    id: 'run-test', sessionId: 'session-test', workspacePath: '/tmp/acp-test', command: '/opt/tools/native-agent',
    startedAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
    liveness: 'live', activity: 'working', hook: { support: 'unavailable', events: [], connected: false, reason: 'hook support is not configured in this fixture' }
  }
}

function nativeReceipt(run: RunningAgent) {
  return {
    requestId: 'request-1', workspacePath: run.workspacePath, sessionId: run.sessionId,
    target: 'native', state: 'completed', continuity: 'same-history',
    native: { run, session: { id: run.sessionId, worktreePath: run.workspacePath, title: run.command, createdAt: run.startedAt, exited: false } }
  }
}

describe('strict ACP wire decoders', () => {
  it('rejects wrong capability scalar types', () => {
    expect(() => parseAcpAgentSnapshot(snapshot({ capabilities: { loadSession: 'yes' } }))).toThrow(/loadSession/)
  })

  it('rejects malformed permission request payloads', () => {
    expect(() => parseAcpAgentSnapshot(snapshot({ permissions: [{ id: 'permission-1', request: {} }] }))).toThrow(/request.*missing field.*sessionId/)
  })

  it('rejects malformed prompt results', () => {
    expect(() => parseAcpPromptRecord({ requestId: 'request-1', state: 'completed', result: {} })).toThrow(/result.*missing field.*stopReason/)
    expect(() => parseAcpPromptRecord({ requestId: 'request-1', state: 'completed', result: { stopReason: 'end_turn', usage: { totalTokens: 1.5, inputTokens: 0, outputTokens: 1 } } })).toThrow(/totalTokens/)
  })

  it('rejects malformed session notifications', () => {
    const observation = { snapshot: snapshot(), sequence: 0, truncated: false, updates: [{ sequence: 1, notification: {} }], requests: [] }
    expect(() => parseAcpObservation(observation)).toThrow(/notification.*missing field.*sessionId/)
  })

  it('rejects malformed native mode switch results', () => {
    const receipt = { requestId: 'request-1', workspacePath: '/tmp/acp-test', sessionId: 'session-test', target: 'native', state: 'completed', continuity: 'same-history', native: {} }
    expect(() => parseAgentModeSwitchReceipt(receipt)).toThrow(/native.*missing field.*run/)
  })

  it('rejects obsolete preset identity on otherwise valid runs', () => {
    const run = nativeRun()
    expect(parseAgentModeSwitchReceipt(nativeReceipt(run)).native?.run).toEqual(run)
    expect(() => parseAgentModeSwitchReceipt(nativeReceipt({ ...run, ...{ presetId: 'codex' } }))).toThrow(/unknown field: presetId/)
  })

  it('preserves admitted provider provenance across wire decoding for display', () => {
    const run = {
      ...nativeRun(),
      provider: { driverId: 'claude', providerInstanceId: 'instance-work', providerInstanceRevision: 7, accountId: 'account-work', providerAccountRevision: 3 }
    }
    const parsed = parseAgentModeSwitchReceipt(nativeReceipt(run)).native!.run
    expect(parsed.provider).toEqual(run.provider)
    expect(agentProviderName(parsed)).toBe('Claude Code')
  })

  it('displays custom driver provenance without inventing a provider for native commands', () => {
    const run = nativeRun()
    expect(agentProviderName(run)).toBe('legacy provider: /opt/tools/native-agent')
    expect(agentProviderName({ ...run, provider: { driverId: 'custom-command', providerInstanceId: 'instance-custom', providerInstanceRevision: 1, accountId: null, providerAccountRevision: null } })).toBe('custom-command')
  })
  it('rejects prompt fields that contradict their state', () => {
    expect(() => parseAcpPromptRecord({ requestId: 'request-1', state: 'completed' })).toThrow(/completed.*result/)
    expect(() => parseAcpPromptRecord({ requestId: 'request-1', state: 'accepted', result: { stopReason: 'end_turn' } })).toThrow(/accepted.*result/)
    expect(() => parseAcpPromptRecord({ requestId: 'request-1', state: 'uncertain' })).toThrow(/uncertain.*error/)
  })

  it('rejects mode-switch fields that contradict target or state', () => {
    const base = { requestId: 'request-1', workspacePath: '/tmp/acp-test', sessionId: 'session-test', continuity: 'same-history' }
    expect(() => parseAgentModeSwitchReceipt({ ...base, target: 'native', state: 'completed' })).toThrow(/completed.*native/)
    expect(() => parseAgentModeSwitchReceipt({ ...base, target: 'native', state: 'accepted', error: 'early' })).toThrow(/accepted.*payload/)
    expect(() => parseAgentModeSwitchReceipt({ ...base, target: 'native', state: 'uncertain' })).toThrow(/uncertain.*error/)
    expect(() => parseAgentModeSwitchReceipt({ ...base, target: 'acp', state: 'accepted' })).toThrow(/continuity/)
  })

  it('accepts a representative nested ACP response', () => {
    const parsed = parseAcpAgentSnapshot(snapshot({
      capabilities: { loadSession: true, promptCapabilities: { image: false }, providers: null },
      permissions: [{ id: 'permission-1', request: {
        sessionId: 'session-test',
        toolCall: { toolCallId: 'tool-1' },
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]
      }}]
    }))
    expect(parsed.capabilities).toMatchObject({ loadSession: true, promptCapabilities: { image: false }, providers: null })
    expect(parsed.permissions[0]?.request.toolCall.toolCallId).toBe('tool-1')
  })

  it('accepts schema-nullable tool updates and NES capabilities', () => {
    const toolUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', kind: null, status: null, title: null, content: null, locations: null }
    expect(parseAcpObservation(observation(toolUpdate)).updates[0]?.notification.update).toEqual(toolUpdate)

    expect(parseAcpAgentSnapshot(snapshot({ capabilities: { nes: { events: null, context: null } } })).capabilities?.nes).toEqual({ events: null, context: null })
    expect(parseAcpAgentSnapshot(snapshot({ capabilities: { nes: {
      events: { document: null },
      context: { recentFiles: null, relatedSnippets: null, editHistory: null, userActions: null, openFiles: null, diagnostics: null }
    } } })).capabilities?.nes).toEqual({
      events: { document: null },
      context: { recentFiles: null, relatedSnippets: null, editHistory: null, userActions: null, openFiles: null, diagnostics: null }
    })
    expect(parseAcpAgentSnapshot(snapshot({ capabilities: { nes: { events: { document: { didChange: null } } } } })).capabilities?.nes).toEqual({ events: { document: { didChange: null } } })
  })

  it('rejects usage values outside unsigned safe integers', () => {
    for (const [used, size] of [[-1, 0], [0.5, 1], [0, -1], [0, Number.MAX_SAFE_INTEGER + 1]]) {
      expect(() => parseAcpObservation(observation({ sessionUpdate: 'usage_update', used, size }))).toThrow(/(used|size).*non-negative integer/)
    }
  })
})
