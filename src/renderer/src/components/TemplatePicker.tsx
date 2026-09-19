import { useEffect, useState } from 'react'

interface Template {
  id: string
  name: string
  description: string
}

interface TemplatePickerProps {
  onSelect: (id: string | null) => void
  selectedId?: string
}

export function TemplatePicker({ onSelect, selectedId }: TemplatePickerProps) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void window.donwells.sessionTemplateList()
      .then(result => { if (active) setTemplates(result) })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [attempt])

  if (loading) {
    return <div className="text-xs text-muted p-2">Loading templates…</div>
  }

  if (error !== null) {
    return <div>
      <p role="alert">Could not load templates: {error}</p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAttempt(value => value + 1)}>Retry templates</button>
    </div>
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        className={`w-full text-left text-xs px-2 py-1 rounded ${!selectedId ? 'bg-primary/10 text-primary' : 'text-muted hover:bg-muted/10'}`}
        onClick={() => onSelect(null)}
      >
        No template
      </button>
      {templates.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`w-full text-left text-xs px-2 py-1 rounded ${selectedId === t.id ? 'bg-primary/10 text-primary' : 'text-muted hover:bg-muted/10'}`}
          onClick={() => onSelect(t.id)}
          title={t.description}
        >
          {t.name}
        </button>
      ))}
      {templates.length === 0 && !loading && (
        <p className="text-xs text-muted p-2">No templates yet</p>
      )}
    </div>
  )
}
