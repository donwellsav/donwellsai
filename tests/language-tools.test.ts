import { afterEach, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor/editor'
const controls = vi.hoisted(() => ({ worker: vi.fn(), restart: undefined as undefined | (() => void) }))
vi.mock('monaco-editor/languages/features/typescript/register.js', () => ({
  getTypeScriptWorker: async () => controls.worker,
  getJavaScriptWorker: async () => controls.worker,
  typescriptDefaults: { onDidChange: (callback: () => void) => { controls.restart = callback; return { dispose() {} } } },
  javascriptDefaults: { onDidChange: () => ({ dispose() {} }) }
}))
import { installLanguageDiagnostics } from '../src/renderer/src/language-diagnostics'

afterEach(() => vi.useRealTimers())
it('discards stale diagnostics and recovers a failed worker without changing the text model', async () => {
  vi.useFakeTimers()
  let version = 1
  let changed = (): void => {}
  let removed = (_model: unknown): void => {}
  const old = Promise.withResolvers<unknown[]>()
  const semantic = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue([])
  controls.worker.mockReset().mockResolvedValue({ getSyntacticDiagnostics: async () => [], getSemanticDiagnostics: semantic })
  const markers = vi.fn()
  const errors = vi.fn()
  const model = {
    getLanguageId: () => 'typescript', getVersionId: () => version, isDisposed: () => false,
    uri: { toString: () => 'file:///checkout/main.ts' }, getPositionAt: () => ({ lineNumber: 1, column: 1 }),
    onDidChangeContent: (callback: () => void) => { changed = callback; return { dispose() {} } }
  }
  const monaco = {
    MarkerSeverity: { Error: 8, Warning: 4 },
    editor: {
      setModelMarkers: markers, getModels: () => [model], onDidCreateModel() {}, onDidChangeModelLanguage() {},
      onWillDisposeModel: (callback: typeof removed) => { removed = callback }
    }
  }
  installLanguageDiagnostics(monaco as unknown as typeof Monaco, errors)
  await vi.advanceTimersByTimeAsync(300)
  version++; changed()
  old.resolve([{ start: 0, length: 1, category: 1, code: 2322, messageText: 'stale error' }])
  await vi.advanceTimersByTimeAsync(300)
  expect(markers.mock.calls.every((call) => call[2].length === 0)).toBe(true)
  controls.worker.mockRejectedValueOnce(new Error('worker crashed'))
  version++; changed()
  await vi.advanceTimersByTimeAsync(300)
  expect(errors).toHaveBeenCalledWith(expect.stringContaining('Restart TypeScript'))
  semantic.mockResolvedValue([{ start: 0, length: 1, category: 1, code: 2322, messageText: 'current error' }])
  controls.restart?.()
  await vi.advanceTimersByTimeAsync(300)
  expect(markers).toHaveBeenLastCalledWith(model, 'donwells-language', [expect.objectContaining({ message: 'current error', code: '2322' })])
  expect(version).toBe(3)
  removed(model)
  expect(markers).toHaveBeenLastCalledWith(model, 'donwells-language', [])
})
