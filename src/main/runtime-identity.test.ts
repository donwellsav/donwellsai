import { describe, expect, it } from 'vitest'
import type { ProcessIdentity, RuntimeExpectation } from '@shared/child-process/process-spec'
import { createRuntimeIdentityAuthority } from './runtime-identity'

const capturedAt = '2026-09-12T00:00:00.000Z'
const now = () => new Date(capturedAt)
const live = {
  ok: true,
  pid: 42,
  bootId: 'boot-a',
  startedAt: '1001',
  executablePath: '/bin/agent'
} as const
const expected: RuntimeExpectation = {
  family: 'acp-agent',
  executablePath: '/bin/agent',
  generation: 'g1'
}

function capturedIdentity(): ProcessIdentity {
  return {
    pid: 42,
    bootId: 'boot-a',
    startedAt: '1001',
    executablePath: '/bin/agent',
    family: 'acp-agent',
    capturedAt,
    generation: 'g1'
  }
}

describe('runtime identity authority', () => {
  it('captures a complete identity and verifies the same process birth', () => {
    const authority = createRuntimeIdentityAuthority({ read: () => live, now })
    const identity = authority.capture(42, expected)

    expect(identity).toEqual(capturedIdentity())
    expect(authority.verify(identity)).toEqual({ status: 'valid', current: identity })
  })

  it('treats an absent recorded identity as an indeterminate legacy record', () => {
    const authority = createRuntimeIdentityAuthority({ read: () => live, now })

    expect(authority.verify(null)).toEqual({
      status: 'indeterminate',
      reason: 'legacy-record',
      detail: 'process identity was not recorded'
    })
  })

  it('detects PID reuse from either boot or process start identity', () => {
    const identity = capturedIdentity()
    const changedStart = createRuntimeIdentityAuthority({ read: () => ({ ...live, startedAt: '999' }), now })
    const changedBoot = createRuntimeIdentityAuthority({ read: () => ({ ...live, bootId: 'boot-b' }), now })

    expect(changedStart.verify(identity)).toEqual({ status: 'stale', reason: 'pid-reused' })
    expect(changedBoot.verify(identity)).toEqual({ status: 'stale', reason: 'pid-reused' })
  })

  it('detects a different executable at the same process birth', () => {
    const authority = createRuntimeIdentityAuthority({
      read: () => ({ ...live, executablePath: '/bin/other' }),
      now
    })

    expect(authority.verify(capturedIdentity())).toEqual({ status: 'stale', reason: 'executable-mismatch' })
  })

  it('maps native observation failures without treating uncertainty as stale', () => {
    const identity = capturedIdentity()
    const notFound = createRuntimeIdentityAuthority({ read: () => ({ ok: false, code: 'not-found', message: 'gone' }), now })
    const denied = createRuntimeIdentityAuthority({ read: () => ({ ok: false, code: 'access-denied', message: 'denied' }), now })
    const failed = createRuntimeIdentityAuthority({ read: () => ({ ok: false, code: 'native-error', message: 'broken' }), now })

    expect(notFound.verify(identity)).toEqual({ status: 'stale', reason: 'not-found' })
    expect(denied.verify(identity)).toEqual({ status: 'indeterminate', reason: 'access-denied', detail: 'denied' })
    expect(failed.verify(identity)).toEqual({ status: 'indeterminate', reason: 'native-error', detail: 'broken' })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid capture PID %s',
    pid => {
      const authority = createRuntimeIdentityAuthority({ read: () => live, now })

      expect(() => authority.capture(pid, expected)).toThrow('positive safe integer')
    }
  )

  it.each([
    { ok: false, code: 'not-found', message: 'gone' } as const,
    { ok: false, code: 'access-denied', message: 'denied' } as const,
    { ok: false, code: 'native-error', message: 'broken' } as const
  ])('rejects capture when native observation returns $code', observation => {
    const authority = createRuntimeIdentityAuthority({ read: () => observation, now })

    expect(() => authority.capture(42, expected)).toThrow(observation.message)
  })

  it('rejects a native success for a different PID', () => {
    const authority = createRuntimeIdentityAuthority({ read: () => ({ ...live, pid: 43 }), now })

    expect(() => authority.capture(42, expected)).toThrow('returned PID 43')
    expect(authority.verify(capturedIdentity())).toEqual({
      status: 'indeterminate',
      reason: 'native-error',
      detail: 'native observation returned PID 43 for requested PID 42'
    })
  })

  it.each(['bootId', 'startedAt', 'executablePath'] as const)('rejects an empty native %s', field => {
    const authority = createRuntimeIdentityAuthority({ read: () => ({ ...live, [field]: '   ' }), now })

    expect(() => authority.capture(42, expected)).toThrow(field)
    expect(authority.verify(capturedIdentity())).toMatchObject({ status: 'indeterminate', reason: 'native-error' })
  })

  it('rejects an explicitly expected executable mismatch during capture', () => {
    const authority = createRuntimeIdentityAuthority({ read: () => live, now })

    expect(() => authority.capture(42, { ...expected, executablePath: '/bin/other' })).toThrow('executable')
  })

  it.each(['', '   ', 'g'.repeat(32_769)])('rejects malformed generation values', generation => {
    const authority = createRuntimeIdentityAuthority({ read: () => live, now })

    expect(() => authority.capture(42, { ...expected, generation })).toThrow('generation')
  })

  it('uses injected realpath normalization for POSIX executable equality', () => {
    const realpath = (path: string) => path === '/links/agent' ? '/resolved/agent' : path
    const authority = createRuntimeIdentityAuthority({
      read: () => ({ ...live, executablePath: '/resolved/agent' }),
      now,
      platform: 'linux',
      realpath
    })
    const identity = { ...capturedIdentity(), executablePath: '/links/agent' }

    expect(authority.capture(42, { ...expected, executablePath: '/links/agent' })).toMatchObject({
      executablePath: '/resolved/agent'
    })
    expect(authority.verify(identity)).toEqual({ status: 'valid', current: identity })
  })

  it('normalizes Windows separators and case for executable equality', () => {
    const authority = createRuntimeIdentityAuthority({
      read: () => ({ ...live, executablePath: 'C:\\Program Files\\Agent\\agent.exe' }),
      now,
      platform: 'win32'
    })
    const identity = {
      ...capturedIdentity(),
      executablePath: 'c:/program files/agent/AGENT.EXE'
    }

    expect(authority.capture(42, {
      ...expected,
      executablePath: 'c:/program files/agent/AGENT.EXE'
    })).toMatchObject({ executablePath: 'C:\\Program Files\\Agent\\agent.exe' })
    expect(authority.verify(identity)).toEqual({ status: 'valid', current: identity })
  })
})
