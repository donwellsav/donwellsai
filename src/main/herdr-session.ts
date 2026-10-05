import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import type { HerdrAgentStatus, HerdrPaneSummary, HerdrSnapshot, HerdrTerminalSource, HerdrWorkspaceSummary } from '@shared/herdr-session'
import { AgentRegistry } from './agents/registry'

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_FRAME_LINE = 2 * 1024 * 1024
const STATUS = new Set<HerdrAgentStatus>(['idle', 'working', 'blocked', 'done', 'unknown'])

export function sessionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\bherdr\b/gi, 'session service')
}

function executable(): string {
  const found = new AgentRegistry().findExecutable('herdr')
  if (found) return found
  for (const path of [join(homedir(), '.local', 'bin', 'herdr'), '/opt/homebrew/bin/herdr', '/usr/local/bin/herdr']) {
    try { accessSync(path, constants.X_OK); return path } catch { /* continue */ }
  }
  throw new Error('The session service was not found. Install it, then refresh.')
}

function run(executablePath: string, args: string[], timeoutMs: number, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', size = 0, settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(new Error(sessionErrorMessage(error)))
      else resolve(stdout)
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error('The session service did not respond in time.')) }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) { child.kill(); finish(new Error('The session service returned more data than Don can safely display.')); return }
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8192) })
    child.once('error', error => finish(error))
    child.once('close', code => finish(code === 0 ? undefined : new Error(stderr.trim() || `Session service exited with code ${code ?? 'unknown'}.`)))
  })
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function string(value: unknown, limit = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\0\r\n]/.test(value) ? value : undefined
}

function sessionId(value: unknown): string | undefined {
  const id = string(value, 128)
  return id && /^[\w.:-]+$/.test(id) ? id : undefined
}

function path(value: unknown): string | undefined {
  const result = string(value, 4096)
  return result && isAbsolute(result) ? result : undefined
}

function agentStatus(value: unknown): HerdrAgentStatus {
  return typeof value === 'string' && STATUS.has(value as HerdrAgentStatus) ? value as HerdrAgentStatus : 'unknown'
}

export function normalizeHerdrSnapshot(value: unknown): HerdrSnapshot {
  const envelope = object(value)
  const result = object(envelope?.result)
  const snapshot = object(result?.snapshot)
  if (result?.type !== 'session_snapshot' || !snapshot || !Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.panes)) {
    throw new Error('The session service returned an unsupported session snapshot.')
  }
  const workspaces: HerdrWorkspaceSummary[] = []
  for (const item of snapshot.workspaces.slice(0, 500)) {
    const value = object(item), workspaceId = sessionId(value?.workspace_id)
    if (!value || !workspaceId) continue
    const worktree = object(value.worktree)
    workspaces.push({
      workspaceId,
      label: string(value.label) ?? string(worktree?.repo_name) ?? workspaceId,
      ...(path(worktree?.checkout_path) ? { checkoutPath: path(worktree?.checkout_path) } : {}),
      ...(string(worktree?.repo_name) ? { repoName: string(worktree?.repo_name) } : {}),
      agentStatus: agentStatus(value.agent_status)
    })
  }
  const workspaceIds = new Set(workspaces.map(workspace => workspace.workspaceId))
  const panes: HerdrPaneSummary[] = []
  for (const item of snapshot.panes.slice(0, 2000)) {
    const value = object(item), paneId = sessionId(value?.pane_id), workspaceId = sessionId(value?.workspace_id)
    if (!value || !paneId || !workspaceId || !workspaceIds.has(workspaceId)) continue
    const agent = string(value.display_agent) ?? string(value.agent)
    const label = string(value.terminal_title_stripped) ?? string(value.title) ?? string(value.label) ?? agent ?? paneId
    panes.push({
      paneId,
      workspaceId,
      label,
      ...(path(value.foreground_cwd) ?? path(value.cwd) ? { cwd: path(value.foreground_cwd) ?? path(value.cwd) } : {}),
      ...(agent ? { agent } : {}),
      agentStatus: agentStatus(value.agent_status),
      focused: value.focused === true
    })
  }
  return { workspaces, panes }
}

export async function readHerdrSnapshot(): Promise<HerdrSnapshot> {
  const output = await run(executable(), ['api', 'snapshot'], 6000, MAX_SNAPSHOT_BYTES)
  try { return normalizeHerdrSnapshot(JSON.parse(output)) }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('The session service returned invalid session data.')
    throw error
  }
}

type ActiveTerminal = {
  child: ChildProcessWithoutNullStreams
  paneId: string
  mode: 'observe' | 'control'
  takeover: boolean
  cols: number
  rows: number
  sequence: number
  buffer: string
  stderr: string
  stopping: boolean
  onData(data: string, sequence: number): void
  onError(error: string): void
}

export class HerdrTerminalBridge {
  private sessions = new Map<string, ActiveTerminal>()

