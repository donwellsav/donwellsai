import { MAX_IMAGE_PREVIEW_PIXELS } from '@shared/media-preview'
import type * as PdfJsModule from 'pdfjs-dist'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'

export type PdfJsEngine = typeof PdfJsModule

let enginePromise: Promise<PdfJsEngine> | null = null

export function pdfAssetUrl(path: string): string {
  return new URL(`./pdfjs/${path}`, document.baseURI).toString()
}

/** PDF.js is a large engine; only PDF panes pay its parse/evaluation cost. */
export function loadPdfEngine(): Promise<PdfJsEngine> {
  if (!enginePromise) {
    enginePromise = import('pdfjs-dist').then((engine) => {
      engine.GlobalWorkerOptions.workerSrc = pdfAssetUrl('pdf.worker.min.mjs')
      return engine
    }).catch((error: unknown) => {
      enginePromise = null
      throw error
    })
  }
  return enginePromise
}

export async function createLocalPdfLoadingTask(bytes: Uint8Array): Promise<PDFDocumentLoadingTask> {
  const engine = await loadPdfEngine()
  return engine.getDocument({
    data: bytes,
    cMapUrl: pdfAssetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: pdfAssetUrl('standard_fonts/'),
    wasmUrl: pdfAssetUrl('wasm/'),
    iccUrl: pdfAssetUrl('iccs/'),
    useWorkerFetch: false,
    useWasm: true,
    useSystemFonts: true,
    stopAtErrors: true,
    maxImageSize: MAX_IMAGE_PREVIEW_PIXELS,
    canvasMaxAreaInBytes: MAX_IMAGE_PREVIEW_PIXELS * 4,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    ownerDocument: document
  })
}

export function textSegmentsFromContent(content: TextContent): string[] {
  const segments: string[] = []
  for (const item of content.items) {
    if ('str' in item) segments.push(item.str)
  }
  return segments
}
