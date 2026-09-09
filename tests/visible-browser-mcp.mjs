// Isolated native WebContentsView: never attaches to a user's running app or terminal.
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'vite'
const require = createRequire(import.meta.url), root = resolve('.'), temp = await mkdtemp(join(tmpdir(), 'donwells-visible-mcp-'))
try {
  await writeFile(join(temp, 'main.ts'), `
import {app,BrowserWindow} from 'electron';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {BrowserViews} from '${root}/src/main/browser-views';
import {ProjectMemoryMcpSession,PROJECT_MEMORY_MCP_PROTOCOL_VERSION} from '${root}/src/cli/project-memory-mcp';
app.setPath('userData',${JSON.stringify(join(temp, 'profile'))});
const timeout=setTimeout(()=>{console.error('Native MCP test timed out');app.exit(1)},20000);
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false}), key=${JSON.stringify(temp)}, instance='native-mcp-test';
 const views=new BrowserViews(window,async path=>{assert.equal(path,key);return path});
 const server=createServer((_request,response)=>response.end(${JSON.stringify('<title>MCP preview</title><button id="save" onclick="this.textContent=\'Saved through MCP\'">Save</button>')}));
 try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await views.request({op:'create',key,instance});
  const session=new ProjectMemoryMcpSession({workspacePath:key,harness:'codex',invoke:async(method,params)=>{
   if(method==='browser.open'){await views.request({op:'navigate',key:params.worktreePath,instance,url:params.url});return views.request({op:'snapshot',key,instance})}
   if(method==='browser.snapshot')return views.request({op:'snapshot',key:params.key,instance});
   if(method==='browser.eval')return views.evaluate(params.key,params.js);
   throw new Error('Unexpected method '+method);
  }});
  const send=async(method,params,id=1)=>JSON.parse(await session.handleLine(JSON.stringify({jsonrpc:'2.0',method,params,id})));
  await send('initialize',{protocolVersion:PROJECT_MEMORY_MCP_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'native-test',version:'1'}});
  await session.handleLine(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}));
  const execute=async(command,params)=>{const reply=await send('tools/call',{name:'donwells_execute',arguments:{command,params}});assert(!reply.error&&!reply.result.isError,JSON.stringify(reply));return JSON.parse(reply.result.content[0].text)};
  await execute('browser-open',{worktreePath:key,url:'http://127.0.0.1:'+server.address().port});
  const before=await execute('browser-snapshot',{key});assert.equal(before.title,'MCP preview');assert.match(before.text,/Save/);
  const id=views.target(key).id;
  await execute('browser-eval',{key,js:'document.querySelector("#save").click(); true'});
  const after=await execute('browser-snapshot',{key});assert.match(after.text,/Saved through MCP/);assert.equal(views.target(key).id,id);
  console.log(JSON.stringify({ok:true,checks:['MCP opens native built-in view','MCP reads rendered page','MCP operates same native page','native view identity retained']}));
 } finally {views.close();window.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));clearTimeout(timeout)}
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`)
  await build({ configFile: false, logLevel: 'error', resolve: { alias: { '@shared': join(root, 'src/shared') } }, build: { outDir: join(temp, 'out'), lib: { entry: join(temp, 'main.ts'), formats: ['cjs'], fileName: () => 'main.cjs' }, rollupOptions: { external: ['electron', ...builtinModules, ...builtinModules.map(name => 'node:' + name)] } } })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [join(temp, 'out/main.cjs')], { env, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  if (code !== 0) throw new Error('Native browser MCP regression failed: ' + code)
} finally { await rm(temp, { recursive: true, force: true }) }
