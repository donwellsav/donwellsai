import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { resolveDocumentLink } from './document-navigation'
import {
  getDocumentViewState,
  saveDocumentViewState,
  type MarkdownViewState
} from './document-view-state'
import { useAppStore } from './store'

type MarkdownRenderCheckpoint = Readonly<{
  token: number
  interaction: number
}>

type MarkdownViewRefs = Readonly<{
  hostRef: RefObject<HTMLDivElement | null>
  scrollRef: RefObject<HTMLDivElement | null>
}>

const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

function navigationErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function reportNavigationError(message: string): void {
  useAppStore.getState().setError(message)
}

function displayLink(href: string): string {
  const compact = href.replace(/\s+/g, ' ').trim()
  return compact.length <= 120 ? compact : compact.slice(0, 117) + '…'
}

function findMarkdownAnchor(host: HTMLElement, anchor: string): HTMLElement | undefined {
  for (const element of host.querySelectorAll<HTMLElement>('[id]')) {
    if (element.id === anchor) return element
  }
  return undefined
}

function activeMarkdownHeading(host: HTMLElement, scroller: HTMLElement): string | undefined {
  const threshold = scroller.getBoundingClientRect().top + 96
  let active: string | undefined
  for (const heading of host.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]')) {
    if (heading.getBoundingClientRect().top > threshold) break
    active = heading.id
  }
  return active
}

function anchorScrollTop(host: HTMLElement, scroller: HTMLElement, anchor: string): number | undefined {
  if (anchor === '') return 0
  const target = findMarkdownAnchor(host, anchor)
  if (!target) return undefined
  return Math.max(
    0,
    scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  )
}

function scrollToMarkdownAnchor(
  host: HTMLElement,
  scroller: HTMLElement,
  anchor: string,
  behavior: ScrollBehavior
): number | undefined {
  const top = anchorScrollTop(host, scroller, anchor)
  if (top === undefined) return undefined
  scroller.scrollTo({ top, behavior })
  return top
}

/**
 * Owns Markdown-only link routing and view continuity. Render work stays in the
 * preview component; this hook correlates its async completions with saved
 * scroll state and versioned navigation targets from the store.
 */
