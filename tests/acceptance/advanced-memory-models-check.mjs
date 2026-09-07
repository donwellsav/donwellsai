import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const [discovery, output] = process.argv.slice(2)
const bridge = JSON.parse(readFileSync(discovery, 'utf8'))
const request = async encoding_format => {
  const response = await fetch(bridge.url + '/baseline/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: ['Copper Orchard uses SQLite.'], dimensions: 1536, encoding_format }) })
  assert(response.ok)
  return (await response.json()).data[0].embedding
}
const floats = await request('float'), bytes = Buffer.from(await request('base64'), 'base64')
assert.equal(floats.length, 1536)
assert.equal(bytes.length, 1536 * 4)
assert(Math.abs(Math.hypot(...floats) - 1) < 1e-6)
for (let i = 0; i < floats.length; i++) assert(Math.abs(floats[i] - bytes.readFloatLE(i * 4)) < 1e-6)
const calls = JSON.parse(readFileSync(discovery + '.metrics.json', 'utf8')).filter(row => row.operation === 'chat/completions' && typeof row.queueMs === 'number').map(row => ({ start: Date.parse(row.at) + row.queueMs, end: Date.parse(row.at) + row.ms })).sort((a, b) => a.start - b.start)
assert(calls.length >= 2, 'Run real model trials before checking their concurrency')
for (let i = 1; i < calls.length; i++) assert(calls[i].start >= calls[i - 1].end - 5, 'Completed model requests overlapped')
writeFileSync(output, JSON.stringify({ mrlDimensions: 1536, normalized: true, floatAndBase64Agree: true, completedModelCallsChecked: calls.length, serialized: true, toleranceMs: 5 }) + '\n', { flag: 'wx' })
