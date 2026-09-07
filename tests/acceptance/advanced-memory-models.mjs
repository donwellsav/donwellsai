// Trial-only local model bridge: common embeddings/reranking and usage receipts for every candidate.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { qmd: { type: 'string' }, embedding: { type: 'string' }, reranker: { type: 'string' }, output: { type: 'string' } } })
for (const key of ['qmd', 'embedding', 'reranker', 'output']) assert(values[key])
const { LlamaCpp } = await import(pathToFileURL(join(resolve(values.qmd), 'dist/llm.js')))
const llm = new LlamaCpp({ embedModel: resolve(values.embedding), rerankModel: resolve(values.reranker) })
const model = 'Ornith-1.5-35B-A3B-MLX-8bit', metrics = []
let queue = Promise.resolve()
let chatQueue = Promise.resolve()
const serial = operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result }
const server = createServer(async (request, response) => {
  const start = performance.now(), route = /^\/(hindsight|graphiti|lightrag|baseline)\/v1\/(embeddings|chat\/completions|rerank|info)$/.exec(request.url)
  const receipt = { candidate: route?.[1], operation: route?.[2], at: new Date().toISOString() }
  const controller = new AbortController()
  response.once('close', () => { if (!response.writableEnded) controller.abort() })
  const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
  try {
    if (request.method === 'GET' && route?.[2] === 'info') { send(200, { model_id: 'qwen3-reranker-0.6b-q8_0' }); return }
    assert(request.method === 'POST' && route, 'Unknown trial route')
    let body = ''; for await (const chunk of request) { body += chunk; assert(Buffer.byteLength(body) <= 4 * 1024 * 1024, 'Trial request exceeds 4 MiB') }
    const input = JSON.parse(body)
    if (route[2] === 'chat/completions') {
      assert(!input.stream, 'Trial usage accounting requires non-streaming completions')
      const operation = chatQueue.then(async () => {
        controller.signal.throwIfAborted()
        receipt.queueMs = performance.now() - start
        const result = await fetch('http://127.0.0.1:8899/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer omlx-local' }, body: JSON.stringify({ ...input, model }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) })
        const data = await result.json(); receipt.status = result.status; receipt.usage = data.usage ?? null; send(result.status, data)
      })
      chatQueue = operation.catch(() => {})
      await operation
    } else if (route[2] === 'embeddings') {
      const inputs = typeof input.input === 'string' ? [input.input] : input.input
      assert(Array.isArray(inputs) && inputs.length && inputs.every(text => typeof text === 'string'), 'Embeddings require text')
      const vectors = await serial(() => llm.embedBatch(inputs)); assert(vectors.length === inputs.length && vectors.every(v => v?.embedding.length === 2560))
      const dimensions = input.dimensions ?? 2560
      assert(Number.isInteger(dimensions) && dimensions >= 32 && dimensions <= 2560, 'Invalid Qwen MRL dimensions')
      if (dimensions !== 2560) for (const value of vectors) { const reduced = value.embedding.slice(0, dimensions), norm = Math.hypot(...reduced); assert(norm > 0); value.embedding = reduced.map(x => x / norm) }
      receipt.texts = inputs.length
      receipt.dimensions = dimensions
      send(200, { object: 'list', model: 'Qwen3-Embedding-4B-Q8_0', data: vectors.map((value, index) => ({ object: 'embedding', index, embedding: input.encoding_format === 'base64' ? Buffer.from(new Float32Array(value.embedding).buffer).toString('base64') : value.embedding })), usage: { prompt_tokens: 0, total_tokens: 0 } })
    } else {
      const documents = input.documents ?? input.texts
      assert(typeof input.query === 'string' && Array.isArray(documents))
      const ranked = await serial(() => llm.rerank(input.query, documents.map((doc, i) => ({ file: String(i), text: typeof doc === 'string' ? doc : doc.text }))))
      assert(ranked.model !== 'fallback', 'Native reranking unavailable')
      send(200, input.texts ? ranked.results.map(item => ({ index: item.index, score: item.score })) : { results: ranked.results.slice(0, input.top_n ?? ranked.results.length).map(item => ({ index: item.index, relevance_score: item.score })) })
    }
  } catch (error) { receipt.error = String(error).slice(0, 500); send(500, { error: { message: receipt.error } }) }
  finally { receipt.ms = performance.now() - start; metrics.push(receipt); writeFileSync(values.output + '.metrics.json', JSON.stringify(metrics, null, 2) + '\n') }
})
await llm.embed('Warm the shared local embedding model.')
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
writeFileSync(values.output, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, pid: process.pid, model, embeddingDimensions: 2560, embeddingTokenUsage: 'unavailable; response compatibility counters are not measurements' }) + '\n', { flag: 'wx' })
console.log('Local trial model bridge ready')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.all([queue, chatQueue]); await llm.dispose(); process.exit() })
