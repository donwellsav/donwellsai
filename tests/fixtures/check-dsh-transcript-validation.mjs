#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { validateIntegratedDshTurn } from '../helpers/dsh-transcript-validation.mjs'

const [transcript, zstd = 'zstd'] = process.argv.slice(2)
assert(transcript, 'Usage: check-dsh-transcript-validation.mjs <session.jsonl.zstd> [zstd]')
const events = execFileSync(zstd, ['-dc', transcript], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n').map(JSON.parse)
const end = events.findLast(event => event.type === 'turn/end')
assert(end, 'Transcript has no completed turn')
const turn = events.filter(event => event.data?.turn === end.data.turn)
assert.equal(validateIntegratedDshTurn(turn).acceptedInvalidCommandRecovery, true)
const injected = structuredClone(turn)
injected.push({ type: 'tool/call', data: { turn: end.data.turn, step: 99, callId: 'injected', name: 'unexpected_tool', arguments: '{}' } })
injected.push({ type: 'tool/result', data: { turn: end.data.turn, step: 99, message: { content: [{ type: 'tool-result', toolCallId: 'injected', isError: true, content: [{ type: 'text', text: 'unexpected failure' }] }] } } })
assert.throws(() => validateIntegratedDshTurn(injected), /unexpected failed tool call/)
console.log('DSH transcript validator accepts the recovered correction and rejects unknown errors')
