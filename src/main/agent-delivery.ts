import type { AgentDeliveryReceipt, AgentDeliveryRequest } from '@shared/agent-delivery'
import type { AgentRuntime } from './agent-runtime'
import type { DaemonClient } from './daemon-client'

const MAX_ATTACHMENT_BYTES = 64 * 1024
const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f]/

export async function deliverAgentAttachment(
  runtime: Pick<AgentRuntime, 'list'>,
  terminals: Pick<DaemonClient, 'writeAgent'>,
  resolveWorkspace: (path: string) => Promise<string>,
  request: AgentDeliveryRequest
): Promise<AgentDeliveryReceipt> {
  if (!request || typeof request !== 'object' || typeof request.submit !== 'boolean') throw new Error('Invalid attachment delivery request')
  const { sessionId, attachment, submit } = request
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('Invalid agent session')
  if (!attachment || !['diff-review', 'design-capture'].includes(attachment.kind)) throw new Error('Invalid attachment kind')
  if (typeof attachment.title !== 'string' || !attachment.title.trim() || attachment.title.length > 512) throw new Error('Invalid attachment title')
  if (typeof attachment.workspacePath !== 'string') throw new Error('Invalid attachment workspace')
  const text = attachment.text
  if (typeof text !== 'string' || !text.trim() || CONTROL_CHARACTERS.test(text)) throw new Error('Attachment must contain plain text without terminal control characters')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds the 64 KiB delivery limit')
  const workspacePath = await resolveWorkspace(attachment.workspacePath)
  const run = (await runtime.list()).find((candidate) => candidate.sessionId === sessionId)
  if (!run || run.workspacePath !== workspacePath) throw new Error('Select an agent in the attachment workspace')
  if (run.liveness !== 'live' || !['working', 'waiting'].includes(run.activity)) throw new Error('The selected agent is not accepting attachments; permission prompts must be handled in its terminal')
  const input = '\x1b[200~' + text + '\x1b[201~' + (submit ? '\r' : '')
  await terminals.writeAgent(sessionId, input)
  return { sessionId, bytes, submitted: submit }
}
