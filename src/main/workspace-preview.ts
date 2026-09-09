import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { extname } from 'node:path'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { resolveExistingEntry } from './worktree-files'

const MIME: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.txt': 'text/plain', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' }

/** One loopback origin per checkout keeps root-relative assets working and projects isolated. */
export class WorkspacePreview {
  private servers = new Map<string, Promise<{ server: Server; origin: string; token: string }>>()
  constructor(private verify: (root: string) => Promise<string>) {}
  async url(workspacePath: string, relativePath: string): Promise<string> {
    const root = await this.verify(workspacePath)
    const entry = await resolveExistingEntry(root, relativePath)
    if (entry.kind !== 'file') throw new Error('Select a file to preview')
    this.validatePath(entry.relPath)
    let pending = this.servers.get(root)
    if (!pending) {
      pending = this.start(root).catch(error => { this.servers.delete(root); throw error })
      this.servers.set(root, pending)
    }
    const { origin, token } = await pending
    return `${origin}/${entry.relPath.split('/').map(encodeURIComponent).join('/')}?donwells-preview=${token}`
  }
  async resolveUrl(workspacePath: string, input: string): Promise<string> {
    const url = new URL(input)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[a-f0-9]{64}$/.test(url.searchParams.get('donwells-preview') ?? '')) return input
    const restored = new URL(await this.url(workspacePath, decodeURIComponent(url.pathname).slice(1)))
    for (const [key, value] of url.searchParams) if (key !== 'donwells-preview') restored.searchParams.append(key, value)
    restored.hash = url.hash
    return restored.href
  }
  private validatePath(path: string): void {
    if (path.split('/').some(part => part.startsWith('.'))) throw new Error('Hidden workspace files are not served in browser previews')
  }
  private async start(root: string) {
    const token = randomBytes(32).toString('hex')
    const server = createServer(async (request, response) => {
      let file: Awaited<ReturnType<typeof open>> | undefined
      try {
        const address = server.address()
        if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}`) { response.writeHead(403).end(); return }
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return }
        const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
        const cookie = `donwells-preview=${token}`
        if (url.searchParams.get('donwells-preview') !== token && !request.headers.cookie?.split(';').some(value => value.trim() === cookie)) { response.writeHead(403).end(); return }
        const path = decodeURIComponent(url.pathname).slice(1)
        this.validatePath(path)
        await this.verify(root)
        const entry = await resolveExistingEntry(root, path.endsWith('/') ? path + 'index.html' : path)
        if (entry.kind !== 'file') { response.writeHead(404).end(); return }
        file = await open(entry.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const identity = await file.stat()
        const current = await resolveExistingEntry(root, entry.relPath)
        if (!identity.isFile() || identity.dev !== current.identity.dev || identity.ino !== current.identity.ino) throw new Error('File changed while opening')
        response.writeHead(200, { 'Content-Type': MIME[extname(path).toLowerCase()] ?? 'text/plain', 'Content-Length': identity.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': `${cookie}; HttpOnly; SameSite=Strict; Path=/` })
        if (request.method === 'HEAD') response.end()
        else await pipeline(file.createReadStream({ autoClose: false }), response)
      } catch {
        if (!response.headersSent) response.writeHead(404).end('Preview file unavailable')
        else response.destroy()
      } finally { await file?.close().catch(() => undefined) }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Preview server failed to start')
    return { server, origin: `http://127.0.0.1:${address.port}`, token }
  }
  async close(): Promise<void> {
    const pending = [...this.servers.values()]; this.servers.clear()
    await Promise.allSettled(pending.map(async item => { const { server } = await item; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }))
  }
}
