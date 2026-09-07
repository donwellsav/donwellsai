import type * as Monaco from 'monaco-editor/editor'
import { getTypeScriptWorker, getJavaScriptWorker, typescriptDefaults, javascriptDefaults, type Diagnostic } from 'monaco-editor/languages/features/typescript/register.js'

function messageText(message: Diagnostic['messageText']): string {
  return typeof message === 'string' ? message : [message.messageText, ...(message.next ?? []).map(messageText)].join('\n')
}

export function installLanguageDiagnostics(monaco: typeof Monaco, reportError: (message: string) => void): void {
  const listeners = new Map<Monaco.editor.ITextModel, () => void>()
  const attach = (model: Monaco.editor.ITextModel): void => {
    listeners.get(model)?.()
    const language = model.getLanguageId()
    if (language !== 'typescript' && language !== 'javascript') return
    let generation = 0
    let timer: ReturnType<typeof setTimeout>
    const validate = async (): Promise<void> => {
      const request = ++generation
      const version = model.getVersionId()
      const current = (): boolean => !model.isDisposed() && request === generation && version === model.getVersionId()
      try {
        const getWorker = await (language === 'typescript' ? getTypeScriptWorker() : getJavaScriptWorker())
        const worker = await getWorker(model.uri)
        if (!current()) return
        const results = await Promise.all([
          worker.getSyntacticDiagnostics(model.uri.toString()),
          ...(language === 'typescript' ? [worker.getSemanticDiagnostics(model.uri.toString())] : [])
        ])
        if (!current()) return
        monaco.editor.setModelMarkers(model, 'donwells-language', results.flat().map((diagnostic) => {
          const start = model.getPositionAt(diagnostic.start ?? 0)
          const end = model.getPositionAt((diagnostic.start ?? 0) + (diagnostic.length ?? 1))
          return {
            startLineNumber: start.lineNumber, startColumn: start.column,
            endLineNumber: end.lineNumber, endColumn: end.column,
            severity: diagnostic.category === 1 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
            message: messageText(diagnostic.messageText), code: String(diagnostic.code), source: 'TypeScript · open files'
          }
        }))
      } catch (error) {
        if (current()) reportError(`Language tools failed: ${String(error)}. Use “Restart TypeScript / JavaScript tools” in the editor command menu.`)
      }
    }
    const schedule = (): void => {
      generation++
      clearTimeout(timer)
      monaco.editor.setModelMarkers(model, 'donwells-language', [])
      timer = setTimeout(() => { void validate() }, 300)
    }
    const changes = model.onDidChangeContent(schedule)
    const defaults = language === 'typescript' ? typescriptDefaults : javascriptDefaults
    const restart = defaults.onDidChange(schedule)
    listeners.set(model, () => {
      generation++
      clearTimeout(timer)
      changes.dispose()
      restart.dispose()
      listeners.delete(model)
      monaco.editor.setModelMarkers(model, 'donwells-language', [])
    })
    schedule()
  }
  monaco.editor.onDidCreateModel(attach)
  monaco.editor.onDidChangeModelLanguage(({ model }) => attach(model))
  monaco.editor.onWillDisposeModel((model) => listeners.get(model)?.())
  for (const model of monaco.editor.getModels()) attach(model)
}
