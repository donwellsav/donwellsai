import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin' || process.arch !== 'arm64') process.exit(0)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'native/history'), output = join(root, 'resources/native/history')
const manifest = JSON.parse(readFileSync(join(source, 'build.json'), 'utf8'))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const binary = join(output, 'agentsview')
for (const [name, expected] of Object.entries(manifest.inputs)) {
  if (hash(join(source, name)) !== expected) throw new Error(`History build input changed: ${name}`)
}
mkdirSync(output, { recursive: true })
if (!existsSync(binary) || hash(binary) !== manifest.binarySha256) {
  const stage = mkdtempSync(join(tmpdir(), 'donwells-history-build-'))
  try {
    execFileSync('/usr/bin/tar', ['-xzf', join(source, 'source.tar.gz'), '-C', stage])
    execFileSync('/usr/bin/patch', ['-d', stage, '-p1', '-i', join(source, 'cwd3.patch')], { stdio: 'inherit' })
    mkdirSync(join(stage, 'internal/pricing/snapshot'), { recursive: true })
    for (const name of ['litellm_snapshot.json.gz', 'genai_prices.json.gz']) copyFileSync(join(source, 'snapshots', name), join(stage, 'internal/pricing/snapshot', name))
    execFileSync('go', ['build', '-buildvcs=false', '-tags', 'fts5', '-trimpath', '-ldflags=-s -w -X main.version=0.42.0-donwells-cwd3', '-o', join(stage, 'agentsview'), './cmd/agentsview'], { cwd: stage, env: { ...process.env, CGO_ENABLED: '1', GOTOOLCHAIN: 'go1.27.0' }, stdio: 'inherit' })
    if (hash(join(stage, 'agentsview')) !== manifest.binarySha256) throw new Error('History build differs from the tested binary; qualify the build before packaging')
    copyFileSync(join(stage, 'agentsview'), binary)
  } finally { rmSync(stage, { recursive: true, force: true }) }
}
chmodSync(binary, 0o755)
copyFileSync(join(source, 'LICENSE'), join(output, 'LICENSE'))
copyFileSync(join(source, 'DEPENDENCY_NOTICES.txt'), join(output, 'DEPENDENCY_NOTICES.txt'))
copyFileSync(join(source, 'build.json'), join(output, 'build.json'))
console.log('Bundled history engine verified.')
