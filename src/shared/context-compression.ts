import { logger } from './logger'

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp?: number
  tokens?: number
}

export interface CompressionResult {
  messages: Message[]
  compressed: boolean
  originalCount: number
  removedCount: number
  estimatedTokens: number
}

export interface CompressionOptions {
  /** Maximum estimated tokens before compression triggers. */
  maxTokens: number
  /** Messages to always preserve (system prompts, recent context). */
  preserveCount: number
  /** Minimum messages to keep even if over limit. */
  minKept: number
}

const DEFAULT_OPTIONS: CompressionOptions = {
  maxTokens: 100000,
  preserveCount: 4,
  minKept: 8
}

/**
 * Estimates token count from character count.
 * Uses the ~4 chars/token heuristic for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Compresses a message history to fit within token limits.
 *
 * Strategy:
 * 1. Always preserve system messages and recent messages (sliding window)
 * 2. Summarize or drop middle messages when over limit
 * 3. Preserve message pairs (user + assistant) to maintain coherence
 */
export function compressContext(
  messages: Message[],
  options: Partial<CompressionOptions> = {}
): CompressionResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  if (messages.length === 0) {
    return { messages: [], compressed: false, originalCount: 0, removedCount: 0, estimatedTokens: 0 }
  }

  // Calculate total tokens
  const totalTokens = messages.reduce((sum, m) => sum + (m.tokens ?? estimateTokens(m.content)), 0)

  if (totalTokens <= opts.maxTokens) {
    return {
      messages,
      compressed: false,
      originalCount: messages.length,
      removedCount: 0,
      estimatedTokens: totalTokens
    }
  }

  // Need to compress: keep first N (system) + last N (recent), summarize middle
  const headCount = Math.min(opts.preserveCount, Math.floor(messages.length / 3))
  const tailCount = Math.max(opts.minKept - headCount, Math.floor(messages.length / 3))

  const head = messages.slice(0, headCount)
  const tail = messages.slice(-tailCount)
  const middle = messages.slice(headCount, messages.length - tailCount)

  // Summarize middle section
  const summarized = summarizeMessages(middle)

  const compressed = [
    ...head,
    ...(summarized ? [summarized] : []),
    ...tail
  ]

  const newTokens = compressed.reduce((sum, m) => sum + (m.tokens ?? estimateTokens(m.content)), 0)

  logger.info(
    {
      original: messages.length,
      compressed: compressed.length,
      removed: messages.length - compressed.length,
      originalTokens: totalTokens,
      newTokens
    },
    'context: compressed'
  )

  return {
    messages: compressed,
    compressed: true,
    originalCount: messages.length,
    removedCount: messages.length - compressed.length,
    estimatedTokens: newTokens
  }
}

/**
 * Summarizes a block of messages into a single context message.
 */
function summarizeMessages(messages: Message[]): Message | null {
  if (messages.length === 0) return null

  const userMessages = messages.filter(m => m.role === 'user')
  const assistantMessages = messages.filter(m => m.role === 'assistant')

  const summaryParts: string[] = []

  if (userMessages.length > 0) {
    const topics = userMessages
      .map(m => m.content.slice(0, 100))
      .filter(c => c.length > 0)
    summaryParts.push(`Previous discussion covered ${userMessages.length} user messages including: ${topics.slice(0, 3).join('; ')}${topics.length > 3 ? '...' : ''}`)
  }

  if (assistantMessages.length > 0) {
    const lastResponse = assistantMessages[assistantMessages.length - 1]
    summaryParts.push(`Last assistant response was ${lastResponse.content.length} characters.`)
  }

  const content = `[Context summary: ${messages.length} messages compressed. ${summaryParts.join(' ')}]`

  return {
    role: 'system',
    content,
    timestamp: Date.now(),
    tokens: estimateTokens(content)
  }
}

/**
 * Sliding window compressor that keeps only the most recent N messages.
 * Useful for stateless contexts where full history isn't needed.
 */
export function slidingWindow(
  messages: Message[],
  windowSize: number,
  includeSystem = true
): Message[] {
  if (messages.length <= windowSize) return messages

  const system = includeSystem ? messages.filter(m => m.role === 'system') : []
  const nonSystem = messages.filter(m => m.role !== 'system')

  return [...system, ...nonSystem.slice(-windowSize)]
}
