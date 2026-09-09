import type { KeyboardEvent } from 'react'

export function focusContextMenu(menu: HTMLDivElement | null, selector = '[role="menuitem"]:not(:disabled)'): void {
  if (!menu) return
  const bounds = menu.getBoundingClientRect()
  menu.style.left = `${parseFloat(menu.style.left || '0') - Math.max(0, bounds.right - window.innerWidth + 8)}px`
  menu.style.top = `${parseFloat(menu.style.top || '0') - Math.max(0, bounds.bottom - window.innerHeight + 8)}px`
  menu.querySelector<HTMLElement>(selector)?.focus()
}

export function contextMenuKey(event: KeyboardEvent<HTMLDivElement>, close: () => void, selector = '[role="menuitem"]:not(:disabled)'): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key === 'Tab') {
    // Mixed popovers contain forms and filters; Tab must still reach their fields and submit button.
    if (!event.currentTarget.querySelector('input, textarea, select')) close()
    return
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement | undefined)?.tagName ?? '')) return
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)].filter(item => item.getClientRects().length > 0)
  if (items.length === 0) return
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}
