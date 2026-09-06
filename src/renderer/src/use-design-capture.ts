import type { AgentAttachmentDraft } from '@shared/agent-delivery'
import {
  buildDesignAttachmentDraft,
  clampDesignCapture,
  type DesignCapture,
  type DesignCaptureScreenshot
} from '@shared/design-capture'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  DESIGN_CAPTURE_BEGIN_SCRIPT,
  DESIGN_CAPTURE_CANCEL_SCRIPT,
  captureDesignPreview,
  type DesignCaptureWebview
} from './design-capture'

type UseDesignCaptureOptions = {
  webviewRef: RefObject<DesignCaptureWebview | null>
  workspacePath: string
  active: boolean
  ready: boolean
  loading: boolean
  loadError: string | null
  onBeforeSelect(): void
}

export function useDesignCapture({
  webviewRef,
  workspacePath,
  active,
  ready,
  loading,
  loadError,
  onBeforeSelect
}: UseDesignCaptureOptions) {
  const generationRef = useRef(0)
  const modeRef = useRef(false)
  const [mode, setMode] = useState(false)
  const [capture, setCapture] = useState<DesignCapture | null>(null)
  const [screenshot, setScreenshot] = useState<DesignCaptureScreenshot | null>(null)
  const [screenshotPending, setScreenshotPending] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [attachment, setAttachment] = useState<AgentAttachmentDraft | null>(null)

  const cancel = useCallback((): void => {
    generationRef.current += 1
    modeRef.current = false
    setMode(false)
    setScreenshotPending(false)
    const element = webviewRef.current
    if (!element) return
    void (element as unknown as DesignCaptureWebview).executeJavaScript(DESIGN_CAPTURE_CANCEL_SCRIPT).catch(() => {
      // Navigation or guest teardown can destroy the execution world before cleanup lands.
    })
  }, [webviewRef])

  const dispose = useCallback((): void => {
    generationRef.current += 1
    modeRef.current = false
    const element = webviewRef.current
    if (!element) return
    void (element as unknown as DesignCaptureWebview).executeJavaScript(DESIGN_CAPTURE_CANCEL_SCRIPT).catch(() => {})
  }, [webviewRef])

  const clear = useCallback((): void => {
    generationRef.current += 1
    setCapture(null)
    setScreenshot(null)
    setScreenshotPending(false)
    setNote('')
    setError(null)
    setAttachment(null)
  }, [])

  const navigationStarted = useCallback((): void => {
    if (modeRef.current) cancel()
    clear()
  }, [cancel, clear])

  const begin = useCallback((): void => {
    const element = webviewRef.current
    if (!element || !ready || loading || loadError) {
      setError('Design Mode is available after the page finishes loading.')
      return
    }

    onBeforeSelect()
    setCapture(null)
    setScreenshot(null)
    setScreenshotPending(false)
    setError(null)
    setAttachment(null)
    const generation = ++generationRef.current
    const webview = element as unknown as DesignCaptureWebview
    modeRef.current = true
    setMode(true)

    void webview.executeJavaScript(DESIGN_CAPTURE_BEGIN_SCRIPT, true).then(async (rawCapture) => {
      if (generationRef.current !== generation) return
      modeRef.current = false
      setMode(false)
      if (rawCapture === null) return

      const nextCapture = clampDesignCapture(rawCapture)
      if (!nextCapture) {
        setError('The selected page element could not be captured safely. Select a smaller, non-editable element.')
        return
      }
      setCapture(nextCapture)
      setScreenshotPending(true)
      const nextScreenshot = await captureDesignPreview(webview, nextCapture)
      if (generationRef.current !== generation) return
      setScreenshot(nextScreenshot)
      setScreenshotPending(false)
    }).catch(() => {
      if (generationRef.current !== generation) return
      modeRef.current = false
      setMode(false)
      setScreenshotPending(false)
      setError('Design Mode could not inspect this page safely.')
    })
  }, [loadError, loading, onBeforeSelect, ready, webviewRef])

  const attach = useCallback((): void => {
    if (!capture) return
    setAttachment(buildDesignAttachmentDraft(capture, workspacePath, note))
  }, [capture, note, workspacePath])
  const dismissError = useCallback((): void => {
    setError(null)
  }, [])

  const closeAttachment = useCallback((): void => {
    setAttachment(null)
  }, [])

  useEffect(() => {
    if (!active && modeRef.current) cancel()
  }, [active, cancel])


  return {
    mode,
    capture,
    screenshot,
    screenshotPending,
    note,
    error,
    attachment,
    begin,
    cancel,
    clear,
    dispose,
    navigationStarted,
    attach,
    setNote,
    dismissError,
    closeAttachment
  }
}
