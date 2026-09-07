import { artifactPath } from '@shared/project-export'
export { artifactPath } from '@shared/project-export'
import transferDecoder from './project-kit-transfer.py?raw'
import { parseKnowledgeSelections } from '@shared/project-knowledge'
import type { ProjectKitKnowledge } from '@shared/project-export'
import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fsyncSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isObject } from '@shared/command-catalog'
import { parseProjectMemoryDocument, parseProjectMemoryIdentifier, type ProjectMemoryProjectDocument, type ProjectMemoryRevision } from '@shared/project-memory'
import { parseProjectHandoff, type ProjectHandoff } from '@shared/project-handoff'
import { INTEGRATED_PROJECT_TOOLS } from '@shared/project-doctor'
import { redactDesignCaptureSecrets } from '@shared/design-capture'
import { APP_WORKFLOW_FILES, validateProjectName } from '@shared/project-creation'
import type { ProjectKitApi, ProjectKitPreview, ProjectKitReference, ProjectKitReport } from '@shared/project-export'
import type { PersistedState, Repo } from '@shared/types'
import { restoreWorkspaceLayout } from '../renderer/src/workspace-layout'
import { ProjectMemoryStore } from './project-memory-store'
import { ProjectHandoffStore } from './project-handoff'
import { resolveProjectToolScope } from './project-tools'
import { ProcessExecutionError, runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { WorktreeFiles } from './worktree-files'
import { idFromPath, type Store } from './store'
import type { ProjectDoctor } from './project-doctor'

const MAX_BYTES = 32 * 1024 * 1024
const PORTABLE_ROOT = '/project'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
type SavedWorkspace = NonNullable<PersistedState['workspaceSession']>['repos'][string]
type PortablePane = { key: string; kind: SavedWorkspace['panes'][string][number]['kind'] }
type Payload = {
  memory: ProjectMemoryProjectDocument
  handoffs: ProjectHandoff[]
  artifacts: Array<{ path: string; content: string }>
  layout: { panes: PortablePane[]; docking: unknown }
  tools: ProjectKitPreview['tools']
  references: ProjectKitReference[]
  knowledge: ProjectKitKnowledge
}
type Kit = { schemaVersion: 1 | 2 | 3; archiveId: string; sourceName: string; sourceProjectKey: string; createdAt: string; checksums: Record<keyof Payload, string>; payload: Payload }
const baseSections = ['memory', 'handoffs', 'artifacts', 'layout', 'tools'] as const
const version2Sections = [...baseSections, 'references'] as const
const sections = [...version2Sections, 'knowledge'] as const
const warnings = ['Learned snapshots restore as historical readable documents. After configuring Hindsight, use Reconnect learned facts to import them with fresh embeddings. Select native task/workflow files as text artifacts. SSH/VM pairing is omitted and must be recreated on the destination.', 'Machine-absolute source references are omitted; safe source IDs and relative references survive. Arbitrary learned metadata and retention options are omitted; canonical source mappings are preserved separately.', 'Imported evidence and handoffs are historical; verify against this checkout before reuse.', 'Code, document and native session indexes must be rebuilt. No derived caches are included.', 'Tool executables, models, reference roots, agent sessions and credentials require local setup. All project tools start disabled.']

function kitArtifactPath(value: unknown): string {
  if(typeof value==='string'&&Object.hasOwn(APP_WORKFLOW_FILES,value))return value
  if(typeof value==='string'&&/^\.github\/workflows\/[^/]+\.ya?ml$/.test(value)){artifactPath(value.slice(1));return value}
  if(typeof value==='string'&&/^\.backlog\/(?:config\.yml|tasks\/[^/]+\.md)$/.test(value)){artifactPath(value.slice(1));return value}
  return artifactPath(value)
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid project kit fields')
}
function safeText(value: string): string {
  return redactDesignCaptureSecrets(value).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
}
function portableSourceRef(value: string | null): string | null {
  if (!value || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('file:')) return null
  return safeText(value)
}
function portableRevision<T extends ProjectMemoryRevision>(revision: T): T {
  return { ...revision, title: safeText(revision.title), content: safeText(revision.content), tags: revision.tags.map(safeText), provenance: { harness: revision.provenance.harness, workspace: PORTABLE_ROOT, sourceSession: portableSourceRef(revision.provenance.sourceSession), sourceRef: portableSourceRef(revision.provenance.sourceRef) } }
}

/** Bounded regular-file reads, including a post-read size check for concurrent growth. */
async function readBounded(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error('Choose an absolute local path')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Project kit must be a regular file no larger than 32 MiB')
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1))
    let length = 0
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length); if (!read.bytesRead) break; length += read.bytesRead }
    if (length !== stat.size) throw new Error('Project kit changed while reading')
    return bytes.subarray(0, length)
  } finally { await file.close() }
}

