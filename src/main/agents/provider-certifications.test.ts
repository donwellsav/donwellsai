import { describe, expect, it } from 'vitest'
import { PROVIDER_CERTIFICATIONS, certificationFor } from './provider-certifications'

describe('provider certifications', () => {
  it('ships no managed-support certification without reviewed evidence', () => {
    expect(PROVIDER_CERTIFICATIONS).toEqual([])
    expect(certificationFor('codex', 'managed', '/usr/bin/codex', [], process.platform, process.arch)).toBeUndefined()
  })
})
