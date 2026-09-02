import { useAppStore } from '../store'

export function Sidebar() {
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const addRepo = useAppStore((s) => s.addRepo)
  const removeRepo = useAppStore((s) => s.removeRepo)
  const setActiveRepo = useAppStore((s) => s.setActiveRepo)

  const handleAdd = async () => {
    const dir = await window.orca.pickDirectory()
    if (dir) void addRepo(dir)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>Orca Lite</h1>
        <button className="icon-btn" title="Add repo" onClick={() => void handleAdd()}>
          +
        </button>
      </div>
      <div className="repo-list">
        {repos.length === 0 && (
          <div className="empty-hint">
            No repos yet.
            <br />
            Add a git repository to start managing worktrees.
          </div>
        )}
        {repos.map((r) => (
          <div key={r.repo.id} className="repo-row">
            <button className={`repo-item ${r.repo.id === activeRepoId ? 'active' : ''}`} onClick={() => setActiveRepo(r.repo.id)}>
              <span className="repo-name">{r.repo.path.split('/').filter(Boolean).pop()}</span>
              <span className="repo-path">{r.repo.path}</span>
            </button>
            <button
              className="icon-btn repo-remove"
              title="Remove repo"
              onClick={() => {
                if (confirm(`Remove ${r.repo.path} from Orca Lite? (does not touch the folder)`)) void removeRepo(r.repo.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}