function parsePortableKnowledge(value: unknown, memory: ProjectMemoryProjectDocument, handoffs: ProjectHandoff[]): ProjectKitKnowledge {
  if(value===null)return {hindsight:null,temporal:[],settings:{}}
  exact(value,['hindsight','temporal','settings'])
  const settings=value.settings
  if(!isObject(settings)||Object.keys(settings).some(key=>!['documentRetrievalMode','hindsightModel','graphitiModel','embeddingModel','embeddingDimensions','taskAuthority'].includes(key)))throw new Error('Unknown portable integration settings')
  if(settings.documentRetrievalMode!==undefined&&!['auto','lexical','hybrid'].includes(String(settings.documentRetrievalMode)))throw new Error('Invalid portable retrieval mode')
  if(settings.taskAuthority!==undefined&&settings.taskAuthority!=='backlog.md')throw new Error('Invalid task authority')
  for(const key of ['hindsightModel','graphitiModel','embeddingModel'])if(settings[key]!==undefined&&(typeof settings[key]!=='string'||!settings[key]||settings[key].length>200||settings[key].startsWith('/')||/[\x00-\x1f]/.test(settings[key])))throw new Error('Model references must be portable identities, not machine paths')
  if(settings.embeddingDimensions!==undefined&&(!Number.isSafeInteger(settings.embeddingDimensions)||Number(settings.embeddingDimensions)<1||Number(settings.embeddingDimensions)>4096))throw new Error('Invalid portable embedding dimensions')
  const exists=(ref:{kind:string;id:string;revision:number})=>ref.kind==='memory'?memory.entries.some(entry=>entry.current.id===ref.id&&(entry.current.revision===ref.revision||entry.history.some(value=>value.revision===ref.revision))):handoffs.some(entry=>entry.id===ref.id&&entry.revision===ref.revision)
  const temporal=parseKnowledgeSelections(value.temporal)
  if(temporal.some(ref=>!exists(ref)))throw new Error('Temporal rebuild reference is absent or erased')
  let hindsight:ProjectKitKnowledge['hindsight']=null
  if(value.hindsight!==null){
    const learned=value.hindsight;exact(learned,['transferSchemaRevision','exportedAt','model','sources','documents'])
    if(typeof learned.transferSchemaRevision!=='string'||!/^([a-f0-9]{40}|[0-9.]+)$/.test(learned.transferSchemaRevision)||typeof learned.exportedAt!=='string'||!Number.isFinite(Date.parse(learned.exportedAt))||typeof learned.model!=='string'||learned.model.length>200)throw new Error('Invalid learned snapshot identity')
    if(!Array.isArray(learned.sources)||learned.sources.length>50||!Array.isArray(learned.documents)||learned.documents.length>50)throw new Error('Learned snapshot source limit exceeded')
    const sources=learned.sources.map(ref=>{
      exact(ref,['kind','id','revision','projectKey','sourceTime','documentId'])
      const selected=parseKnowledgeSelections([{kind:ref.kind,id:ref.id,revision:ref.revision}])[0]
      if(ref.projectKey!==memory.projectKey||!exists(selected)||typeof ref.documentId!=='string'||!/^[a-f0-9]{64}$/.test(ref.documentId)||!(ref.sourceTime===null||typeof ref.sourceTime==='string'&&Number.isFinite(Date.parse(ref.sourceTime))))throw new Error('Learned source reference is foreign, absent or erased')
      return {...selected,projectKey:memory.projectKey,sourceTime:ref.sourceTime as string|null,documentId:ref.documentId}
    })
    if(new Set(sources.map(ref=>ref.documentId)).size!==sources.length)throw new Error('Duplicate learned source document')
    const seen=new Set<string>()
    const scrub=(value:unknown):unknown=>typeof value==='string'?safeText(value):Array.isArray(value)?value.map(scrub):isObject(value)?Object.fromEntries(Object.entries(value).map(([key,value])=>[key,scrub(value)])):value
    const documents=learned.documents.map(document=>{
      if(!isObject(document)||typeof document.id!=='string'||!sources.some(ref=>ref.documentId===document.id)||seen.has(document.id)||!Array.isArray(document.facts)||document.facts.length>2000||!Array.isArray(document.chunks)||document.chunks.length>2000)throw new Error('Invalid or foreign learned document')
      seen.add(document.id)
      const fields=['id','original_text','retain_params','tags','created_at','chunks','facts']
      if(Object.keys(document).some(key=>!fields.includes(key)))throw new Error('Unsupported learned document field')
      const chunks=document.chunks.map(chunk=>{
        exact(chunk,['chunk_index','chunk_text'])
        if(!Number.isSafeInteger(chunk.chunk_index)||Number(chunk.chunk_index)<0||typeof chunk.chunk_text!=='string')throw new Error('Invalid learned chunk')
        return chunk
      })
      if(new Set(chunks.map(chunk=>chunk.chunk_index)).size!==chunks.length)throw new Error('Duplicate learned chunk')
      const strings=(value:unknown)=>Array.isArray(value)&&value.every(item=>typeof item==='string')
      if(document.original_text!==undefined&&document.original_text!==null&&typeof document.original_text!=='string'||document.tags!==undefined&&!strings(document.tags))throw new Error('Invalid learned document text')
      const factCount=document.facts.length
      const facts=document.facts.map(fact=>{
        if(!isObject(fact)||typeof fact.text!=='string'||!['world','experience'].includes(String(fact.fact_type)))throw new Error('Unsupported learned fact type')
        const fields=['text','fact_type','context','event_date','occurred_start','occurred_end','mentioned_at','metadata','tags','observation_scopes','chunk_index','entities','causal_relations','created_at','consolidated_at','consolidation_failed_at']
        if(Object.keys(fact).some(key=>!fields.includes(key)))throw new Error('Unsupported learned fact field')
        if(fact.context!==undefined&&fact.context!==null&&typeof fact.context!=='string'||['tags','entities'].some(key=>fact[key]!==undefined&&!strings(fact[key])))throw new Error('Invalid learned fact text')
        for(const key of ['event_date','occurred_start','occurred_end','mentioned_at','created_at','consolidated_at','consolidation_failed_at'])if(fact[key]!==undefined&&fact[key]!==null&&(typeof fact[key]!=='string'||!Number.isFinite(Date.parse(fact[key]))))throw new Error('Invalid learned fact timestamp')
        if(fact.chunk_index!==undefined&&fact.chunk_index!==null&&!chunks.some(chunk=>chunk.chunk_index===fact.chunk_index))throw new Error('Learned fact references an absent chunk')
        const scopes=fact.observation_scopes
        if(scopes!==undefined&&scopes!==null&&!(typeof scopes==='string'&&['per_tag','combined','all_combinations','shared'].includes(scopes))&&!(Array.isArray(scopes)&&scopes.every(strings)))throw new Error('Invalid learned observation scope')
        if(fact.causal_relations!==undefined){
          if(!Array.isArray(fact.causal_relations))throw new Error('Invalid learned causal relations')
          for(const edge of fact.causal_relations){exact(edge,['relation_type','target_fact_index']);if(typeof edge.relation_type!=='string'||!Number.isSafeInteger(edge.target_fact_index)||Number(edge.target_fact_index)<0||Number(edge.target_fact_index)>=factCount)throw new Error('Learned causal relation references an absent fact')}
        }
        return {...scrub(fact) as Record<string,unknown>,metadata:{}} // Upstream arbitrary metadata/retention options can contain credentials; canonical refs are carried separately.
      })
      return {...scrub(document) as Record<string,unknown>,retain_params:null,facts}
    })
    if(documents.length!==sources.length)throw new Error('Learned snapshot omitted selected source documents')
    hindsight={transferSchemaRevision:learned.transferSchemaRevision,exportedAt:learned.exportedAt,model:safeText(learned.model),sources,documents}
  }
  return {hindsight,temporal,settings:settings as ProjectKitKnowledge['settings']}
}
function remapPortableKnowledge(value:ProjectKitKnowledge,projectKey:string,ids:Map<string,string>):ProjectKitKnowledge {
  const map=(ref:ProjectKitKnowledge['temporal'][number])=>({...ref,id:ids.get(ref.kind+':'+ref.id)!})
  const sources=value.hindsight?.sources.map(ref=>{const next=map(ref);return {...ref,...next,projectKey,documentId:hash(JSON.stringify([next.kind,next.id,next.revision]))}})
  const documentIds=new Map(value.hindsight?.sources.map((ref,i)=>[ref.documentId,sources![i].documentId])??[])
  return {...value,temporal:value.temporal.map(map),hindsight:value.hindsight?{...value.hindsight,sources:sources!,documents:value.hindsight.documents.map(doc=>({...doc,id:documentIds.get(String(doc.id))!}))}:null}
}

