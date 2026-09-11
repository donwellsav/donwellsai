/**
 * Pure builder for the live capability matrix (R3).
 *
 * Fed by the renderer's store.agents list — AgentPreset values produced by the
 * main-process AgentRegistry from AGENT_PROVIDER_DEFINITIONS — so the table
 * reports what the host actually wires, never a hand-maintained guess.
 */

export type CapabilityRow = {
  provider: string
  installed: boolean
  hooks: boolean
  skills: boolean
  memory: boolean
  note?: string
}

type CapabilityPreset = {
  name: string
  available: boolean
  hookSupport: { support: string }
  skillConsumer: { supported: boolean }
  memorySupport?: string
}

export function buildCapabilityRows(agents: readonly CapabilityPreset[]): CapabilityRow[] {
  return agents.map((agent) => {
    const memory = agent.memorySupport === 'direct' || agent.memorySupport === 'acp'
    const note = !agent.available
      ? 'not installed'
      : agent.memorySupport === 'acp'
        ? 'memory via ACP session'
        : undefined
    return {
      provider: agent.name,
      installed: agent.available,
      hooks: agent.hookSupport.support === 'native',
      skills: agent.skillConsumer.supported,
      memory,
      ...(note ? { note } : {})
    }
  })
}
