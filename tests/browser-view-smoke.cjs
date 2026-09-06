// Run against a real package, with a fresh profile; this does not touch installed user data.
const { spawnSync } = require('node:child_process')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { parseArgs } = require('node:util')
const { values } = parseArgs({ options: { app: {type:'string'}, playwright: {type:'string'} } })
const app = values.app || process.env.DONWELLS_BROWSER_SMOKE_APP
const playwright = values.playwright || process.env.DONWELLS_PLAYWRIGHT
if (!app || !playwright) throw new Error('Supply --app <packaged executable> and --playwright <installed index.mjs>')
const root = mkdtempSync(join(tmpdir(),'donwells-browser-view-smoke-'))
const result = spawnSync(process.execPath,[join(__dirname,'acceptance/browser-view-ui.mjs'),'--app',app,'--playwright',playwright,'--profile',join(root,'profile'),'--evidence',join(root,'evidence')],{stdio:'inherit'})
console.log('Browser view evidence:',join(root,'evidence'))
if (result.error) throw result.error
process.exitCode = result.status ?? 1
