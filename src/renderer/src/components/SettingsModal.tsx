import { useCallback, useEffect, useState } from 'react'
import type { Automation, AutomationRun, OrchestrationRun, SettingsSection, SkillMeta, TerminalThemeName } from '@shared/types'
import { useAppStore } from '../store'
import { Icon } from './Icon'
import { TERMINAL_THEMES } from '../terminal-themes'

const SECTIONS: { id: SettingsSection; label: string; icon: 'gear' | 'terminal' | 'bolt' | 'clock' | 'layers' }[] = [
  { id: 'general', label: 'General', icon: 'gear' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'skills', label: 'Skills', icon: 'bolt' },
  { id: 'automations', label: 'Automations', icon: 'clock' },
  { id: 'orchestration', label: 'Orchestration', icon: 'layers' }
]

/** One labeled settings row: title + hint on the left, control on the right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <span>{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

/** Segmented control (Off/2s/5s…, Block/Bar/Underline…). */
function Seg({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={v === value} className={`seg-btn ${v === value ? 'active' : ''}`} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  )
}

/** Switch toggle. */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="toggle-knob" />
    </button>
  )
}

export function SettingsModal({ open }: { open: boolean }) {
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const section = useAppStore((s) => s.settingsSection)
  if (!open) return null
  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-layout">
          <nav className="settings-nav">
            <div className="settings-nav-title">Settings</div>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`settings-nav-item ${section === s.id ? 'active' : ''}`}
                onClick={() => useAppStore.getState().openSettings(s.id)}
              >
                <Icon name={s.icon} size={14} />
                {s.label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {section === 'general' && <GeneralSection />}
            {section === 'terminal' && <TerminalSection />}
            {section === 'skills' && <SkillsSection />}
            {section === 'automations' && <AutomationsSection />}
            {section === 'orchestration' && <OrchestrationSection />}
          </div>
          <button className="icon-btn settings-close" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
      </div>
    </div>
  )
}

/** General: agent command, status polling, about. */
function GeneralSection() {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const agents = useAppStore((s) => s.agents)
  const [cmd, setCmd] = useState(settings.agentCommand)
  const [meta, setMeta] = useState<{ version: string; shell: string; userDataDir: string } | null>(null)
  useEffect(() => {
    window.orca.meta().then(setMeta).catch(() => {})
  }, [])
  const commitCmd = (): void => {
    void setSettings({ agentCommand: cmd.trim() || 'codex' })
  }
  return (
    <>
      <h3 className="settings-heading">General</h3>
      <Row label="Default agent command" hint="Used by ⌘↩ and the palette's Run agent action">
        <div className="settings-stack">
          <input
            className="input"
            style={{ width: 260 }}
            value={cmd}
            placeholder="codex, claude, pi, opencode…"
            onChange={(e) => setCmd(e.target.value)}
            onBlur={commitCmd}
            onKeyDown={(e) => e.key === 'Enter' && commitCmd()}
          />
          <div className="agent-chips">
            {agents.map((a) => (
              <button
                key={a.name}
                className={`chip ${settings.agentCommand === a.command ? 'chip-active' : ''}`}
                onClick={() => {
                  setCmd(a.command)
                  void setSettings({ agentCommand: a.command })
                }}
              >
                {a.name}
              </button>
            ))}
          </div>
        </div>
      </Row>
      <Row label="Status refresh" hint="Polls git status, ports and resource usage">
        <Seg
          value={String(settings.statusPollMs)}
          options={[
            ['0', 'Off'],
            ['2000', '2s'],
            ['5000', '5s'],
            ['10000', '10s']
          ]}
          onChange={(v) => void setSettings({ statusPollMs: Number(v) })}
        />
      </Row>
      <div className="settings-about">
        <div className="settings-about-title">donwells.ai</div>
        {meta && (
          <>
            <div>Version {meta.version}</div>
            <div className="settings-about-path" title={meta.userDataDir}>
              Shell {meta.shell || 'default'}
            </div>
            <div className="settings-about-path">{meta.userDataDir}</div>
          </>
        )}
      </div>
    </>
  )
}

