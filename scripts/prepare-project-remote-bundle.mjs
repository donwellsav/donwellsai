#!/usr/bin/env node
// Offline, internal guest qualification bundle. Does not install or contact a guest.
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(repo, 'package.json'))
const [destination, nodePath] = process.argv.slice(2)
if (!destination || !nodePath || !destination.startsWith('/') || !nodePath.startsWith('/')) throw new Error('Usage: prepare-project-remote-bundle.mjs /new/output/directory /portable/node')
if (existsSync(destination)) throw new Error('Destination already exists; use a new bundle directory')
const runtime = JSON.parse(execFileSync(nodePath, ['-p', 'JSON.stringify({version:process.version,arch:process.arch,abi:process.versions.modules,sqlite:typeof require("node:sqlite").DatabaseSync})'], { encoding: 'utf8' }))
if (runtime.arch !== 'arm64' || runtime.sqlite !== 'function') throw new Error('Initial guest requires arm64 Node with node:sqlite')
const linked = execFileSync('/usr/bin/otool', ['-L', nodePath], { encoding: 'utf8' })
if (linked.split('\n').slice(1).some(line => line.trim() && !line.trim().startsWith('/usr/lib/') && !line.trim().startsWith('/System/Library/'))) throw new Error('Node requires non-system dylibs; copying its binary alone is not portable')
mkdirSync(destination, { mode: 0o700 }); mkdirSync(join(destination, 'bin'))
cpSync(nodePath, join(destination, 'bin/node'))
const esbuild = require(createRequire(require.resolve('vite')).resolve('esbuild'))
const result = await esbuild.build({ absWorkingDir: repo, entryPoints: ['src/main/project-remote-entry.ts', 'src/main/project-remote-memory-entry.ts', 'src/main/terminal-daemon-entry.ts'], outdir: join(destination, 'out/main'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['node-pty', 'electron'], alias: { '@shared': join(repo, 'src/shared') }, metafile: true, logLevel: 'warning' })
for (const output of Object.values(result.metafile.outputs)) for (const item of output.imports) if (item.external && !item.path.startsWith('node:') && item.path !== 'node-pty') throw new Error('Unexpected guest dependency: ' + item.path)
const pty = dirname(require.resolve('node-pty/package.json')), target = join(destination, 'node_modules/node-pty')
mkdirSync(target, { recursive: true })
for (const path of ['lib', 'prebuilds/darwin-arm64', 'package.json', 'LICENSE']) cpSync(join(pty, path), join(target, path), { recursive: true, dereference: true })
const node = join(destination, 'bin/node')
// Deny Electron at resolution time. Import only passive endpoints, never daemon main().
execFileSync(node, ['-e', `const Module=require('node:module');const load=Module._load;Module._load=function(id,...args){if(id==='electron')throw Error('Electron leaked into guest');return load.call(this,id,...args)};require('./out/main/project-remote-entry.js');require('./out/main/project-remote-memory-entry.js');require('node-pty');console.log('passive imports passed')`], { cwd: destination, stdio: 'pipe' })
for (const file of ['project-remote-entry.js', 'project-remote-memory-entry.js', 'terminal-daemon-entry.js']) execFileSync(node, ['--check', join(destination, 'out/main', file)], { stdio: 'pipe' })
const help = execFileSync(node, [join(destination, 'out/main/project-remote-entry.js'), '--help'], { encoding: 'utf8' })
if (!help.startsWith('Usage: project-remote-entry')) throw new Error('Remote CLI help failed')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), files = []
function walk(path) { for (const name of readdirSync(path)) { const file = join(path, name), stat = statSync(file); if (stat.isDirectory()) walk(file); else files.push({ path: relative(destination, file), bytes: stat.size, sha256: hash(readFileSync(file)) }) } }
walk(destination)
const sources = Object.keys(result.metafile.inputs).map(path => ({ path, sha256: hash(readFileSync(resolve(repo, path))) }))
writeFileSync(join(destination, 'deployment-manifest.json'), JSON.stringify({ schemaVersion: 1, purpose: 'Internal new-guest qualification; not a release distribution', runtime: { ...runtime, source: realpathSync(nodePath) }, nodePty: JSON.parse(readFileSync(join(pty, 'package.json'))).version, checks: ['plain Node passive imports with Electron denied', 'node-pty import', 'three entry syntax checks', 'remote CLI help'], limitations: ['No guest/SSH/PTY spawn performed', 'Attach Node distribution license/notices before redistribution', 'OpenCode executable and its runtime configured separately'], files, sources }, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ destination, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), runtime, checks: 'passed' }))
