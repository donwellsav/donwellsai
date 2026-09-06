import { resolve, join } from 'node:path'
import { createServer } from 'vite'
const [profile, action, projectKey, id, recipient] = process.argv.slice(2)
if (!profile || !['claim', 'delivery-crash', 'read'].includes(action)) throw new Error('Explicit handoff fixture profile and action required')
const root = resolve(import.meta.dirname, '../..')
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, resolve: { alias: { '@shared': join(root, 'src/shared') } } })
try {
  const { ProjectHandoffStore } = await server.ssrLoadModule('/src/main/project-handoff.ts')
  const store = new ProjectHandoffStore(profile)
  const go = new Promise(resolve => process.once('message', resolve))
  process.send({ ready: true, pid: process.pid })
  await go
  try {
    if (action === 'delivery-crash') {
      store.beginDelivery(projectKey, id, 2, recipient)
      process.kill(process.pid, 'SIGKILL')
    } else {
      const value = action === 'claim' ? store.accept(projectKey, id, 1, recipient, `claim-${recipient}`) : store.get(projectKey, id)
      process.send({ ok: true, value, pid: process.pid })
    }
  } catch (error) { process.send({ ok: false, error: error.message, pid: process.pid }) }
} finally { await server.close(); process.disconnect() }
