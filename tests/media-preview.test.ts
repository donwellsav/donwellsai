import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  IMAGE_PREVIEW_BYTE_LIMIT,
  mediaPreviewDescriptorForPath,
  validateBinaryPreviewGeneration,
  validateBinaryPreviewPayload,
  validateBinaryPreviewRequest
} from '../src/shared/media-preview'
import { readBinaryPreview } from '../src/main/binary-preview'
import {
  findTextMatches,
  imageScaleForFit,
  pdfScaleForFit,
  textSegmentsForMatch
} from '../src/renderer/src/media-preview'

const roots: string[] = []
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'donwells-media-'))
  roots.push(root)
  return root
}

function deterministicPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 40 120 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')]
  const offsets: number[] = [0]
  let length = parts[0]!.byteLength
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(length)
    const object = Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`, 'latin1')
    parts.push(object)
    length += object.byteLength
  }
  const xrefOffset = length
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  ].join('')
  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('media preview transport', () => {
  it('classifies only inert raster formats and PDFs', () => {
    expect(mediaPreviewDescriptorForPath('art/PHOTO.JPEG')).toEqual({ kind: 'image', mime: 'image/jpeg' })
    expect(mediaPreviewDescriptorForPath('docs/report.PDF')).toEqual({ kind: 'pdf', mime: 'application/pdf' })
    expect(mediaPreviewDescriptorForPath('art/active.svg')).toBeNull()
    expect(mediaPreviewDescriptorForPath('README.md')).toBeNull()
  })

  it('returns complete typed bytes with correlated generations and matching MIME', async () => {
    const root = await workspace()
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'pixel.png'), ONE_PIXEL_PNG)
    await writeFile(join(root, 'docs', 'sample.pdf'), deterministicPdf('Alpha beta Alpha'))

    const image = await readBinaryPreview(root, { path: 'pixel.png', kind: 'image', generation: 7 })
    expect(image).toMatchObject({
      path: 'pixel.png', kind: 'image', mime: 'image/png', size: ONE_PIXEL_PNG.byteLength, generation: 7
    })
    expect(image.bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(image.bytes)).toBe(false)
    expect(Buffer.from(image.bytes).equals(ONE_PIXEL_PNG)).toBe(true)

    const pdf = await readBinaryPreview(root, { path: 'docs/sample.pdf', kind: 'pdf', generation: 8 })
    const validated = validateBinaryPreviewPayload(pdf, { path: 'docs/sample.pdf', kind: 'pdf', generation: 8 })
    expect(validated.bytes.byteLength).toBe(validated.size)

    const loadingTask = getDocument({ data: validated.bytes, stopAtErrors: true, useSystemFonts: true })
    try {
      const parsed = await loadingTask.promise
      expect(parsed.numPages).toBe(1)
      const page = await parsed.getPage(1)
      const content = await page.getTextContent()
      const text = content.items.flatMap((item) => 'str' in item ? [item.str] : []).join('')
      expect(text).toContain('Alpha beta Alpha')
    } finally {
      await loadingTask.destroy()
    }
  })

  it('rejects header mismatches, malformed PDFs, and unsupported active markup', async () => {
    const root = await workspace()
    await writeFile(join(root, 'not-a-pdf.pdf'), ONE_PIXEL_PNG)
    await writeFile(join(root, 'truncated.pdf'), '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')
    await writeFile(join(root, 'active.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script /></svg>')

    await expect(readBinaryPreview(root, { path: 'not-a-pdf.pdf', kind: 'pdf', generation: 1 }))
      .rejects.toMatchObject({ code: 'malformed' })
    await expect(readBinaryPreview(root, { path: 'truncated.pdf', kind: 'pdf', generation: 2 }))
      .rejects.toMatchObject({ code: 'malformed' })
    await expect(readBinaryPreview(root, { path: 'active.svg', kind: 'image', generation: 3 }))
      .rejects.toMatchObject({ code: 'unsupported' })
  })

  it('rejects traversal, direct symlinks, oversized files, and cancelled reads', async () => {
    const root = await workspace()
    const outside = await workspace()
    await writeFile(join(outside, 'outside.png'), ONE_PIXEL_PNG)
    await symlink(join(outside, 'outside.png'), join(root, 'linked.png'))
    await writeFile(join(root, 'huge.png'), '')
    await truncate(join(root, 'huge.png'), IMAGE_PREVIEW_BYTE_LIMIT + 1)
    await writeFile(join(root, 'pixel.png'), ONE_PIXEL_PNG)

    await expect(readBinaryPreview(root, { path: '../outside.png', kind: 'image', generation: 1 }))
      .rejects.toThrow('Path escapes worktree')
    await expect(readBinaryPreview(root, { path: 'linked.png', kind: 'image', generation: 2 }))
      .rejects.toThrow('Path escapes worktree')
    await expect(readBinaryPreview(root, { path: 'huge.png', kind: 'image', generation: 3 }))
      .rejects.toMatchObject({ code: 'too-large' })

    const controller = new AbortController()
    controller.abort()
    await expect(readBinaryPreview(root, { path: 'pixel.png', kind: 'image', generation: 4 }, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' })
  })

  it('validates request and response generations instead of accepting stale payloads', () => {
    expect(validateBinaryPreviewGeneration(7)).toBe(7)
    expect(() => validateBinaryPreviewGeneration(Number.NaN)).toThrow('generation')
    expect(() => validateBinaryPreviewRequest({ path: 'x.png', kind: 'image', generation: -1 })).toThrow('generation')
    expect(() => validateBinaryPreviewRequest({ path: 'x.png', kind: 'image', generation: 1, extra: true })).toThrow('request')
    expect(() => validateBinaryPreviewPayload({
      path: 'x.png', kind: 'image', mime: 'image/png', size: 1, generation: 1, bytes: new Uint8Array(1)
    }, { path: 'x.png', kind: 'image', generation: 2 })).toThrow('Stale')
  })
})

describe('media preview consumer calculations', () => {
  it('fits images and PDF pages without losing actual-size semantics', () => {
    expect(imageScaleForFit('contain', { width: 400, height: 200 }, { width: 1_000, height: 1_000 })).toBe(1)
    expect(imageScaleForFit('width', { width: 400, height: 200 }, { width: 1_000, height: 300 })).toBe(2.5)
    expect(pdfScaleForFit('page', { width: 600, height: 800 }, { width: 900, height: 600 })).toBe(0.75)
    expect(pdfScaleForFit('actual', { width: 600, height: 800 }, { width: 300, height: 300 })).toBe(1)
  })

  it('counts literal case-insensitive matches and maps cross-span highlights exactly', () => {
    expect(findTextMatches('Alpha alpha ALPHA', 'alpha', 4)).toEqual([
      { page: 4, index: 0, length: 5 },
      { page: 4, index: 6, length: 5 },
      { page: 4, index: 12, length: 5 }
    ])
    expect(findTextMatches('a.b a-b', 'a.b', 1)).toEqual([{ page: 1, index: 0, length: 3 }])
    expect(findTextMatches('x x x', 'x', 2, 2)).toEqual([
      { page: 2, index: 0, length: 1 },
      { page: 2, index: 2, length: 1 }
    ])
    expect(textSegmentsForMatch(['pre al', 'pha po', 'st'], { index: 4, length: 5 })).toEqual([
      { segment: 0, start: 4, end: 6 },
      { segment: 1, start: 0, end: 3 }
    ])
  })
})
