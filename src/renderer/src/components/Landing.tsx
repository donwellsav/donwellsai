import { useState } from 'react'
import { useAppStore } from '../store'
import { pathBasename } from '../workspace-navigation'
import { openProjectSetup } from '../project-setup'
import { Icon } from './Icon'
import './workspace-lifecycle.css'

export function Landing() {
  const repos = useAppStore((state) => state.repos)
  const navigation = useAppStore((state) => state.workspaceNavigation)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const projectSidebarOpen = sidebarOpen && repos.length > 0
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openExisting = async (): Promise<void> => {
    if (opening) return
    setOpening(true)
    setError(null)
    try {
      const directory = await window.donwells.pickDirectory()
      if (directory) {
        await useAppStore.getState().addRepo(directory)
        const failure = useAppStore.getState().error
        if (failure) setError(failure)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOpening(false)
    }
  }

  const openWorkspace = (_repoId: string, path: string): void => {
    const state = useAppStore.getState()
    state.setActiveWorktree(path)
  }

  const actions = (
    <div className="landing-actions">
      <button className="btn btn-primary" onClick={() => openProjectSetup()}><Icon name="plus" size={16} />New project</button>
      <button className="btn" disabled={opening} onClick={() => void openExisting()}><Icon name="dir" size={16} />{opening ? 'Opening…' : 'Open existing folder'}</button>
    </div>
  )

  if (repos.length === 0) {
    return (
      <main className="landing workspace-landing">
        <div className="workspace-home-empty">
          <div aria-hidden="true"><Icon name="dir" size={28} /></div>
          <div className="workspace-home-intro">
            <h1 className="landing-title">Start a project.</h1>
            <p className="landing-sub">Create a new folder with optional Git setup, or open a project already on your computer.</p>
          </div>
          {actions}
          {error && <p role="alert">{error}</p>}
          <p>Your files stay on your computer. Each project has its own terminals, editors, and agent sessions.</p>
        </div>
      </main>
    )
  }

  return (
    <main className="landing workspace-landing">
      <div className="workspace-home">
        <header className="workspace-home-header">
          <div><h1>{projectSidebarOpen ? 'Workspace' : 'Projects'}</h1><p>{projectSidebarOpen ? 'Choose a checkout from Projects on the left.' : 'Open a workspace or start something new.'}</p></div>
          {!projectSidebarOpen && actions}
        </header>
        {error && <p role="alert">{error}</p>}
        {!projectSidebarOpen && <section className="workspace-home-projects" aria-labelledby="workspace-projects-title">
          <div className="workspace-home-section-heading"><h2 id="workspace-projects-title">On this computer</h2><span>{repos.length} {repos.length === 1 ? 'project' : 'projects'}</span></div>
          <div className="workspace-home-project-list">
            {repos.map((repo) => (
              <article key={repo.repo.id} className="workspace-home-project">
                <div className="workspace-home-project-title">
                  <span className="workspace-home-project-mark"><Icon name={repo.repo.kind === 'folder' ? 'dir' : 'git'} size={18} /></span>
                  <span><strong>{pathBasename(repo.repo.path)}</strong><small title={repo.repo.path}>{repo.repo.path}</small></span>
                  {repo.repo.kind !== 'folder' && <button className="btn btn-sm" onClick={() => { useAppStore.getState().setActiveRepo(repo.repo.id); useAppStore.getState().setCreateOpen(true) }}><Icon name="plus" size={14} />New worktree</button>}
                </div>
                <div className="workspace-home-worktrees">
                  {repo.worktrees.map((worktree) => (
                    <button key={worktree.path} onClick={() => openWorkspace(repo.repo.id, worktree.path)}>
                      <span><strong>{navigation.renames[worktree.path] ?? pathBasename(worktree.path)}</strong><small>{repo.repo.kind === 'folder' ? 'Local folder' : worktree.detached ? 'Detached worktree' : worktree.branch || 'No commits yet'}</small></span>
                      <span className="workspace-home-open">Open <Icon name="chevrons" size={14} /></span>
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>}

      </div>
    </main>
  )
}
