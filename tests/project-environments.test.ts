import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectEnvironments } from '../src/main/project-environments'
import { validateSshConfig, sshFailureMessage, sshProjectArguments } from '../src/main/project-remote'
import { ProcessExecutionError } from '../src/shared/child-process/run-process'
import { ProjectRemoteServer, readRemoteProjectMapping } from '../src/main/project-remote-server'
import { TerminalDaemon } from '../src/main/terminal-daemon'
import { DaemonClient } from '../src/main/daemon-client'
import type { ProjectRemoteRequest, SshEnvironmentConfig, ProjectRemoteOperation } from '../src/shared/project-environment'

const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-environment-'))); paths.push(root)
  const project = join(root, 'project'); mkdirSync(project)
  const identityFile = join(root, 'identity'); writeFileSync(identityFile, 'not-a-real-private-key', { mode: 0o600 })
  const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)])
  const config: SshEnvironmentConfig = { kind: 'ssh', hostname: '127.0.0.1', username: 'dwtrial', port: 2222, identityFile, hostKey: 'ssh-ed25519 ' + key.toString('base64'), hostFingerprint: 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, ''), remoteProjectId: 'remote-project', remoteRoot: project }
  return { root, project, config }
}

it('pins independently verified SSH identity and makes project pairing immutable with explicit paused dispatch', async () => {
  const { root, project, config } = fixture()
  expect(() => validateSshConfig({ ...config, hostFingerprint: 'SHA256:unverified' })).toThrow('independently verified')
  expect(() => validateSshConfig({ ...config, hostname: '-oProxyCommand=evil' })).toThrow('hostname')
  const args = sshProjectArguments(config, '/private/known_hosts')
  expect(args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', 'ForwardAgent=no', 'IdentityAgent=none', 'ClearAllForwardings=yes']))
  expect(args.slice(-3)).toEqual(['--', 'dwtrial@127.0.0.1', 'donwells-project-v1'])
  let remotePlatform = { os: 'darwin', arch: 'arm64', runtime: 'v24.19.0' }
  let remoteCapabilities = ['terminal', 'ordered-input', 'operation-journal']
  const transport = vi.fn(async (_environment, _knownHosts, request: ProjectRemoteRequest) => request.method === 'hello' ? { version: 1, projectId: config.remoteProjectId, root: project, environmentId: request.environmentId, generation: 1, ...remotePlatform, capabilities: remoteCapabilities } : [])
  const environments = new ProjectEnvironments(join(root, 'profile'), async path => {
    if (path !== project) throw new Error('unregistered project')
    return { projectPath: project, checkoutPath: project, projectKey: 'project-key', indexKey: 'checkout-key' }
  }, transport)
  const environment = await environments.configure(project, 'guest', config)
  expect(environment.state).toBe('configured')
  await expect(environments.request(project, 'guest', 1, 'terminal.open', { cols: 80, rows: 24 }, 'open')).rejects.toThrow('Connect')
  await environments.connect(project, 'guest', 1)
  remotePlatform = { os: 'linux', arch: 'arm64', runtime: 'v24.19.0' }
  await environments.configure(project, 'linux-guest', config)
  expect((await environments.connect(project, 'linux-guest', 1)).state).toBe('ready')
  remotePlatform = { os: 'linux', arch: 'x64', runtime: 'v24.19.0' }
  await environments.configure(project, 'wrong-arch', config)
  await expect(environments.connect(project, 'wrong-arch', 1)).rejects.toThrow('handshake')
  remotePlatform = { os: 'linux', arch: 'arm64', runtime: 'v23.11.0' }
  await environments.configure(project, 'wrong-runtime', config)
  await expect(environments.connect(project, 'wrong-runtime', 1)).rejects.toThrow('handshake')
  remotePlatform = { os: 'linux', arch: 'arm64', runtime: 'v24.19.0' }; remoteCapabilities = ['terminal']
  await environments.configure(project, 'missing-capability', config)
  await expect(environments.connect(project, 'missing-capability', 1)).rejects.toThrow('handshake')
  await environments.request(project, 'guest', 1, 'terminal.list', {}, 'list')
  await environments.pause(project, 'guest', 1)
  await expect(environments.request(project, 'guest', 1, 'terminal.open', { cols: 80, rows: 24 }, 'open')).rejects.toThrow('Connect')
  await expect(environments.request(project, 'guest', 2, 'terminal.list', {}, 'list')).rejects.toThrow('generation')
  await expect(environments.configure(project, 'guest', { ...config, username: 'other' })).rejects.toThrow('reassigned')
  writeFileSync(join(root, 'profile/project-environments/guest.known_hosts'), 'changed host key\n')
  await expect(environments.connect(project, 'guest', 1)).rejects.toThrow('trust file changed')
  expect((await environments.list(project))[0].state).toBe('unverifiable')
  expect(() => readRemoteProjectMapping(join(root, 'mapping.json'))).toThrow()
})

it('reports bounded SSH stderr when the transport rejects authentication', () => {
  const result = { code: 255, signal: null, stdout: '', stderr: '\u001b[31mPermission denied (publickey).\r\n', durationMs: 1 }
  expect(sshFailureMessage(new ProcessExecutionError('exit', 'process exited with code 255', { result }))).toBe('SSH remote request failed: Permission denied (publickey).')
  expect(sshFailureMessage(new Error('other failure'))).toBeUndefined()
})

it('keeps a real daemon terminal across endpoint reconnects without replaying ordered input', async () => {
  const { root, project } = fixture(), stateDirectory = join(root, 'supervisor')
  const mapping = { version: 1 as const, environmentId: 'guest', generation: 1, projectId: 'remote-project', root: project, stateDirectory }
  const daemon = new TerminalDaemon({ userDataDir: stateDirectory, authToken: 'remote-fixture-token' })
  const makeClient = () => new DaemonClient(stateDirectory, { data() {}, exit() {}, title() {}, agent() {}, agentDismissed() {} }, join(root, 'unused.js'))
  let client = makeClient(), sessionId = '', agentSessionId = ''
  const request = (method: ProjectRemoteRequest['method'], requestId: string, params: Record<string, unknown> = {}): ProjectRemoteRequest => ({ version: 1, environmentId: 'guest', generation: 1, projectId: 'remote-project', remoteRoot: project, method, requestId, params })
  await daemon.start()
  try {
    let server = new ProjectRemoteServer(mapping, client)
    await expect(server.dispatch({ ...request('hello', 'hello'), projectId: 'other' })).rejects.toThrow('identity')
    expect(await server.dispatch(request('hello', 'hello'))).toMatchObject({ sharedMemory: false, root: project })
    const opened = await server.dispatch(request('terminal.open', 'open', { cols: 80, rows: 24 })) as ProjectRemoteOperation
    expect(opened.state).toBe('completed'); sessionId = (opened.result as { id: string }).id
    const input = request('terminal.write', 'input', { sessionId, sequence: 0, data: "printf 'once\\n' >> output.txt\r" })
    expect(await server.dispatch(input)).toMatchObject({ state: 'completed', sequence: 0 })
    client.disconnect(); client = makeClient(); server = new ProjectRemoteServer(mapping, client)
    expect(await server.dispatch(input)).toMatchObject({ state: 'completed', sequence: 0 })
    await expect(server.dispatch({ ...input, params: { ...input.params, data: 'different' } })).rejects.toThrow('different parameters')
    await expect(server.dispatch(request('terminal.write', 'gap', { sessionId, sequence: 3, data: 'x' }))).rejects.toThrow('sequence mismatch')
    for (let i = 0; i < 100; i++) { try { if (readFileSync(join(project, 'output.txt'), 'utf8') === 'once\n') break } catch {} await new Promise(resolve => setTimeout(resolve, 10)) }
    expect(readFileSync(join(project, 'output.txt'), 'utf8')).toBe('once\n')
    const observed = await server.dispatch(request('terminal.observe', 'observe', { sessionId }))
    expect(observed).toMatchObject({ session: { id: sessionId }, nextInputSequence: 1 })
    await expect(server.dispatch(request('terminal.stop', 'wrong', { sessionId: 'someone-else' }))).rejects.toThrow('not owned')
    expect(await server.dispatch(request('terminal.stop', 'stop', { sessionId }))).toMatchObject({ state: 'completed' })
    const harmlessAgent = join(root, 'opencode'); copyFileSync('/bin/cat', harmlessAgent); chmodSync(harmlessAgent, 0o700)
    const agent = await client.startAgent(project, 'opencode', 'opencode', { executable: harmlessAgent, args: [] }); agentSessionId = agent.session.id
    const stopped = await server.dispatch(request('terminal.stop', 'stop-agent', { sessionId: agentSessionId })) as ProjectRemoteOperation
    expect(stopped).toMatchObject({ state: 'completed', result: { sessionId: agentSessionId, workspacePath: project, liveness: 'exited' } })
    expect((await client.listAgents()).find(run => run.sessionId === agentSessionId)?.liveness).toBe('exited')
    await client.dismissAgent(agentSessionId); agentSessionId = ''
  } finally { if (agentSessionId) await client.stopAgent(agentSessionId).catch(() => {}); if (sessionId) await client.close(sessionId).catch(() => {}); client.disconnect(); expect(await daemon.stopIfIdle()).toBe(true) }
})

it('records an uncertain input and blocks later bytes after dispatch failure', async () => {
  const { root, project } = fixture()
  const daemon = { list: async () => [{ id: 'session', worktreePath: project, title: 'fixture', createdAt: '', exited: false }], open: vi.fn(), attach: vi.fn(), resize: vi.fn(), close: vi.fn(), writeAcknowledged: vi.fn(async () => { throw new Error('connection lost after write') }) }
  const server = new ProjectRemoteServer({ version: 1, environmentId: 'guest', generation: 1, projectId: 'project', root: project, stateDirectory: join(root, 'journal') }, daemon)
  const request: ProjectRemoteRequest = { version: 1, environmentId: 'guest', generation: 1, projectId: 'project', remoteRoot: project, method: 'terminal.write', requestId: 'first', params: { sessionId: 'session', sequence: 0, data: 'x' } }
  expect(await server.dispatch(request)).toMatchObject({ state: 'uncertain' })
  expect(await server.dispatch(request)).toMatchObject({ state: 'uncertain' })
  expect(daemon.writeAcknowledged).toHaveBeenCalledTimes(1)
  await expect(server.dispatch({ ...request, requestId: 'second', params: { ...request.params, sequence: 1 } })).rejects.toThrow('pending or uncertain')
})

it('prepares only the admitted Lume machine with scoped mounts and explicit clipboard/VNC disable', async () => {
  const { root, project } = fixture()
  const { prepareLumeEnvironment } = await import('../src/main/project-lume')
  const storage = join(root, 'vms'), vm = join(storage, 'disposable'), returns = join(root, 'returns'), executable = join(root, 'admitted-lume')
  mkdirSync(vm, { recursive: true }); mkdirSync(returns); writeFileSync(executable, 'fixture-binary')
  writeFileSync(join(vm, 'disk.img'), 'disposable-disk'); writeFileSync(join(vm, 'nvram.bin'), 'disposable-nvram')
  writeFileSync(join(vm, 'config.json'), JSON.stringify({ machineIdentifier: 'machine-A', cpuCount: 4, memorySize: 8 * 1024 ** 3, os: 'macOS' }))
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  const admission = { executable, executableSha256: sha('fixture-binary'), clipboardDisabledQualified: true, vncDisabledQualified: true }
  const config = { storageDirectory: storage, name: 'disposable', machineIdentifierSha256: sha('machine-A'), mounts: [{ path: project, purpose: 'source' as const, mode: 'ro' as const }, { path: returns, purpose: 'results' as const, mode: 'rw' as const }] }
  const scope = { projectPath: project, checkoutPath: project, projectKey: 'project', indexKey: 'checkout' }
  const spec = prepareLumeEnvironment(admission, config, scope, returns)
  expect(spec.args).toEqual(['run', 'disposable', '--storage', storage, '--display', 'native', '--vnc', 'disabled', '--no-clipboard', '--network', 'nat', '--shared-dir', project + ':ro', '--shared-dir', returns + ':rw'])
  expect(() => prepareLumeEnvironment({ ...admission, clipboardDisabledQualified: false }, config, scope, returns)).toThrow('qualified')
  expect(() => prepareLumeEnvironment(admission, { ...config, machineIdentifierSha256: sha('other-machine') }, scope, returns)).toThrow('machine identity')
  expect(() => prepareLumeEnvironment(admission, { ...config, mounts: [{ path: root, purpose: 'source', mode: 'ro' }] }, scope, returns)).toThrow('reviewed source')
})

it('authenticates each bridge call and writes one canonical memory revision with a durable minimal receipt', async () => {
  const { root, project, config } = fixture()
  const { ProjectMemoryService } = await import('../src/main/project-memory')
  const { DatabaseSync } = await import('node:sqlite')
  const projectKey = 'a'.repeat(64), profile = join(root, 'profile')
  const scope = async (path: string) => { if (path !== project) throw new Error('unregistered'); return { projectPath: project, checkoutPath: project, projectKey, indexKey: projectKey } }
  const memory = new ProjectMemoryService(profile, async path => { await scope(path); return { projectPath: project, projectKey } })
  let live = true
  const transport = vi.fn(async (_environment, _knownHosts, request: ProjectRemoteRequest) => {
    if (request.method === 'hello') return { version: 1, projectId: config.remoteProjectId, root: project, environmentId: 'guest', generation: 1, os: 'darwin', arch: 'arm64', runtime: 'v24.19.0', capabilities: ['terminal', 'ordered-input', 'operation-journal'] }
    if (request.method === 'agent.authenticate' && live && (request.params.credential as { token: string }).token === 'valid') return { workspacePath: project }
    throw new Error('owner credential revoked')
  })
  const environments = new ProjectEnvironments(profile, scope, transport, memory)
  await environments.configure(project, 'guest', config); await environments.connect(project, 'guest', 1)
  const credential = { runId: 'run', sessionId: 'session', token: 'valid' }
  const input = { workspacePath: '/untrusted/guest-path', kind: 'decision', title: 'Shared authority', content: 'Canonical fact from remote agent', tags: [], attribution: { harness: 'opencode', sourceSession: 'session' } }
  const created = await environments.invokeMemory(project, 'guest', 1, 'mutation', 'memory.create', input, credential) as { id: string; revision: number }
  expect(await memory.projectMemoryGet({ workspacePath: project, id: created.id })).toMatchObject({ content: input.content, revision: 1 })
  expect(await environments.invokeMemory(project, 'guest', 1, 'mutation', 'memory.create', input, credential)).toEqual({ alreadyCompleted: true, id: created.id, revision: 1 })
  await expect(environments.invokeMemory(project, 'guest', 1, 'mutation', 'memory.create', { ...input, title: 'Different' }, credential)).rejects.toThrow('different parameters')
  expect(await environments.invokeMemory(project, 'guest', 1, 'status', 'memory.operation', { requestId: 'mutation' }, credential)).toMatchObject({ state: 'completed', receipt: { id: created.id, revision: 1 } })
  const db = new DatabaseSync(join(profile, 'project-environments/environments.sqlite'))
  try { const rows = db.prepare('SELECT * FROM memory_requests').all(); expect(rows).toHaveLength(1); expect(JSON.stringify(rows)).not.toContain(input.content); expect(JSON.stringify(rows)).not.toContain('valid') } finally { db.close() }
  live = false
  await expect(environments.invokeMemory(project, 'guest', 1, 'read', 'memory.get', { id: created.id }, credential)).rejects.toThrow('revoked')
  await expect(environments.invokeMemory(project, 'guest', 1, 'tool', 'tool.call', {}, credential)).rejects.toThrow('only project memory')
  await environments.pause(project, 'guest', 1)
  await expect(environments.invokeMemory(project, 'guest', 1, 'read', 'memory.get', { id: created.id }, credential)).rejects.toThrow('paused')
})

it('stages selected remote text and guards return updates, additions and deletion against local edits', async () => {
  const { root, project } = fixture()
  const { ProjectEnvironmentResults } = await import('../src/main/project-environment-results')
  const { WorktreeFiles } = await import('../src/main/worktree-files')
  const files = new WorktreeFiles(), hash = (content: string) => 'sha256:' + createHash('sha256').update(content).digest('hex')
  writeFileSync(join(project, 'update.txt'), 'before'); writeFileSync(join(project, 'delete.txt'), 'delete baseline')
  const remote = new Map<string, string>([['update.txt', 'after'], ['new/output.txt', 'new result']])
  const environment = { id: 'guest', generation: 1, checkoutPath: project }
  const environments = { get: async () => environment, request: async (_workspace: string, _id: string, _generation: number, method: string, params: { path: string }) => {
    if (method !== 'result.read') throw new Error('unexpected mutation')
    const content = remote.get(params.path); return content === undefined ? { exists: false } : { exists: true, content, revision: hash(content) }
  } } as unknown as ProjectEnvironments
  const results = new ProjectEnvironmentResults(join(root, 'profile'), environments, { readFile: files.readFile.bind(files), writeFile: files.writeFile.bind(files), createWorkspaceEntry: files.createWorkspaceEntry.bind(files), deleteWorkspaceEntry: files.deleteWorkspaceEntry.bind(files), handoffSource: async () => ({ sourceRevision: null, dirty: false, projectPath: project, workspacePath: project }) } as never)
  const review = await results.capture(project, 'guest', 1, ['update.txt', 'delete.txt', 'new/output.txt'])
  await results.stage(project, review.id)
  writeFileSync(join(project, 'delete.txt'), 'local edit after review')
  await expect(results.decline(project, review.id, ['update.txt', 'missing.txt'])).rejects.toThrow('staged')
  expect((await results.get(project, review.id)).files[0].state).toBe('staged')
  const declined = await results.decline(project, review.id, ['delete.txt'])
  const declinedBytes = declined.files[1].received
  expect(declined.files[1].state).toBe('declined')
  expect((await results.stage(project, review.id)).files[1]).toMatchObject({ state: 'declined', received: declinedBytes })
  await expect(results.apply(project, review.id, ['delete.txt'])).rejects.toThrow('new capture')
  const applied = await results.apply(project, review.id, ['update.txt', 'new/output.txt'])
  expect(applied.files.map(file => file.state)).toEqual(['applied', 'declined', 'applied'])
  expect(readFileSync(join(project, 'update.txt'), 'utf8')).toBe('after')
  expect(readFileSync(join(project, 'new/output.txt'), 'utf8')).toBe('new result')
  expect(readFileSync(join(project, 'delete.txt'), 'utf8')).toBe('local edit after review')
  expect((await results.get(project, review.id)).files[0].baseContent).toBe('before')
  await expect(results.capture(project, 'guest', 1, ['.env'])).rejects.toThrow()
  const deletion = await files.readFile(project, 'delete.txt')
  writeFileSync(join(project, 'delete.txt'), 'newer local edit')
  await expect(files.deleteWorkspaceEntry(project, { path: 'delete.txt', expectedRevision: deletion.revision! })).rejects.toThrow()
})

it('serves the scoped memory socket only while its acknowledged forward is owned and closes it on stop', async () => {
  const { project, config } = fixture()
  const { ProjectEnvironmentMemory } = await import('../src/main/project-environment-memory')
  const { remoteMemoryRequest } = await import('../src/main/project-remote-memory-entry')
  let localSocket = '', stopped = false
  const invokeMemory = vi.fn(async (_workspace, _id, _generation, _requestId, method, _params, credential) => { if (credential.token !== 'valid') throw new Error('revoked'); return { method, canonical: project } })
  const environments = {
    get: async (workspace: string) => { if (workspace !== project) throw new Error('wrong project'); return { id: 'guest', generation: 1, state: 'ready', config } },
    trustFile: () => '/unused-known-hosts', invokeMemory,
    request: async (_workspace: string, _id: string, _generation: number, method: string, params: Record<string, unknown>) => {
      if (method === 'hello') return { memorySocket: '/private/remote-memory.sock' }
      if (method === 'memory.prepare') return {}
      if (method === 'memory.probe') return remoteMemoryRequest(localSocket, 'bridge.ping', params, {}, 'probe', 1000)
      throw new Error('unexpected method')
    }
  } as unknown as ProjectEnvironments
  const bridge = new ProjectEnvironmentMemory(environments, (async spec => {
    const args = spec.args!; expect(args).toEqual(expect.arrayContaining(['-N', 'ClearAllForwardings=no', 'StreamLocalBindUnlink=no', 'ExitOnForwardFailure=yes']))
    localSocket = args[args.indexOf('-R') + 1].slice('/private/remote-memory.sock:'.length)
    await new Promise<void>(resolve => spec.signal!.addEventListener('abort', () => { stopped = true; resolve() }, { once: true }))
    return { exitCode: 0, stdout: '', stderr: '' }
  }) as never)
  try {
    expect(await bridge.start(project, 'guest', 1)).toEqual({ state: 'connected' })
    expect(await remoteMemoryRequest(localSocket, 'memory.list', {}, { token: 'valid' }, 'read', 1000)).toMatchObject({ canonical: project })
    await expect(remoteMemoryRequest(localSocket, 'memory.list', {}, { token: 'bad' }, 'rejected', 1000)).rejects.toThrow('revoked')
    await expect(bridge.stop('/other-project', 'guest', 1)).rejects.toThrow('wrong project')
    await bridge.stop(project, 'guest', 1)
    expect(stopped).toBe(true); expect(bridge.active).toBe(false)
    await expect(remoteMemoryRequest(localSocket, 'memory.list', {}, { token: 'valid' }, 'after-stop', 1000)).rejects.toThrow()
  } finally { await bridge.close() }
})

it('reports the SSH reason when a remote memory forward is rejected', async () => {
  const { project, config } = fixture()
  const { ProjectEnvironmentMemory } = await import('../src/main/project-environment-memory')
  const environments = {
    get: async () => ({ id: 'guest', generation: 1, state: 'ready', config }), trustFile: () => '/unused-known-hosts',
    request: async (_workspace: string, _id: string, _generation: number, method: string) => method === 'hello' ? { memorySocket: '/private/remote-memory.sock' } : {}
  } as unknown as ProjectEnvironments
  const result = { exitCode: 255, signal: null, stdout: '', stderr: 'Error: remote port forwarding failed for listen path\n', timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false }
  const bridge = new ProjectEnvironmentMemory(environments, (async () => { throw new ProcessExecutionError('exit', 'process exited with code 255', { result }) }) as never)
  try { await expect(bridge.start(project, 'guest', 1)).rejects.toThrow('SSH remote request failed: Error: remote port forwarding failed for listen path') }
  finally { await bridge.close() }
})

it('admits only private prepared Lume disks and reconnects/stops the recorded owner without replaying launch', async () => {
  const { root, project } = fixture(), profile = join(root, 'lume-profile')
  const { ProjectLume } = await import('../src/main/project-lume')
  const scope = async (path: string) => { if (path !== project) throw new Error('foreign project'); return { projectPath: project, checkoutPath: project, projectKey: 'project', indexKey: 'checkout' } }
  let running = false, release!: () => void, launches = 0
  let vm = ''
  const execute = vi.fn(async spec => {
    if (spec.args[0] === 'get') return { stdout: JSON.stringify([{ name: 'fresh', cpuCount: 4, memorySize: 8 * 1024 ** 3, os: 'macOS', status: running ? 'running' : 'stopped', vncUrl: null, ipAddress: '192.168.64.20' }]) }
    if (spec.args[0] === 'run') { launches++; running = true; writeFileSync(join(vm, 'sessions.json'), JSON.stringify({ vncEnabled: false, pid: process.pid, startedAt: 123 })); await new Promise<void>(resolve => { release = resolve }); return { stdout: '' } }
    if (spec.args[0] === 'stop') { running = false; release(); return { stdout: '' } }
    if (spec.args[0] === 'attach') return { stdout: 'Requested native display' }
    throw new Error('Unexpected command')
  })
  const owner = new ProjectLume(profile, scope, execute as never), info = await owner.list(project)
  vm = join(info.storageDirectory, 'fresh'); mkdirSync(vm)
  writeFileSync(join(vm, 'disk.img'), 'new disk'); writeFileSync(join(vm, 'nvram.bin'), 'new nvram')
  writeFileSync(join(vm, 'config.json'), JSON.stringify({ machineIdentifier: 'new-machine', cpuCount: 4, memorySize: 8 * 1024 ** 3, os: 'macOS' }))
  const binary = join(root, 'qualified-lume'); writeFileSync(binary, 'fixture')
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  writeFileSync(info.admissionPath, JSON.stringify({ executable: binary, executableSha256: sha('fixture'), clipboardDisabledQualified: true, vncDisabledQualified: true }), { mode: 0o600 })
  const config = { storageDirectory: info.storageDirectory, name: 'fresh', machineIdentifierSha256: sha('new-machine'), mounts: [{ path: project, mode: 'ro' as const, purpose: 'source' as const }, { path: info.returnDirectory, mode: 'rw' as const, purpose: 'results' as const }] }
  await expect(owner.register(project, 'user-vm', { ...config, storageDirectory: root })).rejects.toThrow('retained')
  await owner.register(project, 'fresh', config)
  expect((await owner.action(project, 'fresh', 'start')).state).toBe('starting')
  expect((await owner.action(project, 'fresh', 'status')).state).toBe('running')
  const reconnected = new ProjectLume(profile, scope, execute as never)
  expect(await reconnected.action(project, 'fresh', 'status')).toMatchObject({ state: 'running', pid: process.pid })
  expect(launches).toBe(1)
  writeFileSync(join(vm, '.native-display-owner.json'), JSON.stringify({ processIdentifier: process.pid + 1 }))
  await expect(reconnected.action(project, 'fresh', 'show')).rejects.toThrow('Native viewer')
  expect(execute.mock.calls.filter(([spec]) => spec.args[0] === 'attach')).toHaveLength(0)
  writeFileSync(join(vm, '.native-display-owner.json'), JSON.stringify({ processIdentifier: process.pid }))
  expect(await reconnected.action(project, 'fresh', 'show')).toMatchObject({ state: 'running', pid: process.pid, startedAt: 123 })
  expect(execute.mock.calls.filter(([spec]) => spec.args[0] === 'attach').map(([spec]) => spec.args)).toEqual([['attach', 'fresh', '--storage', info.storageDirectory, '--display', 'native']])
  expect(launches).toBe(1)
  writeFileSync(join(vm, 'sessions.json'), JSON.stringify({ vncEnabled: false, pid: process.pid, startedAt: 124 }))
  await expect(reconnected.action(project, 'fresh', 'show')).rejects.toThrow('recorded owner')
  expect(execute.mock.calls.filter(([spec]) => spec.args[0] === 'attach')).toHaveLength(1)
  writeFileSync(join(vm, 'sessions.json'), JSON.stringify({ vncEnabled: false, pid: process.pid, startedAt: 123 }))
  await expect(reconnected.action('/foreign', 'fresh', 'stop')).rejects.toThrow('foreign')
  await expect(reconnected.action(project, 'fresh', 'remove')).rejects.toThrow('Stop the guest')
  expect((await reconnected.action(project, 'fresh', 'status')).state).toBe('running')
  expect((await reconnected.action(project, 'fresh', 'stop')).state).toBe('stopped')
  await expect(reconnected.action(project, 'fresh', 'show')).rejects.toThrow('running ownership')
  await reconnected.action(project, 'fresh', 'remove')
  expect((await reconnected.list(project)).guests).toEqual([])
  await expect(reconnected.register(project, 'fresh', config)).rejects.toThrow('already been used')
  await reconnected.register(project, 'replacement-binding', config)
  expect((await reconnected.list(project)).guests.map(value => value.id)).toEqual(['replacement-binding'])
  await expect(reconnected.action(project, 'fresh', 'start')).rejects.toThrow('removed')
  expect(readFileSync(join(vm, 'disk.img'), 'utf8')).toBe('new disk')
})

it('removes only idle paused SSH bindings, retains trust and blocks stale IDs after restart', async () => {
  const { root, project, config } = fixture()
  const scope = async (path: string) => { if (path !== project) throw new Error('foreign project'); return { projectPath: project, checkoutPath: project, projectKey: 'project', indexKey: 'checkout' } }
  const transport = vi.fn(async () => [] as Array<{ exited: boolean }>)
  const profile = join(root, 'remove-profile'), owner = new ProjectEnvironments(profile, scope, transport)
  await owner.configure(project, 'remove-guest', config)
  await expect(owner.remove(project, 'remove-guest', 1)).rejects.toThrow('Pause')
  await owner.pause(project, 'remove-guest', 1)
  await expect(owner.remove('/foreign', 'remove-guest', 1)).rejects.toThrow('foreign')
  transport.mockRejectedValueOnce(new Error('unreachable'))
  await expect(owner.remove(project, 'remove-guest', 1)).rejects.toThrow('unreachable')
  transport.mockResolvedValueOnce([{ exited: false }])
  await expect(owner.remove(project, 'remove-guest', 1)).rejects.toThrow('Stop remote terminals')
  expect(await owner.list(project)).toHaveLength(1)
  const trust = readFileSync(owner.trustFile('remove-guest'), 'utf8')
  let releasePending!: () => void
  transport.mockImplementationOnce(() => new Promise(resolve => { releasePending = () => resolve([]) }))
  const pending = owner.request(project, 'remove-guest', 1, 'terminal.list', {}, 'pending-observation')
  await vi.waitFor(() => expect(releasePending).toBeTypeOf('function'))
  transport.mockResolvedValueOnce([])
  const removing = owner.remove(project, 'remove-guest', 1)
  await expect(owner.request(project, 'remove-guest', 1, 'terminal.list', {}, 'during-remove')).rejects.toThrow(/removed|removal/)
  releasePending(); await pending; await removing
  expect(await owner.list(project)).toEqual([])
  expect(readFileSync(owner.trustFile('remove-guest'), 'utf8')).toBe(trust)
  const reloaded = new ProjectEnvironments(profile, scope, transport)
  await expect(reloaded.configure(project, 'remove-guest', config)).rejects.toThrow('removed')
  await expect(reloaded.request(project, 'remove-guest', 1, 'terminal.open', {}, 'stale')).rejects.toThrow('mismatch')
  expect(transport.mock.calls).toHaveLength(4)
})