/** Terminal: live-applied appearance + behavior (scrollback applies to new terminals). */
function TerminalSection() {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const [font, setFont] = useState(settings.fontFamily ?? '')
  const commitFont = (): void => {
    void setSettings({ fontFamily: font.trim() || undefined })
  }
  const activeTheme = settings.terminalTheme ?? 'tomorrow-night'
  return (
    <>
      <h3 className="settings-heading">Terminal</h3>
      <Row label="Theme" hint="Applies to every open terminal immediately">
        <div className="theme-grid">
          {(Object.entries(TERMINAL_THEMES) as [TerminalThemeName, (typeof TERMINAL_THEMES)[TerminalThemeName]][]).map(([id, t]) => (
            <button
              key={id}
              className={`theme-card ${activeTheme === id ? 'active' : ''}`}
              onClick={() => void setSettings({ terminalTheme: id })}
            >
              <span className="theme-preview" style={{ background: t.swatch[0] }}>
                {t.swatch.slice(1).map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
              <span className="theme-card-label">{t.label}</span>
            </button>
          ))}
        </div>
      </Row>
      <Row label="Font size" hint={`${settings.fontSize}px — applies live`}>
        <input
          type="range"
          min={9}
          max={24}
          value={settings.fontSize}
          onChange={(e) => void setSettings({ fontSize: Number(e.target.value) })}
        />
      </Row>
      <Row label="Font family" hint="Blank = default mono stack">
        <input
          className="input"
          style={{ width: 260 }}
          value={font}
          placeholder="'SF Mono', Menlo, monospace…"
          onChange={(e) => setFont(e.target.value)}
          onBlur={commitFont}
          onKeyDown={(e) => e.key === 'Enter' && commitFont()}
        />
      </Row>
      <Row label="Cursor style">
        <Seg
          value={settings.cursorStyle ?? 'block'}
          options={[
            ['block', 'Block'],
            ['bar', 'Bar'],
            ['underline', 'Underline']
          ]}
          onChange={(v) => void setSettings({ cursorStyle: v as 'block' | 'bar' | 'underline' })}
        />
      </Row>
      <Row label="Cursor blink">
        <Toggle checked={settings.cursorBlink ?? true} onChange={(v) => void setSettings({ cursorBlink: v })} />
      </Row>
      <Row label="Copy on select" hint="Selection is copied to the clipboard on mouse-up">
        <Toggle checked={settings.copyOnSelect ?? false} onChange={(v) => void setSettings({ copyOnSelect: v })} />
      </Row>
      <Row label="Scrollback" hint="Lines kept per terminal — applies to new terminals">
        <Seg
          value={String(settings.scrollback ?? 10000)}
          options={[
            ['1000', '1k'],
            ['5000', '5k'],
            ['10000', '10k'],
            ['50000', '50k']
          ]}
          onChange={(v) => void setSettings({ scrollback: Number(v) })}
        />
      </Row>
    </>
  )
}

/** Installed agent skills: list, install from URL/path, remove. */
function SkillsSection() {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.orca.skillsList().then(setSkills).catch(() => setSkills([]))
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])

  const install = async (): Promise<void> => {
    const src = source.trim()
    if (!src || busy) return
    setBusy(true)
    setErr(null)
    try {
      await window.orca.skillsInstall(src)
      setSource('')
      refresh()
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field">
      <span>Agent skills ({skills.length})</span>
      <div className="skills-list">
        {skills.map((s) => (
          <div key={s.name} className="skill-row">
            <span className="skill-name">{s.name}</span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                void window.orca.skillsRemove(s.name).then(refresh)
              }}
            >
              Remove
            </button>
          </div>
        ))}
        {skills.length === 0 && <span className="empty-note">No skills installed.</span>}
      </div>
      <div className="skill-install-row">
        <input
          className="input"
          value={source}
          placeholder="Skill URL or file path (.md)"
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void install()
          }}
        />
        <button className="btn btn-primary btn-sm" disabled={!source.trim() || busy} onClick={() => void install()}>
          {busy ? 'Installing…' : 'Install'}
        </button>
      </div>
      {err && <div className="form-error">{err}</div>}
    </div>
  )
}

