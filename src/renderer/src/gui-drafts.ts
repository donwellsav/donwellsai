// Drafts survive renderer replacement in main-process memory, never in profile files.
const owners = new Map<string, Map<string, unknown>>()
const publishTimers = new Map<string, number>()
let restoring = false

/**
 * Coalesce publishes per draft name: panels write on every keystroke-triggered
 * effect, and the snapshot is the WHOLE map — one write burst must cost one IPC.
 */
function schedulePublish(name: string): void {
  const previous = publishTimers.get(name)
  if (previous !== undefined) window.clearTimeout(previous)
  publishTimers.set(name, window.setTimeout(() => {
    publishTimers.delete(name)
    const values = owners.get(name)
    if (!values || restoring || typeof window === 'undefined' || !window.donwells.guiDraftsWrite) return
    void window.donwells.guiDraftsWrite(name, JSON.stringify([...values])).catch(error => {
      window.dispatchEvent(new CustomEvent('gui-draft-error', { detail: String(error) }))
    })
  }, 250))
}

export function guiDraftMap<T>(name: string): Map<string, T> {
  const values = new Map<string, T>()
  values.set = (key, value) => { Map.prototype.set.call(values, key, value); schedulePublish(name); return values }
  values.delete = key => { const removed = Map.prototype.delete.call(values, key); if (removed) schedulePublish(name); return removed }
  values.clear = () => { Map.prototype.clear.call(values); schedulePublish(name) }
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
