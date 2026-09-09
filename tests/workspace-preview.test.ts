import { mkdtemp, realpath, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorkspacePreview } from '../src/main/workspace-preview'

it('serves local HTML and assets, rejects hidden files, foreign hosts, symlinks, and removed workspaces', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'donwells-preview-')))
  let registered = true
  const preview = new WorkspacePreview(async path => { if (!registered || path !== root) throw new Error('Unknown workspace'); return root })
  try {
    await mkdir(join(root, 'site'))
    await writeFile(join(root, 'site', 'hello world.html'), '<link rel="stylesheet" href="/style.css"><h1>Preview</h1>')
    await writeFile(join(root, 'style.css'), 'h1 { color: red }')
    await writeFile(join(root, '.env'), 'private')
    await symlink(join(root, '.env'), join(root, 'leak.txt'))
    const url = await preview.url(root, 'site/hello world.html')
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(await response.text()).toContain('<h1>Preview</h1>')
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const origin = new URL(url).origin
    expect(await (await fetch(origin + '/style.css', { headers: { cookie } })).text()).toContain('color: red')
    expect((await fetch(origin + '/style.css')).status).toBe(403)
    expect(await new Promise(resolve => get(url, { headers: { Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode) }))).toBe(403)
    expect((await fetch(url, { method: 'POST' })).status).toBe(405)
    for (const path of ['/.env', '/leak.txt', '/%2eenv', '/site/%2e%2e/.env', '/%2fetc%2fpasswd']) {
      expect((await fetch(origin + path, { headers: { cookie } })).status).toBe(404)
    }
    await expect(preview.url(root, '../escape')).rejects.toThrow()
    await preview.close()
    const restored = await preview.resolveUrl(root, url + '&mode=demo#game')
    expect(restored).not.toBe(url)
    expect(new URL(restored).searchParams.get('mode')).toBe('demo')
    expect(new URL(restored).hash).toBe('#game')
    expect((await fetch(restored)).status).toBe(200)
    expect(await preview.resolveUrl(root, 'https://example.com/app')).toBe('https://example.com/app')
    registered = false
    expect((await fetch(restored)).status).toBe(404)
  } finally { await preview.close(); await rm(root, { recursive: true, force: true }) }
})
