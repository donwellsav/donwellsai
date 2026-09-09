// Drafts survive renderer replacement in main-process memory, never in profile files.
const owners = new Map<string, Map<string, unknown>>()
let restoring = false

export function guiDraftMap<T>(name: string): Map<string, T> {
  const values = new Map<string, T>()
  // ponytail: publish the bounded owner snapshot; use per-key IPC if large draft collections make typing expensive.
  const publish = () => {
    if (restoring || typeof window === 'undefined' || !window.donwells.guiDraftsWrite) return
    void window.donwells.guiDraftsWrite(name, JSON.stringify([...values])).catch(error => {
      window.dispatchEvent(new CustomEvent('gui-draft-error', { detail: String(error) }))
    })
  }
  values.set = (key, value) => { Map.prototype.set.call(values, key, value); publish(); return values }
  values.delete = key => { const removed = Map.prototype.delete.call(values, key); if (removed) publish(); return removed }
  values.clear = () => { Map.prototype.clear.call(values); publish() }
  owners.set(name, values)
  return values
}

export async function restoreGuiDrafts(): Promise<void> {
  if (!window.donwells.guiDraftsRead) return
  const saved = await window.donwells.guiDraftsRead()
  restoring = true
  try {
    for (const [name, text] of saved) {
      const owner = owners.get(name)
      if (!owner) continue
      const entries: Array<[string, unknown]> = JSON.parse(text)
      for (const [key, value] of entries) owner.set(key, value)
    }
  } finally { restoring = false }
}
