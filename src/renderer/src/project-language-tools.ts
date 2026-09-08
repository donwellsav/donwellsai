import type * as Monaco from 'monaco-editor/editor'
import type { ProjectLanguageDocument, ProjectLanguageStatus } from '@shared/project-language-tools'

const attached = new Set<string>()
export const isProjectLanguageAttached = (uri: string): boolean => attached.has(uri)

export function attachProjectLanguageTools(monaco: typeof Monaco, model: Monaco.editor.ITextModel, workspacePath: string, path: string, report: (message: string) => void) {
  const plainErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')
  const language = model.getLanguageId()
  if (language !== 'typescript' && language !== 'javascript') return { restart: async () => undefined, definition: async () => undefined, references: async () => [], dispose: () => undefined }
  let active = true, generation = 0, timer: ReturnType<typeof setTimeout>, status: ProjectLanguageStatus | null = null
  const document = (): ProjectLanguageDocument => ({ workspacePath, path, version: model.getVersionId(), content: model.getValue() })
  const fallback = (error: unknown) => { attached.delete(model.uri.toString()); monaco.editor.setModelMarkers(model, 'donwells-project-language', []); report(`Project language tools unavailable: ${plainErrorMessage(error)}. Open-file TypeScript tools remain active.`) }
  const validate = async () => {
    const request = ++generation, version = model.getVersionId()
    try {
      const result = await window.donwells.projectLanguageDiagnostics(document())
      if (!active || request !== generation || version !== model.getVersionId() || result.generation !== status?.generation) return
      monaco.editor.setModelMarkers(model, 'donwells-project-language', result.diagnostics.map(item => ({ startLineNumber:item.start.line,startColumn:item.start.column,endLineNumber:item.end.line,endColumn:item.end.column,severity:item.severity==='error'?monaco.MarkerSeverity.Error:item.severity==='warning'?monaco.MarkerSeverity.Warning:monaco.MarkerSeverity.Info,message:item.message,code:String(item.code),source:'TypeScript · project' })))
    } catch (error) { if (active && request === generation) fallback(error) }
  }
  const schedule = () => { clearTimeout(timer); timer=setTimeout(()=>void validate(),300) }
  void window.donwells.projectLanguageOpen(document()).then(next => { if(!active)return;status=next;attached.add(model.uri.toString());monaco.editor.setModelMarkers(model,'donwells-language',[]);schedule() }).catch(fallback)
  const change=model.onDidChangeContent(()=>{if(status)schedule()})
  return {
    restart: async () => { status=await window.donwells.projectLanguageRestart(workspacePath);attached.add(model.uri.toString());await window.donwells.projectLanguageChange(document());schedule() },
    definition: async (line:number,column:number) => { const result=await window.donwells.projectLanguageDefinition(document(),line,column);if(result.version!==model.getVersionId()||result.generation!==status?.generation)return undefined;return result.definitions[0] },
    references: async (line:number,column:number) => { const result=await window.donwells.projectLanguageReferences(document(),line,column);if(result.version!==model.getVersionId()||result.generation!==status?.generation)return [];return result.references },
    dispose: () => { active=false;generation++;clearTimeout(timer);change.dispose();attached.delete(model.uri.toString());monaco.editor.setModelMarkers(model,'donwells-project-language',[]);void window.donwells.projectLanguageClose(workspacePath,path).catch(()=>undefined) }
  }
}
