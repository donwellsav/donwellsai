import { describe, expect, it } from 'vitest'
import { localRuntimePaths } from '../src/main/local-runtime'

describe('local runtime addressing', () => {
  it('produces a Windows named pipe rather than an escaped relative path', () => {
    const paths = localRuntimePaths('C:\\Users\\Sam\\AppData\\Roaming\\donwells.ai', 'terminal', 'win32')
    expect(paths.socketPath.startsWith('\\\\.\\pipe\\')).toBe(true)
  })

  it('keeps case-sensitive profiles isolated', () => {
    const upper = localRuntimePaths('/virtual/Profiles/Work', 'terminal', 'linux')
    const lower = localRuntimePaths('/virtual/Profiles/work', 'terminal', 'linux')
    expect(upper.socketPath).not.toBe(lower.socketPath)
  })

  it('isolates application control from terminal ownership within Unix limits', () => {
    const profile = '/virtual/' + 'nested-profile/'.repeat(30)
    const app = localRuntimePaths(profile, 'app', 'darwin')
    const terminal = localRuntimePaths(profile, 'terminal', 'darwin')
    expect(app.socketPath).not.toBe(terminal.socketPath)
    expect(Buffer.byteLength(app.socketPath)).toBeLessThanOrEqual(103)
    expect(Buffer.byteLength(terminal.socketPath)).toBeLessThanOrEqual(103)
  })
})
