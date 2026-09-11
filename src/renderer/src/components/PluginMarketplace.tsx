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
    return <div className="plugin-marketplace p-3"><p className="text-xs text-muted">Loading plugins…</p></div>
  }

  return (
    <div className="plugin-marketplace space-y-3">
      <div className="flex items-center gap-2">
        <input
          className="input flex-1"
          type="search"
          placeholder="Search plugins…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search plugins"
        />
        <button className="btn btn-secondary btn-sm" onClick={handleInstall}>Install from folder…</button>
      </div>

      {error && <p className="text-xs text-destructive p-2">{error}</p>}

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {filtered.map(plugin => (
          <div key={plugin.id} className="flex items-center justify-between p-2 rounded border border-border/50">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">
                {plugin.name} <span className="text-muted">v{plugin.version}</span>
              </p>
              <p className="text-xs text-muted truncate">{plugin.description}</p>
              <p className="text-xs text-muted">
                {plugin.active ? 'active' : plugin.enabled ? 'enabled (loading…)' : 'disabled'}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {plugin.enabled ? (
                <button className="btn btn-secondary btn-xs" onClick={() => handleDisable(plugin)}>Disable</button>
              ) : (
                <button className="btn btn-primary btn-xs" onClick={() => handleEnable(plugin)}>Enable</button>
              )}
              <button className="btn btn-secondary btn-xs" onClick={() => handleRemove(plugin)}>Remove</button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-muted p-2">No plugins found. Use “Install from folder…” to add one, or place a plugin folder under the plugins directory to discover it here.</p>
        )}
      </div>
    </div>
  )
}
