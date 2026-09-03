import { useAppStore } from '../store'

/** Landing surface when no worktree is active (Orca's Landing.tsx). */
export function Landing() {
  const repos = useAppStore((s) => s.repos)
  const addRepo = useAppStore((s) => s.addRepo)
  const setCreateOpen = useAppStore((s) => s.setCreateOpen)
  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="landing-logo">O</div>
        <h1 className="landing-title">donwells.ai</h1>
        <p className="landing-sub">
          {repos.length === 0
            ? 'Add a git repository to start running CLI agents in parallel worktrees.'
            : 'Select a workspace in the sidebar, or create a new worktree.'}
        </p>
        <div className="landing-actions">
          <button
            className="btn btn-secondary"
            onClick={() => void (async () => {
              const dir = await window.orca.pickDirectory()
              if (dir) void addRepo(dir)
            })()}
          >
            Add Project
          </button>
          <button
            className="btn btn-primary"
            disabled={repos.length === 0}
            onClick={() => setCreateOpen(true)}
          >
            Create Worktree
          </button>
        </div>
      </div>
    </div>
  )
}
