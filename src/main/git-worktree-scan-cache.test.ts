import { describe, expect, it } from 'vitest'
import { WorktreeScanCache } from './git'
import type { Worktree } from '../shared/types'

const sample: Worktree[] = []

describe('WorktreeScanCache', () => {
  it('retries a scan after a previous scan failed', async () => {
    const cache = new WorktreeScanCache()
    let attempts = 0
    const scan = async (): Promise<Worktree[]> => {
      attempts += 1
      if (attempts === 1) throw new Error('transient git failure')
      return sample
    }
    await expect(cache.get('repo', scan)).rejects.toThrow('transient git failure')
    await expect(cache.get('repo', scan)).resolves.toBe(sample)
    expect(attempts).toBe(2)
  })
})
