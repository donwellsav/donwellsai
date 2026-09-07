import { resolve } from 'node:path'

export async function runProjectRemote(argv: readonly string[]): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--mapping' || !argv[1].startsWith('/')) throw new Error('Usage: donwells project-remote --mapping /administrator/owned/project.json')
  // The deployment bundle carries the existing daemon and native PTY binding; no SSH-side global app RPC is exposed.
  const entry = require(resolve(__dirname, '../../out/main/project-remote-entry.js')) as { runProjectRemoteStdio(path: string): Promise<void> }
  await entry.runProjectRemoteStdio(argv[1])
  return 0
}
