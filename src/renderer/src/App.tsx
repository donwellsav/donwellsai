import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { WorktreeGrid } from './components/WorktreeGrid'
import { useAppStore } from './store'
import { initTerminalEvents } from './terminal-bus'

export function App() {
  const load = useAppStore((s) => s.load)
  const loading = useAppStore((s) => s.loading)
  const error = useAppStore((s) => s.error)
  const setError = useAppStore((s) => s.setError)
  const activeRepoId = useAppStore((s) => s.activeRepoId)

  useEffect(() => {
    // Wire PTY event stream once; terminal data bypasses React entirely.
    initTerminalEvents(
      (sessionId, exitCode) => {
        useAppStore.getState().applyTerminalExit(sessionId, exitCode)
      },
      (sessionId, title) => {
        useAppStore.getState().applyTerminalTitle(sessionId, title)
      }
    )
    void load()
  }, [load])

  return (
    <div className="app">
      <Sidebar />
      <main className="main">{loading ? <div className="loading">Loading…</div> : <WorktreeGrid key={activeRepoId ?? 'none'} />}</main>
      {error && (
        <div className="error-toast" onClick={() => setError(null)} title={error}>
          {error}
        </div>
      )}
    </div>
  )
}