/** Automations: scheduled agent commands per worktree, with run history. */
function AutomationsSection() {
  const repos = useAppStore((s) => s.repos)
  const [items, setItems] = useState<Automation[]>([])
  const [runsFor, setRunsFor] = useState<string | null>(null)
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [worktreePath, setWorktreePath] = useState('')
  const [kind, setKind] = useState<'interval' | 'daily'>('interval')
  const [minutes, setMinutes] = useState(30)
  const [time, setTime] = useState('09:00')

  const refresh = useCallback(() => {
    window.orca.automationsList().then(setItems).catch(() => setItems([]))
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])
  useEffect(() => {
    if (!runsFor) return
    window.orca.automationRuns(runsFor).then(setRuns).catch(() => setRuns([]))
  }, [runsFor, items])

  // candidate worktree paths from loaded repos
  const wtPaths: string[] = repos.flatMap((r) => r.worktrees.map((w) => w.path))
  useEffect(() => {
    if (!worktreePath && wtPaths.length > 0) setWorktreePath(wtPaths[0]!)
  }, [wtPaths, worktreePath])

  const save = async (): Promise<void> => {
    if (!name.trim() || !command.trim() || !worktreePath) return
    await window.orca.automationSave({
      id: crypto.randomUUID(),
      name: name.trim(),
      worktreePath,
      command: command.trim(),
      schedule: kind === 'interval' ? { kind: 'interval', minutes: Math.max(1, minutes) } : { kind: 'daily', time },
      enabled: true,
      createdAt: new Date().toISOString()
    })
    setName('')
    setCommand('')
    refresh()
  }

  const statusDot = (st?: string): string =>
    st === 'ok' ? '✓' : st === 'failed' ? '✕' : st === 'running' ? '●' : st === 'interrupted' ? '⏹' : '–'

  return (
    <div className="field">
      <span>Automations ({items.length})</span>
      <div className="skills-list">
        {items.map((a) => (
          <div key={a.id} className="skill-row">
            <span className="skill-name" title={a.worktreePath}>
              {statusDot(a.lastStatus)} {a.name} · {a.schedule.kind === 'interval' ? `every ${a.schedule.minutes}m` : `daily ${a.schedule.time}`}
            </span>
            <span className="automation-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => setRunsFor(runsFor === a.id ? null : a.id)}>
                Runs
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => void window.orca.automationRunNow(a.id).then(refresh)}>
                Run
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => void window.orca.automationRemove(a.id).then(refresh)}
              >
                Remove
              </button>
            </span>
          </div>
        ))}
        {items.length === 0 && <span className="empty-note">No automations configured.</span>}
        {runsFor && (
          <div className="automation-runs">
            {runs.map((r) => (
              <div key={r.id} className="automation-run-row">
                <span className={`run-status run-${r.status}`}>{r.status}</span>
                <span className="run-time">{new Date(r.startedAt).toLocaleString()}</span>
                {r.tail && <span className="run-tail" title={r.tail}>{r.tail.slice(0, 60)}</span>}
              </div>
            ))}
            {runs.length === 0 && <span className="empty-note">No runs yet.</span>}
          </div>
        )}
      </div>
      <div className="automation-form">
        <input className="input" value={name} placeholder="Name" onChange={(e) => setName(e.target.value)} />
        <input className="input" value={command} placeholder="Command" onChange={(e) => setCommand(e.target.value)} />
        <select className="input" value={worktreePath} onChange={(e) => setWorktreePath(e.target.value)}>
          {wtPaths.map((p) => (
            <option key={p} value={p}>
              {p.split('/').pop()}
            </option>
          ))}
        </select>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'interval' | 'daily')}>
          <option value="interval">Every N minutes</option>
          <option value="daily">Daily at</option>
        </select>
        {kind === 'interval' ? (
          <input className="input" type="number" min={1} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
        ) : (
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        )}
        <button className="btn btn-primary btn-sm" disabled={!name.trim() || !command.trim() || !worktreePath} onClick={() => void save()}>
          Add
        </button>
      </div>
    </div>
  )
}

/** Orchestration: fan a prompt across worktrees, live task statuses. */
function OrchestrationSection() {
  const repos = useAppStore((s) => s.repos)
  const [runs, setRuns] = useState<OrchestrationRun[]>([])
  const [command, setCommand] = useState('')
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [parallel, setParallel] = useState(4)

  const refresh = useCallback(() => {
    window.orca.orchestrationList().then(setRuns).catch(() => setRuns([]))
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])
  // poll while any run is live so task states advance in the UI
  const anyRunning = runs.some((r) => r.status === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [anyRunning, refresh])

  const wtPaths: string[] = repos.flatMap((r) => r.worktrees.map((w) => w.path))
  const selectedPaths = wtPaths.filter((p) => selected[p])

  const start = async (): Promise<void> => {
    if (!command.trim() || selectedPaths.length === 0) return
    await window.orca.orchestrationStart(`Run ${new Date().toLocaleTimeString()}`, command.trim(), selectedPaths, parallel)
    setCommand('')
    setSelected({})
    refresh()
  }

  return (
    <div className="field">
      <span>Orchestration</span>
      <div className="skills-list">
        {runs.slice(0, 5).map((r) => (
          <div key={r.id} className="orch-run">
            <div className="orch-run-head">
              <span className={`run-status run-${r.status === 'done' ? 'ok' : r.status}`}>{r.status}</span>
              <span className="skill-name">{r.name}</span>
              <span className="run-time">
                {r.tasks.filter((t) => t.status === 'done').length}/{r.tasks.length}
              </span>
              {r.status === 'running' && (
                <button className="btn btn-secondary btn-sm" onClick={() => void window.orca.orchestrationCancel(r.id).then(refresh)}>
                  Cancel
                </button>
              )}
            </div>
            <div className="orch-tasks">
              {r.tasks.map((t) => (
                <span key={t.id} className={`orch-task task-${t.status}`} title={`${t.worktreePath}${t.error ? ` — ${t.error}` : ''}`}>
                  {t.worktreePath.split('/').pop()}
                </span>
              ))}
            </div>
          </div>
        ))}
        {runs.length === 0 && <span className="empty-note">No orchestration runs yet.</span>}
      </div>
      <div className="orch-form">
        <input
          className="input"
          value={command}
          placeholder="Prompt/command to fan out"
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void start()
          }}
        />
        <input className="input" type="number" min={1} max={8} value={parallel} title="Parallel tasks" onChange={(e) => setParallel(Number(e.target.value))} />
      </div>
      <div className="orch-worktrees">
        {wtPaths.map((p) => (
          <label key={p} className={`orch-wt ${selected[p] ? 'on' : ''}`}>
            <input type="checkbox" checked={!!selected[p]} onChange={(e) => setSelected((s) => ({ ...s, [p]: e.target.checked }))} />
            {p.split('/').pop()}
          </label>
        ))}
      </div>
      <button className="btn btn-primary btn-sm" disabled={!command.trim() || selectedPaths.length === 0} onClick={() => void start()}>
        Fan out ({selectedPaths.length})
      </button>
    </div>
  )
}