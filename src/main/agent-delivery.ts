import type { AgentDeliveryReceipt, AgentDeliveryRequest } from '@shared/agent-delivery'
import type { AgentRuntime } from './agent-runtime'
import type { DaemonClient } from './daemon-client'
import { logger } from '@shared/logger'

const MAX_ATTACHMENT_BYTES = 64 * 1024
const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f]/

export async function deliverAgentAttachment(
  runtime: Pick<AgentRuntime, 'list'> & Partial<Pick<AgentRuntime, 'findAcpSession' | 'promptAcp'>>,
  terminals: Pick<DaemonClient, 'writeAgent'>,
  resolveWorkspace: (path: string) => Promise<string>,
  request: AgentDeliveryRequest
): Promise<AgentDeliveryReceipt> {
  if (!request || typeof request !== 'object' || typeof request.submit !== 'boolean') throw new Error('Invalid attachment delivery request')
  const { sessionId, attachment, submit } = request
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('Invalid agent session')
  if (!attachment || !['diff-review', 'design-capture', 'handoff'].includes(attachment.kind)) throw new Error('Invalid attachment kind')
  if (typeof attachment.title !== 'string' || !attachment.title.trim() || attachment.title.length > 512) throw new Error('Invalid attachment title')
  if (typeof attachment.workspacePath !== 'string') throw new Error('Invalid attachment workspace')
  const text = attachment.text
  if (typeof text !== 'string' || !text.trim() || CONTROL_CHARACTERS.test(text)) throw new Error('Attachment must contain plain text without terminal control characters')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > 100_000) {
    logger.warn({ bytes, sessionId }, 'agent: large attachment delivery')
  }
  if (bytes > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds the 64 KiB delivery limit')
  const workspacePath = await resolveWorkspace(attachment.workspacePath)
  const run = (await runtime.list()).find((candidate) => candidate.sessionId === sessionId)
  if (!run && runtime.findAcpSession && runtime.promptAcp) {
    const acp = await runtime.findAcpSession(sessionId)
    if (!acp || acp.workspacePath !== workspacePath || acp.liveness !== 'live') throw new Error('Select an available ACP session in the attachment workspace')
    if (!submit) throw new Error('Review this attachment in the ACP panel and explicitly submit it')
    if (!request.requestId) throw new Error('ACP delivery requires a stable request ID')
    const result = await runtime.promptAcp(workspacePath, sessionId, request.requestId, text)
    if (result.state === 'uncertain') throw new Error(result.error ?? 'Previous ACP delivery outcome is uncertain; it was not replayed')
    return { sessionId, bytes, submitted: true }
  }
  if (!run || run.workspacePath !== workspacePath) throw new Error('Select an agent in the attachment workspace')
  if (run.liveness !== 'live' || !['working', 'waiting'].includes(run.activity)) throw new Error('The selected agent is not accepting attachments; permission prompts must be handled in its terminal')
  const input = '\x1b[200~' + text + '\x1b[201~' + (submit ? '\r' : '')
  await terminals.writeAgent(sessionId, input)
  return { sessionId, bytes, submitted: submit }
}
