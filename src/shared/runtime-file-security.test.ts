import { describe, expect, it } from 'vitest'
import {
  createPrivateRuntimeDirectoryValidator,
  type NativeRuntimeFileAddon
} from './runtime-file-security'

describe('runtime directory security boundary', () => {
  it('accepts a native private-directory observation with a complete identity', () => {
    const calls: string[] = []
    const addon: NativeRuntimeFileAddon = {
      platform: 'win32',
      runtimeFileSecurityContractVersion: 1,
      readPrivateRuntimeFile: () => undefined,
      validatePrivateRuntimeDirectory: (path: string) => {
        calls.push(path)
        return { ok: true, fileIdentity: { platform: 'win32', volumeSerial: '1', fileId: '2' } }
      }
    }
    const validate = createPrivateRuntimeDirectoryValidator(addon, 'win32')
    validate('C:\\Users\\alice\\AppData\\Local\\Donwells')
    expect(calls).toEqual(['C:\\Users\\alice\\AppData\\Local\\Donwells'])
  })

  it('preserves native directory policy failures as typed security errors', () => {
    const addon: NativeRuntimeFileAddon = {
      platform: 'win32',
      runtimeFileSecurityContractVersion: 1,
      readPrivateRuntimeFile: () => undefined,
      validatePrivateRuntimeDirectory: () => ({ ok: false, code: 'native-error', message: 'Users write ACE' })
    }
    const validate = createPrivateRuntimeDirectoryValidator(addon, 'win32')
    expect(() => validate('C:\\runtime')).toThrowError(expect.objectContaining({
      name: 'RuntimeFileSecurityError',
      code: 'native-error',
      message: 'Users write ACE'
    }))
  })

  it('rejects an addon that omits the native directory operation', () => {
    const addon: NativeRuntimeFileAddon = {
      platform: 'win32',
      runtimeFileSecurityContractVersion: 1,
      readPrivateRuntimeFile: () => undefined
    }
    expect(() => createPrivateRuntimeDirectoryValidator(addon, 'win32')).toThrow(/missing validatePrivateRuntimeDirectory/)
  })
})
