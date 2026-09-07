import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { once } from 'node:events'
import { DaemonClient } from './daemon-client'
import { ProjectRemoteServer, readRemoteProjectMapping } from './project-remote-server'
import type { ProjectRemoteRequest } from '@shared/project-environment'

export async function runProjectRemoteStdio(mappingPath: string): Promise<void> {
  if (!['darwin', 'linux'].includes(process.platform) || process.arch !== 'arm64' || process.getuid?.() === 0) throw new Error('Remote deployment requires a dedicated non-root macOS or Linux arm64 account')
  if (process.type !== undefined) throw new Error('Remote entry requires a compatible Node runtime, not GUI Electron')
  if (process.env.SSH_ORIGINAL_COMMAND !== 'donwells-project-v1') throw new Error('Remote entry requires its restricted SSH forced command')
  const mapping = readRemoteProjectMapping(mappingPath)
  process.env.DONWELLS_REMOTE_MEMORY_SOCKET = join(mapping.stateDirectory, 'memory.sock')
  process.env.DONWELLS_REMOTE_MEMORY_ROOT = mapping.root
  process.env.DONWELLS_REMOTE_MEMORY_ENTRY = join(__dirname, 'project-remote-memory-entry.js')
  const client = new DaemonClient(mapping.stateDirectory, { data() {}, exit() {}, title() {}, agent() {}, agentDismissed() {} }, join(__dirname, 'terminal-daemon-entry.js'))
  const server = new ProjectRemoteServer(mapping, client), decoder = new StringDecoder('utf8')
  let buffer = ''
  try {
    for await (const chunk of process.stdin) {
      buffer += decoder.write(chunk as Buffer)
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error('Remote request frame exceeds limit')
        let request: ProjectRemoteRequest | undefined, response: unknown
        try { request = JSON.parse(line) as ProjectRemoteRequest; response = { version: 1, requestId: request.requestId, ok: true, result: await server.dispatch(request) } }
        catch (error) { response = { version: 1, requestId: request?.requestId ?? '', ok: false, error: String(error).slice(0, 1024) } }
        const output = JSON.stringify(response) + '\n'
        if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw new Error('Remote response exceeds limit')
        if (!process.stdout.write(output)) await once(process.stdout, 'drain')
      }
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) throw new Error('Remote request frame exceeds limit')
    }
    if ((buffer + decoder.end()).trim()) throw new Error('Incomplete remote request frame')
  } finally { client.disconnect() }
}

if (require.main === module && process.argv[2] === '--help') {
  process.stdout.write('Usage: project-remote-entry --mapping /administrator/owned/project.json\nRestricted SSH stdio endpoint. Requires donwells-project-v1 forced command; no global app RPC.\n')
} else if (require.main === module) {
  if (process.argv[2] !== '--mapping' || process.argv.length !== 4) throw new Error('Usage: project-remote-entry --mapping /administrator/owned/project.json')
  void runProjectRemoteStdio(process.argv[3]).catch(error => { console.error(String(error)); process.exitCode = 1 })
}
