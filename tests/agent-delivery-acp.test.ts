import { expect, it, vi } from 'vitest'
import { deliverAgentAttachment } from '../src/main/agent-delivery'

it('delivers reviewed ACP text through a stable journal request and rejects unsubmitted, cross-project or uncertain delivery', async () => {
  const promptAcp = vi.fn(async () => ({ requestId: 'review-1', state: 'accepted' as 'accepted' | 'uncertain' }))
  const runtime = { list: async () => [], findAcpSession: async () => ({ sessionId: 'acp', workspacePath: '/project', liveness: 'live' as const }), promptAcp }
  const terminals = { writeAgent: vi.fn() }
  const request = { sessionId: 'acp', requestId: 'review-1', submit: true, attachment: { kind: 'diff-review' as const, workspacePath: '/project', title: 'Reviewed change', text: 'Apply this reviewed change' } }
  const deliver = (input = request) => deliverAgentAttachment(runtime, terminals, async path => path, input)
  await expect(deliver({ ...request, submit: false })).rejects.toThrow('explicitly submit')
  await expect(deliver({ ...request, requestId: '' })).rejects.toThrow('stable request ID')
  await expect(deliver({ ...request, attachment: { ...request.attachment, workspacePath: '/other' } })).rejects.toThrow('attachment workspace')
  expect(promptAcp).not.toHaveBeenCalled()
  expect(await deliver()).toMatchObject({ sessionId: 'acp', submitted: true })
  expect(promptAcp).toHaveBeenCalledWith('/project', 'acp', 'review-1', request.attachment.text)
  expect(terminals.writeAgent).not.toHaveBeenCalled()
  promptAcp.mockResolvedValue({ requestId: 'review-1', state: 'uncertain' })
  await expect(deliver()).rejects.toThrow('not replayed')
})
