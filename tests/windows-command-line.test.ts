import { describe, expect, it } from 'vitest'
import { resolveSpawn } from '../src/shared/child-process/run-process'
import {
  buildWindowsCmdShimCommandLine,
  isCmdInterpretedProgram,
  quoteWindowsArgument,
  quoteWindowsCmdArgument
} from '../src/shared/child-process/windows-command-line'

describe('Windows process encoding', () => {
  it('recognizes only targets that require a cmd.exe hop', () => {
    expect(isCmdInterpretedProgram('C:\\tools\\pnpm.CMD')).toBe(true)
    expect(isCmdInterpretedProgram('C:\\tools\\setup.bat')).toBe(true)
    expect(isCmdInterpretedProgram('C:\\tools\\git.exe')).toBe(false)
  })

  it('preserves quotes, trailing slashes and percent data as quoted values', () => {
    expect(quoteWindowsArgument('C:\\Program Files\\')).toBe('"C:\\Program Files\\\\"')
    expect(quoteWindowsArgument('a"b')).toBe('"a""b"')
    expect(quoteWindowsCmdArgument('%PATH%')).toBe('""^%"PATH"^%""')
  })

  it('rejects line breaks that cmd.exe cannot encode', () => {
    expect(() => buildWindowsCmdShimCommandLine('tool.cmd', ['first\nsecond'])).toThrow(/line break/)
    expect(() => buildWindowsCmdShimCommandLine('bad\rtool.cmd', [])).toThrow(/line break/)
  })

  it('uses one verbatim cmd argument without shell mode', () => {
    const resolved = resolveSpawn({
      program: 'C:\\Tools\\agent.cmd',
      args: ['a&b', '%TEMP%', 'quote"value'],
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    }, 'win32')
    expect(resolved.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(resolved.options).toMatchObject({
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true
    })
    expect(resolved.args).toHaveLength(1)
    expect(resolved.args[0]).toContain('/d /v:off /s /c')
    expect(resolved.args[0]).toContain('"a&b"')
    expect(resolved.args[0]).toContain('"^%"TEMP"^%"')
  })
})
