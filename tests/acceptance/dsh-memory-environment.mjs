// Configuration compatibility probe against the admitted DSH installation; not model continuation.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { configureAgentMemory } from '../../src/main/agents/project-memory-config.ts'

const { values } = parseArgs({ options: { loader: { type: 'string' }, subprocess: { type: 'string' } } })
assert(values.loader && values.subprocess, 'Provide the admitted DSH loader and subprocess module paths')
const { interpolate } = await import(pathToFileURL(values.loader).href)
const { scrubbedParentEnv } = await import(pathToFileURL(values.subprocess).href)
const root = mkdtempSync(join(tmpdir(), 'donwells-dsh-env-'))
const names = ['RUN_ID', 'SESSION_ID', 'TOKEN'].map(suffix => `DONWELLS_AGENT_HOOK_${suffix}`)
const previous = names.map(name => process.env[name])
try {
  names.forEach((name, index) => { process.env[name] = `synthetic-setup-${index}` })
  const result = await configureAgentMemory({
    files: {
      readFile: async () => { throw new Error('Fresh configuration should not be read') },
      writeFile: async () => { throw new Error('Fresh configuration should not overwrite') },
      createWorkspaceEntry: async (_, entry) => {
        if (entry.kind === 'dir') mkdirSync(join(root, entry.path))
        else writeFileSync(join(root, entry.path), entry.content)
      }
    },
    workspacePath: root, provider: 'deepseek-harness', userDataDir: root,
    executable: '/fixture/node', cliPath: '/fixture/donwells.mjs'
  })
  const text = readFileSync(join(root, result.path), 'utf8')
  assert(!text.includes('synthetic-setup'), 'Setup must not persist a session credential')
  const config = JSON.parse(text)[0].insert[0].config
  assert.equal(scrubbedParentEnv().DONWELLS_AGENT_HOOK_TOKEN, undefined)
  for (const session of ['first', 'second']) {
    names.forEach((name, index) => { process.env[name] = `synthetic-${session}-${index}` })
    const env = { ...scrubbedParentEnv(), ...interpolate({}, config).env }
    names.forEach(name => assert.equal(env[name], process.env[name]))
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  }
  names.forEach(name => { delete process.env[name] })
  names.forEach(name => assert.equal(interpolate({}, config).env[name], ''))
  const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  console.log(JSON.stringify({ loaderSha256: sha256(values.loader), subprocessSha256: sha256(values.subprocess), deferredAcrossSessions: true, missingCredentialEmpty: true, noCredentialPersisted: true }))
} finally {
  names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index] })
  rmSync(root, { recursive: true, force: true })
}
