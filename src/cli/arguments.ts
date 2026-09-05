import { RPC_COMMANDS, findCommand, isObject, validateCommandParams, type CommandField, type CommandSpec } from '../shared/command-catalog.js'
import { resolve } from 'node:path'

export type CliArguments = {
  command?: CommandSpec
  params: Record<string, unknown>
  userData?: string
  timeoutMs: number
  text: boolean
  dryRun: boolean
  help: boolean
}

const globalFlags = new Map<string, 'boolean' | 'string'>([
  ['help', 'boolean'], ['text', 'boolean'], ['json', 'boolean'], ['dry-run', 'boolean'],
  ['user-data', 'string'], ['timeout-ms', 'string'], ['params', 'string']
])
const commandFlags = new Map<string, 'boolean' | 'string'>()
for (const command of RPC_COMMANDS) {
  for (const field of command.fields) {
    if (field.flag) commandFlags.set(field.flag, field.kind === 'boolean' ? 'boolean' : 'string')
  }
}

function assertNoDuplicateObjectKeys(text: string): void {
  let position = 0
  const whitespace = (): void => { while (/\s/.test(text[position] ?? '')) position += 1 }
  const string = (): string => {
    const start = position
    position += 1
    while (position < text.length) {
      if (text[position] === '\\') { position += 2; continue }
      if (text[position] === '"') { position += 1; return JSON.parse(text.slice(start, position)) as string }
      position += 1
    }
    throw new Error('Invalid JSON; no command was sent')
  }
  const value = (): void => {
    whitespace()
    if (text[position] === '{') {
      position += 1
      const keys = new Set<string>()
      whitespace()
      while (text[position] !== '}') {
        const key = string()
        if (keys.has(key)) throw new Error('Duplicate JSON key: ' + key)
        keys.add(key)
        whitespace()
        position += 1
        value()
        whitespace()
        if (text[position] !== ',') break
        position += 1
        whitespace()
      }
      position += 1
      return
    }
    if (text[position] === '[') {
      position += 1
      whitespace()
      while (text[position] !== ']') {
        value()
        whitespace()
        if (text[position] !== ',') break
        position += 1
      }
      position += 1
      return
    }
    if (text[position] === '"') { string(); return }
    while (position < text.length && !/[\s,\]}]/.test(text[position] ?? '')) position += 1
  }
  value()
}

function jsonObject(text: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Invalid JSON; no command was sent') }
  assertNoDuplicateObjectKeys(text)
  if (!isObject(value)) throw new Error('Expected a JSON object')
  return value
}

function fieldValue(field: CommandField, text: string): unknown {
  if (field.kind === 'integer' || field.kind === 'number') {
    if (!text.trim()) throw new Error('Missing numeric value: ' + field.name)
    return Number(text)
  }
  if (field.kind === 'boolean') {
    if (text !== 'true' && text !== 'false') throw new Error('Expected true or false for ' + field.name)
    return text === 'true'
  }
  if (field.kind === 'object') return jsonObject(text)
  return text
}

function isAbsolutePath(path: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)
}

