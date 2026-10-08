import { useMemo, useState } from 'react'
import './capability-matrix.css'
import { Icon } from './Icon'
import { useAppStore } from '../store'
import { buildCapabilityRows } from '../../../shared/capability-matrix'

/**
 * Provider capability matrix UI.
 *
 * Renders the live AgentPreset list the main process derives from
 * AGENT_PROVIDER_DEFINITIONS + PATH discovery (R3). A dash means the
 * provider binary is not installed at all — distinct from a minus, which
 * means "installed, but the host does not wire this capability".
 */

const CAPABILITIES = [
  { id: 'installed', label: 'Installed', description: 'Binary found on PATH' },
  { id: 'hooks', label: 'Hooks', description: 'Per-run status hooks' },
  { id: 'skills', label: 'Skills', description: 'Workspace skill discovery' },
  { id: 'memory', label: 'Memory', description: 'Shared project memory wiring' },
] as const

export function CapabilityMatrix() {
  const [expanded, setExpanded] = useState(false)
  const agents = useAppStore((state) => state.agents)
  const rows = useMemo(() => buildCapabilityRows(agents), [agents])

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
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={CAPABILITIES.length + 1}>Loading providers…</td>
                </tr>
              ) : (
                rows.map(row => (
                  <tr key={row.provider}>
                    <th scope="row">
                      {row.provider}
                      {row.note ? (
                        <span className="capability-text" title={row.note}>
                          {' '}
                          ({row.note})
                        </span>
                      ) : null}
                    </th>
                    <td>
                      {row.installed ? (
                        <span className="capability-yes" aria-label="Installed: supported">
                          <Icon name="check" size={14} />
                        </span>
                      ) : (
                        <span className="capability-no" aria-label="Installed: not installed">
                          <Icon name="minus" size={14} />
                        </span>
                      )}
                    </td>
                    {(['hooks', 'skills', 'memory'] as const).map(capId => {
                      const cap = CAPABILITIES.find(c => c.id === capId)!
                      const value = row[capId]
                      return (
                        <td key={capId}>
                          {!row.installed ? (
                            <span className="capability-text" aria-label={`${cap.label}: not installed`}>
                              —
                            </span>
                          ) : value ? (
                            <span className="capability-yes" aria-label={`${cap.label}: supported`}>
                              <Icon name="check" size={14} />
                            </span>
                          ) : (
                            <span className="capability-no" aria-label={`${cap.label}: not supported`}>
                              <Icon name="minus" size={14} />
                            </span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
