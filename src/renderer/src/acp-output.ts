import type { AcpObservation } from '@shared/agent-runtime'

type Output = { kind: 'text'; text: string } | { kind: 'tool'; id: string; title: string; status: string }

/** Collapse streaming chunks and repeated tool status updates into their current rows. */
export function acpOutput(updates: AcpObservation['updates']): Output[] {
  const output: Output[] = [], tools = new Map<string, Extract<Output, { kind: 'tool' }>>()
  for (const { notification: { update } } of updates) {
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'user_message_chunk') {
      const text = update.content.type === 'text' ? update.content.text : `[${update.content.type} content]`
      const last = output.at(-1)
      if (last?.kind === 'text') last.text += text
      else output.push({ kind: 'text', text })
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      let row = tools.get(update.toolCallId)
      if (!row) { row = { kind: 'tool', id: update.toolCallId, title: update.title ?? update.toolCallId, status: update.status ?? 'pending' }; tools.set(row.id, row); output.push(row) }
      if (update.title) row.title = update.title
      if (update.status) row.status = update.status
    }
  }
  return output
}
