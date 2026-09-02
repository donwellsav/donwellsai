import { useAppStore } from '../store'
import { WorktreeCard } from './WorktreeCard'

export function WorktreeGrid() {
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const createWorktree = useAppStore((s) => s.createWorktree)

  const repo = repos.find((r) => r.repo.id === activeRepoId)

  if (!repo) {
    return <div className="empty-hint">Select a repo from the sidebar to manage its worktrees.</div>
  }

  return (
    <div className="worktree-view">
      <div className="worktree-bar">
        <span className="repo-title">{repo.repo.path.split('/').filter(Boolean).pop()}</span>
        <span className="branch-pill">{repo.defaultBranch}</span>
        <span className="repo-path-full" title={repo.repo.path}>
          {repo.repo.path}
        </span>
        <form
          className="worktree-create"
          onSubmit={(e) => {
            e.preventDefault()
            const input = (e.currentTarget.elements.namedItem('wt-name') as HTMLInputElement).value
            if (input.trim()) {
              void createWorktree(input.trim())
              e.currentTarget.reset()
            }
          }}
        >
          <input name="wt-name" placeholder="new branch / worktree name" />
          <button className="btn btn-accent" type="submit">
            Create
          </button>
        </form>
      </div>
      <div className="worktree-grid">
        {repo.worktrees.map((wt) => (
          <WorktreeCard key={wt.id} worktree={wt} />
        ))}
      </div>
    </div>
  )
}