export function useMarkdownView(
  worktreePath: string,
  relPath: string,
  { hostRef, scrollRef }: MarkdownViewRefs
): Readonly<{
  beginRender: () => MarkdownRenderCheckpoint
  finishRender: (checkpoint: MarkdownRenderCheckpoint) => void
  failRender: (checkpoint: MarkdownRenderCheckpoint) => void
  navigateToAnchor: (anchor: string) => void
}> {
  const navigation = useAppStore((state) => state.documentNavigation[worktreePath]?.[relPath])
  const navigationRef = useRef(navigation)
  const renderTokenRef = useRef(0)
  const renderReadyRef = useRef(false)
  const interactionRef = useRef(0)
  const consumedNavigationRef = useRef<number | undefined>(undefined)
  const pendingRestoreRef = useRef<MarkdownViewState | undefined>(undefined)
  const latestStateRef = useRef<MarkdownViewState | undefined>(undefined)
  navigationRef.current = navigation

  const captureState = useCallback((): MarkdownViewState | undefined => {
    const host = hostRef.current
    const scroller = scrollRef.current
    if (!host || !scroller) return undefined
    const anchor = activeMarkdownHeading(host, scroller)
    return {
      scrollTop: Math.max(0, scroller.scrollTop),
      ...(anchor ? { anchor } : {}),
      ...(consumedNavigationRef.current !== undefined
        ? { navigationGeneration: consumedNavigationRef.current }
        : {})
    }
  }, [hostRef, scrollRef])

  const applyReadyPosition = useCallback((restoreInteraction?: number): void => {
    if (!renderReadyRef.current) return
    const host = hostRef.current
    const scroller = scrollRef.current
    if (!host || !scroller) return

    const target = navigationRef.current
    if (
      target?.anchor !== undefined &&
      target.mode !== 'edit' &&
      target.generation !== consumedNavigationRef.current
    ) {
      pendingRestoreRef.current = undefined
      consumedNavigationRef.current = target.generation
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const top = scrollToMarkdownAnchor(host, scroller, target.anchor, reducedMotion ? 'auto' : 'smooth')
      if (top === undefined) {
        reportNavigationError(`Section “${displayLink(target.anchor)}” was not found in ${relPath}`)
      }
      const state: MarkdownViewState = {
        scrollTop: top ?? Math.max(0, scroller.scrollTop),
        ...(top !== undefined && target.anchor ? { anchor: target.anchor } : {}),
        navigationGeneration: target.generation
      }
      latestStateRef.current = state
      saveDocumentViewState(worktreePath, relPath, 'preview', state)
      return
    }

    const pending = pendingRestoreRef.current
    if (pending && restoreInteraction === interactionRef.current) {
      scroller.scrollTo({ top: Math.max(0, pending.scrollTop), behavior: 'auto' })
      if (
        pending.anchor &&
        scroller.scrollTop + 1 < pending.scrollTop
      ) {
        scrollToMarkdownAnchor(host, scroller, pending.anchor, 'auto')
      }
    }
    pendingRestoreRef.current = undefined
    const state = captureState()
    if (state) {
      latestStateRef.current = state
      saveDocumentViewState(worktreePath, relPath, 'preview', state)
    }
  }, [captureState, hostRef, relPath, scrollRef, worktreePath])

  const beginRender = useCallback((): MarkdownRenderCheckpoint => {
    if (renderReadyRef.current) {
      const state = captureState()
      if (state) {
        pendingRestoreRef.current = state
        latestStateRef.current = state
      }
    }
    renderReadyRef.current = false
    return { token: ++renderTokenRef.current, interaction: interactionRef.current }
  }, [captureState])

  const finishRender = useCallback((checkpoint: MarkdownRenderCheckpoint): void => {
    if (checkpoint.token !== renderTokenRef.current) return
    renderReadyRef.current = true
    applyReadyPosition(checkpoint.interaction)
  }, [applyReadyPosition])

  const failRender = useCallback((checkpoint: MarkdownRenderCheckpoint): void => {
    if (checkpoint.token === renderTokenRef.current) renderReadyRef.current = false
  }, [])

  const navigateLink = useCallback((href: string): void => {
    const resolved = resolveDocumentLink(relPath, href)
    if (!resolved) {
      reportNavigationError(`Unsupported or invalid document link: ${displayLink(href) || '(empty link)'}`)
      return
    }
    if (resolved.kind === 'external') {
      void window.donwells.openExternal(resolved.href).catch((error: unknown) => {
        reportNavigationError(`Could not open external link: ${navigationErrorMessage(error)}`)
      })
      return
    }

    const openPreview = useAppStore.getState().openPreview
    const operation = resolved.kind === 'anchor'
      ? openPreview(worktreePath, relPath, { mode: 'preview', anchor: resolved.anchor })
      : openPreview(worktreePath, resolved.relPath, {
          mode: resolved.mode,
          ...(resolved.line !== undefined ? { line: resolved.line } : {}),
          ...(resolved.column !== undefined ? { column: resolved.column } : {}),
          ...(resolved.anchor !== undefined
            ? { anchor: resolved.anchor }
            : resolved.mode === 'preview'
              ? { anchor: '' }
              : {})
        })
    void operation.catch((error: unknown) => {
      reportNavigationError(`Could not open document link: ${navigationErrorMessage(error)}`)
    })
  }, [relPath, worktreePath])

  const navigateToAnchor = useCallback((anchor: string): void => {
    navigateLink('#' + encodeURIComponent(anchor))
  }, [navigateLink])

  useEffect(() => {
    renderTokenRef.current += 1
    renderReadyRef.current = false
    interactionRef.current = 0
    const saved = getDocumentViewState(worktreePath, relPath, 'preview')
    pendingRestoreRef.current = saved
    latestStateRef.current = saved
    consumedNavigationRef.current = saved?.navigationGeneration

    const scroller = scrollRef.current
    if (!scroller) return
    const onUserScrollIntent = (): void => {
      interactionRef.current += 1
    }
    const onScroll = (): void => {
      if (!renderReadyRef.current) return
      const state = captureState()
      if (state) latestStateRef.current = state
    }
    for (const event of USER_SCROLL_EVENTS) scroller.addEventListener(event, onUserScrollIntent, { passive: true })
    scroller.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      renderTokenRef.current += 1
      renderReadyRef.current = false
      for (const event of USER_SCROLL_EVENTS) scroller.removeEventListener(event, onUserScrollIntent)
      scroller.removeEventListener('scroll', onScroll)
      const state = latestStateRef.current
      if (state) saveDocumentViewState(worktreePath, relPath, 'preview', state)
    }
  }, [captureState, relPath, scrollRef, worktreePath])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return
      const link = event.target.closest('a[href]')
      if (!link || !host.contains(link)) return
      event.preventDefault()
      event.stopPropagation()
      navigateLink(link.getAttribute('href') ?? '')
    }
    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
  }, [hostRef, navigateLink])

  useEffect(() => {
    if (navigation?.anchor !== undefined) applyReadyPosition()
  }, [applyReadyPosition, navigation?.anchor, navigation?.generation])

  return { beginRender, finishRender, failRender, navigateToAnchor }
}