function resolveOperationalPaths(method: string, params: Record<string, unknown>): void {
  if (method !== 'scheduled.save' && method !== 'parallel.start') return
  if (!isObject(params.input)) return
  const input = structuredClone(params.input)
  const resolveTarget = (candidate: unknown): void => {
    if (!isObject(candidate) || candidate.kind !== 'local' || typeof candidate.root !== 'string') return
    if (!isAbsolutePath(candidate.root)) candidate.root = resolve(candidate.root)
  }
  if (method === 'scheduled.save') resolveTarget(input.target)
  if (method === 'parallel.start' && Array.isArray(input.targets)) {
    for (const target of input.targets) resolveTarget(target)
  }
  params.input = input
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
  const flags = new Map<string, string | boolean>()
  const positional: string[] = []
  let literal = false
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === '--' && !literal) { literal = true; continue }
    if (literal || !token.startsWith('--')) { positional.push(token); continue }
    const separator = token.indexOf('=')
    const name = token.slice(2, separator < 0 ? undefined : separator)
    const kind = globalFlags.get(name) ?? commandFlags.get(name)
    if (!kind) throw new Error('Unknown flag: --' + name)
    if (flags.has(name)) throw new Error('Duplicate flag: --' + name)
    const inline = separator < 0 ? undefined : token.slice(separator + 1)
    if (kind === 'boolean') {
      if (inline !== undefined && inline !== 'true' && inline !== 'false') throw new Error('Expected true or false for --' + name)
      flags.set(name, inline !== 'false')
    } else {
      const value = inline ?? argv[++index]
      if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new Error('Missing value for --' + name)
      flags.set(name, value)
    }
  }
  let name = positional.shift()
  const help = !name || name === 'help' || flags.get('help') === true
  if (name === 'help') name = positional.shift()
  const command = name ? findCommand(name) : undefined
  if (name && !command) throw new Error('Unknown command: ' + name)
  for (const flag of flags.keys()) {
    if (!globalFlags.has(flag) && !command?.fields.some(field => field.flag === flag)) throw new Error('Flag --' + flag + ' is not valid for ' + (name ?? 'help'))
  }
  if (flags.get('text') === true && flags.get('json') === true) throw new Error('Choose --text or --json, not both')
  const timeoutMs = Number(flags.get('timeout-ms') ?? 15_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('--timeout-ms must be an integer from 100 to 120000')
  const userData = flags.get('user-data')
  if (typeof userData === 'string' && !userData.trim()) throw new Error('--user-data must not be empty')
  const result: CliArguments = { command, params: {}, userData: typeof userData === 'string' ? userData : undefined, timeoutMs, text: flags.get('text') === true, dryRun: flags.get('dry-run') === true, help }
  if (help || !command) return result
  const rawParams = flags.get('params')
  let params: Record<string, unknown> = {}
  if (typeof rawParams === 'string') {
    if (positional.length) throw new Error('Do not mix --params with positional arguments')
    params = jsonObject(rawParams)
  } else if (command.mode === 'settings') {
    if (positional.length !== 1) throw new Error(command.name + ' requires exactly one JSON object')
    params = jsonObject(positional[0]!)
  } else if (positional.length === 1 && positional[0]!.trimStart().startsWith('{')
    && !(command.fields.length === 1 && command.fields[0]?.kind === 'object')) {
    params = jsonObject(positional[0]!)
  } else if (command.mode === 'selector') {
    if (positional.length !== 1) throw new Error('ui-activate requires one exact path or repository ID')
    const selector = positional[0]!
    if (selector.startsWith('id:')) params.repoId = selector.slice(3)
    else if (selector.startsWith('path:')) params.worktreePath = selector.slice(5)
    else params[/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(selector) ? 'worktreePath' : 'repoId'] = selector
  } else if (command.mode === 'sidebar') {
    params.side = positional.shift()
    for (const value of positional) {
      const key = ['open', 'close', 'toggle'].includes(value) ? 'open' : ['explorer', 'git'].includes(value) ? 'tab' : 'width'
      if (params[key] !== undefined) throw new Error('Duplicate sidebar argument: ' + key)
      params[key] = key === 'width' ? Number(value) : value
    }
  } else {
    const fields = command.fields.filter(field => !field.flag)
    let position = 0
    for (const field of fields) {
      if (position >= positional.length) break
      if (field.kind === 'string-list') {
        params[field.name] = positional.slice(position)
        position = positional.length
      } else {
        params[field.name] = fieldValue(field, positional[position++]!)
      }
    }
    if (position < positional.length) throw new Error('Too many arguments for ' + command.name)
  }
  for (const field of command.fields) {
    if (!field.flag || !flags.has(field.flag)) continue
    if (params[field.name] !== undefined) throw new Error('Parameter supplied twice: ' + field.name)
    params[field.name] = flags.get(field.flag)
  }
  for (const field of command.fields) {
    const value = params[field.name]
    if (field.kind === 'path' && typeof value === 'string' && !isAbsolutePath(value)) {
      params[field.name] = resolve(value)
    }
  }
  resolveOperationalPaths(command.method, params)
  result.params = validateCommandParams(command.method, params)
  return result
}

function fieldUsage(field: CommandField): string {
  if (field.flag) {
    const value = field.kind === 'boolean' ? '' : ' <' + (field.kind === 'object' ? field.name + '-json' : field.name) + '>'
    const flag = '--' + field.flag + value
    return field.required ? flag : '[' + flag + ']'
  }
  const name = field.kind === 'object' ? field.name + '-json' : field.name
  return (field.required ? '<' : '[') + name + (field.required ? '>' : ']')
}

export function commandUsage(command: CommandSpec): string {
  const args = command.mode === 'settings'
    ? '<json>'
    : command.mode === 'selector'
      ? '<path:directory|id:repository>'
      : command.fields.map(fieldUsage).join(' ')
  return 'donwells ' + command.name + (args ? ' ' + args : '')
}
