import { describe, expect, it, vi } from 'vitest'
import {
  DESIGN_CAPTURE_BUDGET,
  buildDesignAttachmentDraft,
  clampDesignCapture,
  type DesignCapture
} from '../src/shared/design-capture'
import {
  captureDesignPreview,
  type DesignCaptureImage,
  type DesignCaptureWebview
} from '../src/renderer/src/design-capture'

function validRawCapture(): Record<string, unknown> {
  return {
    version: 1,
    url: 'https://user:password@example.test/settings?access_token=secret-value#private',
    title: 'Account api_key=sk-live-abcdefghijklmnopqrstuv',
    selector: '#save-button',
    tag: 'button',
    role: 'button',
    text: 'Save password=hunter2',
    bounds: {
      viewport: { x: 20, y: 30, width: 160, height: 44 },
      page: { x: 20, y: 230, width: 160, height: 44 }
    },
    viewport: { width: 800, height: 600 },
    styles: {
      display: 'inline-flex',
      position: 'relative',
      width: '160px',
      height: '44px',
      margin: '0',
      padding: '8px 12px',
      gap: '6px',
      color: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(10, 10, 12)',
      border: '1px solid rgb(40, 40, 44)',
      borderRadius: '8px',
      boxShadow: 'none',
      fontFamily: 'sans-serif',
      fontSize: '14px',
      fontWeight: '600',
      lineHeight: '20px',
      letterSpacing: '0',
      textAlign: 'center',
      opacity: '1',
      zIndex: 'auto'
    },
    domSnippet: '<form><input type="password" value="hunter2"><script>steal()</script></form><button>api_key=secret</button>'
  }
}

function validCapture(): DesignCapture {
  const capture = clampDesignCapture(validRawCapture())
  if (!capture) throw new Error('fixture capture should be valid')
  return capture
}
function previewCapture(): DesignCapture {
  return {
    ...validCapture(),
    title: 'Settings',
    text: 'Save',
    domSnippet: '<button id="save-button">Save</button>'
  }
}

describe('design capture privacy boundary', () => {
  it('removes URL credentials, secret values, and active or editable markup from untrusted captures', () => {
    const capture = validCapture()
    const serialized = JSON.stringify(capture)

    expect(capture.url).toBe('https://example.test/settings')
    expect(capture.title).toContain('[redacted]')
    expect(capture.text).toBe('Save password=[redacted]')
    expect(capture.domSnippet).toContain('excluded sensitive or active content')
    expect(capture.domSnippet).not.toMatch(/<input|<script|<form/i)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('sk-live-abcdefghijklmnopqrstuv')
  })

  it('rejects whole-document, form-control, invalid-protocol, and zero-area selections', () => {
    for (const tag of ['html', 'body', 'input', 'textarea', 'select', 'iframe']) {
      expect(clampDesignCapture({ ...validRawCapture(), tag })).toBeNull()
    }
    expect(clampDesignCapture({ ...validRawCapture(), url: 'javascript:alert(1)' })).toBeNull()
    expect(clampDesignCapture({
      ...validRawCapture(),
      bounds: {
        viewport: { x: 0, y: 0, width: 0, height: 40 },
        page: { x: 0, y: 0, width: 100, height: 40 }
      }
    })).toBeNull()
  })

  it('builds deterministic paste-only agent context without embedding the preview image', () => {
    const capture = validCapture()
    const first = buildDesignAttachmentDraft(capture, '/worktrees/product', 'Tighten spacing\r\nwithout changing copy')
    const second = buildDesignAttachmentDraft(capture, '/worktrees/product', 'Tighten spacing\r\nwithout changing copy')

    expect(first).toEqual(second)
    expect(first).toMatchObject({ kind: 'design-capture', workspacePath: '/worktrees/product' })
    expect(first.text).toContain('untrusted page data')
    expect(first.text).toContain('Preview only — the image is not transmitted.')
    expect(first.text).toContain('Tighten spacing\\nwithout changing copy')
    expect(first.text).not.toContain('data:image')
  })
})

describe('design capture screenshot preview', () => {
  it('requests only the bounded visible intersection and marks the image preview-only', async () => {
    const capturePage = vi.fn(async (): Promise<DesignCaptureImage> => ({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 590 }),
      toDataURL: () => 'data:image/png;base64,cHJldmlldw=='
    }))
    const webview: DesignCaptureWebview = {
      executeJavaScript: async () => null,
      capturePage
    }
    const capture = previewCapture()
    capture.bounds.viewport = { x: -20, y: 10, width: 2_000, height: 2_000 }

    await expect(captureDesignPreview(webview, capture)).resolves.toEqual({
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,cHJldmlldw==',
      width: 800,
      height: 590,
      previewOnly: true
    })
    expect(capturePage).toHaveBeenCalledWith({ x: 0, y: 10, width: 800, height: 590 })
  })
  it('does not create a pixel preview when the safe metadata required secret redaction', async () => {
    const capturePage = vi.fn()
    const webview: DesignCaptureWebview = {
      executeJavaScript: async () => null,
      capturePage
    }

    await expect(captureDesignPreview(webview, validCapture())).resolves.toBeNull()
    expect(capturePage).not.toHaveBeenCalled()
  })

  it('fails closed when a generated screenshot exceeds the renderer memory budget', async () => {
    const webview: DesignCaptureWebview = {
      executeJavaScript: async () => null,
      capturePage: async () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 160, height: 44 }),
        toDataURL: () => `data:image/png;base64,${'a'.repeat(DESIGN_CAPTURE_BUDGET.screenshotDataUrl)}`
      })
    }

    await expect(captureDesignPreview(webview, previewCapture())).resolves.toBeNull()
  })
})
