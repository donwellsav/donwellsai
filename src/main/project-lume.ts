import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ProcessSpec } from '@shared/child-process/process-spec'
import type { ProjectToolScope } from '@shared/project-tools'

export type LumeEnvironmentConfig = {
  storageDirectory: string; name: string; machineIdentifierSha256: string
  mounts: Array<{ path: string; mode: 'ro' | 'rw'; purpose: 'source' | 'results' }>
}
export type LumeAdmission = { executable: string; executableSha256: string; clipboardDisabledQualified: boolean; vncDisabledQualified: boolean }
const inside = (root: string, path: string) => { const value = relative(root, path); return value === '' || value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value) }
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

/** Prepare only an already admitted disposable guest. Image download/adoption and VM lifetime are separate operations. */
export function prepareLumeEnvironment(admission: LumeAdmission, config: LumeEnvironmentConfig, scope: ProjectToolScope, returnDirectory: string): ProcessSpec {
  if (!admission.clipboardDisabledQualified || !admission.vncDisabledQualified) throw new Error('Lume requires qualified clipboard-disable and no-VNC behavior before launch')
  if (!isAbsolute(admission.executable) || digest(readFileSync(admission.executable)) !== admission.executableSha256) throw new Error('Lume executable does not match its admission')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.name) || !isAbsolute(config.storageDirectory)) throw new Error('Invalid Lume storage identity')
  const storage = realpathSync(config.storageDirectory), vmDirectory = join(storage, config.name)
  if (lstatSync(vmDirectory).isSymbolicLink() || realpathSync(vmDirectory) !== vmDirectory) throw new Error('Lume VM storage identity changed')
  for (const name of ['config.json', 'disk.img', 'nvram.bin']) {
    const file = lstatSync(join(vmDirectory, name))
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('Lume guest files must not alias another VM')
  }
  const guest = JSON.parse(readFileSync(join(vmDirectory, 'config.json'), 'utf8')) as Record<string, unknown>
  if (typeof guest.machineIdentifier !== 'string' || digest(guest.machineIdentifier) !== config.machineIdentifierSha256) throw new Error('Lume machine identity does not match the selected guest')
  if (guest.cpuCount !== 4 || guest.memorySize !== 8 * 1024 ** 3 || guest.os !== 'macOS') throw new Error('This Lume admission requires the selected 4 CPU / 8 GiB macOS guest')
  const args = ['run', config.name, '--storage', storage, '--display', 'native', '--vnc', 'disabled', '--no-clipboard', '--network', 'nat']
  if (config.mounts.length > 8) throw new Error('Too many selected Lume mounts')
  const resultRoot = realpathSync(returnDirectory), checkout = realpathSync(scope.checkoutPath)
  for (const mount of config.mounts) {
    if (!isAbsolute(mount.path) || /[:\0\r\n]/.test(mount.path)) throw new Error('Lume mount path cannot contain colon or control characters')
    const path = realpathSync(mount.path)
    if (path !== mount.path || !lstatSync(path).isDirectory() || inside(path, homedir())) throw new Error('Lume mount must be a selected canonical directory')
    if (mount.purpose === 'source' ? mount.mode !== 'ro' || !inside(checkout, path) : mount.purpose !== 'results' || mount.mode !== 'rw' || !inside(resultRoot, path)) throw new Error('Lume mount exceeds its reviewed source or result scope')
    args.push('--shared-dir', path + ':' + mount.mode)
  }
  return { program: admission.executable, args, cwd: storage, executionHost: { kind: 'local' }, detached: true, timeoutMs: null }
}
