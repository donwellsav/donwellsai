#!/usr/bin/env node
// Offline, internal guest qualification bundle. Does not install or contact a guest.
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(repo, 'package.json'))
const [destination, nodePath, nodePtyPath, esbuildPath] = process.argv.slice(2)
if (!destination || !nodePath || !destination.startsWith('/') || !nodePath.startsWith('/') || [nodePtyPath, esbuildPath].some(path => path && !path.startsWith('/'))) throw new Error('Usage: prepare-project-remote-bundle.mjs /new/output/directory /portable/node [/absolute/node-pty] [/absolute/esbuild]')
if (existsSync(destination)) throw new Error('Destination already exists; use a new bundle directory')
const runtime = JSON.parse(execFileSync(nodePath, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,abi:process.versions.modules,sqlite:typeof require("node:sqlite").DatabaseSync})'], { encoding: 'utf8' }))
if (!['darwin', 'linux'].includes(runtime.platform) || runtime.arch !== 'arm64' || !/^v24\./.test(runtime.version) || runtime.sqlite !== 'function') throw new Error('Guest requires Node 24 with node:sqlite on macOS or Linux arm64')
if (runtime.platform === 'darwin') {
  const linked = execFileSync('/usr/bin/otool', ['-L', nodePath], { encoding: 'utf8' })
  if (linked.split('\n').slice(1).some(line => line.trim() && !line.trim().startsWith('/usr/lib/') && !line.trim().startsWith('/System/Library/'))) throw new Error('Node requires non-system dylibs; copying its binary alone is not portable')
}
mkdirSync(destination, { mode: 0o700 }); mkdirSync(join(destination, 'bin'))
cpSync(nodePath, join(destination, 'bin/node'))
const esbuild = require(esbuildPath ? realpathSync(esbuildPath) : createRequire(require.resolve('vite')).resolve('esbuild'))
const result = await esbuild.build({ absWorkingDir: repo, entryPoints: ['src/main/project-remote-entry.ts', 'src/main/project-remote-memory-entry.ts', 'src/main/project-remote-computer-entry.ts', 'src/main/terminal-daemon-entry.ts'], outdir: join(destination, 'out/main'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['node-pty', 'electron'], alias: { '@shared': join(repo, 'src/shared') }, metafile: true, logLevel: 'warning' })
for (const output of Object.values(result.metafile.outputs)) for (const item of output.imports) if (item.external && !item.path.startsWith('node:') && item.path !== 'node-pty') throw new Error('Unexpected guest dependency: ' + item.path)
const pty = nodePtyPath ? realpathSync(nodePtyPath) : dirname(require.resolve('node-pty/package.json')), target = join(destination, 'node_modules/node-pty')
mkdirSync(target, { recursive: true })
const nativePath = runtime.platform === 'darwin' ? 'prebuilds/darwin-arm64/pty.node' : 'build/Release/pty.node'
if (!existsSync(join(pty, nativePath))) throw new Error(`node-pty is not built for ${runtime.platform}-arm64: ${nativePath}`)
for (const path of ['lib', runtime.platform === 'darwin' ? 'prebuilds/darwin-arm64' : nativePath, 'package.json', 'LICENSE']) { mkdirSync(dirname(join(target, path)), { recursive: true }); cpSync(join(pty, path), join(target, path), { recursive: true, dereference: true }) }
const node = join(destination, 'bin/node')
// Deny Electron at resolution time. Import only passive endpoints, never daemon main().
execFileSync(node, ['-e', `const Module=require('node:module');const load=Module._load;Module._load=function(id,...args){if(id==='electron')throw Error('Electron leaked into guest');return load.call(this,id,...args)};require('./out/main/project-remote-entry.js');require('./out/main/project-remote-memory-entry.js');require('./out/main/project-remote-computer-entry.js');require('node-pty');console.log('passive imports passed')`], { cwd: destination, stdio: 'pipe' })
for (const file of ['project-remote-entry.js', 'project-remote-memory-entry.js', 'project-remote-computer-entry.js', 'terminal-daemon-entry.js']) execFileSync(node, ['--check', join(destination, 'out/main', file)], { stdio: 'pipe' })
const help = execFileSync(node, [join(destination, 'out/main/project-remote-entry.js'), '--help'], { encoding: 'utf8' })
if (!help.startsWith('Usage: project-remote-entry')) throw new Error('Remote CLI help failed')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), files = []
function walk(path) { for (const name of readdirSync(path)) { const file = join(path, name), stat = statSync(file); if (stat.isDirectory()) walk(file); else files.push({ path: relative(destination, file), bytes: stat.size, sha256: hash(readFileSync(file)) }) } }
walk(destination)
const sources = Object.keys(result.metafile.inputs).map(path => ({ path, sha256: hash(readFileSync(resolve(repo, path))) }))
writeFileSync(join(destination, 'deployment-manifest.json'), JSON.stringify({ schemaVersion: 1, purpose: 'Internal new-guest qualification; not a release distribution', runtime: { ...runtime, source: realpathSync(nodePath) }, nodePty: { version: JSON.parse(readFileSync(join(pty, 'package.json'))).version, source: pty, nativePath, nativeSha256: hash(readFileSync(join(pty, nativePath))) }, checks: ['plain Node passive imports with Electron denied', 'node-pty native import', 'four entry syntax checks', 'remote CLI help'], limitations: ['No guest/SSH/PTY spawn performed', 'Attach Node distribution license/notices before redistribution', 'OpenCode executable and its runtime configured separately'], files, sources }, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ destination, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), runtime, checks: 'passed' }))
