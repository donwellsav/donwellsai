// Only the acceptance runner supplies the disposable profile. Kill this process while it owns the migration lock.
import { writeSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createServer } from 'vite'
const profile = process.argv[2]
const requestedBoundary = process.argv[3] ?? 'legacy-fenced'
if (!profile) throw new Error('Disposable acceptance profile is required')
const reversing = ['reverse-prepared', 'reverse-marked', 'reverse-unfenced', 'reverse-published', 'reverse-active'].includes(requestedBoundary)
const aborting = ['abort-marked', 'json-restored'].includes(requestedBoundary)
if (requestedBoundary !== 'upgrade-only' && !reversing && !aborting && !['candidate-prepared', 'manifest-prepared', 'legacy-retired', 'legacy-fenced', 'manifest-active'].includes(requestedBoundary)) throw new Error('Unknown crash boundary')
const root = resolve(import.meta.dirname, '../..')
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, resolve: { alias: { '@shared': join(root, 'src/shared') } } })
try {
  const { migrateProjectMemory, abortProjectMemoryMigration, reverseProjectMemoryMigration } = await server.ssrLoadModule('/src/main/project-memory-migration.ts')
  if (aborting) {
    try { migrateProjectMemory(profile, boundary => { if (boundary === 'legacy-fenced') throw new Error('prepare abort fixture') }) }
    catch (error) { if (error.message !== 'prepare abort fixture') throw error }
  }
  if (requestedBoundary === 'upgrade-only') { migrateProjectMemory(profile); console.log('upgraded') }
  else {
    const operation = reversing ? reverseProjectMemoryMigration : aborting ? abortProjectMemoryMigration : migrateProjectMemory
    operation(profile, boundary => {
      if (boundary !== requestedBoundary) return
      writeSync(1, 'DONWELLS_BOUNDARY:' + JSON.stringify({ pid: process.pid, boundary }) + '\n')
      process.kill(process.pid, 'SIGKILL')
    })
    throw new Error('Migration did not reach the requested crash boundary')
  }
} finally { await server.close() }
