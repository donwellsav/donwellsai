import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import type { ProjectEnvironment, ProjectRemoteRequest, ProjectRemoteResponse, SshEnvironmentConfig } from '@shared/project-environment'

export function validateSshConfig(value: SshEnvironmentConfig): SshEnvironmentConfig {
  if (!value || value.kind !== 'ssh' || typeof value.hostname !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(value.hostname) || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value.username)) throw new Error('Expected an explicit SSH hostname and account')
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('Invalid SSH port')
  if (!isAbsolute(value.identityFile) || !isAbsolute(value.remoteRoot) || /[\0\r\n]/.test(value.identityFile + value.remoteRoot)) throw new Error('SSH identity and remote root require absolute paths')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.remoteProjectId)) throw new Error('Invalid remote project identity')
  const key = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(value.hostKey)
  if (!key) throw new Error('Pairing requires an explicit Ed25519 host public key')
  const bytes = Buffer.from(key[1], 'base64')
  if (bytes.length !== 51 || bytes.readUInt32BE(0) !== 11 || bytes.subarray(4, 15).toString() !== 'ssh-ed25519' || bytes.readUInt32BE(15) !== 32) throw new Error('Invalid SSH host public key')
  const fingerprint = 'SHA256:' + createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')
  if (fingerprint !== value.hostFingerprint) throw new Error('Host key does not match the independently verified fingerprint')
  const identity = lstatSync(value.identityFile)
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 || identity.mode & 0o077 || process.getuid && identity.uid !== process.getuid()) throw new Error('SSH private identity must be a private regular file owned by this account')
  return { ...value, identityFile: realpathSync(value.identityFile) }
}

export function sshProjectArguments(config: SshEnvironmentConfig, knownHosts: string): string[] {
  return ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + knownHosts,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=10',
    '-p', String(config.port), '-i', config.identityFile, '--', config.username + '@' + config.hostname, 'donwells-project-v1']
}

/** OpenSSH owns authentication; the existing process executor owns deadlines and cancellation. */
export async function requestProjectRemote(environment: ProjectEnvironment, knownHosts: string, request: ProjectRemoteRequest, signal?: AbortSignal): Promise<unknown> {
  const config = validateSshConfig(environment.config)
  const response = await runProcess({ program: '/usr/bin/ssh', args: sshProjectArguments(config, knownHosts), env: sanitizedProcessEnv(process.env),
    input: JSON.stringify(request) + '\n', timeoutMs: 30000, maxOutputBytes: 2 * 1024 * 1024, signal, detached: true })
  const lines = response.stdout.trim().split('\n')
  if (lines.length !== 1 || Buffer.byteLength(lines[0]) > 2 * 1024 * 1024) throw new Error('Invalid remote response frame')
  const parsed = JSON.parse(lines[0]) as ProjectRemoteResponse
  if (parsed.version !== 1 || parsed.requestId !== request.requestId || typeof parsed.ok !== 'boolean') throw new Error('Remote response identity mismatch')
  if (!parsed.ok) throw new Error(parsed.error ?? 'Remote request failed')
  return parsed.result
}
