import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'

export type SkillMeta = {
  name: string
  source: string
  installedAt: string
  /** Size in bytes (truncated for preview in UI). */
  size: number
}

/**
 * Skills manager (upstream agent-skill-registry model): stores `.md` skill files
 * under `<userData>/skills/`. Each skill is a markdown document describing how
 * an agent should behave; the agent picks it up via the skills directory.
 */
export class SkillsManager {
  private readonly dir: string
  private readonly metaPath: string

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, 'skills')
    this.metaPath = join(this.dir, '_index.json')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  list(): SkillMeta[] {
    if (!existsSync(this.metaPath)) return []
    try {
      return JSON.parse(readFileSync(this.metaPath, 'utf8')) as SkillMeta[]
    } catch { return [] }
  }

  async install(source: string): Promise<SkillMeta> {
    // source is a raw GitHub URL or any downloadable skill file
    const name = this.nameFromSource(source)
    const body = await this.fetch(source)
    const skillPath = join(this.dir, `${name}.md`)
    writeFileSync(skillPath, body, 'utf8')
    const meta: SkillMeta = { name, source, installedAt: new Date().toISOString(), size: body.length }
    const all = this.list().filter((s) => s.name !== name)
    all.push(meta)
    writeFileSync(this.metaPath, JSON.stringify(all, null, 2), 'utf8')
    return meta
  }

  remove(name: string): void {
    const skillPath = join(this.dir, `${name}.md`)
    if (existsSync(skillPath)) unlinkSync(skillPath)
    const all = this.list().filter((s) => s.name !== name)
    if (all.length > 0) writeFileSync(this.metaPath, JSON.stringify(all, null, 2), 'utf8')
    else if (existsSync(this.metaPath)) unlinkSync(this.metaPath)
  }


  private nameFromSource(source: string): string {
    const base = source.split('/').pop() ?? 'skill'
    return base.replace(/\.md$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  private fetch(url: string, redirects = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const done = setTimeout(() => reject(new Error(`skill fetch timed out: ${url}`)), 15_000)
      const finish = (body: string): void => {
        clearTimeout(done)
        resolve(body)
      }
      const fail = (e: Error): void => {
        clearTimeout(done)
        reject(e)
      }
      if (url.startsWith('http://') || url.startsWith('https://')) {
        if (redirects > 5) return fail(new Error('too many redirects'))
        get(url, (res) => {
          const loc = res.headers.location
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
            res.resume() // drain before following
            this.fetch(new URL(loc, url).toString(), redirects + 1).then(finish, fail)
            return
          }
          if (res.statusCode !== 200) return fail(new Error(`HTTP ${res.statusCode ?? 'unknown'} fetching ${url}`))
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
        }).on('error', fail)
      } else if (url.startsWith('file://')) {
        finish(readFileSync(fileURLToPath(url), 'utf8'))
      } else {
        // treat as a local file path
        finish(readFileSync(url, 'utf8'))
      }
    })
  }
}
