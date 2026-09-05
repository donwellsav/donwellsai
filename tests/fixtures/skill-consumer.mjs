#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT_BY_PROVIDER = {
  codex: '.agents/skills',
  claude: '.claude/skills',
  opencode: '.opencode/skills'
}

const [workspace, provider] = process.argv.slice(2)
const relativeRoot = ROOT_BY_PROVIDER[provider]
if (!workspace || !relativeRoot) {
  process.stderr.write('usage: skill-consumer <workspace> <codex|claude|opencode>\n')
  process.exit(2)
}

const root = join(realpathSync(resolve(workspace)), ...relativeRoot.split('/'))
const skills = []
for (const directory of readdirSync(root).sort()) {
  const packagePath = join(root, directory)
  const packageStat = lstatSync(packagePath)
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) continue
  const manifestPath = join(packagePath, 'SKILL.md')
  const manifestStat = lstatSync(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) continue
  const markdown = readFileSync(manifestPath, 'utf8')
  const match = /^---\r?\n[\s\S]*?^name:\s*["']?([a-z0-9-]+)["']?\s*$[\s\S]*?^---\s*$/m.exec(markdown)
  if (match) skills.push({ name: match[1], path: manifestPath })
}
process.stdout.write(`${JSON.stringify({ provider, root, skills })}\n`)
