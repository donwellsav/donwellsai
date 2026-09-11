import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  compressContext,
  slidingWindow,
  type Message
} from '../src/shared/context-compression'

function makeMessages(count: number, chars = 100): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(chars),
    timestamp: Date.now() + i
  }))
}

describe('context-compression', () => {
  it('estimates tokens from character count', () => {
    expect(estimateTokens('hello world')).toBe(3) // 11 chars / 4 = 2.75 → 3
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
  })

  it('returns unchanged when under token limit', () => {
    const messages = makeMessages(10)
    const result = compressContext(messages, { maxTokens: 10000 })
    expect(result.compressed).toBe(false)
    expect(result.messages.length).toBe(10)
  })

  it('compresses when over token limit', () => {
    const messages = makeMessages(100, 1000) // ~25k tokens
    const result = compressContext(messages, { maxTokens: 10000, preserveCount: 4, minKept: 8 })
    expect(result.compressed).toBe(true)
    expect(result.messages.length).toBeLessThan(100)
    expect(result.removedCount).toBeGreaterThan(0)
  })

  it('preserves system messages and recent messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful' },
      ...makeMessages(50, 500),
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: 'recent answer' }
    ]

    const result = compressContext(messages, { maxTokens: 5000, preserveCount: 4, minKept: 4 })

    // System message should be preserved
    expect(result.messages[0].role).toBe('system')
    expect(result.messages[0].content).toBe('You are helpful')

    // Recent messages should be preserved
    const lastMsg = result.messages[result.messages.length - 1]
    expect(lastMsg.content).toBe('recent answer')
  })

  it('produces a summary message for compressed middle', () => {
    const messages = makeMessages(20, 1000)
    const result = compressContext(messages, { maxTokens: 3000, preserveCount: 2, minKept: 4 })

    const summaryMsg = result.messages.find(m => m.content.includes('Context summary'))
    expect(summaryMsg).toBeDefined()
    expect(summaryMsg!.role).toBe('system')
  })

  it('sliding window keeps most recent N messages', () => {
    const messages = makeMessages(20)
    const result = slidingWindow(messages, 10, false)
    expect(result.length).toBe(10)
    // Should be the last 10
    expect(result[result.length - 1].timestamp).toBe(messages[messages.length - 1].timestamp)
  })

  it('sliding window keeps system messages when includeSystem=true', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...makeMessages(10)
    ]
    const result = slidingWindow(messages, 5, true)
    expect(result[0].role).toBe('system')
    expect(result.length).toBe(6) // 1 system + 5 window
  })

  it('handles empty message array', () => {
    const result = compressContext([])
    expect(result.messages).toEqual([])
    expect(result.estimatedTokens).toBe(0)
  })
})
