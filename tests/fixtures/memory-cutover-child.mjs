// Only the acceptance runner supplies the disposable profile. Kill this process while it owns the migration lock.
import { writeSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createServer } from 'vite'
const profile = process.argv[2]
const requestedBoundary = process.argv[3] ?? 'legacy-fenced'
if (!profile) throw new Error('Disposable acceptance profile is required')
if (!['candidate-prepared', 'manifest-prepared', 'legacy-retired', 'legacy-fenced', 'manifest-active'].includes(requestedBoundary)) throw new Error('Unknown crash boundary')
const root = resolve(import.meta.dirname, '../..')
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, resolve: { alias: { '@shared': join(root, 'src/shared') } } })
try {
  const { migrateProjectMemory } = await server.ssrLoadModule('/src/main/project-memory-migration.ts')
  migrateProjectMemory(profile, boundary => {
    if (boundary !== requestedBoundary) return
    writeSync(1, JSON.stringify({ pid: process.pid, boundary }) + '\n')
    process.kill(process.pid, 'SIGKILL')
  })
  throw new Error('Migration did not reach the requested crash boundary')
} finally { await server.close() }
