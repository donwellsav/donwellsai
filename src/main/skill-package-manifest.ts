import type { SkillPackageManifest } from '@shared/skill-packages'

const MAX_FRONTMATTER_BYTES = 64 * 1024
const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1_024
const MAX_OPTIONAL_FIELD_LENGTH = 512
const PACKAGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export class SkillPackageManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillPackageManifestError'
  }
}

type FrontmatterEntry = {
  inline: string
  continuation: string[]
}

function unquoteScalar(raw: string, field: string): string {
  const withoutComment = raw.replace(/\s+#.*$/, '').trim()
  if (!withoutComment) throw new SkillPackageManifestError(`SKILL.md frontmatter field ${field} must be a string`)
  if (withoutComment.startsWith('[') || withoutComment.startsWith('{') || withoutComment.startsWith('!')
    || withoutComment.startsWith('&') || withoutComment.startsWith('*')) {
    throw new SkillPackageManifestError(`SKILL.md frontmatter field ${field} must be a plain string`)
  }
  if (withoutComment.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(withoutComment)
      if (typeof parsed !== 'string') throw new Error('not a string')
      return parsed
    } catch (error) {
      throw new SkillPackageManifestError(`SKILL.md frontmatter field ${field} has invalid quoting: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (withoutComment.startsWith("'")) {
    if (!withoutComment.endsWith("'") || withoutComment.length < 2) {
      throw new SkillPackageManifestError(`SKILL.md frontmatter field ${field} has invalid quoting`)
    }
    return withoutComment.slice(1, -1).replace(/''/g, "'")
  }
  return withoutComment
}

function entryValue(entry: FrontmatterEntry, field: string): string {
  const blockStyle = /^([|>])(?:[+-])?$/.exec(entry.inline)
  if (blockStyle) {
    const lines = entry.continuation.map((line) => line.trim())
    return blockStyle[1] === '|' ? lines.join('\n').trim() : lines.filter(Boolean).join(' ').trim()
  }
  if (entry.continuation.some((line) => line.trim().length > 0)) {
    throw new SkillPackageManifestError(`SKILL.md frontmatter field ${field} must not contain nested data`)
  }
  return unquoteScalar(entry.inline, field)
}

function optionalValue(entries: Map<string, FrontmatterEntry>, field: string): string | undefined {
  const entry = entries.get(field)
  if (!entry) return undefined
  const value = entryValue(entry, field).trim()
  if (!value) return undefined
  if (value.length > MAX_OPTIONAL_FIELD_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw new SkillPackageManifestError(`SKILL.md frontmatter field ${field} is invalid or too long`)
  }
  return value
}

/** Parse only the scalar fields consumed by the app; nested metadata remains inert text. */
export function parseSkillPackageManifest(markdown: string): SkillPackageManifest {
  const text = markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    throw new SkillPackageManifestError('SKILL.md must begin with YAML frontmatter')
  }

  const normalized = text.replace(/\r\n?/g, '\n')
  const closing = normalized.indexOf('\n---\n', 4)
  if (closing < 0) throw new SkillPackageManifestError('SKILL.md frontmatter is not terminated with ---')
  if (Buffer.byteLength(normalized.slice(0, closing), 'utf8') > MAX_FRONTMATTER_BYTES) {
    throw new SkillPackageManifestError('SKILL.md frontmatter is too large')
  }
  if (!normalized.slice(closing + 5).trim()) {
    throw new SkillPackageManifestError('SKILL.md must contain instructions after its frontmatter')
  }

  const entries = new Map<string, FrontmatterEntry>()
  let current: FrontmatterEntry | undefined
  for (const [index, line] of normalized.slice(4, closing).split('\n').entries()) {
    if (line.includes('\t')) throw new SkillPackageManifestError(`SKILL.md frontmatter line ${index + 2} contains a tab`)
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) {
      if (!current) throw new SkillPackageManifestError(`SKILL.md frontmatter line ${index + 2} has no parent field`)
      current.continuation.push(line)
      continue
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))$/.exec(line)
    if (!match) throw new SkillPackageManifestError(`SKILL.md frontmatter line ${index + 2} is malformed`)
    const key = match[1]
    if (entries.has(key)) throw new SkillPackageManifestError(`SKILL.md frontmatter field ${key} is duplicated`)
    current = { inline: match[2], continuation: [] }
    entries.set(key, current)
    if (entries.size > 100) throw new SkillPackageManifestError('SKILL.md frontmatter contains too many fields')
  }

  const nameEntry = entries.get('name')
  const descriptionEntry = entries.get('description')
  if (!nameEntry) throw new SkillPackageManifestError('SKILL.md frontmatter requires name')
  if (!descriptionEntry) throw new SkillPackageManifestError('SKILL.md frontmatter requires description')
  const name = entryValue(nameEntry, 'name').trim()
  const description = entryValue(descriptionEntry, 'description').trim()
  if (!PACKAGE_NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new SkillPackageManifestError('Skill name must be 1–64 lowercase letters, numbers, or single hyphen-separated words')
  }
  if (!description || description.length > MAX_DESCRIPTION_LENGTH || CONTROL_CHARACTERS.test(description)) {
    throw new SkillPackageManifestError('Skill description must be 1–1024 characters without control characters')
  }

  return {
    name,
    description,
    version: optionalValue(entries, 'version'),
    license: optionalValue(entries, 'license'),
    compatibility: optionalValue(entries, 'compatibility')
  }
}
