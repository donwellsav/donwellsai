import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const nativeDirectory = join(root, 'resources', 'native')
const addonPath = join(nativeDirectory, 'runtime-identity.node')
const manifestPath = join(nativeDirectory, 'runtime-identity-build.json')
const [addonBytes, manifestBytes] = await Promise.all([readFile(addonPath), readFile(manifestPath)])
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const sha256 = createHash('sha256').update(addonBytes).digest('hex')

if (manifest.identityContractVersion !== 1) throw new Error('Runtime identity contract version must be 1')
if (manifest.runtimeFileSecurityContractVersion !== 1) throw new Error('Runtime file security contract version must be 1')
if (manifest.platform !== process.platform) throw new Error('Runtime identity platform differs from the host platform')
if (manifest.arch !== process.arch) throw new Error('Runtime identity architecture differs from the host architecture')
if (manifest.sha256 !== sha256) throw new Error('Runtime identity manifest hash differs from the staged addon')

console.log(`Native runtime identity verified for ${process.platform}/${process.arch} (${sha256})`)
