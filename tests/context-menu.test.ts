import { afterEach, expect, it, vi } from 'vitest'
import type { KeyboardEvent } from 'react'
import { contextMenuKey, focusContextMenu } from '../src/renderer/src/context-menu'

afterEach(() => vi.unstubAllGlobals())

it('keeps menus in the viewport and supports wrapped keyboard navigation and Escape', () => {
  const items = [{ focus: vi.fn(), getClientRects: () => [{}] }, { focus: vi.fn(), getClientRects: () => [{}] }]
  vi.stubGlobal('document', { activeElement: items[0] })
  vi.stubGlobal('window', { innerWidth: 900, innerHeight: 600 })
  const menu = {
    style: { left: '850px', top: '550px' },
    getBoundingClientRect: () => ({ right: 1010, bottom: 690 }),
    querySelector: () => items[0], querySelectorAll: () => items
  }
  focusContextMenu(menu as unknown as HTMLDivElement)
  expect(menu.style).toEqual({ left: '732px', top: '452px' })
  const close = vi.fn()
  const event = { key: 'ArrowUp', currentTarget: menu, preventDefault: vi.fn(), stopPropagation: vi.fn() }
  contextMenuKey(event as unknown as KeyboardEvent<HTMLDivElement>, close)
  expect(items[1]!.focus).toHaveBeenCalledOnce()
  event.key = 'Escape'
  contextMenuKey(event as unknown as KeyboardEvent<HTMLDivElement>, close)
  expect(close).toHaveBeenCalledOnce()
  expect(event.stopPropagation).toHaveBeenCalledOnce()
  event.preventDefault.mockClear()
  contextMenuKey({ ...event, key: 'Home', target: { tagName: 'INPUT' } } as unknown as KeyboardEvent<HTMLDivElement>, close)
  expect(event.preventDefault).not.toHaveBeenCalled()
})

it('skips collapsed menu contents and enters at the last visible item on ArrowUp', () => {
  const hidden = { focus: vi.fn(), getClientRects: () => [] }
  const first = { focus: vi.fn(), getClientRects: () => [{}] }
  const last = { focus: vi.fn(), getClientRects: () => [{}] }
  vi.stubGlobal('document', { activeElement: null })
  const close = vi.fn(), preventDefault = vi.fn()
  const event = { key: 'ArrowUp', currentTarget: { querySelector: () => null, querySelectorAll: () => [first, last, hidden] }, preventDefault }
  contextMenuKey(event as unknown as KeyboardEvent<HTMLDivElement>, close)
  expect(last.focus).toHaveBeenCalledOnce()
  expect(hidden.focus).not.toHaveBeenCalled()
  preventDefault.mockClear()
  contextMenuKey({ ...event, key: 'Tab' } as unknown as KeyboardEvent<HTMLDivElement>, close)
  expect(close).toHaveBeenCalledOnce()
  expect(preventDefault).not.toHaveBeenCalled()
  close.mockClear()
  contextMenuKey({ ...event, key: 'Tab', currentTarget: { querySelector: () => ({ tagName: 'INPUT' }) } } as unknown as KeyboardEvent<HTMLDivElement>, close)
  expect(close).not.toHaveBeenCalled()
})
