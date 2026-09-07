import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export function relativeFiles(directory) {
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true })
  const unsupported = entries.find(entry => entry.isSymbolicLink())
  if (unsupported) throw new Error(`Packaged resource symlink is not allowed: ${join(unsupported.parentPath, unsupported.name)}`)
  return entries.filter(entry => entry.isFile() && entry.name !== '.DS_Store')
    .map(entry => relative(directory, join(entry.parentPath, entry.name)))
    .sort()
}

export function assertMatchingDirectory(source, shipped) {
  const expected = relativeFiles(source), actual = relativeFiles(shipped)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`Packaged resource file list differs: ${shipped}`)
  return expected
}

export function externalResourcesIdentity(resources, entries) {
  const digest = createHash('sha256'), files = []
  for (const { to } of entries) {
    const target = join(resources, to)
    const names = statSync(target).isDirectory() ? relativeFiles(target) : ['']
    for (const name of names) {
      const key = name ? `${to}/${name}` : to
      digest.update(key + '\0').update(createHash('sha256').update(readFileSync(join(target, name))).digest())
      files.push(key)
    }
  }
  return { fileCount: files.length, sha256: digest.digest('hex') }
}
