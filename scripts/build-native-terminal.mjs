import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const root = resolve(import.meta.dirname, '..')
const output = join(root, 'resources/native')
mkdirSync(output, { recursive: true })
if (process.platform !== 'darwin') process.exit(0)
const directory = join(root, 'native/ghostty'), vendor = join(directory, '.vendor/libghostty-spm')
const revision = 'e47b20a860d464ac7ecb9c1eec01612cc6b178a5'
const run = (command, args, cwd = directory) => execFileSync(command, args, { cwd, stdio: 'inherit' })
if (!existsSync(vendor)) {
  mkdirSync(join(directory, '.vendor'), { recursive: true })
  run('git', ['clone', 'https://github.com/Lakr233/libghostty-spm.git', vendor])
  run('git', ['checkout', '--detach', revision], vendor)
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: vendor, encoding: 'utf8' }).trim()
if (head !== revision) throw new Error('Unexpected native terminal dependency revision; inspect native/ghostty/.vendor before rebuilding')
const patch = join(directory, 'host-integration.patch')
try { execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: vendor, stdio: 'ignore' }) }
catch { run('git', ['apply', '--check', patch], vendor); run('git', ['apply', patch], vendor) }
const core = join(directory, '.vendor/ghostty'), coreRevision = 'c4e16970a803b170e352432424f44192cb59f3ac'
if (!existsSync(core)) {
  run('git', ['init', core])
  run('git', ['fetch', '--depth=1', 'https://github.com/ghostty-org/ghostty.git', coreRevision], core)
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], core)
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: core, encoding: 'utf8' }).trim() !== coreRevision) throw new Error('Unexpected Ghostty core revision')
if (!['arm64', 'x64'].includes(process.arch)) throw new Error(`Unsupported native architecture: ${process.arch}`)
const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-macos.13.0`
const coreOutput = join(directory, '.build/core-no-intl', target)
cpSync(join(directory, 'replay-grid.patch'), join(vendor, 'Patches/ghostty/0099-donwells-replay-grid.patch'))
// Use upstream's external-I/O patch stack, but never its gettext-linked prebuilt binary.
execFileSync('./Script/build-ghostty.sh', [core, target, coreOutput], {
  cwd: vendor, stdio: 'inherit', env: { ...process.env, ZIG_BUILD_EXTRA_ARGS: '-Di18n=false' },
})
const framework = join(vendor, 'BinaryTarget/GhosttyKit.xcframework')
rmSync(framework, { recursive: true, force: true })
run('xcodebuild', ['-create-xcframework', '-library', join(coreOutput, 'lib/libghostty.a'), '-headers', join(coreOutput, 'include'), '-output', framework])
cpSync(join(vendor, 'Package.local.swift'), join(vendor, 'Package.swift'))
run('swift', ['build', '-c', 'release'])
const require = createRequire(import.meta.url), version = require('electron/package.json').version
const headers = [join(homedir(), '.electron-gyp', version, 'include/node'), '/opt/homebrew/include/node', '/usr/local/include/node'].find(path => existsSync(join(path, 'node_api.h')))
if (!headers) throw new Error('Node-API headers unavailable. Run pnpm rebuild:native to install Electron build headers.')
const release = join(directory, '.build/release')
const symbols = execFileSync('nm', ['-gU', join(release, 'libDonwellsGhostty.dylib')], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
if (/libintl|bindtextdomain|gettext/.test(symbols)) throw new Error('Native library unexpectedly includes gettext; do not package it')
run('clang', ['-shared', '-undefined', 'dynamic_lookup', '-I', headers, join(directory, 'bridge.c'), '-L', release, '-lDonwellsGhostty', '-Wl,-rpath,@loader_path', '-o', join(output, 'ghostty.node')])
cpSync(join(release, 'libDonwellsGhostty.dylib'), join(output, 'libDonwellsGhostty.dylib'))
cpSync(join(release, 'GhosttyKit_GhosttyTerminal.bundle'), join(output, 'GhosttyKit_GhosttyTerminal.bundle'), { recursive: true })
cpSync(join(vendor, 'LICENSE'), join(output, 'GhosttyTerminal-LICENSE.txt'))
cpSync(join(directory, '.build/checkouts/MSDisplayLink/LICENSE'), join(output, 'MSDisplayLink-LICENSE.txt'))
cpSync(join(directory, 'Ghostty-LICENSE.txt'), join(output, 'Ghostty-LICENSE.txt'))
cpSync(join(directory, 'notices'), join(output, 'notices'), { recursive: true })
const manifest = readFileSync(join(core, 'build.zig.zon'), 'utf8')
const z2dHash = manifest.match(/\.z2d = \.\{[\s\S]*?\.hash = "([^"]+)"/)[1]
const coveredSource = join(output, 'notices/z2d-source')
rmSync(coveredSource, { recursive: true, force: true })
cpSync(join(core, 'zig-pkg', z2dHash), coveredSource, { recursive: true })
cpSync(join(directory, 'notices/z2d-COPYING.txt'), join(coveredSource, 'COPYING'))
cpSync(join(directory, 'notices/z2d-LICENSE.txt'), join(coveredSource, 'LICENSE'))
writeFileSync(join(output, 'build.json'), JSON.stringify({ wrapper: revision, core: coreRevision, target, flags: ['-Di18n=false'], z2dHash }, null, 2))
console.log(`Native Ghostty built for ${process.arch}; external daemon retains PTY ownership.`)
