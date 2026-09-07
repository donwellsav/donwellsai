import { createHash } from 'node:crypto'
import { PROJECT_MEMORY_MAX_HISTORY_REVISIONS } from '@shared/project-memory'
import { parseKnowledgeSelections, type KnowledgeSelection } from '@shared/project-knowledge'
import type { TemporalSnapshot } from '@shared/project-temporal-knowledge'
import { ProjectMemoryStore } from './project-memory-store'

/** A disposable projection of retained canonical revisions, never a second history authority. */
export function temporalSources(profile: string, projectKey: string, selection: KnowledgeSelection[]): TemporalSnapshot {
  const selected = parseKnowledgeSelections(selection), memory = new ProjectMemoryStore(profile)
  const sources: TemporalSnapshot['sources'] = [], historyFloors: TemporalSnapshot['historyFloors'] = []
  for (const source of selected) {
    if (source.kind !== 'memory') throw new Error('Dated relationships currently require memory revisions; handoffs have no authored timestamps')
    const history = memory.history(projectKey, source.id, PROJECT_MEMORY_MAX_HISTORY_REVISIONS + 1)
    if (history.entry.revision !== source.revision) throw new Error('Temporal source changed; review its latest revision')
    const revisions = history.revisions.slice().sort((a, b) => a.revision - b.revision)
    if (history.truncated) historyFloors.push({ id: source.id, oldestAvailableAt: revisions[0].updatedAt })
    for (let i = 0; i < revisions.length; i++) {
      const revision = revisions[i]
      if (revision.archivedAt) continue
      const hash = createHash('sha256').update(JSON.stringify([projectKey, source.id, revision.revision])).digest('hex')
      sources.push({ ref: { kind: 'memory', id: source.id, revision: revision.revision, projectKey, sourceTime: revision.updatedAt }, episodeId: `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`, content: `${revision.kind}: ${revision.title}\n${revision.content}`, availableFrom: revision.updatedAt, availableUntil: revisions[i + 1]?.updatedAt ?? null })
    }
  }
  // ponytail: reviewed history is capped at 128 episodes/256 KiB; larger corpora need checkpointed streaming.
  if (sources.length > 128 || sources.reduce((n, source) => n + Buffer.byteLength(source.content), 0) > 256 * 1024) throw new Error('Temporal history exceeds 128 episodes or 256 KiB; select fewer sources')
  return { sources: sources.sort((a, b) => a.availableFrom.localeCompare(b.availableFrom) || a.episodeId.localeCompare(b.episodeId)), historyFloors, selected }
}
