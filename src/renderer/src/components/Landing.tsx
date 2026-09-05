import { useMemo, useState } from 'react'
import { appCommand, appCommandPlatform, formatAppShortcut } from '@shared/app-commands'
import { useAppStore } from '../store'
import { orderedWorkspacePaths, pathBasename } from '../workspace-navigation'
import { Icon } from './Icon'
import './workspace-lifecycle.css'

/** A useful workspace home: resume real work, browse registered projects, or start a command. */
export function Landing() {
  const repos = useAppStore((state) => state.repos)
  const activeRepoId = useAppStore((state) => state.activeRepoId)
  const workspaceNavigation = useAppStore((state) => state.workspaceNavigation)
  const addRepo = useAppStore((state) => state.addRepo)
  const setCreateOpen = useAppStore((state) => state.setCreateOpen)
  const setPaletteOpen = useAppStore((state) => state.setPaletteOpen)
  const openRuns = useAppStore((state) => state.openRuns)
  const [adding, setAdding] = useState(false)
  const settings = useAppStore((state) => state.settings)
  const chord = settings.keyboardShortcutOverrides['command-palette'] ?? appCommand('command-palette')?.defaultAccelerators[0]
  const commandShortcut = chord ? formatAppShortcut(chord, appCommandPlatform(navigator.platform || navigator.userAgent)) : ''

  const workspaces = useMemo(() => {
    const ownerByPath = new Map(repos.flatMap((repo) => repo.worktrees.map((worktree) => [worktree.path, repo] as const)))
    return orderedWorkspacePaths(repos, workspaceNavigation).flatMap((path) => {
      const repo = ownerByPath.get(path)
      const worktree = repo?.worktrees.find((candidate) => candidate.path === path)
      return repo && worktree ? [{ repo, worktree }] : []
    })
  }, [repos, workspaceNavigation])
  const gitRepos = useMemo(() => repos.filter((repo) => repo.repo.kind !== 'folder'), [repos])
  const resume = workspaces.find(({ worktree }) => workspaceNavigation.pinnedPaths.includes(worktree.path))
    ?? workspaces.find(({ repo }) => repo.repo.id === activeRepoId)
    ?? workspaces[0]

  const openWorkspace = (repoId: string, path: string): void => {
    const state = useAppStore.getState()
    state.setActiveRepo(repoId)
    state.setActiveWorktree(path)
  }
  const addProject = async (): Promise<void> => {
    if (adding) return
    setAdding(true)
    try {
      const directory = await window.donwells.pickDirectory()
      if (directory) await addRepo(directory)
    } finally {
      setAdding(false)
    }
  }

  if (repos.length === 0) {
    return (
      <div className="landing workspace-landing workspace-landing-empty">
        <main className="workspace-home-empty">
          <div className="landing-logo" aria-hidden="true">&gt;_</div>
          <div className="workspace-home-intro">
            <span className="lifecycle-eyebrow">Workspace control</span>
            <h1 className="landing-title">Bring your project into focus.</h1>
            <p className="landing-sub">Open a Git repository or any local folder. Git projects can also create isolated worktrees for parallel agent work.</p>
          </div>
          <div className="landing-actions">
            <button className="btn btn-primary" disabled={adding} onClick={() => void addProject()}>
              <Icon name="dir" size={14} /> {adding ? 'Opening…' : 'Add project'}
            </button>
            <button className="btn btn-secondary" onClick={() => setPaletteOpen(true, 'commands')}>
              <Icon name="search" size={14} /> Browse commands
            </button>
          </div>
          <button className="workspace-home-text-action" onClick={() => openRuns('orchestration')}>
            Open Runs <span aria-hidden="true">→</span>
          </button>
        </main>
      </div>
    )
  }

  return (
    <div className="landing workspace-landing">
      <main className="workspace-home">
        <header className="workspace-home-header">
          <div>
            <span className="lifecycle-eyebrow">Workspace control</span>
            <h1>Pick up where you left off.</h1>
            <p>Open an existing workspace, create an isolated worktree, or jump straight to a command.</p>
          </div>
          <div className="workspace-home-header-actions">
            {resume && (
              <button className="btn btn-primary" onClick={() => openWorkspace(resume.repo.repo.id, resume.worktree.path)}>
                <Icon name="play" size={13} /> Resume {workspaceNavigation.renames[resume.worktree.path] ?? pathBasename(resume.worktree.path)}
              </button>
            )}
            {gitRepos.length > 0 && (
              <button className="btn btn-secondary" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" size={13} /> Create worktree
              </button>
            )}
            <button className="btn btn-secondary" disabled={adding} onClick={() => void addProject()}>
              <Icon name="dir" size={13} /> {adding ? 'Opening…' : 'Add project'}
            </button>
          </div>
        </header>

        <section className="workspace-home-projects" aria-labelledby="workspace-projects-title">
          <div className="workspace-home-section-heading">
            <div>
              <span className="lifecycle-eyebrow">Registered locally</span>
              <h2 id="workspace-projects-title">Projects</h2>
            </div>
            <span>{repos.length} {repos.length === 1 ? 'project' : 'projects'} · {workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'}</span>
          </div>
          <div className="workspace-home-project-list">
            {repos.map((repo) => {
              const folder = repo.repo.kind === 'folder'
              return (
                <article key={repo.repo.id} className="workspace-home-project">
                  <div className="workspace-home-project-title">
                    <span className="workspace-home-project-mark">{folder ? <Icon name="dir" size={14} /> : <Icon name="git" size={14} />}</span>
                    <span>
                      <strong>{pathBasename(repo.repo.path)}</strong>
                      <small title={repo.repo.path}>{repo.repo.path}</small>
                    </span>
                    <span className="badge">{folder ? 'folder' : `${repo.worktrees.length} ${repo.worktrees.length === 1 ? 'workspace' : 'workspaces'}`}</span>
                  </div>
                  <div className="workspace-home-worktrees">
                    {repo.worktrees.map((worktree) => (
                      <button key={worktree.path} onClick={() => openWorkspace(repo.repo.id, worktree.path)}>
                        <span>
                          <strong>{workspaceNavigation.renames[worktree.path] ?? pathBasename(worktree.path)}</strong>
                          <small>{folder ? 'Local folder' : worktree.detached ? `Detached ${worktree.head?.slice(0, 8) ?? ''}` : worktree.branch || 'Branch unavailable'}</small>
                        </span>
                        <span className="workspace-home-open">Open <span aria-hidden="true">→</span></span>
                      </button>
                    ))}
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        <nav className="workspace-home-shortcuts" aria-label="Workspace shortcuts">
          <button onClick={() => setPaletteOpen(true, 'commands')}>
            <Icon name="search" size={14} /><span><strong>Commands</strong><small>Search every app action</small></span><span aria-hidden="true">{commandShortcut}</span>
          </button>
          <button onClick={() => openRuns('orchestration')}>
            <Icon name="activity" size={14} /><span><strong>Runs</strong><small>Parallel and scheduled work</small></span><span aria-hidden="true">→</span>
          </button>
        </nav>
      </main>
    </div>
  )
}
