import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { BrowserCommandRouter } from '../browser-routing'
import { BrowserPane } from './BrowserPane'

type HostBounds = {
  key: string
  left: number
  top: number
  width: number
  height: number
}

/**
 * Stable browser host layer. Every worktree guest stays mounted exactly once;
 * the active worktree's guest is aligned over its split-layout Workbench slot.
 */
export function BrowserHosts() {
  const panes = useAppStore((state) => state.panes)
  const activeWorktreePath = useAppStore((state) => state.activeWorktreePath)
  const activePaneKey = useAppStore((state) =>
    state.activeWorktreePath ? state.activePane[state.activeWorktreePath] : undefined
  )
  const activeLayout = useAppStore((state) =>
    state.activeWorktreePath ? state.layouts[state.activeWorktreePath] : undefined
  )
  const layerRef = useRef<HTMLDivElement>(null)
  const routerRef = useRef<BrowserCommandRouter | null>(null)
  const [bounds, setBounds] = useState<HostBounds | null>(null)

  if (!routerRef.current) {
    routerRef.current = new BrowserCommandRouter({
      activeKey: () => useAppStore.getState().activeWorktreePath,
      hasPane: (key) => useAppStore.getState().panes[key]?.some((pane) => pane.kind === 'browser' && !!pane.url) ?? false,
      openPane: (key, nextUrl) => useAppStore.getState().openBrowser(key, nextUrl)
    })
  }
  const router = routerRef.current

  useEffect(() => {
    const unsubscribe = window.donwells.onBrowserCommand(async ({ id, cmd }) => {
      try {
        const result = await router.route(cmd)
        window.donwells.resolveBrowserCommand(id, { ok: true, result })
      } catch (reason) {
        window.donwells.resolveBrowserCommand(id, {
          ok: false,
          error: reason instanceof Error ? reason.message : String(reason)
        })
      }
    })
    window.donwells.browserRouterReady?.()
    return () => {
      unsubscribe()
      router.cancelPending()
    }
  }, [router])

  useLayoutEffect(() => {
    const layer = layerRef.current
    const stage = layer?.parentElement
    if (!layer || !stage || !activeWorktreePath) {
      setBounds(null)
      return
    }

    let slot: HTMLElement | null = null
    let resizeObserver: ResizeObserver
    const measure = (): void => {
      const nextSlot = [...stage.querySelectorAll<HTMLElement>('.browser-pane-slot')]
        .find((candidate) => candidate.dataset.browserWorktree === activeWorktreePath) ?? null
      if (slot !== nextSlot) {
        if (slot) resizeObserver.unobserve(slot)
        slot = nextSlot
        if (slot) resizeObserver.observe(slot)
      }
      if (!slot) {
        setBounds(null)
        return
      }
      const stageRect = stage.getBoundingClientRect()
      const slotRect = slot.getBoundingClientRect()
      if (slotRect.width <= 0 || slotRect.height <= 0) {
        setBounds(null)
        return
      }
      const next: HostBounds = {
        key: activeWorktreePath,
        left: slotRect.left - stageRect.left,
        top: slotRect.top - stageRect.top,
        width: slotRect.width,
        height: slotRect.height
      }
      setBounds((current) =>
        current?.key === next.key &&
        current.left === next.left &&
        current.top === next.top &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next
      )
    }
    resizeObserver = new ResizeObserver(measure)
    const mutationObserver = new MutationObserver(measure)

    resizeObserver.observe(stage)
    mutationObserver.observe(stage, { childList: true, subtree: true })
    measure()
    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [activeWorktreePath, activePaneKey, activeLayout])

  const browsers = Object.entries(panes).flatMap(([worktreePath, worktreePanes]) => {
    const pane = worktreePanes.find((candidate) => candidate.kind === 'browser' && !!candidate.url)
    return pane?.url ? [{ worktreePath, paneKey: pane.key, url: pane.url }] : []
  })

  return (
    <div
      ref={layerRef}
      className="browser-hosts"
      style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}
    >
      {browsers.map(({ worktreePath, paneKey, url }) => {
        const visible = bounds?.key === worktreePath
        const activate = (): void => {
          const state = useAppStore.getState()
          if (state.activePane[worktreePath] !== paneKey) state.setActivePane(worktreePath, paneKey)
        }
        return (
          <div
            key={worktreePath}
            className="browser-host"
            data-browser-host={worktreePath}
            aria-hidden={!visible}
            onMouseDownCapture={activate}
            onFocusCapture={activate}
            style={{
              position: 'absolute',
              display: visible ? 'flex' : 'none',
              flexDirection: 'column',
              pointerEvents: 'auto',
              overflow: 'hidden',
              opacity: activePaneKey === paneKey ? 1 : 0.82,
              transition: 'opacity .14s ease',
              left: visible ? bounds.left : 0,
              top: visible ? bounds.top : 0,
              width: visible ? bounds.width : 0,
              height: visible ? bounds.height : 0
            }}
          >
            <BrowserPane
              worktreePath={worktreePath}
              url={url}
              router={router}
              active={visible && activePaneKey === paneKey}
            />
          </div>
        )
      })}
    </div>
  )
}
