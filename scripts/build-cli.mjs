import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(command, ['exec', 'tsc', '-p', 'tsconfig.cli.json'], { cwd: root, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)

// TypeScript preserves @shared/* specifiers in the emitted CommonJS. Keep the
// runtime package self-contained instead of relying on a tsconfig-only alias.
const alias = join(root, 'dist-cli', 'node_modules', '@shared')
rmSync(alias, { recursive: true, force: true })
mkdirSync(join(root, 'dist-cli', 'node_modules'), { recursive: true })
cpSync(join(root, 'dist-cli', 'shared'), alias, { recursive: true })
