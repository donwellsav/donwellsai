/** Quote one value for CommandLineToArgvW while keeping cmd.exe quote parity even. */
function quoteWindows(value: string, escapePercent: boolean): string {
  if (value.includes('\0')) throw new Error('Windows process arguments cannot contain NUL')
  let quoted = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    if (char === '"') {
      quoted += `${'\\'.repeat(backslashes * 2)}""`
      backslashes = 0
      continue
    }
    if (escapePercent && char === '%') {
      quoted += `${'\\'.repeat(backslashes * 2)}"^%"`
      backslashes = 0
      continue
    }
    quoted += `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

export function quoteWindowsCmdArgument(value: string): string {
  return quoteWindows(value, true)
}

/**
 * Build the single verbatim argument passed to cmd.exe for .cmd/.bat targets.
 * CR/LF cannot be escaped by cmd.exe and are rejected rather than truncated.
 */
export function buildWindowsCmdShimCommandLine(program: string, args: readonly string[]): string {
  for (const value of [program, ...args]) {
    if (/[\r\n]/.test(value)) {
      throw new Error('cmd.exe cannot receive an argument containing a line break')
    }
  }
  const inner = [program, ...args].map(quoteWindowsCmdArgument).join(' ')
  return `/d /v:off /s /c "${inner}"`
}

export function isCmdInterpretedProgram(program: string): boolean {
  const lower = program.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat')
}
