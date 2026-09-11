import { useState, useEffect, useCallback } from 'react'

interface PluginMarketplaceItem {
  id: string
  name: string
  version: string
  description: string
  author: string
  downloads: number
  rating: number
  category: string
  installed: boolean
}

interface PluginMarketplaceProps {
  onInstall: (pluginId: string) => Promise<void>
  onUninstall: (pluginId: string) => Promise<void>
}

/**
 * Plugin Marketplace UI
 *
 * Browse, install, and manage plugins.
 * Fetches real plugin list from the main process via IPC.
 */
export function PluginMarketplace({ onInstall, onUninstall }: PluginMarketplaceProps) {
  const [plugins, setPlugins] = useState<PluginMarketplaceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    void window.donwells.pluginList()
      .then((result) => {
        if (cancelled) return
        // Map plugin manifest to marketplace item format
        const items: PluginMarketplaceItem[] = (result as unknown as Array<{ id: string; name: string; description: string; active: boolean }>).map((p) => ({
          id: p.id,
          name: p.name,
          version: '1.0.0',
          description: p.description,
          author: 'donwells-team',
          downloads: 0,
          rating: 0,
          category: 'general',
          installed: p.active,
        }))
        setPlugins(items)
      })
      .catch(() => {
        if (cancelled) return
        setPlugins([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [])

  const categories = ['all', ...new Set(plugins.map(p => p.category))]

  const filtered = plugins.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.description.toLowerCase().includes(search.toLowerCase())
    const matchesCategory = selectedCategory === 'all' || p.category === selectedCategory
    return matchesSearch && matchesCategory
  })

  const handleInstall = useCallback(async (plugin: PluginMarketplaceItem) => {
    await onInstall(plugin.id)
    setPlugins(prev => prev.map(p => p.id === plugin.id ? { ...p, installed: true } : p))
  }, [onInstall])

  const handleUninstall = useCallback(async (plugin: PluginMarketplaceItem) => {
    await onUninstall(plugin.id)
    setPlugins(prev => prev.map(p => p.id === plugin.id ? { ...p, installed: false } : p))
  }, [onUninstall])

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
        <select
          className="input"
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          aria-label="Filter by category"
        >
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {filtered.map(plugin => (
          <div key={plugin.id} className="flex items-center justify-between p-2 rounded border border-border/50">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{plugin.name}</p>
              <p className="text-xs text-muted truncate">{plugin.description}</p>
            </div>
            {plugin.installed ? (
              <button className="btn btn-secondary btn-xs" onClick={() => handleUninstall(plugin)}>Uninstall</button>
            ) : (
              <button className="btn btn-primary btn-xs" onClick={() => handleInstall(plugin)}>Install</button>
            )}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-muted p-2">No plugins found</p>
        )}
      </div>
    </div>
  )
}