function parseKit(bytes: Buffer): Kit {
  let kit: unknown
  try { kit = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Project kit contains invalid JSON') }
  exact(kit, ['schemaVersion', 'archiveId', 'sourceName', 'sourceProjectKey', 'createdAt', 'checksums', 'payload'])
  if ((kit.schemaVersion !== 1 && kit.schemaVersion !== 2 && kit.schemaVersion !== 3) || typeof kit.archiveId !== 'string' || !/^[a-f0-9-]{36}$/.test(kit.archiveId) || typeof kit.sourceProjectKey !== 'string' || !/^[a-f0-9]{64}$/.test(kit.sourceProjectKey) || validateProjectName(kit.sourceName) || typeof kit.createdAt !== 'string' || !Number.isFinite(Date.parse(kit.createdAt))) throw new Error('Unsupported or invalid project kit manifest')
  const admittedSections = kit.schemaVersion === 1 ? baseSections : kit.schemaVersion === 2 ? version2Sections : sections
  exact(kit.payload, admittedSections); exact(kit.checksums, admittedSections)
  for (const key of admittedSections) if (kit.checksums[key] !== hash(JSON.stringify(kit.payload[key]))) throw new Error('Project kit checksum mismatch: ' + key)
  const memory = parseProjectMemoryDocument({ schemaVersion: 2, projects: [kit.payload.memory] }).projects[0]!
  if (memory.projectKey !== kit.sourceProjectKey || memory.projectPath !== PORTABLE_ROOT) throw new Error('Project kit memory identity mismatch')
  if (!Array.isArray(kit.payload.handoffs) || kit.payload.handoffs.length > 2500) throw new Error('Project kit handoff limit exceeded')
  const handoffs = kit.payload.handoffs.map(parseProjectHandoff)
  if (new Set(handoffs.map(value => value.id)).size !== handoffs.length || handoffs.some(value => value.projectKey !== kit.sourceProjectKey || value.checkoutPath !== PORTABLE_ROOT)) throw new Error('Project kit handoff identity mismatch')
  if (!Array.isArray(kit.payload.artifacts) || kit.payload.artifacts.length > 100) throw new Error('Select at most 100 text artifacts')
  const artifacts = kit.payload.artifacts.map(value => {
    exact(value, ['path', 'content']); const path = kitArtifactPath(value.path); if(path.split('/')[0]==='donwells-import')throw new Error('Artifact collides with imported knowledge metadata')
    if (typeof value.content !== 'string' || value.content.includes('\0') || Buffer.byteLength(value.content) > 512 * 1024) throw new Error('Artifact exceeds supported text size')
    return { path, content: value.content }
  })
  if (new Set(artifacts.map(value => value.path.normalize('NFC').toLocaleLowerCase('en-US'))).size !== artifacts.length) throw new Error('Duplicate artifact paths')
  if (artifacts.some(a => artifacts.some(b => a !== b && b.path.toLowerCase().startsWith(a.path.toLowerCase() + '/')))) throw new Error('Artifact file/directory collision')
  exact(kit.payload.layout, ['panes', 'docking'])
  if (!Array.isArray(kit.payload.layout.panes) || kit.payload.layout.panes.length > 64) throw new Error('Project kit panel limit exceeded')
  const panes = kit.payload.layout.panes.map(value => {
    exact(value, ['key', 'kind'])
    if (typeof value.key !== 'string' || !/^kit-pane-\d+$/.test(value.key) || !['terminal','explorer','git-status','browser','memory','recovery','search','computer','environments'].includes(String(value.kind))) throw new Error('Invalid portable panel')
    return value as PortablePane
  })
  if (new Set(panes.map(value => value.key)).size !== panes.length) throw new Error('Duplicate portable panels')
  const docking = restoreWorkspaceLayout(kit.payload.layout.docking, panes).layout
  if (!Array.isArray(kit.payload.tools) || kit.payload.tools.length > 32) throw new Error('Invalid tool manifest')
  const tools = kit.payload.tools.map(value => {
    exact(value, ['id', 'version', 'configured', 'enabled'])
    if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) || typeof value.version !== 'string' || value.version.length > 128 || /[\x00-\x1f\x7f]/.test(value.version) || typeof value.configured !== 'boolean' || typeof value.enabled !== 'boolean') throw new Error('Invalid tool manifest entry')
    return value as ProjectKitPreview['tools'][number]
  })
  if (new Set(tools.map(value => value.id)).size !== tools.length) throw new Error('Duplicate tool identities')
  const identities = [
    ...memory.entries.map(entry => ({ kind: 'memory' as const, id: entry.current.id })),
    ...(memory.erased ?? []).map(entry => ({ kind: 'memory' as const, id: entry.id })),
    ...handoffs.map(entry => ({ kind: 'handoff' as const, id: entry.id }))
  ]
  const expected = new Set(identities.map(entry => entry.kind + ':' + entry.id))
  const rawReferences = kit.schemaVersion === 1 ? identities.map(entry => ({ ...entry, originalProjectKey: kit.sourceProjectKey, originalId: entry.id })) : kit.payload.references
  if (!Array.isArray(rawReferences) || rawReferences.length !== expected.size) throw new Error('Project kit reference map is incomplete')
  const references = rawReferences.map(value => {
    exact(value, ['kind', 'id', 'originalProjectKey', 'originalId'])
    const id = parseProjectMemoryIdentifier(value.id), originalId = parseProjectMemoryIdentifier(value.originalId)
    if ((value.kind !== 'memory' && value.kind !== 'handoff') || typeof value.originalProjectKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.originalProjectKey) || !expected.delete(value.kind + ':' + id)) throw new Error('Invalid or duplicate project kit reference identity')
    return { kind: value.kind, id, originalProjectKey: value.originalProjectKey, originalId } as ProjectKitReference
  })
  return { ...kit, payload: { memory, handoffs, artifacts, layout: { panes, docking }, tools, references, knowledge: parsePortableKnowledge(kit.schemaVersion === 3 ? kit.payload.knowledge : null, memory, handoffs) } } as Kit
}
function preview(kit: Kit, digest: string): ProjectKitPreview {
  const currentIds = new Set(kit.payload.memory.entries.map(entry => entry.current.id))
  const omitted = kit.payload.handoffs.flatMap(handoff => (handoff.memorySources ?? []).filter(ref => !currentIds.has(ref.id)).map(ref => `Historical handoff ${handoff.id}: memory reference ${ref.id} revision ${ref.revision} is absent or erased and will not be restored.`))
  return { schemaVersion: kit.schemaVersion, learnedFacts: kit.payload.knowledge.hindsight?.documents.reduce((n,doc)=>n+(doc.facts as unknown[]).length,0)??0, temporalSources: kit.payload.knowledge.temporal.length, portableSettings: kit.payload.knowledge.settings, erasedMemories: kit.payload.memory.erased?.length ?? 0, archiveId: kit.archiveId, sourceProjectKey: kit.sourceProjectKey, sourceName: kit.sourceName, sha256: digest, memories: kit.payload.memory.entries.length, revisions: kit.payload.memory.entries.reduce((n, entry) => n + entry.history.length, 0), handoffs: kit.payload.handoffs.length, artifacts: kit.payload.artifacts.map(value => value.path), tools: kit.payload.tools, warnings: [...warnings, ...(kit.schemaVersion === 1 ? ['Version 1 kit will be converted with a reference map. Any original identity history already omitted by its exporter cannot be recovered.'] : []), ...omitted, ...kit.payload.tools.filter(value => !INTEGRATED_PROJECT_TOOLS.some(tool => tool.id === value.id && tool.version === value.version)).map(value => `Unsupported tool version: ${value.id} ${value.version}`)] }
}

