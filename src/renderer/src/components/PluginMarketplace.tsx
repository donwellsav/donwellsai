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
 * In a production app, this would connect to a remote API.
 * For now, it uses a local catalog.
 */
export function PluginMarketplace({ onInstall, onUninstall }: PluginMarketplaceProps) {
  const [plugins, setPlugins] = useState<PluginMarketplaceItem[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string>('all')
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  useEffect(() => {
    // Load catalog
    setLoading(true)
    // Simulated catalog - in production, fetch from API
    setPlugins([
      {
        id: 'code-formatter',
        name: 'Code Formatter',
        version: '1.2.0',
        description: 'Auto-format code on save with Prettier',
        author: 'donwells-team',
        downloads: 15420,
        rating: 4.8,
        category: 'productivity',
        installed: false,
      },
      {
        id: 'git-blame',
        name: 'Git Blame',
        version: '2.0.1',
        description: 'Inline git blame annotations in the editor',
        author: 'community',
        downloads: 8930,
        rating: 4.5,
        category: 'git',
        installed: false,
      },
      {
        id: 'ai-review',
        name: 'AI Code Review',
        version: '0.9.0',
        description: 'Automated code review suggestions',
        author: 'donwells-team',
        downloads: 5200,
        rating: 4.2,
        category: 'ai',
        installed: false,
      },
    ])
    setLoading(false)
  }, [])

  const categories = ['all', ...new Set(plugins.map(p => p.category))]

  const filtered = plugins.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.description.toLowerCase().includes(search.toLowerCase())
    const matchesCategory = category === 'all' || p.category === category
    return matchesSearch && matchesCategory
  })

  const handleInstall = useCallback(async (plugin: PluginMarketplaceItem) => {
    setInstalling(plugin.id)
    try {
      await onInstall(plugin.id)
      setPlugins(prev => prev.map(p => p.id === plugin.id ? { ...p, installed: true } : p))
    } finally {
      setInstalling(null)
    }
  }, [onInstall])

  const handleUninstall = useCallback(async (plugin: PluginMarketplaceItem) => {
    setInstalling(plugin.id)
    try {
      await onUninstall(plugin.id)
      setPlugins(prev => prev.map(p => p.id === plugin.id ? { ...p, installed: false } : p))
    } finally {
      setInstalling(null)
    }
  }, [onUninstall])

  return (
    <div className="plugin-marketplace">
      <div className="marketplace-header">
        <h3>Plugin Marketplace</h3>
        <input
          type="search"
          placeholder="Search plugins..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search plugins"
        />
      </div>

      <div className="marketplace-categories" role="tablist">
        {categories.map(cat => (
          <button
            key={cat}
            className={`category-tab ${category === cat ? 'active' : ''}`}
            onClick={() => setCategory(cat)}
            role="tab"
            aria-selected={category === cat}
          >
            {cat.charAt(0).toUpperCase() + cat.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="marketplace-loading">Loading...</div>
      ) : (
        <div className="marketplace-grid">
          {filtered.map(plugin => (
            <div key={plugin.id} className="plugin-card">
              <div className="plugin-card-header">
                <h4>{plugin.name}</h4>
                <span className="plugin-version">v{plugin.version}</span>
              </div>
              <p className="plugin-description">{plugin.description}</p>
              <div className="plugin-meta">
                <span>by {plugin.author}</span>
                <span>★ {plugin.rating.toFixed(1)}</span>
                <span>{plugin.downloads.toLocaleString()} downloads</span>
              </div>
              <button
                className={`plugin-install-btn ${plugin.installed ? 'installed' : ''}`}
                onClick={() => plugin.installed ? handleUninstall(plugin) : handleInstall(plugin)}
                disabled={installing === plugin.id}
              >
                {installing === plugin.id
                  ? '...'
                  : plugin.installed
                    ? 'Uninstall'
                    : 'Install'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