  isActive(sessionId: string): boolean { return this.sessions.has(sessionId) }

  async start(sessionId: string, source: HerdrTerminalSource, cols: number, rows: number, onData: ActiveTerminal['onData'], onError: ActiveTerminal['onError']): Promise<void> {
    if (source.mode === 'control' && process.env['HERDR_ENV'] !== '1') throw new Error('Session control is available only when Don is opened from a managed session.')
    const sequence = this.sessions.get(sessionId)?.sequence ?? 0
    this.stop(sessionId)
    const args = ['terminal', 'session', source.mode, source.paneId]
    if (source.mode === 'control' && source.takeover) args.push('--takeover')
    args.push('--cols', String(cols), '--rows', String(rows))
    const child = spawn(executable(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const active: ActiveTerminal = { child, paneId: source.paneId, mode: source.mode, takeover: source.takeover === true, cols, rows, sequence, buffer: '', stderr: '', stopping: false, onData, onError }
    this.sessions.set(sessionId, active)
    const decoder = new StringDecoder('utf8')
    const fail = (error: string) => {
      if (this.sessions.get(sessionId) !== active || active.stopping) return
      this.stop(sessionId)
      onError(sessionErrorMessage(error))
    }
    const consume = (chunk: Buffer) => {
      active.buffer += decoder.write(chunk)
      if (active.buffer.length > MAX_FRAME_LINE && !active.buffer.includes('\n')) { fail('The session service sent an oversized terminal frame.'); return }
      let newline: number
      while ((newline = active.buffer.indexOf('\n')) !== -1) {
        if (newline > MAX_FRAME_LINE) { fail('The session service sent an oversized terminal frame.'); return }
        const line = active.buffer.slice(0, newline).trim()
        active.buffer = active.buffer.slice(newline + 1)
        if (!line) continue
        try {
          const frame = JSON.parse(line) as Record<string, unknown>
          if (frame.type === 'terminal.closed') { fail(string(frame.reason) ?? 'The session service closed this terminal connection.'); return }
          if (frame.type !== 'terminal.frame') continue
          if (frame.encoding !== 'ansi' || !Number.isSafeInteger(frame.seq) || Number(frame.seq) < 0 || !Number.isInteger(frame.width) || Number(frame.width) < 1 || Number(frame.width) > 1000 || !Number.isInteger(frame.height) || Number(frame.height) < 1 || Number(frame.height) > 1000 || typeof frame.full !== 'boolean' || typeof frame.bytes !== 'string' || frame.bytes.length > MAX_FRAME_BYTES * 2) throw new Error('The session service sent an invalid terminal frame.')
          const bytes = Buffer.from(frame.bytes, 'base64')
          if (bytes.length > MAX_FRAME_BYTES || bytes.toString('base64').replace(/=+$/, '') !== frame.bytes.replace(/=+$/, '')) throw new Error('The session service sent an invalid terminal frame.')
          onData(`${frame.full ? '\u001b[H\u001b[2J' : ''}${bytes.toString('utf8')}`, ++active.sequence)
        } catch (error) { fail(error instanceof Error ? error.message : String(error)); return }
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', chunk => { active.stderr = (active.stderr + chunk.toString('utf8')).slice(-8192) })
    child.stdin.on('error', error => fail(error.message))
    child.once('error', error => fail(error.message))
    child.once('close', code => {
      if (this.sessions.get(sessionId) === active && !active.stopping) fail(active.stderr.trim() || `Session connection closed with code ${code ?? 'unknown'}.`)
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  }

  input(sessionId: string, data: string): void {
    const active = this.sessions.get(sessionId)
    if (!active || active.mode !== 'control') throw new Error('Take control of the session before sending input.')
    if (Buffer.byteLength(data) > MAX_FRAME_BYTES) throw new Error('Terminal input is too large.')
    active.child.stdin.write(JSON.stringify({ type: 'terminal.input', text: data }) + '\n')
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const active = this.sessions.get(sessionId)
    if (!active || cols === active.cols && rows === active.rows) return
    active.cols = cols; active.rows = rows
    if (active.mode === 'control') {
      active.child.stdin.write(JSON.stringify({ type: 'terminal.resize', cols, rows }) + '\n')
      return
    }
    void this.start(sessionId, { kind: 'herdr', paneId: active.paneId, mode: active.mode, takeover: active.takeover }, cols, rows, active.onData, active.onError).catch(error => active.onError(sessionErrorMessage(error)))
  }

  stop(sessionId: string): void {
    const active = this.sessions.get(sessionId)
    if (!active) return
    this.sessions.delete(sessionId)
    active.stopping = true
    try { if (active.mode === 'control' && active.child.stdin.writable) active.child.stdin.write('{"type":"terminal.release"}\n') } catch { /* the Herdr client may already have closed */ }
    active.child.kill()
  }

  clear(): void { for (const sessionId of this.sessions.keys()) this.stop(sessionId) }
}
