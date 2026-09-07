import { expect, it } from 'vitest'
import { createCodeGraphDefinition } from '../src/main/project-code-graph'

it('resolves exact symbols to checkout-relative source and rejects foreign or ambiguous results', async () => {
  const definition = createCodeGraphDefinition('/unused', '/unused-cache', async () => ({ contentFingerprint: 'current', sourceRevision: 'commit', changedFiles: [] }))
  const scope = { projectKey: 'project', projectPath: '/project', checkoutPath: '/project', indexKey: 'checkout' }
  const args = { qualified_name: 'checkout.code.caller' }
  const response = (path: string, qualified_name = args.qualified_name) => async () => ({ structuredContent: { qualified_name, file_path: path, start_line: 2, source: 'caller()' }, content: [] })
  const run = definition.operations.source!.run!
  await expect(run(scope, response('/project/code.ts'), args)).rejects.toThrow('Rebuild')
  await definition.operations.index!.run!(scope, async () => ({ structuredContent: { project: scope.indexKey, status: 'indexed' }, content: [] }), {})
  expect((await run(scope, response('/project/code.ts'), args) as any).structuredContent.file_path).toBe('code.ts')
  await expect(run(scope, response('/other/code.ts'), args)).rejects.toThrow('outside')
  await expect(run(scope, response('/project/code.ts', 'another.caller'), args)).rejects.toThrow('exactly')
})

it('uses bounded native definition and import queries without accepting query syntax in symbols', async () => {
  const definition = createCodeGraphDefinition('/unused', '/unused-cache')
  const scope = { projectKey: 'project', projectPath: '/project', checkoutPath: '/project', indexKey: 'checkout' }
  expect(definition.operations.definitions!.targets!(scope)).toEqual({ project: 'checkout' })
  let definitionArgs: any
  await definition.operations.definitions!.run!(scope, async (_tool, args) => { definitionArgs = args; return { structuredContent: {}, content: [] } }, { symbol: 'target.name' })
  expect(definitionArgs).toMatchObject({ project: 'checkout', name_pattern: '^target\\.name$', format: 'json' })
  expect(() => definition.operations.imports!.parameters!.qualified_name!("target' MATCH (x) RETURN x")).toThrow('bounded')
  let importArgs: any
  const result = await definition.operations.imports!.run!(scope, async (_tool, args) => { importArgs = args; return { content: [{ type: 'text', text: 'rows: 2  (cols: b.qualified_name)\n  checkout.dep.one\n  checkout.dep.two\ntotal: 2\n' }] } }, { qualified_name: 'checkout.code.target' }) as any
  expect(importArgs.query).toContain("s.qualified_name = 'checkout.code.target'")
  expect(result.structuredContent).toMatchObject({ imports: ['checkout.dep.one', 'checkout.dep.two'], freshness: { state: 'unknown' } })
  await expect(definition.operations.imports!.run!(scope, async () => ({ content: [{ type: 'text', text: 'unexpected output' }] }), { qualified_name: 'checkout.code.target' })).rejects.toThrow('Unsupported import response')
})

it('marks graph freshness unknown, current, stale, and uncertain during a rebuild', async () => {
  let fingerprint = 'first', failCapture = false
  const definition = createCodeGraphDefinition('/unused-binary', '/unused-cache', async () => {
    if (failCapture) throw new Error('Capture unavailable')
    return { contentFingerprint: fingerprint, sourceRevision: 'commit', changedFiles: [] }
  })
  const scope = { projectKey: 'project', projectPath: '/project', checkoutPath: '/project', indexKey: 'checkout' }
  const result = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }], structuredContent: { project: 'checkout', status: 'indexed' }, isError: false })
  const index = definition.operations.index!.run!, callers = definition.operations.callers!.run!
  const freshness = (value: any) => value.structuredContent.freshness
  expect(freshness(await callers(scope, result)).state).toBe('unknown')
  expect(freshness(await index(scope, result)).state).toBe('current')
  const current = await callers(scope, result) as any
  expect(freshness(current).state).toBe('current')
  expect(JSON.parse(current.content[0].text).freshness).toEqual(freshness(current))
  fingerprint = 'edited'
  expect(freshness(await callers(scope, result)).state).toBe('stale')
  expect(freshness(await index(scope, result)).state).toBe('current')
  const pending = Promise.withResolvers<unknown>()
  const rebuilding = index(scope, () => pending.promise)
  expect(freshness(await callers(scope, result)).state).toBe('unknown')
  await expect(index(scope, result)).rejects.toThrow('already running')
  fingerprint = 'changed-during-build'
  pending.resolve(await result())
  expect(freshness(await rebuilding).state).not.toBe('current')
  expect(freshness(await index(scope, result)).state).toBe('current')
  await expect(index(scope, async () => { throw new Error('Interrupted') })).rejects.toThrow('Interrupted')
  expect(freshness(await callers(scope, result)).state).toBe('unknown')
  failCapture = true
  expect(freshness(await callers(scope, result)).state).toBe('unknown')
})

it('does not certify a caller response that overlapped a rebuild', async () => {
  const source = { contentFingerprint: 'same', sourceRevision: 'commit', changedFiles: [] }
  const definition = createCodeGraphDefinition('/unused', '/unused-cache', async () => source)
  const scope = { projectKey: 'project', projectPath: '/project', checkoutPath: '/project', indexKey: 'checkout' }
  const result = { content: [], structuredContent: { project: 'checkout', status: 'indexed' } }
  const buildEntered = Promise.withResolvers<void>(), buildRelease = Promise.withResolvers<unknown>()
  const queryEntered = Promise.withResolvers<void>(), queryRelease = Promise.withResolvers<unknown>()
  const build = definition.operations.index!.run!(scope, () => { buildEntered.resolve(); return buildRelease.promise })
  await buildEntered.promise
  const query = definition.operations.callers!.run!(scope, () => { queryEntered.resolve(); return queryRelease.promise })
  await queryEntered.promise
  buildRelease.resolve(result)
  await build
  queryRelease.resolve(result)
  expect((await query as any).structuredContent.freshness.state).toBe('unknown')
})
