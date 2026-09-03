import { execFile } from 'node:child_process'

export type WorktreePort = { port: number; pid: number; command: string }
/** Orca ResourceUsageStatusSegment + ports segment data for one worktree. */
export type WorktreeScan = {
  ports: WorktreePort[]
  /** summed %cpu of worktree processes (instantaneous sample) */
  cpuPercent: number
  /** summed resident memory in MB */
  memMB: number
}

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

/** Parse `ps -axo pid=,%cpu=,rss=` output → pid → {cpu, rssKB}. */
export function parsePsTable(out: string): Map<number, { cpu: number; rssKB: number }> {
  const map = new Map<number, { cpu: number; rssKB: number }>()
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 3) continue
    const pid = Number(cols[0])
    const cpu = Number(cols[1])
    const kb = Number(cols[2])
    if (!Number.isInteger(pid) || pid <= 0) continue
    map.set(pid, { cpu: Number.isFinite(cpu) ? cpu : 0, rssKB: Number.isFinite(kb) ? kb : 0 })
  }
  return map
}

/**
 * Ports + resource usage for ALL processes whose cwd is inside the worktree
 * (Orca's ports + resource status segments). Two single-pass system scans:
 * `ps -axo pid,%cpu,rss` and `lsof -d cwd` — no per-pid fan-out. Best-effort:
 * missing/sandboxed tools yield an empty scan.
 */
export async function scanWorktree(worktreePath: string): Promise<WorktreeScan> {
  const psTable = parsePsTable(await exec('ps', ['-axo', 'pid=,%cpu=,rss='], 4000))
  if (psTable.size === 0) return { ports: [], cpuPercent: 0, memMB: 0 }

  const cwds = parseLsofCwd(await exec('lsof', ['-d', 'cwd', '-Fn', '+c0'], 6000))
  const pids = [...cwds.entries()]
    .filter(([pid, cwd]) => psTable.has(pid) && (cwd === worktreePath || cwd.startsWith(worktreePath + '/')))
    .map(([pid]) => pid)
    .slice(0, MAX_PIDS)

  let cpu = 0
  let memKB = 0
  for (const pid of pids) {
    const u = psTable.get(pid)!
    cpu += u.cpu
    memKB += u.rssKB
  }

  const listeners = parseLsofListeners(await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '+c0'], 4000))
  const byPort = new Map<number, WorktreePort>()
  for (const { pid, port, command } of listeners) {
    if (!pids.includes(pid)) continue
    if (byPort.has(port)) continue
    byPort.set(port, { port, pid, command })
  }

  return {
    ports: [...byPort.values()].sort((a, b) => a.port - b.port),
    cpuPercent: Math.round(cpu * 10) / 10,
    memMB: Math.round(memKB / 1024)
  }
}
