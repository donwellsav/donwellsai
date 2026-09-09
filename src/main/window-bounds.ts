import type { Rectangle } from 'electron'

/** Keep restored windows reachable after a display is removed or resized. */
export function restoreWindowBounds(saved: Rectangle | undefined, workArea: Rectangle): Rectangle {
  const width = Math.min(workArea.width, Math.max(900, saved?.width ?? 1280))
  const height = Math.min(workArea.height, Math.max(600, saved?.height ?? 800))
  return {
    width, height,
    x: Math.round(Math.max(workArea.x, Math.min(saved?.x ?? workArea.x + (workArea.width - width) / 2, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(saved?.y ?? workArea.y + (workArea.height - height) / 2, workArea.y + workArea.height - height)))
  }
}
