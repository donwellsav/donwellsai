#!/usr/bin/env node
// Check the carried policy against exact admitted sources without compiling or starting a VM.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const source = process.argv[2]
if (!source) throw new Error('Usage: node native/lume/check-policy.mjs /pinned/cua/source')
const here = import.meta.dirname, record = JSON.parse(readFileSync(join(here, 'source.json'), 'utf8'))
const scratch = mkdtempSync(join(tmpdir(), 'donwells-lume-policy-'))
try {
  for (const [path, expected] of Object.entries(record.sourceSha256)) {
    const bytes = readFileSync(join(source, path))
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Source revision mismatch: ' + path)
    mkdirSync(dirname(join(scratch, path)), { recursive: true }); writeFileSync(join(scratch, path), bytes)
  }
  execFileSync('/usr/bin/git', ['apply', resolve(here, 'clipboard-policy.patch')], { cwd: scratch })
  const vm = readFileSync(join(scratch, 'libs/lume/src/VM/VM.swift'), 'utf8')
  const match = vm.match(/static func shouldStartClipboardWatcher\([\s\S]*?\n    }/)
  if (!match) throw new Error('Policy function not found')
  const swift = 'import Foundation\nenum DisplayMode { case native, vnc, none }\n' + match[0].replace('static func', 'func') + `
for mode in [DisplayMode.native, .vnc, .none] {
 for os in ["macOS", "linux"] {
  for requested in [false, true] {
   assert(!shouldStartClipboardWatcher(displayMode: mode, osType: os, explicitlyRequested: requested, explicitlyDisabled: true))
   assert(shouldStartClipboardWatcher(displayMode: mode, osType: os, explicitlyRequested: requested) == (requested || (mode == .native && os == "macOS")))
  }
 }
}
print("Pinned clipboard policy checks passed; full build and guest proof remain pending")
`
  writeFileSync(join(scratch, 'check.swift'), swift)
  execFileSync('/usr/bin/swift', [join(scratch, 'check.swift')], { stdio: 'inherit', timeout: 30000 })
} finally { rmSync(scratch, { recursive: true, force: true }) }
