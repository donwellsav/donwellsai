export type ProjectLanguageStatus = { state:'ready'|'unavailable'|'failed'|'stopped'|'paused'|'starting'; generation:number; version:string|null; detail:string; pid?:number; documents?:number }
export type ProjectLanguageDiagnostic = { start:{line:number;column:number}; end:{line:number;column:number}; severity:'error'|'warning'|'info'; code:number; message:string }
export type ProjectLanguageDefinition = { path:string; start:{line:number;column:number}; end:{line:number;column:number} }
export type ProjectLanguageDocument = { workspacePath:string; path:string; version:number; content:string }
export type ProjectLanguageApi = {
  projectLanguageStatus(workspacePath:string):Promise<ProjectLanguageStatus>
  projectLanguageStop(workspacePath:string):Promise<ProjectLanguageStatus>
  projectLanguageOpen(document:ProjectLanguageDocument):Promise<ProjectLanguageStatus>
  projectLanguageChange(document:ProjectLanguageDocument):Promise<ProjectLanguageStatus>
  projectLanguageClose(workspacePath:string,path:string):Promise<void>
  projectLanguageDiagnostics(document:ProjectLanguageDocument):Promise<{generation:number;version:number;diagnostics:ProjectLanguageDiagnostic[]}>
  projectLanguageDefinition(document:ProjectLanguageDocument,line:number,column:number):Promise<{generation:number;version:number;definitions:ProjectLanguageDefinition[]}>
  projectLanguageReferences(document:ProjectLanguageDocument,line:number,column:number):Promise<{generation:number;version:number;references:ProjectLanguageDefinition[]}>
  projectLanguageRestart(workspacePath:string):Promise<ProjectLanguageStatus>
}
