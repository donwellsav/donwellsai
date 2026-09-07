// Stdio trial adapter around the actual production index, with separate native project scopes.
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { openProjectDocumentIndex } from '../../src/main/project-document-index.ts'
const [work, tools] = process.argv.slice(2)
const hash = value => createHash('sha256').update(value).digest('hex')
const indexes = new Map(), documents = new Map()
try {
  for await (const line of createInterface({ input: process.stdin })) {
    let stop = false
    try {
      const input = JSON.parse(line), project = input.doc?.project ?? input.project ?? 'project'
      if (!['project', 'foreign'].includes(project)) throw new Error('Unknown trial project')
      if (input.operation === 'close') stop = true
      else if (!indexes.has(project)) {
        indexes.set(project, await openProjectDocumentIndex({ qmdPackage: join(tools, 'qmd/node_modules/@tobilu/qmd'), lancePackage: join(tools, 'lance/node_modules/@lancedb/lancedb'), database: join(work, 'index', project), collections: [hash(project)], embeddingModel: join(tools, 'models/Qwen3-Embedding-4B-Q8_0.gguf'), rerankingModel: join(tools, 'models/qwen3-reranker-0.6b-q8_0.gguf') }))
        documents.set(project, new Map())
      }
      let result = null
      if (input.operation === 'query') {
        const value = await indexes.get(project).search(input.question)
        if (value.mode !== 'hybrid' && !(value.mode === 'unindexed' && documents.get(project).size === 0 && value.hits.length === 0)) throw new Error(value.modelError || 'Semantic baseline unavailable')
        result = [...new Set(value.hits.map(hit => hit.path))].slice(0, 5)
      } else if (input.operation === 'retain' || input.operation === 'delete') {
        const selected = documents.get(project), doc = input.doc
        if (input.operation === 'delete') selected.delete(doc.id)
        else selected.set(doc.id, { path: doc.id, content: doc.text, revision: hash(doc.text) })
        await indexes.get(project).replace(hash(project), [...selected.values()])
      } else if (!stop) throw new Error('Unknown trial operation')
      console.log(JSON.stringify({ donwells23: true, result }))
    } catch (error) { console.log(JSON.stringify({ donwells23: true, error: String(error) })) }
    if (stop) break
  }
} finally { for (const index of indexes.values()) await index.close() }
