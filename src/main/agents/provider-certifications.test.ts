import { describe, expect, it } from 'vitest'
import { isProviderCertificationPlatform } from '@shared/provider-authority'
import { PROVIDER_CERTIFICATIONS, certificationFor, parseProviderCertification, type ProviderCertification } from './provider-certifications'

const PLATFORM = isProviderCertificationPlatform(process.platform) ? process.platform : undefined
const reviewed = {
  driverId: 'codex',
  modes: ['managed'] as const,
  executablePath: '/usr/local/bin/codex',
  supportedVersionRange: '>=1.0.0 <2.0.0',
  platform: PLATFORM,
  architecture: 'arm64'
}

describe('provider certifications', () => {
  it('ships no managed-support certification without reviewed evidence', () => {
    expect(PROVIDER_CERTIFICATIONS).toEqual([])
    expect(certificationFor('codex', 'managed', '/usr/bin/codex', [], process.platform, process.arch)).toBeUndefined()
  })

  it('decodes a reviewed entry and freezes it', () => {
    const parsed = parseProviderCertification({ ...reviewed, executableSha256: 'a'.repeat(64), version: '1.2.0', allowedArgs: ['--isolated'] })
    expect(parsed).toMatchObject({ ...reviewed, executableSha256: 'a'.repeat(64), version: '1.2.0', allowedArgs: ['--isolated'] })
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it('de-duplicates repeated modes rather than widening them', () => {
    expect(parseProviderCertification({ ...reviewed, modes: ['managed', 'managed', 'none'] }).modes).toEqual(['managed', 'none'])
  })

  it('rejects an unreviewed platform instead of coercing it onto a known one', () => {
    expect(() => parseProviderCertification({ ...reviewed, platform: 'plan9' })).toThrowError(/reviewed platform/)
    expect(() => parseProviderCertification({ ...reviewed, platform: undefined })).toThrowError(/reviewed platform/)
    expect(() => parseProviderCertification({ ...reviewed, platform: 'Darwin' })).toThrowError(/reviewed platform/)
  })

  it('rejects malformed credential modes, drivers, and digests', () => {
    expect(() => parseProviderCertification({ ...reviewed, modes: [] })).toThrowError(/managed\/none modes/)
    expect(() => parseProviderCertification({ ...reviewed, modes: ['external'] })).toThrowError(/managed\/none modes/)
    expect(() => parseProviderCertification({ ...reviewed, driverId: 'not-a-driver' })).toThrowError(/known agent driver/)
    expect(() => parseProviderCertification({ ...reviewed, executableSha256: 'not-a-digest' })).toThrowError(/sha256/)
    expect(() => parseProviderCertification({ ...reviewed, verify: 'yes' })).toThrowError(/must be a function/)
  })

  it('matches only the exact reviewed tuple and never falls back', () => {
    if (PLATFORM === undefined) return
    const entry = parseProviderCertification({ ...reviewed, verify: () => true })
    const matches = (overrides: Partial<ProviderCertification>) => certificationFor('codex', 'managed', '/usr/local/bin/codex', [], PLATFORM, 'arm64', [{ ...entry, ...overrides }]) !== undefined
    expect(matches({})).toBe(true)
    expect(matches({ driverId: 'claude' })).toBe(false)
    expect(matches({ modes: ['none'] })).toBe(false)
    expect(matches({ executablePath: '/usr/local/bin/other' })).toBe(false)
    expect(matches({ architecture: 'x64' })).toBe(false)
    expect(matches({ platform: process.platform === 'linux' ? 'darwin' : 'linux' })).toBe(false)
    // External is never a certified mode, and an unreviewed host never matches.
    expect(certificationFor('codex', 'external', '/usr/local/bin/codex', [], PLATFORM, 'arm64', [entry])).toBeUndefined()
    expect(certificationFor('codex', 'managed', '/usr/local/bin/codex', [], 'plan9' as NodeJS.Platform, 'arm64', [entry])).toBeUndefined()
  })

  it('rejects a candidate whose platform was never reviewed', () => {
    const corrupted = { ...parseProviderCertification(reviewed), platform: 'plan9' } as unknown as ProviderCertification
    expect(certificationFor('codex', 'managed', '/usr/local/bin/codex', [], 'plan9' as NodeJS.Platform, 'arm64', [corrupted])).toBeUndefined()
  })
})
