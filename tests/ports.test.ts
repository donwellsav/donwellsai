import { describe, it, expect } from 'vitest'
import { parseLsofListeners, parseLsofCwd, parsePsTable } from '../src/main/ports'

const LISTENERS = `COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    42411 muzik   22u  IPv4  0x9f2a1c3d4e5f      0t0  TCP *:3000 (LISTEN)
vite    42877 muzik   19u  IPv6  0x9f2a1c3d4e5f0     0t0  TCP [::]:5173 (LISTEN)
node    42411 muzik   23u  IPv4  0x9f2a1c3d4e600     0t0  TCP localhost:9229 (LISTEN)
Code    31000 muzik   44u  IPv4  0x9f2a1c3d4e601     0t0  TCP *:63342 (LISTEN)
sshd    99999 muzik    4u  IPv4  0x9f2a1c3d4e602     0t0  TCP *:22 (LISTEN)
`

const CWDS = `p42411
n/Users/muzik/work/api
p42877
n/Users/muzik/work/api/apps/web
p31000
n/Applications/Visual Studio Code.app/Contents/Resources
`

describe('parseLsofListeners', () => {
  it('extracts pid, port, command from IPv4/IPv6/localhost rows', () => {
    const l = parseLsofListeners(LISTENERS)
    expect(l).toContainEqual({ pid: 42411, port: 3000, command: 'node' })
    expect(l).toContainEqual({ pid: 42877, port: 5173, command: 'vite' })
    expect(l).toContainEqual({ pid: 42411, port: 9229, command: 'node' })
    expect(l).toContainEqual({ pid: 99999, port: 22, command: 'sshd' })
    expect(l).toHaveLength(5)
  })

  it('deduplicates repeated (pid, port) rows', () => {
    const dup = LISTENERS + 'node    42411 muzik   24u  IPv4  0x9f2a1c3d4e603     0t0  TCP *:3000 (LISTEN)\n'
    expect(parseLsofListeners(dup).filter((x) => x.port === 3000)).toHaveLength(1)
  })

  it('ignores non-LISTEN rows and malformed lines', () => {
    const out = 'node 1 user 1u IPv4 0 TCP *:3000 (ESTABLISHED)\ngarbage line\nnode x user TCP *:7000 (LISTEN)\n'
    expect(parseLsofListeners(out)).toHaveLength(0)
  })
})

describe('parseLsofCwd', () => {
  it('maps pid to cwd path', () => {
    const m = parseLsofCwd(CWDS)
    expect(m.get(42411)).toBe('/Users/muzik/work/api')
    expect(m.get(42877)).toBe('/Users/muzik/work/api/apps/web')
    expect(m.get(31000)).toContain('Visual Studio Code')
  })

  it('tolerates empty output', () => {
    expect(parseLsofCwd('')).toBeInstanceOf(Map)
  })
})

describe('parsePsTable', () => {
  it('maps pid to cpu and rss', () => {
    const out = '  42411  12.3  102400\n  42877   0.5   51200\n'
    const m = parsePsTable(out)
    expect(m.get(42411)).toEqual({ cpu: 12.3, rssKB: 102400 })
    expect(m.get(42877)).toEqual({ cpu: 0.5, rssKB: 51200 })
  })

  it('tolerates empty and malformed rows', () => {
    expect(parsePsTable('')).toBeInstanceOf(Map)
    expect(parsePsTable('garbage row\n').size).toBe(0)
  })
})