export class ProjectExport implements ProjectKitApi {
  private files = new WorktreeFiles()
  constructor(private profile: string, private store: Store, private resolveWorkspace: (path: string) => Promise<{ path: string; projectPath: string }>, private doctor: Pick<ProjectDoctor, 'configuration'> & Partial<Pick<ProjectDoctor, 'knowledgeExport' | 'knowledgeImport' | 'temporalKnowledgeStatus'>>, private onImported: () => void = () => {}) {}

  async projectKitReconnectLearned(workspacePath:string) {
    const scope=await resolveProjectToolScope(workspacePath,this.resolveWorkspace),config=await this.doctor.configuration(workspacePath)
    const python=config.graphiti?.python??config.duckdbPython
    if(!python||!this.doctor.knowledgeImport)throw new Error('Configure Hindsight and an existing Graphiti or DuckDB Python before reconnecting learned facts')
    const memory=new ProjectMemoryStore(this.profile).exportProject(scope),handoffs=new ProjectHandoffStore(this.profile).list(scope.projectKey)
    const knowledge=parsePortableKnowledge(JSON.parse((await readBounded(join(scope.checkoutPath,'donwells-import','knowledge.json'))).toString()),memory,handoffs)
    if(!knowledge.hindsight?.sources.length)throw new Error('This restored project has no learned source documents')
    const sources=knowledge.hindsight.sources
    for(const source of sources)if(source.documentId!==hash(JSON.stringify([source.kind,source.id,source.revision])))throw new Error('Restored learned document identity does not match its canonical source')
    const encoded=await runProcess({program:python,args:['-I','-c',transferDecoder],input:JSON.stringify({documents:knowledge.hindsight.documents}),cwd:scope.checkoutPath,env:{HOME:process.env.HOME,PATH:process.env.PATH},timeoutMs:30000,maxOutputBytes:12*1024*1024})
    const archive=JSON.parse(encoded.stdout)
    return this.doctor.knowledgeImport(workspacePath,sources.map(({kind,id,revision})=>({kind,id,revision})),archive.archiveBase64,knowledge.hindsight.documents.reduce((count,doc)=>count+(doc.facts as unknown[]).length,0))
  }
  async projectKitExport(workspacePath: string, outputPath: string, selected: string[], options?: {includeLearned?:boolean}) {
    if (!Array.isArray(selected) || selected.length > 100) throw new Error('Select at most 100 text artifacts')
    const scope = await resolveProjectToolScope(workspacePath, this.resolveWorkspace)
    const memory = new ProjectMemoryStore(this.profile).exportProject(scope)
    const handoffs = new ProjectHandoffStore(this.profile).list(scope.projectKey)
    const config = await this.doctor.configuration(workspacePath)
    if(options && (Object.keys(options).some(key=>key!=='includeLearned') || (options.includeLearned!==undefined && typeof options.includeLearned!=='boolean')))throw new Error('Invalid kit export options')
    let importedKnowledge:ProjectKitKnowledge|null=null
    let learned:ProjectKitKnowledge['hindsight']=null
    const importedPath=join(scope.checkoutPath,'donwells-import','knowledge.json')
    try {importedKnowledge=parsePortableKnowledge(JSON.parse((await readBounded(importedPath)).toString()),memory,handoffs);learned=importedKnowledge.hindsight} catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    if(options?.includeLearned){
      if(!this.doctor.knowledgeExport)throw new Error('Learned export owner is unavailable')
      const python=config.graphiti?.python??config.duckdbPython
      if(!python)throw new Error('Configure an existing Graphiti or DuckDB Python to inspect the native learned transfer archive')
      const snapshot=await this.doctor.knowledgeExport(workspacePath)
      const decoded=await runProcess({program:python,args:['-I','-c',transferDecoder],input:JSON.stringify({archiveBase64:snapshot.archiveBase64}),cwd:scope.checkoutPath,env:{HOME:process.env.HOME,PATH:process.env.PATH},timeoutMs:30000,maxOutputBytes:20*1024*1024})
      const transfer=JSON.parse(decoded.stdout)
      learned={transferSchemaRevision:snapshot.transferSchemaRevision,exportedAt:snapshot.exportedAt,model:snapshot.model,sources:snapshot.sources,documents:transfer.documents}
    }
    const artifacts = []
    for (const input of selected) {
      const path = kitArtifactPath(input), file = await this.files.readFile(scope.checkoutPath, path)
      if (file.binary || file.truncated) throw new Error('Artifact must be bounded UTF-8 text: ' + path)
      artifacts.push({ path, content: safeText(file.content) })
    }
    const repo = this.store.listRepos().find(value => value.path === scope.projectPath)!
    const saved = this.store.getWorkspaceSession()?.repos[repo.id]
    const original = (saved?.panes[scope.checkoutPath] ?? []).filter(pane => !['preview', 'diff'].includes(pane.kind)).slice(0, 64)
    const clean = restoreWorkspaceLayout(saved?.docking?.[scope.checkoutPath], original, saved?.layouts?.[scope.checkoutPath]).layout
    const keys = new Map(original.map((pane, index) => [pane.key, `kit-pane-${index}`]))
    const remap = (value: unknown): unknown => typeof value === 'string' ? keys.get(value) ?? value : Array.isArray(value) ? value.map(remap) : isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remap(child)])) : value
    const panes = original.map(pane => ({ key: keys.get(pane.key)!, kind: pane.kind }))
    const previousReport = await this.projectKitReport(workspacePath)
    const origins = new Map((previousReport?.identityMapping ?? []).map(ref => [ref.kind + ':' + ref.targetId, ref]))
    const reference = (kind: ProjectKitReference['kind'], id: string): ProjectKitReference => {
      const origin = origins.get(kind + ':' + id)
      return { kind, id, originalProjectKey: origin?.originalProjectKey ?? scope.projectKey, originalId: origin?.originalId ?? id }
    }
    const temporal=config.graphiti && this.doctor.temporalKnowledgeStatus ? (await this.doctor.temporalKnowledgeStatus(workspacePath)).sources : importedKnowledge?.temporal ?? []
    const knowledge=parsePortableKnowledge({hindsight:learned,temporal,settings:{...importedKnowledge?.settings,...(config.documentRetrievalMode?{documentRetrievalMode:config.documentRetrievalMode}:{}),...(config.hindsight?{hindsightModel:config.hindsight.model}:{}),...(config.graphiti?{graphitiModel:config.graphiti.model,embeddingModel:config.graphiti.embeddingModel,embeddingDimensions:config.graphiti.embeddingDimensions}:{}),...(repo.taskAuthority?{taskAuthority:repo.taskAuthority}:{})}},memory,handoffs)
    const payload: Payload = {
      knowledge,
      references: [...memory.entries.map(entry => reference('memory', entry.current.id)), ...(memory.erased ?? []).map(entry => reference('memory', entry.id)), ...handoffs.map(entry => reference('handoff', entry.id))],
      memory: { projectKey: scope.projectKey, projectPath: PORTABLE_ROOT, ...(memory.erased?.length ? { erased: memory.erased } : {}), entries: memory.entries.map(entry => ({ current: portableRevision(entry.current), history: entry.history.map(portableRevision) })) },
      handoffs: handoffs.map(value => ({ ...value, ...(value.reviewEvidence ? { reviewEvidence: value.reviewEvidence.map(note => ({ ...note, target: { ...note.target, workspacePath: PORTABLE_ROOT }, body: safeText(note.body), anchor: { ...note.anchor, context: note.anchor.context.map(line => ({ ...line, text: safeText(line.text) })) } })) } : {}), checkoutPath: PORTABLE_ROOT, goal: safeText(value.goal), summary: safeText(value.summary), openQuestions: value.openQuestions.map(safeText), nextSteps: value.nextSteps.map(safeText), fromSessionId: 'historical', acceptedBySessionId: value.acceptedBySessionId ? 'historical' : null, evidenceIds: [] })),
      artifacts, layout: { panes, docking: restoreWorkspaceLayout(remap(clean), panes).layout },
      tools: INTEGRATED_PROJECT_TOOLS.map(tool => ({ id: tool.id, version: tool.version, configured: tool.fields.some(field => Boolean(config[field])), enabled: !config.disabled.includes(tool.id) }))
    }
    const kit: Kit = { schemaVersion: 3, archiveId: randomUUID(), sourceName: basename(scope.projectPath), sourceProjectKey: scope.projectKey, createdAt: new Date().toISOString(), checksums: Object.fromEntries(sections.map(key => [key, hash(JSON.stringify(payload[key]))])) as Kit['checksums'], payload }
    const bytes = Buffer.from(JSON.stringify(kit) + '\n')
    if (bytes.length > MAX_BYTES) throw new Error('Selected project kit exceeds 32 MiB')
    parseKit(bytes)
    const current = await resolveProjectToolScope(workspacePath, this.resolveWorkspace)
    if (current.projectKey !== scope.projectKey || current.indexKey !== scope.indexKey) throw new Error('Project changed during export')
    if(hash(JSON.stringify(new ProjectMemoryStore(this.profile).exportProject(scope)))!==hash(JSON.stringify(memory)) || hash(JSON.stringify(new ProjectHandoffStore(this.profile).list(scope.projectKey)))!==hash(JSON.stringify(handoffs)))throw new Error('Canonical project knowledge changed during export; retry from a current snapshot')
    if (!isAbsolute(outputPath)) throw new Error('Choose an absolute export path')
    const parent = await realpath(dirname(outputPath)), target = join(parent, basename(outputPath)), temp = join(parent, `.project-kit-${randomUUID()}.tmp`)
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      if (!(await readBounded(temp)).equals(bytes)) throw new Error('Project kit export verification failed')
      // A hard-link publication is atomic and refuses an existing destination; no overwrite window.
      await link(temp, target)
      return { ...preview(kit, hash(bytes)), path: target }
    } finally { await rm(temp, { force: true }) }
  }

  async projectKitPreview(path: string) { const bytes = await readBounded(path); return preview(parseKit(bytes), hash(bytes)) }

  async projectKitImport(path: string, destination: string, expectedSha256: string, sourceProjectKey: string) {
    const bytes = await readBounded(path), kit = parseKit(bytes)
    if (hash(bytes) !== expectedSha256 || kit.sourceProjectKey !== sourceProjectKey) throw new Error('Project kit changed or source identity was not confirmed')
    if (!isAbsolute(destination) || validateProjectName(basename(destination))) throw new Error('Choose a new absolute project directory')
    const parent = await realpath(dirname(destination)), target = join(parent, basename(destination))
    if (this.store.listRepos().some(repo => repo.path === target)) throw new Error('Restore destination is already registered')
    const git = await runProcess({ program: 'git', args: ['rev-parse', '--show-toplevel'], cwd: parent, env: sanitizedProcessEnv(), timeoutMs: 5000, maxOutputBytes: 4096 }).catch(error => { if (error instanceof ProcessExecutionError && error.kind === 'exit' && /not a git repository|not a git directory/i.test(error.result?.stderr ?? '')) return null; throw error })
    if (git) throw new Error('Choose a restore location outside an existing Git checkout')
    await mkdir(target, { mode: 0o700 }) // Exclusive: existing files, folders and symlinks are never merged.
    const scope = await resolveProjectToolScope(target, async () => ({ path: target, projectPath: target }))
    const identityMapping = kit.payload.references.map(ref => ({ ...ref, targetId: hash(JSON.stringify([scope.projectKey, kit.archiveId, ref.kind, ref.id])) }))
    const mappedIds = new Map(identityMapping.map(ref => [ref.kind + ':' + ref.id, ref.targetId]))
    const currentMemory = new Set(kit.payload.memory.entries.map(entry => entry.current.id))
    const report: ProjectKitReport = { ...preview(kit, hash(bytes)), identityMapping, projectPath: target, projectKey: scope.projectKey, restoredAt: new Date().toISOString() }
    const marker = join(target, '.donwells-restore-incomplete')
    const write = (path: string, value: unknown) => { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd) } finally { closeSync(fd) } }
    write(marker, { archiveId: kit.archiveId, sourceProjectKey, projectKey: scope.projectKey })
    const memory = new ProjectMemoryStore(this.profile), handoffStore = new ProjectHandoffStore(this.profile)
    let importedMemory: ProjectMemoryProjectDocument | undefined, importedHandoffs: ProjectHandoff[] | undefined
    try {
      for (const artifact of kit.payload.artifacts) {
        const output = join(target, artifact.path)
        await mkdir(dirname(output), { recursive: true, mode: 0o700 })
        await this.files.createWorkspaceEntry(target, { path: artifact.path, kind: 'file', content: safeText(artifact.content) })
      }
      const configuration = join(this.profile, 'project-tools', 'configuration', scope.projectKey)
      await mkdir(configuration, { recursive: true, mode: 0o700 })
      write(join(configuration, 'tools.json'), { ...(kit.payload.knowledge.settings.documentRetrievalMode?{documentRetrievalMode:kit.payload.knowledge.settings.documentRetrievalMode}:{}), referenceRoots: [], disabled: INTEGRATED_PROJECT_TOOLS.map(tool => tool.id) })
      const reports = join(this.profile, 'project-kits'); await mkdir(reports, { recursive: true, mode: 0o700 })
      write(join(reports, scope.projectKey + '.json'), report)
      const mapped = { projectKey: scope.projectKey, projectPath: target, ...(kit.payload.memory.erased?.length ? { erased: kit.payload.memory.erased.map(entry => ({ ...entry, id: mappedIds.get('memory:' + entry.id)! })) } : {}), entries: kit.payload.memory.entries.map(entry => ({ current: { ...portableRevision(entry.current), id: mappedIds.get('memory:' + entry.current.id)!, provenance: { ...portableRevision(entry.current).provenance, workspace: target } }, history: entry.history.map(value => ({ ...portableRevision(value), provenance: { ...portableRevision(value).provenance, workspace: target } })) })) }
      memory.importProject(mapped); importedMemory = mapped
      const mappedHandoffs = kit.payload.handoffs.map(value => parseProjectHandoff({ ...value, ...(value.reviewEvidence ? { reviewEvidence: value.reviewEvidence.map(note => ({ ...note, target: { ...note.target, workspacePath: target } })) } : {}), id: mappedIds.get('handoff:' + value.id)!, ...(value.memorySources === undefined ? {} : { memorySources: value.memorySources.filter(ref => currentMemory.has(ref.id)).map(ref => ({ ...ref, id: mappedIds.get('memory:' + ref.id)! })) }), projectKey: scope.projectKey, checkoutPath: target, contentFingerprint: 'sha256:' + '0'.repeat(64), goal: safeText(value.goal), summary: safeText(value.summary), openQuestions: value.openQuestions.map(safeText), nextSteps: value.nextSteps.map(safeText), evidenceIds: [], fromSessionId: 'historical', state: 'superseded', delivery: 'not-sent', acceptedBySessionId: null, dispatch: undefined }))
      handoffStore.importProject(scope.projectKey, mappedHandoffs); importedHandoffs = mappedHandoffs
      const knowledge=remapPortableKnowledge(kit.payload.knowledge,scope.projectKey,mappedIds)
      await mkdir(join(target,'donwells-import'),{mode:0o700})
      write(join(target,'donwells-import','knowledge.json'),knowledge)
      const repo: Repo = { id: idFromPath(target), path: target, kind: 'folder', addedAt: report.restoredAt }
      const panes = kit.payload.layout.panes
      const workspace: SavedWorkspace = { panes: { [target]: panes }, activePane: { [target]: panes[0]?.key ?? '' }, activeTerminal: {}, terminalOrder: {}, layouts: {}, docking: { [target]: kit.payload.layout.docking }, activeWorktreePath: target }
      unlinkSync(marker)
      this.onImported()
      this.store.addImportedRepo(repo, workspace)
      return { repo, report }
    } catch (error) {
      if (importedHandoffs) handoffStore.removeImportedProject(scope.projectKey, importedHandoffs)
      if (importedMemory) memory.removeImportedProject(importedMemory)
      try { write(marker, { archiveId: kit.archiveId, sourceProjectKey, projectKey: scope.projectKey }) } catch { /* Original marker still present. */ }
      throw new Error('Restore did not finish. The new directory and incomplete marker were preserved; existing projects were not changed.', { cause: error })
    }
  }

  async projectKitReport(workspacePath: string): Promise<ProjectKitReport | null> {
    const scope = await resolveProjectToolScope(workspacePath, this.resolveWorkspace), path = join(this.profile, 'project-kits', scope.projectKey + '.json')
    if (!await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) return null
    return JSON.parse((await readBounded(path)).toString('utf8')) as ProjectKitReport
  }
}
