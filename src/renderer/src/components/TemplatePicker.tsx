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

  useEffect(() => {
    void window.donwells.sessionTemplateList()
      .then(setTemplates)
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="text-xs text-muted p-2">Loading templates…</div>
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
