#!/usr/bin/env node
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {existsSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=dirname(dirname(fileURLToPath(import.meta.url)))
const json=path=>JSON.parse(readFileSync(path,'utf8'))
const config=json(join(root,'build/electron-builder.json'))
assert(config.files.includes('!node_modules/@napi-rs/canvas*/**/*'),'Keep the unused Node canvas exclusion aligned with notices')
const seen=new Set(),entries=[]
const locate=(name,from)=>createRequire(join(from,'package.json')).resolve.paths(name)?.map(path=>join(path,name)).find(path=>existsSync(join(path,'package.json')))
function visit(directory){
 directory=realpathSync(directory);if(seen.has(directory))return;seen.add(directory)
 const pkg=json(join(directory,'package.json'))
 if(pkg.name.startsWith('@napi-rs/canvas'))return // PDF rendering uses Chromium canvas; these unused Node binaries are not shipped.
 const files=readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isFile()&&/^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name)).map(entry=>entry.name).sort()
 let notices=files.map(name=>name+'\n'+readFileSync(join(directory,name),'utf8'))
 if(!notices.length){
  const readme=readdirSync(directory).find(name=>/^readme\.md$/i.test(name))
  const content=readme?readFileSync(join(directory,readme),'utf8'):''
  const section=content.match(/^#+ (?:MIT )?Licen[cs]e\b[^\n]*\n([\s\S]*)/im)?.[1]
  if(section?.includes('Permission is hereby granted'))notices=[readme+' license section\n'+section]
 }
 if(pkg.name==='marked-footnote'&&pkg.version==='1.4.0')notices=['Upstream license at npm gitHead faab750f00af4788397948286fb8f7fe0c929a7e\nhttps://github.com/bent10/marked-extensions/blob/faab750f00af4788397948286fb8f7fe0c929a7e/license\n'+readFileSync(join(root,'resources/licenses/marked-footnote-1.4.0.txt'),'utf8')]
 assert(notices.length,`Missing license text: ${pkg.name}@${pkg.version}`)
 entries.push({name:pkg.name,version:pkg.version,text:`${pkg.name}@${pkg.version}\nDeclared license: ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license)}\n${notices.join('\n\n')}`})
 for(const name of Object.keys({...pkg.dependencies,...pkg.optionalDependencies})){const found=locate(name,directory);if(found)visit(found);else assert(pkg.optionalDependencies?.[name],`Missing dependency ${pkg.name} -> ${name}`)}
}
for(const name of Object.keys(json(join(root,'package.json')).dependencies)){const directory=locate(name,root);assert(directory,`Missing installed dependency: ${name}`);visit(directory)}
entries.sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version,'en'))
const output='BUNDLED DEPENDENCY NOTICES\nGenerated from the installed production dependency graph. Includes bundled renderer dependencies.\nElectron and Chromium notices are supplied in the Electron distribution.\nNative CLI agents and optional project tools are separately installed.\nThe bundled native Ghostty terminal engine (libghostty-spm pin in scripts/build-native-terminal.mjs) carries its licenses and corresponding-source archive in Contents/Resources/native/ within the packaged app; see native/ghostty/README.md for the admitted list.\n\n'+entries.map(entry=>entry.text.replaceAll('\r\n','\n').trim()).join('\n\n'+'='.repeat(72)+'\n\n')+'\n'
const target=join(root,'resources/THIRD_PARTY_DEPENDENCIES.txt')
if(process.argv.includes('--check'))assert.equal(readFileSync(target,'utf8'),output,'Dependency notices are stale; run pnpm notices:build')
else writeFileSync(target,output)
console.log(`${entries.length} installed production dependency notices ${process.argv.includes('--check')?'verified':'generated'}.`)
