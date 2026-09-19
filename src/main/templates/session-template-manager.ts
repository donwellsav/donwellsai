import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../../shared/logger'

export interface SessionTemplate {
  id: string
  name: string
  description: string
  category: string
  icon?: string
  /** Initial system prompt for the session. */
  systemPrompt?: string
  /** Initial user prompt to seed the session. */
  initialPrompt?: string
  /** Model/provider overrides. */
  provider?: string
  model?: string
  /** Tool restrictions. */
  allowedTools?: string[]
  deniedTools?: string[]
  /** Environment variables. */
  env?: Record<string, string>
  /** Tags for filtering. */
  tags?: string[]
  /** Template author. */
  author?: string
  /** Built-in templates can't be deleted. */
  builtin?: boolean
}

export interface SessionTemplateManagerOptions {
  /** User templates directory. */
  userDir: string
  /** Built-in templates directory. */
  builtinDir?: string
}

/**
 * A user template's id is used as its file name inside the user templates
 * directory, so a separator, a traversal segment, or an absolute path would let
 * a caller write or delete outside it — including over the repository registry
 * that provider launches are authorized against.
 */
const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function assertTemplateId(id: string): string {
  if (typeof id !== 'string' || !TEMPLATE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid template id: ${String(id)}`)
  }
  return id
}

/**
 * Manages session templates.
 *
 * Templates are pre-configured session setups that users can apply
 * to quickly start common workflows. Templates can be built-in
 * (shipped with the app) or user-created.
 */
export class SessionTemplateManager {
  private options: SessionTemplateManagerOptions
  private templates: Map<string, SessionTemplate> = new Map()

  constructor(options: SessionTemplateManagerOptions) {
    this.options = options
  }

  /**
   * Loads all templates from disk.
   */
  async load(): Promise<void> {
    this.templates.clear()

    // Load built-in templates first
    await this.loadBuiltinTemplates()

    // Load user templates (can override built-in)
    await this.loadUserTemplates()

    logger.info({ count: this.templates.size }, 'session-templates: loaded')
  }

  /**
   * Gets all templates.
   */
  getAll(): SessionTemplate[] {
    return Array.from(this.templates.values())
  }

  /**
   * Gets templates by category.
   */
  getByCategory(category: string): SessionTemplate[] {
    return this.getAll().filter(t => t.category === category)
  }

  /**
   * Gets a template by ID.
   */
  get(id: string): SessionTemplate | undefined {
    return this.templates.get(id)
  }

  /**
   * Searches templates by name, description, or tags.
   */
  search(query: string): SessionTemplate[] {
    const lower = query.toLowerCase()
    return this.getAll().filter(
      t =>
        t.name.toLowerCase().includes(lower) ||
        t.description.toLowerCase().includes(lower) ||
        t.tags?.some(tag => tag.toLowerCase().includes(lower))
    )
  }

  /**
   * Creates a new user template.
   */
  async create(template: Omit<SessionTemplate, 'builtin'>): Promise<SessionTemplate> {
    const newTemplate: SessionTemplate = {
      ...template,
      id: template.id || `tmpl-${Date.now()}`,
    }

    await this.saveUserTemplate(newTemplate)
    this.templates.set(newTemplate.id, newTemplate)

    logger.info({ id: newTemplate.id, name: newTemplate.name }, 'session-templates: created')
    return newTemplate
  }

  /**
   * Updates an existing user template.
   */
  async update(id: string, updates: Partial<SessionTemplate>): Promise<SessionTemplate> {
    const existing = this.templates.get(id)
    if (!existing) throw new Error(`Template ${id} not found`)
    if (existing.builtin) throw new Error(`Cannot modify built-in template ${id}`)

    const updated = { ...existing, ...updates, id }
    await this.saveUserTemplate(updated)
    this.templates.set(id, updated)

    logger.info({ id }, 'session-templates: updated')
    return updated
  }

  /**
   * Deletes a user template.
   */
  async delete(id: string): Promise<void> {
    const existing = this.templates.get(id)
    if (!existing) throw new Error(`Template ${id} not found`)
    if (existing.builtin) throw new Error(`Cannot delete built-in template ${id}`)

    const file = this.templatePath(id)
    await rm(file, { force: true })
    this.templates.delete(id)

    logger.info({ id }, 'session-templates: deleted')
  }

  /**
   * Creates a session from a template.
   */
  async createSession(templateId: string): Promise<{
    systemPrompt?: string
    initialPrompt?: string
    provider?: string
    model?: string
    allowedTools?: string[]
    deniedTools?: string[]
    env?: Record<string, string>
  }> {
    const template = this.get(templateId)
    if (!template) throw new Error(`Template ${templateId} not found`)

    return {
      systemPrompt: template.systemPrompt,
      initialPrompt: template.initialPrompt,
      provider: template.provider,
      model: template.model,
      allowedTools: template.allowedTools,
      deniedTools: template.deniedTools,
      env: template.env,
    }
  }

  private async loadBuiltinTemplates(): Promise<void> {
    const builtin: SessionTemplate[] = [
      {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code for bugs, style, and improvements',
        category: 'development',
        icon: '🔍',
        systemPrompt: 'You are an expert code reviewer. Review the provided code for bugs, style issues, security concerns, and potential improvements.',
        tags: ['review', 'code', 'quality'],
        builtin: true,
      },
      {
        id: 'bug-hunt',
        name: 'Bug Hunt',
        description: 'Systematically find and fix bugs in your project',
        category: 'development',
        icon: '🐛',
        systemPrompt: 'You are a debugging expert. Help identify, isolate, and fix bugs in the codebase.',
        tags: ['debug', 'bugs', 'fix'],
        builtin: true,
      },
      {
        id: 'refactor',
        name: 'Refactoring',
        description: 'Refactor code for clarity and maintainability',
        category: 'development',
        icon: '🔧',
        systemPrompt: 'You are a refactoring expert. Help improve code structure while maintaining behavior.',
        tags: ['refactor', 'clean-code'],
        builtin: true,
      },
      {
        id: 'docs',
        name: 'Documentation',
        description: 'Generate and improve project documentation',
        category: 'writing',
        icon: '📝',
        systemPrompt: 'You are a technical writing expert. Help create clear, comprehensive documentation.',
        tags: ['docs', 'writing'],
        builtin: true,
      },
      {
        id: 'brainstorm',
        name: 'Brainstorming',
        description: 'Creative brainstorming and ideation session',
        category: 'creative',
        icon: '💡',
        systemPrompt: 'You are a creative thinking partner. Help brainstorm ideas, explore possibilities, and think outside the box.',
        tags: ['creative', 'ideas'],
        builtin: true,
      },
    ]

    for (const template of builtin) {
      this.templates.set(template.id, template)
    }
  }

  private async loadUserTemplates(): Promise<void> {
    try {
      const files = await readdir(this.options.userDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const content = await readFile(join(this.options.userDir, file), 'utf-8')
          const template = JSON.parse(content) as SessionTemplate
          this.templates.set(template.id, template)
        } catch (error) {
          logger.warn({ err: error, file }, 'session-templates: failed to load user template')
        }
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
  }

  private async saveUserTemplate(template: SessionTemplate): Promise<void> {
    await mkdir(this.options.userDir, { recursive: true })
    const file = this.templatePath(template.id)
    await writeFile(file, JSON.stringify(template, null, 2), 'utf-8')
  }

  private templatePath(id: string): string {
    return join(this.options.userDir, `${assertTemplateId(id)}.json`)
  }
}

/**
 * Creates a session template manager.
 */
export function createSessionTemplateManager(userDir: string): SessionTemplateManager {
  return new SessionTemplateManager({ userDir })
}
