import { join } from 'node:path'

export function windowsSystem32Binary(fileName: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows'
  return join(root, 'System32', fileName)
}
