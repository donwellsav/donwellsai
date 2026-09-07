/** Retain only the request identity across GUI reloads; retries observe the same daemon journal entry. */
export async function switchAgentMode(workspacePath: string, sessionId: string, target: 'native' | 'acp') {
  const key = `agent-mode-switch:${JSON.stringify([workspacePath, sessionId, target])}`
  const requestId = sessionStorage.getItem(key) ?? crypto.randomUUID()
  sessionStorage.setItem(key, requestId)
  let result = await window.donwells.agentSwitchMode(workspacePath, sessionId, target, requestId)
  const deadline = Date.now() + 30000
  while (result.state === 'accepted' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
    result = await window.donwells.agentSwitchResult(workspacePath, requestId)
  }
  if (result.state !== 'completed') throw new Error(result.error ?? 'Switch is still pending. Check again to observe the same request; work will not be replayed.')
  return result
}
