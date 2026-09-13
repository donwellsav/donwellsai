import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
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
if (manifest.runtimeFileSecurityContractVersion !== 2) throw new Error('Runtime file security contract version must be 2')
if (manifest.platform !== process.platform) throw new Error('Runtime identity platform differs from the host platform')
if (manifest.arch !== process.arch) throw new Error('Runtime identity architecture differs from the host architecture')
if (manifest.sha256 !== sha256) throw new Error('Runtime identity manifest hash differs from the staged addon')

const addon = createRequire(import.meta.url)(addonPath)
if (addon.platform !== process.platform || addon.identityContractVersion !== 1 || addon.runtimeFileSecurityContractVersion !== 2
  || typeof addon.readProcessIdentity !== 'function' || typeof addon.readPrivateRuntimeFile !== 'function'
  || typeof addon.readPrivateRuntimeFileIdentity !== 'function' || typeof addon.validatePrivateRuntimeDirectory !== 'function'
  || typeof addon.withRuntimeAuthorityLock !== 'function' || typeof addon.renameRuntimePathNoReplace !== 'function') {
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
  const directoryObservation = addon.validatePrivateRuntimeDirectory(directory)
  if (directoryObservation?.ok !== true || typeof directoryObservation.fileIdentity !== 'object' || directoryObservation.fileIdentity === null) {
    throw new Error('Runtime identity addon failed its private-directory callable probe')
  }
  const authorityPath = join(directory, 'runtime-owners.sqlite')
  const authorityBytes = Buffer.from('authority-probe')
  await writeFile(authorityPath, authorityBytes, { mode: 0o600 })
  const authorityResult = addon.withRuntimeAuthorityLock(authorityPath, () => {
    const observation = addon.readPrivateRuntimeFileIdentity(authorityPath)
    if (observation?.ok !== true || typeof observation.fileIdentity !== 'object' || observation.fileIdentity === null) {
      throw new Error('Runtime identity addon returned an invalid authority identity')
    }
    return 'authority-ok'
  })
  if (authorityResult !== 'authority-ok' || !(await readFile(authorityPath)).equals(authorityBytes)) {
    throw new Error('Runtime identity addon failed its canonical authority lock probe')
  }
  const renameSource = join(directory, 'rename-source')
  const renameDestination = join(directory, 'rename-destination')
  const firstSource = Buffer.from('first-source')
  await writeFile(renameSource, firstSource, { mode: 0o600 })
  const renamed = addon.renameRuntimePathNoReplace(renameSource, renameDestination)
  if (renamed?.ok !== true || !(await readFile(renameDestination)).equals(firstSource)) {
    throw new Error('Runtime identity addon failed its no-replace rename success probe')
  }
  const secondSource = Buffer.from('second-source')
  await writeFile(renameSource, secondSource, { mode: 0o600 })
  const occupied = addon.renameRuntimePathNoReplace(renameSource, renameDestination)
  if (occupied?.ok !== false || occupied.code !== 'destination-exists'
    || !(await readFile(renameSource)).equals(secondSource) || !(await readFile(renameDestination)).equals(firstSource)) {
    throw new Error('Runtime identity addon failed its occupied no-replace rename probe')
  }
  if (process.platform === 'win32') {
    const walAuthorityPath = join(directory, 'wal-authority.sqlite')
    addon.withRuntimeAuthorityLock(walAuthorityPath, stablePath => {
      const database = new DatabaseSync(stablePath)
      try {
        database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE marker(value TEXT NOT NULL)')
        database.prepare('INSERT INTO marker(value) VALUES(?)').run('committed')
        database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      } finally { database.close() }
    })
    const crashScript = [
      "const { DatabaseSync }=require('node:sqlite')",
      "const addon=require(process.argv[1])",
      "addon.withRuntimeAuthorityLock(process.argv[2],alias=>{",
      "const db=new DatabaseSync(alias)",
      "db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE')",
      "db.prepare('UPDATE marker SET value=?').run('recovered')",
      "db.exec('COMMIT')",
      "process.exit(0)",
      "})"
    ].join(';')
    execFileSync(process.execPath, ['-e', crashScript, addonPath, walAuthorityPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    let reusedAlias = false
    const recovered = addon.withRuntimeAuthorityLock(walAuthorityPath, stablePath => {
      reusedAlias = stablePath.includes('.donwells-alias-')
      const database = new DatabaseSync(stablePath)
      try {
        const value = database.prepare('SELECT value FROM marker').get()?.value
        database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
        return value
      } finally { database.close() }
    })
    if (!reusedAlias || recovered !== 'recovered') throw new Error('Runtime identity addon failed its Windows crash-left WAL recovery probe')
  }
  const processObservation = addon.readProcessIdentity(process.pid)
  if (typeof processObservation !== 'object' || processObservation === null || typeof processObservation.ok !== 'boolean') {
    throw new Error('Runtime identity addon failed its process callable probe')
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
console.log(`Native runtime identity verified for ${process.platform}/${process.arch} (${sha256})`)
