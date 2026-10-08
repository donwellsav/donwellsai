#!/usr/bin/env node
/**
 * Provision the pinned Zig toolchain that the native Ghostty build requires.
 *
 * Ghostty is the terminal, so packaging and CI must be able to build the native
 * surface rather than discover a compiler by luck. The version and its published
 * digest are pinned here; an existing install is reused.
 *
 * `--print-path` prints the directory to put on PATH (for $GITHUB_PATH).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const VERSION = '0.16.0'
const ASSETS = {
  arm64: { file: `zig-aarch64-macos-${VERSION}.tar.xz`, sha256: 'b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489' },
  x64: { file: `zig-x86_64-macos-${VERSION}.tar.xz`, sha256: '0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7' }
}

const asset = ASSETS[process.arch]
if (!asset) throw new Error(`Unsupported architecture for the pinned Zig toolchain: ${process.arch}`)

const cache = join(process.env['DONWELLS_ZIG_CACHE'] ?? join(homedir(), '.cache', 'donwells-zig'), VERSION)

/** The extracted directory is whatever contains the compiler binary. */
function locate() {
  if (!existsSync(cache)) return undefined
  for (const entry of readdirSync(cache)) {
    const candidate = join(cache, entry, 'zig')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const existing = locate()
if (process.argv.includes('--print-path')) {
  if (!existing) throw new Error(`Zig ${VERSION} is not provisioned yet; run this script without --print-path first`)
  console.log(dirname(existing))
  process.exit(0)
}

if (existing) {
  console.log(`Zig ${VERSION} already provisioned: ${existing}`)
  process.exit(0)
}

const url = `https://ziglang.org/download/${VERSION}/${asset.file}`
console.log(`Downloading ${url}`)
const response = await fetch(url)
if (!response.ok) throw new Error(`Zig download failed: HTTP ${response.status} ${response.statusText}`)
const archive = Buffer.from(await response.arrayBuffer())

const digest = createHash('sha256').update(archive).digest('hex')
if (digest !== asset.sha256) throw new Error(`Zig digest mismatch: got ${digest}, expected ${asset.sha256}`)

mkdirSync(cache, { recursive: true })
const tarball = join(cache, asset.file)
writeFileSync(tarball, archive)
try {
  execFileSync('tar', ['-xJf', tarball, '-C', cache], { stdio: 'inherit' })
} finally {
  rmSync(tarball, { force: true })
}

const installed = locate()
if (!installed) throw new Error(`Zig did not extract a compiler under ${cache}`)
console.log(`Zig ${execFileSync(installed, ['version'], { encoding: 'utf8' }).trim()} provisioned: ${installed}`)
