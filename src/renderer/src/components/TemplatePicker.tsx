/**
 * TemplatePicker — placeholder for session template selection.
 * 
 * Will be wired up when session-template IPC handlers land.
 */

import { useEffect, useState } from 'react'
import { logger } from '@shared/logger'

interface TemplatePickerProps {
  onSelect: (id: string | null) => void
  selectedId?: string
}

export function TemplatePicker({ onSelect, selectedId }: TemplatePickerProps) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Placeholder — replace with real IPC call once handlers exist
    setReady(true)
  }, [])

  if (!ready) return null

  return (
    <div className="template-picker" role="group" aria-label="Session templates">
      <p className="template-picker-note">Templates coming soon</p>
    </div>
  )
}
