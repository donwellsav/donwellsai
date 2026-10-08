import { useState, useEffect, useCallback } from 'react'
import type { PluginStateView } from '../../../shared/types'

interface PluginRow {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  active: boolean
}

function toRow(view: PluginStateView): PluginRow {
  return {
    id: view.manifest.id,
    name: view.manifest.name,
    version: view.manifest.version,
    description: view.manifest.description ?? '',
    enabled: view.enabled,
    active: view.active,
  }
}

/**
 * Plugin management UI
 *
 * Lists plugins discovered in the local plugin directory with their truthful
 * three-way state: installed (discovered on disk), enabled (user consented),
 * active (module loaded right now). Enable/Disable is the consent gate;
 * nothing runs that the user has not enabled. "Install from folder" copies a
 * validated plugin folder in (inactive until enabled); Remove revokes consent
 * and moves the folder to the trash, so it stays recoverable.
 */
export function PluginMarketplace() {
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const refresh = useCallback(() => {
    setLoading(true)
    void window.donwells.pluginList()
      .then((views) => {
        setPlugins(views.map(toRow))
        setError(null)
      })
      .catch((err: unknown) => {
        setPlugins([])
        setError(err instanceof Error ? err.message : 'Failed to load plugins')
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const setRowState = useCallback((id: string, patch: Partial<PluginRow>) => {
    setPlugins(prev => prev.map(p => (p.id === id ? { ...p, ...patch } : p)))
  }, [])

  const handleEnable = useCallback(async (plugin: PluginRow) => {
    try {
      await window.donwells.pluginEnable(plugin.id)
      setRowState(plugin.id, { enabled: true, active: true })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Failed to enable ${plugin.name}`)
    }
  }, [setRowState])

  const handleDisable = useCallback(async (plugin: PluginRow) => {
    try {
      await window.donwells.pluginDisable(plugin.id)
      setRowState(plugin.id, { enabled: false, active: false })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Failed to disable ${plugin.name}`)
    }
  }, [setRowState])

  const handleInstall = useCallback(async () => {
    try {
      const dir = await window.donwells.pickDirectory()
      if (!dir) return
      await window.donwells.pluginInstall(dir)
      refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to install plugin')
    }
  }, [refresh])

  const handleRemove = useCallback(async (plugin: PluginRow) => {
    try {
      await window.donwells.pluginRemove(plugin.id)
      refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Failed to remove ${plugin.name}`)
    }
  }, [refresh])

  const filtered = plugins.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.description.toLowerCase().includes(search.toLowerCase()))

  if (loading) {
    return <div><p>Loading plugins…</p></div>
  }

  return (
    <div>
      <div>
        <input
          className="input"
          type="search"
          placeholder="Search plugins…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search plugins"
        />
        <button className="btn btn-secondary btn-sm" onClick={handleInstall}>Install from folder…</button>
      </div>

      {error && <p>{error}</p>}

      <div>
        {filtered.map(plugin => (
          <div key={plugin.id}>
            <div>
              <p>
                {plugin.name} <span>v{plugin.version}</span>
              </p>
              <p>{plugin.description}</p>
              <p>
                {plugin.active ? 'active' : plugin.enabled ? 'enabled (loading…)' : 'disabled'}
              </p>
            </div>
            <div>
              {plugin.enabled ? (
                <button className="btn btn-secondary" onClick={() => handleDisable(plugin)}>Disable</button>
              ) : (
                <button className="btn btn-primary" onClick={() => handleEnable(plugin)}>Enable</button>
              )}
              <button className="btn btn-secondary" onClick={() => handleRemove(plugin)}>Remove</button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p>No plugins found. Use “Install from folder…” to add one, or place a plugin folder under the plugins directory to discover it here.</p>
        )}
      </div>
    </div>
  )
}
