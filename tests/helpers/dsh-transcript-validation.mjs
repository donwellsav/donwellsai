import assert from 'node:assert/strict'

const resultText = part => part.content?.filter(value => value.type === 'text').map(value => value.text).join('\n') ?? ''
const resultJson = part => JSON.parse(resultText(part).replace(/^Error: /, ''))

export function validateIntegratedDshTurn(turn) {
  const calls = new Map(turn.filter(event => event.type === 'tool/call').map(event => [event.data.callId, event.data]))
  const results = turn.filter(event => event.type === 'tool/result').flatMap(event => event.data.message.content).filter(part => part.type === 'tool-result')
  const errors = results.filter(part => part.isError)
  const stale = errors.find(part => calls.get(part.toolCallId)?.name.endsWith('memory_replace'))
  assert(stale, 'Missing deliberate stale-revision tool failure')
  const staleDetail = resultJson(stale)
  assert.equal(staleDetail.code, 'PROJECT_MEMORY_CONFLICT', 'Stale update returned the wrong failure')

  const invalidCommand = errors.find(part => {
    const call = calls.get(part.toolCallId)
    return call?.name.endsWith('project_verification_run') && Object.hasOwn(JSON.parse(call.arguments), 'command')
  })
  if (invalidCommand) {
    assert.equal(resultJson(invalidCommand).error, 'verification arguments contains unknown field: command')
    const rejectedCall = calls.get(invalidCommand.toolCallId)
    const corrected = [...calls.values()].find(call => call.name.endsWith('project_verification_run') && call.step > rejectedCall.step && Object.hasOwn(JSON.parse(call.arguments), 'script'))
    assert(corrected, 'Invalid verification command was not followed by a structured script call')
    const correctedResult = results.find(part => part.toolCallId === corrected.callId)
    assert(correctedResult && !correctedResult.isError, 'Corrected verification call did not succeed')
  }
  assert.deepEqual(errors.map(part => part.toolCallId).sort(), [stale.toolCallId, ...(invalidCommand ? [invalidCommand.toolCallId] : [])].sort(), 'Native DSH turn included an unexpected failed tool call')

  const verification = [...calls.values()].findLast(call => call.name.endsWith('project_verification_results'))
  const verificationResult = results.find(part => part.toolCallId === verification?.callId)
  assert(verificationResult && !verificationResult.isError, 'Native DSH verification result is missing')
  const entries = resultJson(verificationResult)
  assert(entries.some(entry => entry.task?.status === 'succeeded' && entry.task.exitCode === 0), 'Native DSH verification did not succeed')
  return { expectedFailedToolCalls: errors.length, acceptedInvalidCommandRecovery: Boolean(invalidCommand) }
}
