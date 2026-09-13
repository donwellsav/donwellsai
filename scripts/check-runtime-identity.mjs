import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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

const addon = createRequire(import.meta.url)(addonPath)
if (addon.platform !== process.platform || addon.identityContractVersion !== 1 || addon.runtimeFileSecurityContractVersion !== 1
  || typeof addon.readProcessIdentity !== 'function' || typeof addon.readPrivateRuntimeFile !== 'function'
  || typeof addon.withRuntimeAuthority !== 'function') {
  throw new Error('Runtime identity addon does not expose the required callable contract')
}
const directory = await mkdtemp(join(tmpdir(), 'runtime-identity-package-check-'))
try {
  const probePath = join(directory, 'private-runtime.json')
  const expected = Buffer.from('{"runtimeIdentityProbe":true}\n')
  await writeFile(probePath, expected, { mode: 0o600 })
  const observed = addon.readPrivateRuntimeFile(probePath, 1024)
  if (observed?.ok !== true || !Buffer.isBuffer(observed.bytes) || !observed.bytes.equals(expected)
    || typeof observed.fileIdentity !== 'object' || observed.fileIdentity === null) {
    throw new Error('Runtime identity addon failed its private-file callable probe')
  }
  const authorityPath = join(directory, 'runtime-owners.sqlite')
  await writeFile(authorityPath, Buffer.alloc(0), { mode: 0o600 })
  const authorityBytes = Buffer.from('authority-probe')
  const authorityResult = addon.withRuntimeAuthority(authorityPath, false, 1024, observation => {
    if (!Buffer.isBuffer(observation?.bytes) || observation.bytes.length !== 0 || typeof observation.fileIdentity !== 'object' || observation.fileIdentity === null) {
      throw new Error('Runtime identity addon returned an invalid authority observation')
    }
    return { result: 'authority-ok', append: authorityBytes }
  })
  if (authorityResult !== 'authority-ok' || !(await readFile(authorityPath)).equals(authorityBytes)) {
    throw new Error('Runtime identity addon failed its same-handle authority probe')
  }
  const processObservation = addon.readProcessIdentity(process.pid)
  if (typeof processObservation !== 'object' || processObservation === null || typeof processObservation.ok !== 'boolean') {
    throw new Error('Runtime identity addon failed its process callable probe')
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
console.log(`Native runtime identity verified for ${process.platform}/${process.arch} (${sha256})`)
