import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Scan every file, including SQLite WALs and binary artifacts; unreadable files fail the census. */
export function assertNoDisclosure(root: string, markers: readonly string[], allowedInputs: readonly string[] = []): void {
  const needles = markers.map(marker => {
    if (marker.length === 0) throw new Error('Disclosure marker must not be empty')
    return [Buffer.from(marker), Buffer.from(marker, 'utf16le')]
  }).flat()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(`Unexpected census entry: ${relative(root, path)}`)
        if (!entry.isFile()) continue
        if (allowedInputs.includes(relative(root, path))) continue
        const bytes = readFileSync(path)
        if (needles.some(needle => bytes.includes(needle))) {
          throw new Error(`Credential disclosure in ${relative(root, path)}`)
        }
      }
    }
  }
  walk(root)
}
