import { useState, useEffect } from 'react'
import { Icon } from './Icon'
import { useAppStore } from '../store'

/**
 * Provider capability matrix UI.
 *
 * Shows a comparison of what each agent provider supports.
 * Data is static for now; can be extended with runtime capability detection.
 */

type Capability = {
  id: string
  label: string
  description: string
}

type ProviderCapability = {
  provider: string
  capabilities: Record<string, boolean | string>
}

const CAPABILITIES: Capability[] = [
  { id: 'models', label: 'Models', description: 'Supported model providers' },
  { id: 'tools', label: 'Tool Use', description: 'Function calling and tool execution' },
  { id: 'context', label: 'Context', description: 'Maximum context window' },
  { id: 'streaming', label: 'Streaming', description: 'Real-time response streaming' },
  { id: 'multimodal', label: 'Multimodal', description: 'Image and file input support' },
  { id: 'subagents', label: 'Subagents', description: 'Can spawn subagents' },
]

const PROVIDERS: ProviderCapability[] = [
  {
    provider: 'OpenCode',
    capabilities: {
      models: 'OpenAI, Anthropic, Google, Local',
      tools: true,
      context: '128K-1M',
      streaming: true,
      multimodal: true,
      subagents: true,
    },
  },
  {
    provider: 'Claude Code',
    capabilities: {
      models: 'Anthropic',
      tools: true,
      context: '200K',
      streaming: true,
      multimodal: true,
      subagents: true,
    },
  },
  {
    provider: 'Codex',
    capabilities: {
      models: 'OpenAI',
      tools: true,
      context: '128K-200K',
      streaming: true,
      multimodal: true,
      subagents: false,
    },
  },
  {
    provider: 'Gemini CLI',
    capabilities: {
      models: 'Google',
      tools: true,
      context: '1M',
      streaming: true,
      multimodal: true,
      subagents: false,
    },
  },
  {
    provider: 'Kimi Code',
    capabilities: {
      models: 'Moonshot',
      tools: true,
      context: '128K',
      streaming: true,
      multimodal: false,
      subagents: false,
    },
  },
]

export function CapabilityMatrix() {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="capability-matrix">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon name="grid" size={14} />
        {expanded ? 'Hide' : 'Show'} capability matrix
      </button>

      {expanded && (
        <div className="capability-matrix-table" role="region" aria-label="Provider capability comparison">
          <table>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                {CAPABILITIES.map(cap => (
                  <th key={cap.id} scope="col" title={cap.description}>
                    {cap.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map(({ provider, capabilities }) => (
                <tr key={provider}>
                  <th scope="row">{provider}</th>
                  {CAPABILITIES.map(cap => {
                    const val = capabilities[cap.id]
                    return (
                      <td key={cap.id}>
                        {val === true ? (
                          <span className="capability-yes" aria-label={`${cap.label}: supported`}>
                            <Icon name="check" size={14} />
                          </span>
                        ) : val === false ? (
                          <span className="capability-no" aria-label={`${cap.label}: not supported`}>
                            <Icon name="minus" size={14} />
                          </span>
                        ) : (
                          <span className="capability-text">{val}</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
