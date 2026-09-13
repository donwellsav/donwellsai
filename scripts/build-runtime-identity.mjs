import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const supportedPlatforms = new Set(['darwin', 'linux', 'win32'])
const supportedArchitectures = new Set(['arm64', 'x64'])
if (!supportedPlatforms.has(process.platform) || !supportedArchitectures.has(process.arch)) {
  throw new Error('Unsupported runtime identity platform/architecture: ' + process.platform + '/' + process.arch)
}

const nodeGyp = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp')
if (!existsSync(nodeGyp)) throw new Error('Workspace-local node-gyp binary is missing')
const nativeDirectory = join(root, 'native', 'runtime-identity')
execFileSync(nodeGyp, ['rebuild', '--directory', nativeDirectory], { cwd: root, stdio: 'inherit' })

const releaseArtifact = join(nativeDirectory, 'build', 'Release', 'runtime-identity.node')
if (!existsSync(releaseArtifact)) throw new Error('node-gyp did not produce the runtime identity addon')
const outputDirectory = join(root, 'resources', 'native')
mkdirSync(outputDirectory, { recursive: true })
const addonBytes = readFileSync(releaseArtifact)
const sha256 = createHash('sha256').update(addonBytes).digest('hex')
const addonPath = join(outputDirectory, 'runtime-identity.node')
const manifestPath = join(outputDirectory, 'runtime-identity-build.json')
const temporaryAddonPath = addonPath + '.tmp-' + process.pid
const temporaryManifestPath = manifestPath + '.tmp-' + process.pid
try {
  writeFileSync(temporaryAddonPath, addonBytes, { mode: 0o644 })
  renameSync(temporaryAddonPath, addonPath)
  const manifest = JSON.stringify({ identityContractVersion: 1, runtimeFileSecurityContractVersion: 1, platform: process.platform, arch: process.arch, sha256 }, null, 2) + '\n'
  writeFileSync(temporaryManifestPath, manifest, { mode: 0o644 })
  renameSync(temporaryManifestPath, manifestPath)
} finally {
  rmSync(temporaryAddonPath, { force: true })
  rmSync(temporaryManifestPath, { force: true })
}
console.log('Native runtime identity built for ' + process.platform + '/' + process.arch + ' (' + sha256 + ')')
