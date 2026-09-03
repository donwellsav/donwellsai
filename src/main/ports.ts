import { execFile } from 'node:child_process'

export type WorktreePort = { port: number; pid: number; command: string }

const MAX_PIDS = 40

function exec(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 512 }, (err, stdout) => {
      resolve(err ? '' : String(stdout))
    })
  })
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN +c0` output → unique (pid, port, command). */
export function parseLsofListeners(out: string): WorktreePort[] {
  const seen = new Set<string>()
  const out2: WorktreePort[] = []
  for (const line of out.split('\n')) {
    // `node  12345 user  22u  IPv4  0x…  TCP *:3000 (LISTEN)`
    const m = line.match(/(?:^|\s)TCP\s+(?:\*|\[[^\]]+\]|[^\s]+):(\d+)\s+\(LISTEN/)
    if (!m) continue
    const cols = line.trim().split(/\s+/)
    const pid = Number(cols[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const key = `${pid}:${m[1]}`
    if (seen.has(key)) continue
    seen.add(key)
    out2.push({ pid, port: Number(m[1]), command: cols[0] })
  }
  return out2
}

/** Parse `lsof -a -p A,B -d cwd -Fn` output → pid → cwd. */
export function parseLsofCwd(out: string): Map<number, string> {
  const map = new Map<number, string>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid > 0) map.set(pid, line.slice(1))
  }
  return map
}

/**
 * Listening TCP ports owned by processes whose cwd is inside the worktree
 * (Orca's port-segment behavior). Best-effort: lsof may be missing or
 * sandboxed — empty list is a valid result.
 */
export async function scanWorktreePorts(worktreePath: string): Promise<WorktreePort[]> {
  const listeners = parseLsofListeners(await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '+c0'], 4000))
  if (listeners.length === 0) return []
  const pids = [...new Set(listeners.map((l) => l.pid))].slice(0, MAX_PIDS)
  const cwds = parseLsofCwd(await exec('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], 4000))
  const byPort = new Map<number, WorktreePort>()
  for (const { pid, port, command } of listeners) {
    const cwd = cwds.get(pid)
    if (!cwd) continue
    if (cwd !== worktreePath && !cwd.startsWith(worktreePath + '/')) continue
    if (byPort.has(port)) continue
    byPort.set(port, { port, pid, command })
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}
