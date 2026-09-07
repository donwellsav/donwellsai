import { expect, it } from 'vitest'
import { acpOutput } from '../src/renderer/src/acp-output'
import type { AcpObservation } from '../src/shared/agent-runtime'

it('joins streamed text and preserves the tool title when a later status omits it', () => {
  const changes = [
    { sessionUpdate: 'tool_call', toolCallId: 'one', title: 'Read project memory', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'one', status: 'completed' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fact ' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'found.' } }
  ] as const
  const updates = changes.map((update, sequence) => ({ sequence, notification: { sessionId: 'session', update } })) as AcpObservation['updates']
  expect(acpOutput(updates)).toEqual([{ kind: 'tool', id: 'one', title: 'Read project memory', status: 'completed' }, { kind: 'text', text: 'Fact found.' }])
})
