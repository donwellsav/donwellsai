// Run with: node tests/workspace-tool-transfer.mjs
// Real React, FlexLayout and Electron; tool bodies are stateful probes, with no external services.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const root = resolve(import.meta.dirname, '..'), temp = await mkdtemp(join(tmpdir(), 'donwells-tool-transfer-'))
const require = createRequire(import.meta.url)
const captureDir = process.env.DONWELLS_GUI_CAPTURE_DIR
if (captureDir) await mkdir(captureDir, { recursive: true })
const probes = ['ExplorerPane', 'GitPane', 'ProjectMemoryPanel', 'RecoveryPanel', 'ComputerControlPanel', 'ProjectSearch', 'TerminalPane', 'MediaPreviewRouter', 'DiffPane']
const server = await createServer({
  configFile: false, root, cacheDir: join(temp, 'vite-cache'), logLevel: 'error',
  optimizeDeps: { entries: [join(temp, 'fixture.tsx')], include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'flexlayout-react', 'lucide-react'] },
  plugins: [{ name: 'transfer-test-page', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__tool-transfer') return next()
      res.setHeader('Content-Type', 'text/html')
      res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root" style="height:700px"></div><script type="module" src="/@fs/${join(temp, 'fixture.tsx')}"></script></body></html>`))
    })
  } }, { name: 'stateful-tool-probes', enforce: 'pre', load(id) {
    const name = probes.find(name => id === join(root, `src/renderer/src/components/${name}.tsx`))
    if (!name) return
    return `import React, {useState,useEffect} from 'react';
      export function ${name}(){const [owner]=useState(()=>crypto.randomUUID());const [draft,setDraft]=useState('');const [done,setDone]=useState(false);
      useEffect(()=>{window.mounts.push(owner);return()=>window.unmounts.push(owner)},[]);
      return <div data-probe="${name}" data-owner={owner}><input value={draft} onChange={e=>setDraft(e.target.value)}/><button onClick={()=>window.finish=()=>setDone(true)}>{done?'Acknowledged':'Start delayed work'}</button></div>}`
  } }, react()],
  resolve: { dedupe: ['react', 'react-dom'], alias: { '@shared': join(root, 'src/shared'), 'react-dom': join(root, 'node_modules/react-dom'), react: join(root, 'node_modules/react') } },
  server: { hmr: false, host: '127.0.0.1', port: 0, fs: { allow: [root, temp] } }
})
try {
  await writeFile(join(temp, 'fixture.tsx'), `
import '${root}/src/renderer/src/main.css';
import '${root}/src/renderer/src/components/runs/runs.css';
import '${root}/src/renderer/src/components/DesignCapturePanel.css';
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ProjectAnalytics} from '${root}/src/renderer/src/components/ProjectAnalytics';
import {ProjectSearch as ActualProjectSearch} from '${root}/src/renderer/src/components/ProjectSearch.tsx?actual';
import {AgentsSection} from '${root}/src/renderer/src/components/runs/AgentsSection';
import {AcpSessions} from '${root}/src/renderer/src/components/runs/AcpSessions';
import {ProjectKitSettings} from '${root}/src/renderer/src/components/settings/ProjectKitSettings';
import {ProjectToolsSettings} from '${root}/src/renderer/src/components/settings/ProjectToolsSettings';
import {ComputerControlPanel as ActualComputerControlPanel} from '${root}/src/renderer/src/components/ComputerControlPanel.tsx?actual';
import {ExplorerPane as ActualExplorerPane} from '${root}/src/renderer/src/components/ExplorerPane.tsx?actual';
import {RunsPanel} from '${root}/src/renderer/src/components/RunsPanel';
import {WorkspaceShell} from '${root}/src/renderer/src/components/WorkspaceShell';
import {CreateWorktreeModal} from '${root}/src/renderer/src/components/CreateWorktreeModal';
import {MarkdownPreview} from '${root}/src/renderer/src/components/MarkdownPreview';
import {dispatchAppCommand} from '${root}/src/renderer/src/commands';
import {Workbench} from '${root}/src/renderer/src/components/Workbench';
import {RightSidebar} from '${root}/src/renderer/src/components/RightSidebar';
import {ParallelRunsSection} from '${root}/src/renderer/src/components/runs/ParallelRunsSection';
import {ScheduledRunsSection} from '${root}/src/renderer/src/components/runs/ScheduledRunsSection';
import {ProjectHandoffPanel} from '${root}/src/renderer/src/components/ProjectHandoffPanel';
import {ProjectMemoryPanel as ActualProjectMemoryPanel} from '${root}/src/renderer/src/components/ProjectMemoryPanel.tsx?actual';
import {GitPane as ActualGitPane} from '${root}/src/renderer/src/components/GitPane.tsx?actual';
import {ModalDialog} from '${root}/src/renderer/src/components/ModalDialog';
import {DiffReviewPanel} from '${root}/src/renderer/src/components/DiffReviewPanel';
import {DiffPane as ActualDiffPane} from '${root}/src/renderer/src/components/DiffPane.tsx?actual';
import {createDiffReviewSnapshot,createDiffReviewAnchor} from '${root}/src/shared/diff-review';
import {BrowserTestingPanel} from '${root}/src/renderer/src/components/BrowserTestingPanel';
import {BrowserPane} from '${root}/src/renderer/src/components/BrowserPane';
import {BrowserCommandRouter} from '${root}/src/renderer/src/browser-routing';
import {ProjectMemoryConnection} from '${root}/src/renderer/src/components/ProjectMemoryConnection';
import {ProjectKnowledgePanel} from '${root}/src/renderer/src/components/ProjectKnowledgePanel';
import {ProjectTemporalKnowledgePanel} from '${root}/src/renderer/src/components/ProjectTemporalKnowledgePanel';
import {useAppStore} from '${root}/src/renderer/src/store';
import {navigationTargetAvailable} from '${root}/src/renderer/src/navigation-controller';
import {navigationHistoryAuthority} from '${root}/src/renderer/src/navigation-history';
import {TerminalPane as ActualTerminalPane} from '${root}/src/renderer/src/components/TerminalPane.tsx?actual';
import {NativeTerminalPane} from '${root}/src/renderer/src/components/NativeTerminalPane';
import {SettingsModal} from '${root}/src/renderer/src/components/SettingsModal';
import {useAppearance} from '${root}/src/renderer/src/appearance';
function AppearanceBinding(){useAppearance(useAppStore(state=>state.settings));return null}
import {NavigationControls} from '${root}/src/renderer/src/components/NavigationControls';
window.mounts=[];window.unmounts=[];window.donwells=new Proxy({}, {get:()=>async()=>[]});
const path='/transfer-fixture';
function Shell(){const open=useAppStore(s=>s.rightSidebarOpen&&!s.runsOpen),side=useAppStore(s=>s.settings.toolPanelSide);return <WorkspaceShell leftPanel={open&&side==='left'?<RightSidebar/>:undefined}><Workbench/>{open&&side!=='left'&&<RightSidebar/>}</WorkspaceShell>}
const tick=()=>new Promise(r=>setTimeout(r,80));
const check=(value,message)=>{if(!value)throw new Error(message)};
async function checkProjectSettings(view,api) {
const button=text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text);
let toolReport={workspacePath:'/canonical-project',configuration:{referenceRoots:[],disabled:[]},revision:'folder-revision',configurationPath:path+'/tools.json',configurationValid:true,problem:null,resources:[],services:[],backups:[],availableDiskBytes:null};
api.projectDoctorInspect=async()=>toolReport;
let toolSaves=0;
api.projectDoctorConfigure=async(_path,configuration,revision)=>{check(revision===toolReport.revision,'Automatic save lost the configuration revision');toolSaves++;toolReport={...toolReport,configuration,revision:'saved-'+toolSaves};return toolReport};
api.projectToolsList=async()=>[];api.pickDirectory=async()=>'/references/chosen';
view.render(<ProjectToolsSettings/>);await tick();await tick();document.querySelector('#project-tool-documents').open=true;await tick();
const folderSection=document.querySelector('[aria-label="Reference folders"]');folderSection.querySelector('button').click();await tick();check(folderSection.querySelector('.project-folder-row')?.textContent.includes('/references/chosen'),'Native folder choice was not added');
check(toolSaves===1&&toolReport.configuration.referenceRoots[0]==='/references/chosen','Folder choice was not saved automatically');
[...folderSection.querySelectorAll('button')].find(b=>b.textContent==='Add folder…').click();await tick();check(folderSection.querySelectorAll('.project-folder-row').length===1&&toolSaves===1,'Folder picker duplicated the same root');
folderSection.querySelector('.project-folder-row button').click();await tick();check(!folderSection.querySelector('.project-folder-row')&&toolReport.configuration.referenceRoots.length===0,'Folder removal was not saved');
api.projectDoctorConfigure=async()=>{throw new Error('Controlled configuration conflict')};
[...folderSection.querySelectorAll('button')].find(b=>b.textContent==='Add folder…').click();await tick();
check(document.querySelector('[role="alert"]')?.textContent.includes('Controlled configuration conflict'),'Automatic save hid its failure');
view.render(null);await tick();view.render(<ProjectToolsSettings/>);await tick();await tick();
check(document.querySelector('.project-folder-row')?.textContent.includes('/references/chosen')&&button('Save changes'),'Failed automatic save lost the selected folder');
button('Discard changes').click();await tick();view.render(null);await tick();

let installed=[];
api.projectDoctorSetup=async(_path,field,revision)=>{check(revision===toolReport.revision,'Installation used a stale revision');installed.push(field);toolReport={...toolReport,configuration:{...toolReport.configuration,[field]:'/installed/'+field},revision:'installed-'+field};return toolReport};
api.projectDoctorConfigure=async(_path,configuration,revision)=>{check(revision===toolReport.revision,'Toggle used a stale revision');toolReport={...toolReport,configuration,revision:'enabled-revision'};return toolReport};
view.render(<ProjectToolsSettings/>);await tick();await tick();
const installButton=[...document.querySelectorAll('button')].find(button=>button.textContent.startsWith('Install Code graph'));
check(installButton,'Code graph has no single installation action');installButton.click();await tick();await tick();
check(installed.join(',')==='codeGraphBinary'&&toolReport.configuration.codeGraphBinary,'One-action setup failed to save the installed component');
const toggle=document.querySelector('#project-tool-code-graph input[type="checkbox"]');check(toggle,'Installed tool has no enable choice');toggle.click();await tick();await tick();
check(toolReport.configuration.disabled.includes('code-graph'),'Tool preference did not save automatically');
[...document.querySelectorAll('button')].find(button=>button.textContent==='Install Document retrieval').click();await tick();await tick();
check(installed.join(',')==='codeGraphBinary,qmdPackage,lancePackage','Document setup requires extra clicks or downloads optional models');
view.render(null);await tick();
toolReport={...toolReport,discoveredHistoryRoots:{historyOmpRoots:['/sessions/detected']}};
view.render(<ProjectToolsSettings/>);await tick();await tick();
const nativeFolders=document.querySelector('[aria-label="OMP session folders"]');
check(!nativeFolders.querySelector('input[type="checkbox"]').checked&&!nativeFolders.querySelector('button'),'Automatic discovery still asks the user to manage folders');
nativeFolders.querySelector('input[type="checkbox"]').click();await tick();await tick();
check(nativeFolders.textContent.includes('/sessions/detected'),'Custom override did not preserve detected folders');
nativeFolders.querySelector('.project-folder-row button').click();await tick();await tick();
check(Array.isArray(toolReport.configuration.historyOmpRoots)&&toolReport.configuration.historyOmpRoots.length===0,'Removing a detected root did not retain an explicit empty override');
nativeFolders.querySelector('input[type="checkbox"]').click();await tick();await tick();
check(toolReport.configuration.historyOmpRoots===undefined&&!nativeFolders.querySelector('button'),'Returning to automatic discovery still retains custom folder controls or an override');

view.render(null);await tick();
let kitPicker=null,kitPreviewCalls=0,kitExport=null,kitImport=null;
api.projectKitReport=async()=>null;api.listWorkspaceDirectory=async()=>({entries:[]});
api.pickProjectKitPath=async()=>kitPicker;
api.projectKitExport=async(...args)=>{kitExport=args;return {memories:0,revisions:0,artifacts:[],path:args[1]}};
api.projectKitPreview=async(selected)=>{kitPreviewCalls++;return {sourceName:'Test project',sourceProjectKey:'reviewed-source',sha256:'reviewed-sha',schemaVersion:1,memories:0,revisions:0,handoffs:0,erasedMemories:0,artifacts:[],warnings:[],tools:[]}};
api.projectKitImport=async(...args)=>{kitImport=args;return {report:null,repo:{id:'imported-fixture',path:'/restored'}}};
view.render(<ProjectKitSettings/>);await tick();await tick();
check(!document.querySelector('input:not([type="checkbox"])'),'Backup asks the user to enter file paths');
button('Export project kit…').click();await tick();check(!kitExport,'Cancelling Save exported a kit');
kitPicker='/chosen/project.donwells-kit.json';button('Export project kit…').click();await tick();await tick();
check(kitExport?.[1]===kitPicker,'Export did not use the native Save dialog result');
button('Choose project kit…').click();await tick();check(kitPreviewCalls===1&&button('Restore reviewed kit…'),'Choosing a kit did not preview it automatically');
kitPicker=null;button('Restore reviewed kit…').click();await tick();check(!kitImport,'Cancelling destination restored a project');
const openImportedBefore=useAppStore.getState().openImportedProject;useAppStore.setState({openImportedProject:async()=>{}});
kitPicker='/new/project';button('Restore reviewed kit…').click();await tick();await tick();
check(kitImport?.[1]===kitPicker&&kitImport?.[2]==='reviewed-sha'&&kitImport?.[3]==='reviewed-source','Restore lost the reviewed archive identity');
useAppStore.setState({openImportedProject:openImportedBefore});view.render(null);await tick();
api.listRepos=async()=>[];api.skillPackagesList=async()=>({packages:[],legacy:[]});
useAppStore.setState({settingsSection:'project',settingsOpen:true});
view.render(<SettingsModal open={true}/>);await tick();await tick();
check(![...document.querySelectorAll('.project-settings-group')].some(group=>group.open),'Project settings opens a wall of optional configuration');
await window.capture('project-settings-overview');
view.render(null);await tick();useAppStore.setState({settingsOpen:false});


}
if (!window.fixtureStarted) { window.fixtureStarted=true; (async()=>{try{
if (${JSON.stringify(process.argv.includes('--privacy-only'))}) {
 const api={};window.donwells=new Proxy(api,{get:(target,key)=>target[key]??(async()=>[])});
 const view=createRoot(document.getElementById('root'));
 let cleared=0,failClear=false;api.browserHistoryClear=async()=>{if(failClear)throw new Error('History file is locked');cleared++};
 useAppStore.setState({settingsOpen:true,settingsSection:'privacy',setSettings:async patch=>{useAppStore.setState(state=>({settings:{...state.settings,...patch}}));return {ok:true}}});
 view.render(<SettingsModal open={true}/>);await tick();await tick();
 check(!document.querySelector('.settings-security-card'),'Privacy still shows decorative status cards');
 document.querySelector('[aria-label="Save browsing history"]').click();await tick();
 document.querySelector('[aria-label="Allow external agent access"]').click();await tick();
 check(!useAppStore.getState().settings.recordBrowserHistory&&!useAppStore.getState().settings.externalAgentAccess,'Privacy switches did not save');
 const button=text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text);
 button('Clear browsing history…').click();await tick();check(cleared===0,'Opening clear confirmation deleted history');button('Cancel').click();await tick();check(cleared===0,'Cancelling deleted history');
 button('Clear browsing history…').click();await tick();failClear=true;button('Clear history permanently').click();await tick();check(document.querySelector('[role=alert]')?.textContent.includes('History file is locked'),'Clear failure was hidden');
 failClear=false;button('Clear history permanently').click();await tick();check(cleared===1&&document.querySelector('[role=status]')?.textContent.includes('cleared'),'Confirmed clear did not report completion');
 let siteCalls=[],failSites=true;api.browserSiteDataClear=async path=>{siteCalls.push(path);if(failSites)throw new Error('Site storage unavailable')};
 check(button('Clear cookies and site data…').disabled,'Site-data action allowed without a checkout');
 useAppStore.setState({activeWorktreePath:'/project/a'});await tick();
 button('Clear cookies and site data…').click();await tick();button('Cancel').click();await tick();check(siteCalls.length===0,'Cancel cleared site data');
 button('Clear cookies and site data…').click();await tick();useAppStore.setState({activeWorktreePath:'/project/b'});await tick();
 button('Clear site data permanently').click();await tick();check(siteCalls[0]==='/project/a'&&document.querySelector('[role=alert]')?.textContent.includes('Site storage unavailable'),'Clear lost target or hid error');
 failSites=false;button('Clear site data permanently').click();await tick();check(siteCalls.length===2&&siteCalls[1]==='/project/a'&&document.querySelector('[role=status]')?.textContent.includes('/project/a'),'Clear retry targeted another checkout');
 await window.capture('privacy-settings');view.render(null);await tick();window.report({ok:true,checks:['Working privacy preferences','Clear-history confirmation cancellation error and retry']});return;
}
if (${JSON.stringify(process.argv.includes('--terminal-only'))}) {
 const api={};window.donwells=new Proxy(api,{get:(target,key)=>target[key]??(async()=>[])});
 const view=createRoot(document.getElementById('root'));
 api.on=()=>()=>{};
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=> 'first\\nsecond'}});
 let writes=[];useAppStore.setState({settings:{...useAppStore.getState().settings,terminalRenderer:'xterm'},writeTerminal:(_id,text)=>writes.push(text),resizeTerminal:()=>{}});
 for(const bracketed of [true,false]) {
  writes=[];api.attachTerminal=async()=>({session:{exited:false},scrollback:bracketed?'\\x1b[?2004h':'',sequence:1,truncated:false});
  view.render(<div style={{width:700,height:400}}><ActualTerminalPane sessionId={'paste-'+bracketed} cols={80} rows={24} isActive={true}/></div>);await tick();await tick();await tick();
  document.querySelector('.terminal-host').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await tick();
  [...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.startsWith('Paste')).click();await tick();
  check(writes.join('')===(bracketed?'\\x1b[200~first\\rsecond\\x1b[201~':'first\\rsecond'),'Context paste bypassed terminal paste mode or newline normalization');
  view.render(null);await tick();
 }
 writes=[];api.attachTerminal=async()=>({session:{exited:true},scrollback:'',sequence:1,truncated:false});
 view.render(<div style={{width:700,height:400}}><ActualTerminalPane sessionId="paste-exited" cols={80} rows={24} isActive={true}/></div>);await tick();await tick();await tick();
 document.querySelector('.terminal-host').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await tick();
 [...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.startsWith('Paste')).click();await tick();
 check(writes.length===0&&document.querySelector('[role=alert]')?.textContent.includes('Reattach'),'Paste writes to an exited terminal');
 view.render(null);await tick();
 api.secretAvailable=async()=>true;useAppStore.setState({settingsOpen:true,settingsSection:'terminal'});
 view.render(<SettingsModal open={true}/>);await tick();await tick();
 check(document.querySelectorAll('.settings-preference-group').length===4,'Terminal settings are not grouped');
 await window.capture('terminal-settings');
 view.render(null);await tick();window.report({ok:true,checks:['Actual xterm context paste in bracketed and normal modes','Grouped terminal settings']});return;
}
if (${JSON.stringify(process.argv.includes('--project-settings-only'))}) {
  const api={};window.donwells=new Proxy(api,{get:(target,key)=>target[key]??(async()=>[])});
  useAppStore.setState({activeWorktreePath:path,activeRepoId:'fixture',repos:[{repo:{id:'fixture',path},worktrees:[{path}]}],panes:{[path]:[]}});
  const view=createRoot(document.getElementById('root'));
  await checkProjectSettings(view,api);
  window.report({ok:true,checks:['Automatic folder and preference saves','Linked-checkout draft recovery after conflict','Single-action tool installation','Native backup and reviewed restore dialogs']});return;
}
useAppStore.setState({activeWorktreePath:path,panes:{[path]:[]},rightSidebarOpen:true,rightSidebarTab:'memory',runsOpen:false});
const view=createRoot(document.getElementById('root')!);flushSync(()=>view.render(<Shell/>));await tick();
const first=document.querySelector('[data-probe="ProjectMemoryPanel"]')!;check(first,'Sidebar tool did not mount');
const owner=first.getAttribute('data-owner');const input=first.querySelector('input')!;
const defaultPanelSettings=useAppStore.getState().settings;
for(const side of ['left','right']) {
useAppStore.setState({settings:{...defaultPanelSettings,toolPanelSide:side},rightSidebarWidth:260});await tick();
const separator=document.querySelector('[aria-label="Resize workspace panel"]');
if(getComputedStyle(separator).display!=='none') {
separator.dispatchEvent(new KeyboardEvent('keydown',{key:side==='left'?'ArrowRight':'ArrowLeft',bubbles:true,cancelable:true}));await tick();
check(useAppStore.getState().rightSidebarWidth>260&&document.querySelector('.right-sidebar').dataset.side===side,'Panel resize direction does not match its side');
}
check(document.querySelector('[data-probe="ProjectMemoryPanel"]')===first,'Panel side preference replaced the tool owner');
if(side==='left') for(const projectsOpen of [false,true]) {
useAppStore.setState({sidebarOpen:projectsOpen});await tick();
check(document.querySelector('[data-sidebar-tool-slot] [data-probe="ProjectMemoryPanel"]')===first,'Combining Projects detached or remounted the retained tool');
}
}
useAppStore.setState({settings:defaultPanelSettings});await tick();

Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'unsent draft');input.dispatchEvent(new Event('input',{bubbles:true}));
first.querySelector('button')!.click();await tick();
useAppStore.getState().setRightSidebarTab('search');await tick();
check(document.querySelector('[data-sidebar-tool-slot] [data-probe="ProjectSearch"]'),'Search did not enter sidebar');
useAppStore.getState().setRightSidebarTab('memory');await tick();
check(document.querySelector('[data-sidebar-tool-slot] [data-owner="'+owner+'"]')===first,'Sidebar navigation remounted owner');
useAppStore.getState().openWorkspaceModule(path,'memory');await tick();await tick();
const dock=document.querySelector('[data-pane-kind="memory"] [data-probe="ProjectMemoryPanel"]');
check(dock===first,'Dock transfer replaced the React owner');check(input.value==='unsent draft','Dock transfer lost draft');
window.finish();await tick();check(first.querySelector('button')!.textContent==='Acknowledged','Pending work lost its owner');
check(window.mounts.filter(x=>x===owner).length===1&&!window.unmounts.includes(owner),'Transfer remounted the tool');
useAppStore.getState().hidePaneView(path,'memory:'+path);await tick();
useAppStore.getState().openWorkspaceModule(path,'memory');await tick();check(!window.unmounts.includes(owner),'Hide ended resource lifetime');
useAppStore.getState().requestClosePane(path,'memory:'+path);await tick();
check(window.unmounts.includes(owner),'Close retained resource owner');
useAppStore.getState().setRightSidebarTab('memory');await tick();
check(document.querySelector('[data-sidebar-tool-slot] [data-probe="ProjectMemoryPanel"]')?.getAttribute('data-owner')!==owner,'Reopen reused closed owner');
for (const [tab,kind,name] of [['explorer','explorer','ExplorerPane'],['git','git-status','GitPane'],['recovery','recovery','RecoveryPanel'],['search','search','ProjectSearch'],['computer','computer','ComputerControlPanel']]) {
useAppStore.getState().setRightSidebarTab(tab);await tick();
const original=document.querySelector('[data-sidebar-tool-slot] [data-probe="'+name+'"]');check(original,tab+' did not mount');
useAppStore.getState().openWorkspaceModule(path,kind);await tick();await tick();
check(document.querySelector('[data-pane-kind="'+kind+'"] [data-probe="'+name+'"]')===original,tab+' transfer replaced owner');
useAppStore.getState().requestClosePane(path,kind+':'+path);await tick();
}
useAppStore.getState().openWorkspaceModule(path,'memory');await tick();
for(const density of ['compact','comfortable']) {
document.documentElement.dataset.density=density;await tick();
const tabs=[...document.querySelectorAll('.flexlayout__tab_button')];
check(tabs.length&&tabs.every(tab=>tab.getBoundingClientRect().height<=(density==='compact'?30:34)),'Tab chrome remains oversized in '+density+': '+tabs.map(tab=>tab.getBoundingClientRect().height).join(','));
}
document.documentElement.dataset.density='compact';
const originalOpenBrowser=useAppStore.getState().openBrowser;
useAppStore.setState({settings:{...useAppStore.getState().settings,browserHomeUrl:'http://localhost:4321'}});
const layoutTrigger=document.querySelector('[aria-label="Layout"]');layoutTrigger.click();await tick();
const layoutMenu=document.querySelector('[role="menu"][aria-label="Layout"]');check(layoutMenu&&layoutMenu.contains(document.activeElement),'Layout failed to focus its controls');
layoutMenu.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));check(document.activeElement===[...layoutMenu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')].at(-1),'Layout End did not reach final available action');
layoutMenu.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));check(document.activeElement===layoutMenu.querySelector('[role="menuitem"]:not([aria-disabled="true"])'),'Layout Home did not reach first action');
check(!layoutMenu.querySelector('.workspace-browser-action'),'Browser navigation still buried in Layout');
layoutMenu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();check(!document.querySelector('[role="menu"][aria-label="Layout"]')&&document.activeElement===layoutTrigger,'Layout did not dismiss and return focus');
useAppStore.setState({repos:[{repo:{id:'fixture',path},worktrees:[{path}]}],scans:{[path]:{ports:[{port:5173,pid:1,command:'vite'}],cpuPercent:0,memMB:0}}});
await originalOpenBrowser(path);check(useAppStore.getState().panes[path].find(p=>p.kind==='browser').url==='http://localhost:5173','Browser did not discover sole preview');
await originalOpenBrowser(path,'https://example.com/docs');await originalOpenBrowser(path);check(useAppStore.getState().panes[path].find(p=>p.kind==='browser').url==='https://example.com/docs','Automatic browser opening discarded current page');
useAppStore.setState({panes:{[path]:useAppStore.getState().panes[path].filter(p=>p.kind!=='browser')},scans:{[path]:{ports:[{port:5173},{port:8888}],cpuPercent:0,memMB:0}}});
await originalOpenBrowser(path);check(useAppStore.getState().panes[path].find(p=>p.kind==='browser').url==='http://localhost:4321','Ambiguous servers did not fall back to configured home');
useAppStore.setState({panes:{[path]:[{key:'terminal:layout',kind:'terminal'}]},activePane:{[path]:'terminal:layout'}});
await useAppStore.getState().arrangeWorkspace(path,'build');
check(useAppStore.getState().panes[path].some(p=>p.kind==='browser')&&useAppStore.getState().docking[path].model.layout.children.length===2,'Build and preview required manual browser setup');


useAppStore.setState({panes:{[path]:[{key:'preview:notes.md',kind:'preview',file:'notes.md'}]},activePane:{[path]:'preview:notes.md'},previews:{[path]:{'notes.md':{path:'notes.md',content:'# Notes',bytes:7,truncated:false,revision:'r1',v:1,mode:'edit'}}}});await tick();await tick();
const previewAction=document.querySelector('button[aria-label="Read Markdown"]');check(previewAction,'Tab chrome lost Markdown preview action');previewAction.click();await tick();
check(useAppStore.getState().previews[path]['notes.md'].mode==='preview'&&document.querySelector('button[aria-label="Edit Markdown"]'),'Markdown preview action did not toggle');
const setInput=(element,value)=>{Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}))};
const button=text=>[...document.querySelectorAll('button,[role=menuitem]')].find(el=>el.textContent===text);
useAppStore.setState({repos:[{repo:{id:'fixture',path},worktrees:[{path}]}]});
const api={};window.donwells=new Proxy(api,{get:(target,key)=>target[key]??(async()=>[])});
api.on=()=>()=>{};
let tabRevealed;api.revealWorkspaceEntry=async(root,file)=>{tabRevealed=[root,file]};
const documentTab=[...document.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent.includes('notes.md'));documentTab.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:80}));await tick();
document.querySelector('[role="menu"][aria-label="Tab actions"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();
documentTab.focus();documentTab.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));await tick();
const tabMenu=document.querySelector('[role="menu"][aria-label="Tab actions"]');check(tabMenu&&tabMenu.textContent.includes('Open in Finder')&&tabMenu.textContent.includes('Open in browser'),'Document tab lacks opening actions');
[...tabMenu.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent==='Open in Finder').click();await tick();
check(tabRevealed?.join(',')===path+',notes.md'&&!document.querySelector('[role="menu"][aria-label="Tab actions"]'),'Document tab Finder action lost file ownership or menu dismissal');
api.projectDoctorInspect=async()=>({configurationValid:true,configuration:{historyBinary:'/fixture/history',disabled:[]}});
api.projectSessionHistorySearch=async()=>({hits:[{source:'session',id:'session-fixture',title:'Retained transcript',excerpt:'Search match',path:null,line:null,revision:null,indexedAt:null,stale:false}],capabilities:{}});
let pageComplete,pageFail;
api.projectSessionHistoryGet=async(_path,_id,page)=>page?new Promise((resolve,reject)=>{pageComplete=resolve;pageFail=reject}):({agent:'codex',role:'agent',projectAttribution:'fixture',source:'fixture',nativeId:'fixture',previousOrdinal:null,nextOrdinal:5,messages:[{ordinal:0,role:'user',content:'Initial transcript'}]});
useAppStore.setState({settingsOpen:false,activeWorktreePath:path,contentSearch:{query:'retained',source:'session',hidden:false,ignored:false}});
view.render(<ActualProjectSearch workspacePath={path}/>);await new Promise(resolve=>setTimeout(resolve,400));
check(document.querySelector('[aria-label="Search source"]')&&!document.querySelector('.project-search button[type="submit"]'),'Automatic search still exposes redundant submit and source buttons');
document.querySelector('.project-search-results button').click();await tick();
button('Later messages').click();await tick();check(document.querySelector('dialog [role="status"]').textContent==='Loading messages…','Transcript paging has no visible pending state');
button('Close source').click();await tick();pageComplete({previousOrdinal:0,nextOrdinal:null,messages:[{ordinal:5,role:'agent',content:'Late transcript'}]});await tick();check(!document.querySelector('dialog'),'Closed transcript was reopened by delayed paging');
document.querySelector('.project-search-results button').click();await tick();button('Later messages').click();await tick();pageFail(new Error('Paging failed'));await tick();check(document.querySelector('dialog [role="alert"]').textContent.includes('Paging failed'),'Transcript paging error is hidden behind modal');
view.render(null);await tick();useAppStore.setState({contentSearch:{query:'',source:'all',hidden:false,ignored:false}});
const analyticsCalls=[];
api.projectMemoryList=async()=>({entries:[]});
api.verificationList=async()=>[];
api.projectSessionHistoryAnalytics=async(_path,options)=>{analyticsCalls.push(options.engine);return {sessions:0,excluded:0,indexedAt:Date.now(),days:[],costs:[]}};
view.render(<ProjectAnalytics workspacePath={path}/>);await tick();
document.querySelector('.project-analytics summary').click();await tick();
check(analyticsCalls.join(',')==='sqlite','Analytics did not load on opening');
const report=document.querySelector('.project-analytics select');report.value='duckdb';report.dispatchEvent(new Event('change',{bubbles:true}));await tick();
check(analyticsCalls.join(',')==='sqlite'&&!document.querySelector('.project-analytics-result-status'),'Report change retained stale results or started expensive analysis');
button('Run selected analysis').click();await tick();check(analyticsCalls.join(',')==='sqlite,duckdb','Requested comparison did not run');
view.render(null);await tick();
api.projectTasksInspect=async()=>({tools:[],tasks:[]});
useAppStore.setState({activeRepoId:'fixture',sidebarOpen:true,agentComposerOpen:false,agents:[{id:'codex',name:'Codex',command:'codex',available:true}]});
view.render(<WorkspaceShell><AgentsSection/></WorkspaceShell>);await tick();
document.documentElement.dataset.density='comfortable';document.documentElement.dataset.navigation='labels';await tick();
const rail=document.querySelector('.workspace-rail'),browserButton=rail.querySelector('[aria-label="Browser"]');
check(!rail.querySelector('[aria-label="Runs"]'),'Vague Runs destination remains');
rail.querySelector('[aria-label="Automations"]').click();await tick();
check(useAppStore.getState().runsSection==='automations'&&rail.querySelector('[aria-label="Automations"]').getAttribute('aria-pressed')==='true','Automations did not open schedules');
rail.querySelector('[aria-label="Agents"]').click();await tick();
check(useAppStore.getState().runsSection==='agents'&&rail.querySelector('[aria-label="Automations"]').getAttribute('aria-pressed')==='false','Agents did not leave automation navigation');

const projectRows=document.querySelectorAll('.workspace-checkout-single');
check(projectRows.length>0&&!document.querySelector('.workspace-project-heading'),'Single checkout projects still have duplicate headings');
check(projectRows[0].querySelector('.workspace-checkout-line').textContent.trim()!=='Main checkout','Single checkout row lost project identity');
let revealedProject;api.revealWorkspaceEntry=async(workspace,relative)=>{revealedProject={workspace,relative}};
projectRows[0].querySelector('.workspace-checkout-actions').click();await tick();button('Open in Finder').click();await tick();check(revealedProject.workspace===path&&revealedProject.relative==='','Project Finder action lost its root target');
projectRows[0].querySelector('.workspace-checkout-actions').click();await tick();
check(document.querySelector('[role=menu]')&&!document.querySelector('[role=menu] input'),'Checkout actions are not a standard menu');
button('Remove project from app…').click();await tick();check(document.querySelector('.project-removal-modal'),'Project removal confirmation did not open from menu');button('Cancel').click();await tick();
projectRows[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await tick();button('Rename label…').click();await tick();
const checkoutLabel=document.querySelector('[aria-label="Checkout label"]');check(checkoutLabel&&document.activeElement===checkoutLabel,'Rename label did not focus its dialog');
setInput(checkoutLabel,'Renamed project');await tick();button('Save label').click();await tick();check(projectRows[0].textContent.includes('Renamed project')&&!document.querySelector('dialog'),'Renaming checkout label failed');
useAppStore.getState().renameWorkspace(path,'');await tick();

check(rail.querySelectorAll(':scope > button').length===9&&!document.querySelector('.workspace-session-list,.workspace-project-footer'),'Workspace still duplicates session navigation or permanent status chrome');
check(getComputedStyle(browserButton.querySelector('span')).display!=='none'&&browserButton.getBoundingClientRect().height>=40&&rail.getBoundingClientRect().width===128,'Labeled comfortable navigation did not render usable targets');
check(!rail.querySelector('[aria-haspopup="menu"]'),'Navigation rail still contains a miscellaneous menu');
browserButton.click();await tick();check(useAppStore.getState().panes[path].some(p=>p.kind==='browser'),'Browser navigation did not open project preview');
check(browserButton.getAttribute('aria-pressed')==='true','Active browser is not selected in navigation');
useAppStore.getState().hidePaneView(path,'browser:tab');await tick();
browserButton.click();await tick();
check(!useAppStore.getState().docking[path]?.hidden.includes('browser:tab'),'Browser navigation leaves its destination hidden');

document.documentElement.dataset.density='compact';document.documentElement.dataset.navigation='icons';await tick();
check(rail.getBoundingClientRect().width===44&&getComputedStyle(browserButton.querySelector('span')).display==='none','Compact navigation did not restore');
useAppStore.setState({runsOpen:true});await tick();check(browserButton.getAttribute('aria-pressed')==='false','Covered Browser remained selected beneath Runs');
check(!document.querySelector('.agent-launcher')&&!document.querySelector('dialog'),'Agents opens setup instead of showing sessions');
button('New agent').click();await tick();
check(document.querySelector('dialog[open] .agent-launcher'),'New agent is not a focused setup dialog');
setInput(document.querySelector('#agent-launch-command'),'codex --retained');await tick();
document.querySelector('[aria-label="Close agent setup"]').click();await tick();
check(!document.querySelector('dialog'),'Agent setup cannot close');
button('New agent').click();await tick();check(document.querySelector('#agent-launch-command').value==='codex --retained','Closing agent setup lost its draft');
view.render(null);await tick();useAppStore.setState({runsOpen:false,agentComposerOpen:false});
api.projectTasksInspect=async()=>{throw new Error('Task inspection unavailable')};
view.render(<AgentsSection/>);await tick();await tick();button('New agent').click();await tick();
check(!document.querySelector('.agent-launcher')?.textContent.includes('Agent did not start.'),'Task inspection failure is falsely presented as an agent launch failure');
check(document.querySelector('.agent-launcher')?.textContent.includes('Could not load project tasks:'),'Task inspection failure lost its contextual feedback');
api.projectTasksInspect=async()=>({tools:[],tasks:[]});button('Refresh native tasks').click();await tick();await tick();
check(!document.querySelector('.agent-launcher')?.textContent.includes('Could not load project tasks:'),'Successful task refresh retained an obsolete error');
view.render(null);await tick();
const priorRuns=useAppStore.getState().runningAgents;
const populatedRuns=Object.fromEntries(['working','waiting','permission','failed','completed'].map((activity,index)=>['audit-'+index,{id:'audit-'+index,sessionId:'audit-'+index,presetId:'codex',workspacePath:path,command:'codex',task:{intent:'Task '+index+': investigate a long project-specific workflow without losing its context',files:[]},startedAt:'2026-09-09T10:00:00Z',updatedAt:'2026-09-09T10:00:00Z',activity,liveness:['failed','completed'].includes(activity)?'exited':'live',hook:{support:'native',connected:true}}]));
useAppStore.setState({runningAgents:populatedRuns,agentComposerOpen:false,runsSection:'agents'});
view.render(<div style={{width:470,height:600}}><RunsPanel/></div>);await tick();
check(document.querySelectorAll('.agent-card').length===5&&!document.querySelector('.agent-card .btn-danger'),'Populated Agents still shows a wall of destructive buttons');
check([...document.querySelectorAll('.agent-identity strong')].every(el=>el.textContent.startsWith('Task ')),'Agent list hides task identity');
check(document.querySelector('.agent-card').scrollWidth<=document.querySelector('.agent-card').clientWidth,'Long agent tasks overflow a narrow panel');
await window.capture('agents-layout-before-check');
check(document.querySelector('.agent-totals').scrollWidth<=document.querySelector('.agent-totals').clientWidth&&document.querySelectorAll('.agent-card')[4].getBoundingClientRect().bottom<600,'Session chrome displaces the five-session list');
const sessionFilter=document.querySelector('[aria-label="Filter agent sessions"]');sessionFilter.value='history';sessionFilter.dispatchEvent(new Event('change',{bubbles:true}));await tick();check(document.querySelectorAll('.agent-card').length===2,'Finished filter includes active agents');
const sessionSearch=document.querySelector('[aria-label="Search agent sessions"]');setInput(sessionSearch,'Task 3');await tick();check(document.querySelectorAll('.agent-card').length===1&&document.querySelector('.agent-card-failed'),'Session search lost the failed task');
setInput(sessionSearch,'');sessionFilter.value='all';sessionFilter.dispatchEvent(new Event('change',{bubbles:true}));await tick();
let switchCalls=0;api.agentSwitchMode=async()=>{switchCalls++;return {state:'completed'}};
document.querySelector('.agent-card-attention .agent-identity').click();await tick();button('Switch to OpenCode chat…').click();await tick();check(switchCalls===0&&document.querySelector('#agent-switch-title'),'Switching agent stops the current owner before explaining the change');button('Keep current session').click();await tick();check(switchCalls===0,'Cancelling agent switch still changes the session');document.querySelector('.agent-card-attention .agent-identity').click();await tick();
const failedCard=document.querySelector('.agent-card-failed');failedCard.querySelector('[aria-haspopup=menu]').click();await tick();button('Dismiss history…').click();await tick();check(document.querySelector('.agent-confirm'),'Session menu bypassed history removal confirmation');button('Keep session').click();await tick();
await window.capture('populated-agent-sessions');view.render(null);await tick();useAppStore.setState({runningAgents:priorRuns});
useAppStore.setState({runsSection:'agents'});view.render(<RunsPanel/>);await tick();
check(document.querySelector('h2')?.textContent==='Agents'&&!document.querySelector('[role="tablist"]'),'Agent sessions still share automation tabs');
useAppStore.setState({runsSection:'automations'});await tick();
const automationTabs=document.querySelector('[aria-label="Automation views"]');
check(automationTabs?.textContent==='CommandsSchedules','Automation tabs are unclear');
automationTabs.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));await tick();
check(useAppStore.getState().runsSection==='orchestration'&&document.activeElement.id==='runs-tab-orchestration','Automation keyboard tabs failed');
view.render(null);await tick();
for (const mode of ['parallel','schedule']) {
let complete;let submitted;let calls=0;api[mode==='parallel'?'parallelRunStart':'scheduledRunSave']=input=>{submitted=input;calls++;return new Promise(done=>complete=done)};
view.render(mode==='parallel'?<ParallelRunsSection/>:<ScheduledRunsSection/>);await tick();
button(mode==='parallel'?'New command':'New schedule').click();await tick();
check(!document.querySelector('.op-list .op-empty'),mode+' composer displays redundant empty history');
check(document.activeElement===document.querySelector('.op-composer textarea'),mode+' composer did not receive keyboard focus');
check(document.querySelector('dialog[open] .op-composer'),mode+' setup displaces history instead of opening a dialog');
if(mode==='parallel') { check(document.querySelector('.op-target input').checked,'Current project is not selected for a new command');setInput(document.querySelector('#parallel-run-composer textarea'),'echo retained'); }
else {setInput(document.querySelector('.op-composer textarea'),'echo retained');}
await tick();document.querySelector(mode==='parallel'?'[aria-label="Close command setup"]':'[aria-label="Close schedule setup"]').click();await tick();
check(!document.querySelector('dialog[open]'),mode+' setup did not close');
view.render(null);await tick();view.render(mode==='parallel'?<ParallelRunsSection/>:<ScheduledRunsSection/>);await tick();check(!document.querySelector('dialog[open]'),mode+' navigation reopened a closed setup dialog');
if(mode==='schedule') {const registered=useAppStore.getState().repos;useAppStore.setState({repos:[]});await tick();check(!button('Resume setup').disabled,'Removing projects traps the retained schedule draft');useAppStore.setState({repos:registered});await tick();}
button(mode==='parallel'?'New command':'Resume setup').click();await tick();
check(document.querySelector('.op-composer textarea').value==='echo retained',mode+' closing setup lost the draft');
const numberField=document.querySelector('.op-composer input[type=number]');setInput(numberField,'1.5');await tick();button(mode==='parallel'?'Run on 1 target':'Save schedule').click();await tick();check(calls===0&&numberField.validity.stepMismatch,mode+' submitted a fractional execution limit');check(document.activeElement===numberField,mode+' did not focus its invalid field');setInput(numberField,mode==='parallel'?'4':'30');await tick();
await window.capture(mode+'-setup');
await tick();button(mode==='parallel'?'Run on 1 target':'Save schedule').click();await tick();check(calls===1,mode+' did not submit');check(submitted.name==='echo retained',mode+' did not derive a name from the command');
view.render(null);await tick();view.render(mode==='parallel'?<ParallelRunsSection/>:<ScheduledRunsSection/>);await tick();
check(document.querySelector('.op-composer')?.disabled,mode+' remount unlocked pending submission');
view.render(null);await tick();complete({id:'accepted',tasks:[]});await tick();
view.render(mode==='parallel'?<ParallelRunsSection/>:<ScheduledRunsSection/>);await tick();
check(!document.querySelector('.op-composer'),mode+' restored an acknowledged draft');check(calls===1,mode+' repeated submission');
view.render(null);await tick();
}


const commandHistory=[{id:'failed-command',name:'Check all projects',command:'pnpm test',status:'failed',concurrency:2,createdAt:'2026-09-09T10:00:00Z',tasks:[{id:'failed-target',status:'failed',target:{kind:'local',root:path,label:'Current project'},output:'A meaningful failure',exitCode:1}]}];
api.parallelRunsList=async()=>commandHistory;
useAppStore.setState({runsSection:'orchestration'});view.render(<div style={{width:470,height:600}}><RunsPanel/></div>);await tick();
check(document.querySelector('.op-run-card').scrollWidth<=document.querySelector('.op-run-card').clientWidth,'Command row overflows a narrow panel');
document.querySelector('.op-run-main').click();await tick();check(document.querySelector('.op-task-row').open,'Single-checkout output still needs a second expansion');
check(document.querySelector('.op-log-detail').textContent.includes('A meaningful failure'),'Command expansion lost retained output');
await window.capture('command-history-detail');
document.querySelector('.op-actions [aria-haspopup=menu]').click();await tick();button('Delete history…').click();await tick();check(document.querySelector('.op-confirm'),'Command menu bypassed deletion confirmation');button('Keep run').click();await tick();
view.render(null);await tick();api.parallelRunsList=async()=>[{...commandHistory[0],status:'unverifiable'}];view.render(<ParallelRunsSection/>);await tick();document.querySelector('.op-run-main').click();await tick();document.querySelector('.op-task-row input').click();await tick();check(button('Retry selected (1)').disabled&&button('Retry selected (1)').title.includes('verified'),'Unverifiable commands still offer a retry the backend rejects');
view.render(null);await tick();api.parallelRunsList=async()=>Array.from({length:8},(_,index)=>({...commandHistory[0],id:'command-'+index,name:'Project check '+index}));view.render(<ParallelRunsSection/>);await tick();
const commandSearch=document.querySelector('[aria-label="Search command history"]');check(commandSearch,'Large command history has no search');setInput(commandSearch,'check 7');await tick();check(document.querySelectorAll('.op-run-card').length===1,'Command search does not isolate matching history');setInput(commandSearch,'no-such-command');await tick();check(document.querySelector('[role=status]').textContent.includes('No commands match'),'Empty command search is unexplained');
view.render(null);await tick();api.parallelRunsList=async()=>[];


useAppStore.setState({sidebarOpen:true,rightSidebarOpen:true,rightSidebarTab:'memory',runsOpen:false});
document.documentElement.dataset.navigation='labels';
view.render(<div style={{display:'flex',width:1000,height:600}}><WorkspaceShell><div className="workspace-stage">Terminal surface</div><RightSidebar/></WorkspaceShell></div>);await tick();
check(getComputedStyle(document.querySelector('.workspace-stage')).display==='none','Narrow workspace still crushes the terminal beside a tool');
check(document.querySelector('.right-sidebar').getBoundingClientRect().width===document.querySelector('.workspace-surfaces').getBoundingClientRect().width,'Narrow tool does not fill available workspace');
for (const tool of ['memory','recovery','computer']) {
  const selector=document.querySelector('[aria-label="Workspace tool"]');
  selector.value=tool;selector.dispatchEvent(new Event('change',{bubbles:true}));await tick();
  check(useAppStore.getState().rightSidebarTab===tool,'Panel selector lost access to '+tool);
}

check(getComputedStyle(document.querySelector('.right-sidebar-resize')).display==='none','Full-width narrow tool exposes a meaningless splitter');
document.documentElement.dataset.navigation='icons';
const standaloneFrame=document.querySelector('.workspace-frame').parentElement;
standaloneFrame.style.width='1400px';useAppStore.setState({rightSidebarWidth:620,settings:{...defaultPanelSettings,toolPanelSide:'right'}});await tick();await tick();
check(document.querySelector('.right-sidebar').getBoundingClientRect().width===620,'Right panel remains capped at its old width');
standaloneFrame.style.width='1100px';await tick();await tick();
check(document.querySelector('.right-sidebar').getBoundingClientRect().width<=document.querySelector('.workspace-surfaces').clientWidth-320,'Right panel does not adapt to its available workspace');
check(useAppStore.getState().rightSidebarWidth===620,'Right panel resize overwrote preferred width');
standaloneFrame.style.width='1400px';await tick();await tick();check(document.querySelector('.right-sidebar').getBoundingClientRect().width===620,'Right panel preferred width did not return');
useAppStore.setState({settings:defaultPanelSettings,rightSidebarWidth:350});
view.render(<div style={{display:'flex',width:1100,height:600}}><WorkspaceShell leftPanel={<RightSidebar/>}><div className="workspace-stage">Terminal surface</div></WorkspaceShell></div>);await tick();
check(document.querySelector('.workspace-projects > .right-sidebar')&&document.querySelectorAll('.right-sidebar').length===1,'Left tools are not combined with Projects');
check(document.querySelector('.workspace-desk').getBoundingClientRect().width>700&&getComputedStyle(document.querySelector('.workspace-stage')).display!=='none','Combined sidebar did not give space back to the terminal');
const savedProjects=useAppStore.getState().repos;
check(document.querySelector('.workspace-project-scroll').getBoundingClientRect().height<120,'Short project list still reserves empty vertical space');
useAppStore.setState({repos:[...savedProjects,...Array.from({length:30},(_,i)=>({...savedProjects[0],repo:{...savedProjects[0].repo,id:'large-'+i,path:'/projects/project-'+i},worktrees:[{...savedProjects[0].worktrees[0],path:'/projects/project-'+i}]}))]});await tick();
const projectList=document.querySelector('.workspace-project-scroll'),projectPanel=document.querySelector('.workspace-projects');
const firstProjectName=document.querySelector('.workspace-checkout-open').textContent;
document.querySelector('.workspace-checkout-actions').click();await tick();button('Move down').click();await tick();
check(document.querySelector('.workspace-checkout-open').textContent!==firstProjectName,'Move down changed state without reordering visible projects');
check(projectList.scrollHeight>projectList.clientHeight,'Many projects did not scroll independently');projectList.scrollTop=projectList.scrollHeight;check(projectList.scrollTop>0,'Last project is unreachable');
const widthHandle=document.querySelector('.workspace-project-resize'),heightHandle=document.querySelector('.workspace-project-height-resize');
check(widthHandle.getBoundingClientRect().height===projectPanel.getBoundingClientRect().height,'Shared panel lacks full height width handle');
const resizeRect=widthHandle.getBoundingClientRect(),initialPanelWidth=projectPanel.getBoundingClientRect().width;await window.dragPanel([Math.round(resizeRect.left+3),Math.round(resizeRect.top+100)],[Math.round(resizeRect.left+103),Math.round(resizeRect.top+100)]);await tick();check(projectPanel.getBoundingClientRect().width>initialPanelWidth+80&&!document.querySelector('[data-native-resize]'),'Pointer resize did not complete or clear native drag state');
widthHandle.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));await tick();check(projectPanel.getBoundingClientRect().width===620,'Combined project panel cannot expand beyond old cap');
const frameParent=document.querySelector('.workspace-frame').parentElement;frameParent.style.width='800px';await tick();await tick();
check(document.querySelector('.workspace-desk').getBoundingClientRect().width>=320,'Saved wide sidebar crushed the terminal in a narrow window');
check(useAppStore.getState().sidebarWidth===620,'Window resize overwrote preferred column width');frameParent.style.width='1100px';await tick();await tick();check(projectPanel.getBoundingClientRect().width===620,'Preferred width did not return after expanding window');
const listHeight=projectList.getBoundingClientRect().height;heightHandle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await tick();check(projectList.getBoundingClientRect().height>listHeight,'Project and file split cannot resize');
document.querySelector('[aria-label="Collapse navigation"]').click();await tick();check(document.querySelector('.workspace-rail').getBoundingClientRect().width===28&&document.querySelector('.right-sidebar')&&projectList.scrollTop>0,'Collapsing rail lost panels or scroll');
document.querySelector('[aria-label="Expand navigation"]').click();await tick();check(document.querySelector('.workspace-rail').getBoundingClientRect().width===44,'Rail did not expand');
useAppStore.setState({repos:savedProjects,sidebarWidth:224,projectListPercent:35});await tick();
check(projectList.getBoundingClientRect().height<120,'Project list did not release space when projects were removed');
useAppStore.setState({sidebarOpen:false});await tick();
check(document.querySelector('.workspace-surfaces > .right-sidebar')&&!document.querySelector('.workspace-projects'),'Hiding Projects also hid its tool');
view.render(null);await tick();

const controlCalls=[];let controlMode='ready',controlRevision=1,finishObservation;
const controlSnapshot=()=>({structuredContent:{attachment:{app:'Fixture',title:'Test window',pid:1,window:2,generation:1,revision:controlRevision++,foregroundAllowed:false},elements:[{element_token:'target-'+controlRevision,label:'Field',role:'text field'}]},content:[]});
api.projectToolsList=async()=>[{id:'computer-control'}];
api.projectToolStop=async()=>({});
api.projectToolCall=async(_path,_tool,operation)=>{
controlCalls.push(operation);
if(operation==='permissions')return {structuredContent:{accessibility:true,screen_recording:true},content:[]};
if(operation==='windows')return {structuredContent:{windows:[{pid:1,window_id:2,app_name:'Fixture',title:'Test window'}]}};
if(operation==='attach')return controlSnapshot();
if(operation==='observe'){if(controlMode==='refresh-fails')throw new Error('Observation failed');if(controlMode==='delayed')return new Promise(resolve=>finishObservation=resolve);return controlSnapshot()}
if(controlMode==='input-fails')throw new Error('Input outcome uncertain');
return {content:[{type:'text',text:'Action completed'}]};
};
view.render(<div style={{width:360}}><ActualComputerControlPanel workspacePath={path}/></div>);await tick();await tick();
check(!button('Stop and release')&&!document.querySelector('fieldset'),'Unattached Control exposes irrelevant controls');
await window.capture('control-setup');
check(document.querySelector('select').value==='2','Sole window still needs manual selection');button('Attach selected window').click();await tick();
check(!document.querySelector('[aria-label="Refresh windows"]')&&!document.querySelector('input'),'Attached Control retains setup or irrelevant action fields');
await window.capture('control-attached');
const selectControlTarget=()=>{const target=document.querySelector('fieldset select');target.value=target.options[1].value;target.dispatchEvent(new Event('change',{bubbles:true}))};
selectControlTarget();await tick();button('Click').click();await tick();
check(controlCalls.slice(-2).join(',')==='click,observe'&&document.querySelector('fieldset select').options.length===2,'Successful input does not automatically refresh observation');
const actionChoice=document.querySelectorAll('fieldset select')[1];actionChoice.value='type';actionChoice.dispatchEvent(new Event('change',{bubbles:true}));await tick();
check(document.querySelectorAll('fieldset input').length===1&&!document.querySelector('input[placeholder="Meta+Enter"]'),'Control displays irrelevant action fields');setInput(document.querySelector('fieldset input'),'Keep my text');selectControlTarget();await tick();controlMode='refresh-fails';button('Type text').click();await tick();
check(document.querySelector('[role="alert"]').textContent.includes('Action completed')&&controlCalls.filter(op=>op==='type').length===1&&document.querySelector('fieldset select').options.length===1,'Refresh failure loses completed-action status or replays input');
controlMode='ready';button('Inspect').click();await tick();selectControlTarget();await tick();controlMode='input-fails';const beforeFailedInput=controlCalls.length;button('Type text').click();await tick();
check(controlCalls.slice(beforeFailedInput).join(',')==='type'&&document.querySelector('[role="alert"]').textContent.includes('uncertain'),'Uncertain input was automatically retried or observed');
controlMode='ready';button('Inspect').click();await tick();selectControlTarget();await tick();controlMode='delayed';button('Type text').click();await tick();button('Interrupt and release').click();await tick();finishObservation(controlSnapshot());await tick();
check(!document.querySelector('fieldset')&&button('Attach selected window'),'Late observation resurrected a released attachment');view.render(null);await tick();
api.projectToolsList=async()=>[];
api.listWorkspaceDirectory=async()=>({entries:[],truncated:false});
useAppStore.setState({explorer:{[path]:{directories:{'':{phase:'ready',entries:[],truncated:false}},expanded:[],selected:null,showHidden:false,includeIgnored:false}}});
view.render(<ActualExplorerPane worktreePath={path}/>);await tick();
check(!document.querySelector('.explorer-controls')&&document.querySelector('[aria-label="Collapse folders"]').disabled,'Files retains redundant filter row or meaningless collapse');
document.querySelector('[aria-label="Files display options"]').click();await tick();
check(document.querySelector('.explorer-view-options').matches(':popover-open')&&document.activeElement.type==='checkbox','Files display options failed native focus');
document.querySelector('.explorer-view-options input').click();await tick();check(useAppStore.getState().explorer[path].showHidden,'Hidden files preference did not apply');
document.querySelector('.explorer-view-options').hidePopover();
useAppStore.setState({explorer:{[path]:{...useAppStore.getState().explorer[path],directories:{'':{phase:'ready',entries:[{path:'index.html',name:'index.html',type:'file'}],truncated:false}}}}});await tick();
let revealed,previewed;api.revealWorkspaceEntry=async(root,file)=>{revealed=[root,file]};api.workspacePreviewUrl=async(root,file)=>{previewed=[root,file];return 'http://127.0.0.1:4321/index.html'};
const fileMenu=async()=>{document.querySelector('[role="treeitem"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:80}));await tick()};
await fileMenu();check(button('Open')&&button('Open in Finder')&&button('Open in browser'),'Files context menu lacks opening actions');
button('Open in Finder').click();await tick();check(revealed?.join(',')===path+',index.html','Finder action targets wrong file');
await fileMenu();button('Open in browser').click();await tick();check(previewed?.join(',')===path+',index.html'&&useAppStore.getState().panes[path].some(p=>p.kind==='browser'&&p.url==='http://127.0.0.1:4321/index.html'),'File preview does not open the built-in browser');
document.querySelector('[aria-label="New file"]').click();await tick();check(document.querySelector('#explorer-dialog-title')?.textContent==='New file','File creation icon lost its action');button('Cancel').click();await tick();view.render(null);await tick();
const files=Array.from({length:150},(_,i)=>({path:'file-'+i+'.ts',name:'file-'+i+'.ts',type:'file'}));
api.listWorkspaceDirectory=async()=>({entries:files,truncated:false});
useAppStore.setState({sidebarOpen:true,sidebarWidth:420,projectListPercent:50,explorer:{[path]:{...useAppStore.getState().explorer[path],directories:{'':{phase:'ready',entries:files,truncated:false}}}},repos:[...savedProjects,...Array.from({length:30},(_,i)=>({...savedProjects[0],repo:{...savedProjects[0].repo,id:'many-'+i,path:'/projects/many-'+i},worktrees:[{...savedProjects[0].worktrees[0],path:'/projects/many-'+i}]}))]});
view.render(<div style={{display:'flex',width:1100,height:650}}><WorkspaceShell leftPanel={<aside className="right-sidebar"><ActualExplorerPane worktreePath={path}/></aside>}><div className="workspace-stage">Terminal surface</div></WorkspaceShell></div>);await tick();
const largeTree=document.querySelector('.explorer-tree'),largeProjects=document.querySelector('.workspace-project-scroll');
check(largeTree.scrollHeight>largeTree.clientHeight&&largeProjects.scrollHeight>largeProjects.clientHeight,'Large project and file lists do not scroll independently');
largeTree.scrollTop=largeTree.scrollHeight;largeProjects.scrollTop=largeProjects.scrollHeight;
check(largeTree.scrollTop>0&&largeProjects.scrollTop>0,'Last files or projects cannot be reached');await window.capture('large-project-file-panel');
view.render(null);await tick();useAppStore.setState({repos:savedProjects,sidebarWidth:224,projectListPercent:35});
const schedule={id:'menu-schedule',name:'Daily checks',target:{kind:'local',root:path,label:'Project'},command:'echo check',schedule:{kind:'interval',minutes:30},enabled:true,createdAt:Date.now(),nextRunAt:Date.now()+60000};
let scheduleListCalls=0;api.scheduledRunsList=async()=>{scheduleListCalls++;return [{...schedule,name:scheduleListCalls>1?'Daily checks updated':'Daily checks'}]};
view.render(<ScheduledRunsSection/>);await tick();
await new Promise(resolve=>setTimeout(resolve,5200));check(document.querySelector('.op-run-copy strong').textContent==='Daily checks updated','Schedules do not refresh until a live execution is already selected');
api.scheduledRunsList=async()=>[schedule];view.render(null);await tick();view.render(<ScheduledRunsSection/>);await tick();
await window.capture('schedule-list');
const more=document.querySelector('[aria-label="More actions for Daily checks"]');check(more&&!button('Edit'),'Schedule row retains secondary Edit action');more.click();await tick();
const menu=document.querySelector('[role="menu"][aria-label="Actions for Daily checks"]');check(menu&&menu.contains(document.activeElement),'Schedule menu did not take focus');
menu.dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true,cancelable:true}));check(document.activeElement.textContent==='Duplicate paused','Schedule menu typeahead failed');
menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();check(!document.querySelector('[role="menu"]')&&document.activeElement===more,'Schedule menu failed Escape/focus return');
more.click();await tick();button('Edit schedule').click();await tick();
check(document.querySelector('.op-composer'),'Schedule menu edit did not open composer');button('Discard').click();await tick();
let scheduleEnabled=true;api.scheduledRunSetEnabled=async(id,enabled)=>{scheduleEnabled=enabled;return {...schedule,enabled}};api.scheduledRunsList=async()=>[{...schedule,enabled:scheduleEnabled}];
let staleScheduleList;api.scheduledRunsList=()=>new Promise(resolve=>{staleScheduleList=resolve});await new Promise(resolve=>setTimeout(resolve,5200));check(staleScheduleList,'Schedule list did not refresh');
more.click();await tick();button('Pause schedule').click();await tick();check(!scheduleEnabled&&document.querySelector('.op-next').textContent==='Paused','Pausing schedule did not update its visible state');staleScheduleList([schedule]);await tick();check(document.querySelector('.op-next').textContent==='Paused','Late list response reverted the acknowledged pause');api.scheduledRunsList=async()=>[{...schedule,enabled:scheduleEnabled}];
api.scheduledRunRunNow=async()=>({id:'manual-result',status:'succeeded'});api.scheduledRunHistory=async()=>[{id:'manual-result',status:'succeeded',trigger:'manual',startedAt:'2026-09-09T10:00:00Z',output:'Manual run completed',exitCode:0}];
button('Run now').click();await tick();await tick();check(document.querySelector('.op-history-row')?.open&&document.querySelector('.op-log-detail').textContent.includes('Manual run completed'),'Run now did not open the execution it started');check(document.activeElement===document.querySelector('.op-run-main'),'Run now lost keyboard focus instead of moving it to its result');check(!scheduleEnabled,'Run now unexpectedly enabled a paused schedule');
await window.capture('schedule-manual-result');view.render(null);await tick();
api.agentAcpList=async()=>[{id:'only-acp',state:'ready',permissions:[]}];
api.agentAcpObserve=async()=>({snapshot:{id:'only-acp',state:'ready',permissions:[]},requests:[],updates:[],sequence:0,truncated:false});
view.render(<AcpSessions workspacePath={path}/>);await tick();await tick();check(!document.querySelector('select')&&document.querySelector('form'),'Sole ACP session still needs manual selection');view.render(null);await tick();
await checkProjectSettings(view,api);
let rejectHandoff;api.projectHandoffCreate=()=>new Promise((_yes,no)=>rejectHandoff=no);
view.render(<ProjectHandoffPanel workspacePath={path}/>);await tick();
check(document.querySelector('form').hidden,'Handoff presents an unusable authoring form without a source');
useAppStore.setState({runningAgents:{source:{sessionId:'source',workspacePath:path,liveness:'live',command:'codex'}}});await tick();await tick();
check(document.querySelector('[aria-label="Source session"]').value==='source'&&!document.querySelector('form').hidden,'Sole handoff source was not selected automatically');
setInput([...document.querySelectorAll('label')].find(el=>el.textContent==='Goal').querySelector('input'),'Retained goal');await tick();
document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await tick();
view.render(null);await tick();view.render(<ProjectHandoffPanel workspacePath={path}/>);await tick();
check(document.querySelector('form fieldset').disabled,'Handoff remount unlocked pending save');
rejectHandoff(new Error('Controlled handoff failure'));await tick();await tick();
check(!document.querySelector('form fieldset').disabled,'Handoff remained locked after failure');
check(document.querySelector('[role="alert"]')?.textContent.includes('Controlled handoff failure'),'Handoff failure disappeared on remount');
check([...document.querySelectorAll('label')].find(el=>el.textContent==='Goal').querySelector('input').value==='Retained goal','Handoff failure lost draft');
let completeHandoff;api.projectHandoffCreate=()=>new Promise(done=>completeHandoff=done);api.projectHandoffGet=async()=>null;
document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await tick();
view.render(null);await tick();completeHandoff({id:'accepted-handoff'});await tick();await tick();
view.render(<ProjectHandoffPanel workspacePath={path}/>);await tick();
check([...document.querySelectorAll('label')].find(el=>el.textContent==='Goal').querySelector('input').value==='','Handoff restored acknowledged draft');
for (const temporal of [false,true]) {
view.render(null);await tick();
const service=temporal?'projectTemporalKnowledgeStatus':'projectKnowledgeStatus';
let inspections=0;const current={sources:[{kind:'memory',id:'retained-source',revision:1}],pendingCleanup:0,stale:false};
api.projectDoctorInspect=async()=>{inspections++;return {configurationValid:true,revision:'original-revision',configuration:{}}};
api[service]=async()=>current;
view.render(temporal?<ProjectTemporalKnowledgePanel workspacePath={path}/>:<ProjectKnowledgePanel workspacePath={path}/>);await tick();
document.querySelector('details').open=true;await tick();await tick();
const field=[...document.querySelectorAll('label')].find(el=>el.textContent===(temporal?'Model identity':'Server model (configured externally)')).querySelector('input');
setInput(field,'unsaved model');await tick();button('Remove').click();await tick();button('Refresh status').click();await tick();await tick();
check(field.value==='unsaved model','Knowledge refresh replaced configuration draft');
check(!button('Remove'),'Knowledge refresh replaced source selection');
check(inspections===1,'Status refresh replaced configuration revision');
let saveDone;api.projectDoctorConfigure=(_path,_config,revision)=>{check(revision==='original-revision','Save lost original revision');return new Promise(done=>saveDone=done)};
button('Save configuration and stop services').click();await tick();check(field.disabled,'Pending knowledge save allows draft replacement');saveDone({});await tick();await tick();
check(!field.disabled,'Completed knowledge save left input locked');
}
view.render(null);await tick();
api.gitBranches=async()=>({all:['main','topic'],current:'main'});useAppStore.setState({createOpen:true,activeRepoId:'fixture'});view.render(<CreateWorktreeModal/>);await tick();await tick();check(document.activeElement?.id==='worktree-name','Worktree dialog focused known context instead of the name');check(document.querySelector('#worktree-base').list?.options.length===2,'Worktree branch suggestions missing');button('Cancel').click();await tick();view.render(null);await tick();
const memoryEntries=Array.from({length:101},(_,i)=>({id:'memory-'+i,kind:'fact',revision:1,title:'Memory '+i,content:'Retained content',tags:[],provenance:{harness:'fixture'}}));
api.projectMemoryList=async request=>{const entries=request.query?memoryEntries.slice(0,3):memoryEntries;return {entries:entries.slice(request.offset,request.offset+request.limit),total:entries.length,hasMore:request.offset+request.limit<entries.length}};
view.render(<ActualProjectMemoryPanel workspacePath={path}/>);await tick();await tick();check(!document.querySelector('.memory-filter-options').open&&document.querySelector('.memory-panel-actions [aria-label="New memory"]'),'Memory still exposes filters before they are needed');check(document.querySelectorAll('.memory-entry-row').length===100&&button('Previous').disabled,'Memory first-page boundary incorrect');button('Next').click();await tick();await tick();check(document.querySelector('.memory-list-caption').textContent==='101–101 of 101 matching entries'&&button('Next').disabled,'Memory final page or total incorrect');setInput(document.querySelector('[aria-label="Search project memory"]'),'filter');await tick();await tick();await tick();check(document.querySelector('.memory-list-caption').textContent==='1–3 of 3 matching entries'&&!document.querySelector('[aria-label="Memory pages"]'),'Memory filtering retained old page offset');
view.render(null);await tick();
useAppStore.setState({refreshStatuses:async()=>{},statuses:{[path]:{kind:'git',entries:[],branch:'main',ahead:0,behind:0}}});
api.gitBranches=async()=>({current:'main',all:['main','review'],detached:false});
view.render(<ActualGitPane worktreePath={path}/>);await tick();await tick();
let pushed=0;api.gitPush=async()=>{pushed++};
document.querySelector('[aria-label="Source control actions"]').click();await tick();[...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent==='Push').click();await tick();check(document.querySelector('dialog')&&pushed===0,'Consolidated Push bypassed confirmation');button('Cancel').click();await tick();
const branchButton=document.querySelector('[aria-label="Switch branch"]');check(branchButton,'Branches trigger missing');check(!document.querySelector('.git-pane-header,.git-sync-actions'),'Changes still has redundant toolbars');document.querySelector('[aria-label="Source control actions"]').click();await tick();check([...document.querySelectorAll('[role="menuitem"]')].some(item=>item.textContent==='Pull (fast-forward only)'),'Remote actions missing from consolidated menu');document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();branchButton.click();await tick();
const branchName=document.querySelector('input[aria-label="New branch name"]');setInput(branchName,'retained-branch');await tick();
branchName.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();
check(!document.querySelector('.git-branch-picker')&&document.activeElement===branchButton,'Escape did not dismiss branches and restore focus');branchButton.click();await tick();
check(document.querySelector('input[aria-label="New branch name"]').value==='retained-branch','Branch dismissal discarded authored name');
view.render(null);await tick();
function Nested(){const [child,setChild]=React.useState(false);return <ModalDialog labelledBy="parent" onClose={()=>{}}><h2 id="parent">Parent</h2><button onClick={()=>setChild(true)}>Open child</button>{child&&<ModalDialog labelledBy="child" onClose={()=>setChild(false)}><h2 id="child">Child</h2><button onClick={()=>setChild(false)}>Close child</button></ModalDialog>}</ModalDialog>}
view.render(<Nested/>);await tick();button('Open child').focus();button('Open child').click();await tick();button('Close child').click();await tick();
check(document.activeElement===button('Open child'),'Nested dialog stole parent focus');
view.render(null);await tick();
api.on=()=>()=>{};
const snapshot={before:{kind:'content',lineCount:3},after:{kind:'content',lineCount:3}};
view.render(<DiffReviewPanel draftKey="escape-note" workspacePath={path} id="notes" snapshot={snapshot} selection={{side:'after',startLine:1,endLine:1}} notes={[]} runStates={{}} loading={false} saving={false} error="" editingNoteId={null} onSelectionChange={()=>{}} onCreate={async()=>true} onUpdate={async()=>true} onDelete={async()=>true} onJump={()=>{}} onEditingNoteChange={()=>{}} onAttach={()=>{}} onRetry={()=>{}} onClose={()=>{}} onSourcesChecked={()=>{}}/>);await tick();
button('Add note to selection').click();await tick();setInput(document.querySelector('.diff-review-editor textarea'),'Retained review draft');await tick();
flushSync(()=>document.querySelector('.diff-review-editor textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));await tick();check(!document.querySelector('.diff-review-editor'),'Escape did not close editor');
await new Promise(requestAnimationFrame);check(document.activeElement===button('Add note to selection'),'Note dismissal lost trigger focus: '+document.activeElement?.outerHTML);button('Add note to selection').click();await tick();check(document.querySelector('.diff-review-editor textarea').value==='Retained review draft','Escape discarded review draft');
button('Discard').click();await tick();button('Add note to selection').click();await tick();check(document.querySelector('.diff-review-editor textarea').value==='','Explicit discard retained review draft');
view.render(null);await tick();
const attachmentTarget={workspacePath:path,filePath:'attachment.txt',comparison:'working'};
const attachmentSnapshot=await createDiffReviewSnapshot({path:'attachment.txt',contents:'before'},{path:'attachment.txt',contents:'after'});
const largeNotes=['a','b'].map(id=>({id,target:attachmentTarget,snapshot:attachmentSnapshot,anchor:createDiffReviewAnchor('after',1,1,'after'),body:id+'界'.repeat(15000),revision:1,createdAt:'2026-09-08T00:00:00.000Z',updatedAt:'2026-09-08T00:00:00.000Z'}));
api.diffReviewList=async()=>({target:attachmentTarget,notes:largeNotes});api.gitStatus=async()=>({entries:[]});api.readFile=async()=>({content:'after'});api.readFileAtRef=async()=>({content:'before'});api.verificationList=async()=>[];api.agentList=async()=>[];
view.render(<ActualDiffPane worktreePath={path} relPath="attachment.txt"/>);await tick();await tick();document.querySelector('.diff-review-panel-toggle').click();await tick();button('Attach to agent…').click();await tick();
check(button('Preview attachment').disabled,'Oversized selection allowed preview without resolving the limit');
const choices=document.querySelectorAll('.diff-attachment-choices input');check(choices.length===2&&document.querySelector('.diff-attachment-choices').textContent.length<450,'Long note displaced the other selection');choices[1].click();await tick();check(!button('Preview attachment').disabled,'Reducing selection did not unblock preview');button('Preview attachment').click();await tick();
const exact=document.querySelector('textarea[aria-label="Exact attachment text"]').value;check(exact.includes(largeNotes[0].body)&&!exact.includes(largeNotes[1].body),'Preview changed selected note text or included excluded note');
button('Back to note selection').click();await tick();check(document.querySelectorAll('.diff-attachment-choices input:checked').length===1,'Returning to selection lost the chosen subset');button('Cancel').click();await tick();check(document.querySelectorAll('.diff-review-note').length===2,'Selection deleted saved notes');
view.render(null);await tick();
let browserListener;const browserOps=[];const guestState={id:901,url:'http://localhost:4321',title:'Fixture page',loading:false,back:false,forward:false,zoom:1};
api.onBrowserView=listener=>{browserListener=listener;return()=>{browserListener=undefined}};
api.browserHistoryList=async()=>[];api.browserHistoryRecord=async()=>[];
api.browserView=async request=>{browserOps.push(request);if(request.op==='create')return guestState;if(request.op==='snapshot')return {url:guestState.url,title:guestState.title,text:'Fixture page'};if(request.op==='navigate'){guestState.url=request.url;queueMicrotask(()=>{for(const type of ['dom-ready','did-finish-load'])browserListener?.({key:path,instance:request.instance,type,event:{},state:guestState})})}};
const browserRouter=new BrowserCommandRouter({activeKey:()=>path,hasPane:()=>true,openPane:async()=>{}});
view.render(<BrowserPane worktreePath={path} url={guestState.url} router={browserRouter} active={true}/>);await tick();await tick();
for(const density of ['compact','comfortable']){document.documentElement.dataset.density=density;await tick();const toolbar=document.querySelector('[role="toolbar"]');check(toolbar.querySelectorAll(':scope button').length===5&&toolbar.getBoundingClientRect().height<=38,'Browser toolbar remains busy or too tall in '+density+': '+toolbar.getBoundingClientRect().height+'px')}
document.querySelector('[aria-label="Browser tools"]').click();await tick();
const browserTools=document.querySelector('[role="menu"][aria-label="Browser tools"]');check(browserTools&&browserTools.textContent.includes('Inspect page design')&&browserTools.textContent.includes('Browser testing'),'Browser tools lost secondary actions');
[...browserTools.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent==='Zoom in').click();await tick();check(browserOps.some(op=>op.op==='zoom'&&op.factor===1.1),'Zoom menu did not control the browser');
document.querySelector('[aria-label="Browser tools"]').click();await tick();document.querySelector('[role="menu"][aria-label="Browser tools"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();check(!document.querySelector('[role="menu"][aria-label="Browser tools"]'),'Browser tools did not dismiss with Escape');
view.render(null);await tick();document.documentElement.dataset.density='compact';
api.projectToolsList=async()=>[{id:'browser-testing',status:'ready'}];
let completeRuns;api.verificationList=()=>new Promise(done=>completeRuns=done);
api.projectToolCall=async()=>({content:[{text:'context'},{text:'stale observation'}],structuredContent:{id:'test',previewOrigin:'http://localhost',previewUrl:'http://localhost',revision:1,artifacts:[{path:'capture',sha256:'test'}]}});
api.projectToolStop=async()=>undefined;
view.render(<BrowserTestingPanel workspacePath={path} onClose={()=>{}}/>);await tick();check(!button('Screenshot')&&!document.querySelector('.browser-testing-dialog fieldset'),'Browser testing exposes actions before a context exists');button('Open preview in testing context').click();await tick();button('Cancel and stop testing browser').click();await tick();completeRuns([]);await tick();
check(document.querySelector('pre').textContent.includes('stopped'),'Late evidence refresh overwrote stopped browser state');
api.projectToolCall=async(_path,_tool,operation)=>({content:[{text:'context'},{text:operation==='snapshot'?'button Save [ref=e1]':'Page opened'}],structuredContent:{id:'test',previewOrigin:'http://localhost',previewUrl:'http://localhost',currentUrl:'http://localhost',outcome:'observed',revision:2,artifacts:[]}});
button('Open preview in testing context').click();await tick();check(!!button('Inspect')&&!document.querySelector('.browser-testing-dialog fieldset'),'Browser inputs appear without observed elements');
button('Inspect').click();await tick();check(document.querySelector('.browser-testing-dialog fieldset select option[value="e1"]')?.textContent==='button Save','Observed browser element is not directly selectable');

view.render(null);await tick();
useAppStore.setState({activeRepoId:'fixture',activeWorktreePath:path,runsOpen:false,settingsOpen:false,paletteOpen:false,panes:{[path]:[]},previews:{[path]:{}}});
function MediaFocus(){const key=useAppStore(s=>s.activePane[path]);return <div data-pane-key={key} tabIndex={-1}><div className="media-pdf-stage" tabIndex={0}>PDF keyboard surface</div></div>}
view.render(<MediaFocus/>);await tick();await useAppStore.getState().openPreview(path,'keyboard.pdf');await tick();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
check(document.activeElement===document.querySelector('.media-pdf-stage'),'Opening a media file did not focus its keyboard surface');
await useAppStore.getState().openPreview(path,'another.pdf');await tick();check(navigationTargetAvailable({repoId:'fixture',worktreePath:path,kind:'file',paneKey:'preview:keyboard.pdf',file:'keyboard.pdf'}),'Replacing preview removed retained file from history');
view.render(null);await tick();
api.listAgents=async()=>['omp','kimi','hermes','deepseek-harness'].map(id=>({id,name:id,command:id,available:true}));api.meta=async()=>({userDataDir:'/profile',memoryMcp:{command:'donwells',args:[],env:{}}});
for(const provider of ['omp','kimi','hermes','deepseek-harness']){
let launched,closed=false;useAppStore.setState({settingsOpen:true,runAgent:async(_path,command)=>{launched=command;return {ok:true}}});
api.agentConfigureMemory=async(_path,id)=>{check(id===provider,'Setup used wrong harness');return {path:'config',changed:true,...(id==='hermes'?{setupArgs:['mcp','add','memory']}:id==='deepseek-harness'?{launchArgs:['--patch','/workspace/memory.patch.json']}: {})}};
view.render(<ProjectMemoryConnection workspacePath={path} onClose={()=>{closed=true}}/>);await tick();
const select=document.querySelector('dialog select');select.value=provider;select.dispatchEvent(new Event('change',{bubbles:true}));await tick();button(provider==='hermes'?'Open Hermes memory setup':'Connect project memory').click();await tick();
if(provider==='deepseek-harness'){check(!document.querySelector('dialog').textContent.includes('New sessions will load it'),'Patch falsely reported automatic session setup');button('Start session with project memory').click();await tick();check(launched.args[0]==='--patch'&&closed&&!useAppStore.getState().settingsOpen,'DeepSeek launch lost memory patch');}
else if(provider==='hermes')check(launched.args[0]==='mcp'&&closed&&!useAppStore.getState().settingsOpen,'Hermes did not open native setup');
else check(document.querySelector('dialog').textContent.includes('New sessions will load it'),'Saved native setup not acknowledged');
view.render(null);await tick();}
for(const provider of ['codex','claude']) {
let launched,closed=false;api.listAgents=async()=>[{id:provider,name:provider,command:provider,available:true}];
api.agentConfigureMemory=async(_path,id)=>({path:'session',changed:false,launchArgs:id==='codex'?['-c','memory-fixture']:['--mcp-config','{}']});
useAppStore.setState({settingsOpen:true,runAgent:async(_path,command)=>{launched=command;return {ok:true}}});
view.render(<ProjectMemoryConnection workspacePath={path} onClose={()=>{closed=true}}/>);await tick();
check(document.querySelector('dialog select').value===provider,'Memory setup ignored available supported harness');check(document.querySelector('dialog').getBoundingClientRect().width<=480,'Connection dialog inherits oversized editor width');await window.capture('memory-'+provider);button('Start with project memory').click();await tick();
check(launched.args[0]===(provider==='codex'?'-c':'--mcp-config')&&closed&&!useAppStore.getState().settingsOpen,'Session memory setup still requires manual configuration');view.render(null);await tick();
}
useAppStore.setState({settingsOpen:false});
api.secretAvailable=async()=>true;
const settingsBefore=useAppStore.getState().settings, setSettingsBefore=useAppStore.getState().setSettings;
api.applyAppearance=async()=>{};
useAppStore.setState({settingsOpen:true,settingsSection:'appearance',setSettings:async patch=>{useAppStore.setState(state=>({settings:{...state.settings,...patch}}));return {ok:true}}});
view.render(<><AppearanceBinding/><SettingsModal open={true}/></>);await tick();
check(document.querySelectorAll('.settings-preference-group').length===3,'Appearance controls are not grouped by purpose');
const fontChoice=document.querySelector('select[aria-label="Interface font"]');fontChoice.value='1';fontChoice.dispatchEvent(new Event('change',{bubbles:true}));await tick();
check(getComputedStyle(document.body).fontFamily.startsWith('system-ui'),'Interface font selection did not reach the rendered UI');
const motionChoice=document.querySelector('select[aria-label="Interface motion"]');motionChoice.value='1';motionChoice.dispatchEvent(new Event('change',{bubbles:true}));await tick();
check(getComputedStyle(document.querySelector('.settings-close')).transitionDuration==='0s','Reduced motion did not stop interface transitions');
for(const theme of ['dark','light']){useAppStore.setState(state=>({settings:{...state.settings,theme}}));await tick();await window.capture('appearance-'+theme)}
button('Editor typography').click();await tick();check(useAppStore.getState().settingsSection==='editor','Editor typography link did not open editor settings');
useAppStore.setState({settingsSection:'appearance'});await tick();
const themeSelect=document.querySelector('select[aria-label="Theme"]');check(themeSelect&&!document.querySelector('.settings-appearance-card'),'Appearance retains competing theme cards');
themeSelect.value='1';themeSelect.dispatchEvent(new Event('change',{bubbles:true}));await tick();check(useAppStore.getState().settings.theme!==settingsBefore.theme||themeSelect.options[1].textContent.toLowerCase()===settingsBefore.theme,'Theme selector disconnected');
useAppStore.setState({settingsSection:'agents'});await tick();
const agentSetting=document.querySelector('select[aria-label="Default agent command"]');check(agentSetting?.options.length>1&&!document.querySelector('.settings-agent-suggestions'),'Installed agents still occupy a button grid');
agentSetting.value='';agentSetting.dispatchEvent(new Event('change',{bubbles:true}));await tick();check(!document.querySelector('[data-setting-key=agentCommand] [data-settings-dirty=true]'),'Opening custom command falsely dirtied settings');setInput(document.querySelector('input[aria-label="Custom agent command"]'),'custom-agent --flag');await tick();check(document.querySelector('[data-setting-key=agentCommand] [data-settings-dirty=true]'),'Custom agent command lost draft protection');button('Discard').click();await tick();
agentSetting.value=agentSetting.options[0].value;agentSetting.dispatchEvent(new Event('change',{bubbles:true}));await tick();check(useAppStore.getState().settings.agentCommand===agentSetting.options[0].value&&!document.querySelector('[data-setting-key=agentCommand] [data-settings-dirty=true]'),'Installed agent choice did not save automatically');
useAppStore.setState({settingsSection:'terminal'});await tick();
check(document.querySelector('select[aria-label="Terminal palette"]')&&!document.querySelector('.settings-theme-card'),'Terminal palette still uses a card grid');
view.render(null);await tick();useAppStore.setState({settingsOpen:false,settings:settingsBefore,setSettings:setSettingsBefore});
const nativeRequests=[];api.onNativeTerminal=()=>()=>{};api.nativeTerminal=async request=>{nativeRequests.push(request.op);if(request.op==='bounds')window.lastNativeBounds=request.rect;return {truncated:request.op==='create'}};
view.render(<div style={{display:'flex',width:320,height:240}}><NativeTerminalPane sessionId="notice-test" isActive={true}/></div>);await tick();
check(window.lastNativeBounds&&window.lastNativeBounds.width>0,'Native visibility fixture was not visible before opening dialog');
const dragMarker=document.createElement('div');document.body.append(dragMarker);dragMarker.dataset.nativeResize='';await tick();check(window.lastNativeBounds===null,'Native surface captures a panel resize drag');delete dragMarker.dataset.nativeResize;await tick();check(window.lastNativeBounds?.width>0,'Native surface did not return after resize');dragMarker.remove();
const priorFrame=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
const overlay=document.createElement('dialog');overlay.style.cssText='position:fixed;inset:0;width:100vw;height:100vh';document.body.append(overlay);overlay.showModal();await tick();
check(window.lastNativeBounds===null,'Native overlay hiding depends on animation frames');overlay.close();overlay.remove();window.requestAnimationFrame=priorFrame;
const notice=document.querySelector('.terminal-history-notice');check(notice&&notice.getBoundingClientRect().height<=40,'History warning still covers the terminal with a card');
check(document.querySelector('.native-terminal-host').getBoundingClientRect().top>=notice.getBoundingClientRect().bottom,'History notice obscures terminal output');
notice.querySelector('summary').click();await tick();check(notice.querySelector('details').open&&notice.textContent.includes('Retained output'),'History explanation cannot be expanded');
notice.querySelector('[aria-label="Request redraw"]').click();await tick();check(nativeRequests.includes('redraw'),'Compact redraw action disconnected');
notice.querySelector('[aria-label="Dismiss notice"]').click();await tick();check(!document.querySelector('.terminal-history-notice'),'History notice cannot be dismissed');view.render(null);await tick();
navigationHistoryAuthority.completeRestore(undefined,()=>true);
navigationHistoryAuthority.record({repoId:'fixture',worktreePath:path,kind:'file',paneKey:'preview:keyboard.pdf',file:'keyboard.pdf'});
view.render(<div style={{position:'fixed',right:0,top:0,height:32,overflow:'hidden'}}><NavigationControls/></div>);await tick();
check(document.querySelector('.navigation-controls').querySelectorAll(':scope > button').length===1,'Workspace history still occupies multiple toolbar controls');
const recentTrigger=document.querySelector('[aria-label="Recent locations"]');check(!recentTrigger.disabled,'Recent history fixture unavailable');recentTrigger.click();await tick();
const recentMenu=document.querySelector('.navigation-recent-menu');check(recentMenu.matches(':popover-open'),'Recent menu remains clipped inside tab bar');
const bounds=recentMenu.getBoundingClientRect();check(bounds.left>=0&&bounds.right<=innerWidth&&bounds.bottom<=innerHeight,'Recent menu escaped viewport');
recentMenu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();check(!recentMenu.matches(':popover-open')&&document.activeElement===recentTrigger,'Recent Escape lost focus');
recentTrigger.click();await tick();check(recentMenu.matches(':popover-open'),'Recent menu failed to reopen');recentTrigger.click();await tick();check(!recentMenu.matches(':popover-open'),'Recent trigger failed to toggle closed');
view.render(<><button className="icon-btn design-capture-close" id="capture-close-size"><svg width="11" height="11"/></button><div className="browser-design-error"><button className="icon-btn" id="browser-error-size"><svg width="11" height="11"/></button></div><button id="secondary-size" className="btn btn-secondary btn-sm">Secondary</button><button id="ghost-size" className="btn btn-ghost btn-sm">Ghost</button><div className="media-toolbar"><div className="media-toolbar-group"><button className="media-tool-button">Fit width</button></div></div><div className="settings-state">No saved items</div><div className="computer-control-panel" style={{width:260}}><fieldset><legend>Observed element</legend><label>Target<select className="settings-select"><option>Very long window title from a real application with long path</option></select></label><label>Text<input className="input"/></label><button className="btn btn-sm">Click</button></fieldset></div></>);await tick();
for(const id of ['capture-close-size','browser-error-size']){const button=document.getElementById(id);check(button.getBoundingClientRect().width===28&&button.getBoundingClientRect().height===28&&button.querySelector('svg').getBoundingClientRect().width===14,'Local control override broke icon scale: '+id)}
const ghost=document.querySelector('#ghost-size'),secondary=document.querySelector('#secondary-size');
check(ghost.getBoundingClientRect().height===secondary.getBoundingClientRect().height&&getComputedStyle(ghost).fontSize===getComputedStyle(secondary).fontSize,'Ghost button breaks shared small-control scale');
check(document.querySelector('.media-tool-button').getBoundingClientRect().height>=28&&parseFloat(getComputedStyle(document.querySelector('.media-tool-button')).fontSize)>=12,'Media controls remain undersized');
check(document.querySelector('.settings-state').getBoundingClientRect().height<120,'Nested empty state retains excessive reserved space');
const controls=document.querySelector('.computer-control-panel');check(controls.scrollWidth<=controls.clientWidth,'Control form overflows narrow panel');
view.render(<div style={{display:'flex',width:700}}><div style={{flex:'0 0 224px'}}/><section className="runs-panel operational-runs"><div className="runs-body op-runs-body"><ParallelRunsSection/></div></section></div>);await tick();button('New command').click();await tick();
const runForm=document.querySelector('.op-composer'),runSurface=document.querySelector('.runs-panel');check(runSurface.getBoundingClientRect().width<=476&&runForm.getBoundingClientRect().right<=runSurface.getBoundingClientRect().right,'Run composer overflows narrow workspace');

view.render(null);await tick();
useAppStore.setState({activeWorktreePath:path,activeRepoId:'fixture',repos:[{repo:{id:'fixture',path},worktrees:[{path}]}],runsOpen:false,previews:{[path]:{'reader.md':{content:'# Reader\\n\\nA **formatted** phrase and another formatted phrase.\\n\\n## Links\\n\\n[Beginning](#reader)\\n\\n## End\\n\\nFinal paragraph.',mode:'preview',v:0}}},panes:{[path]:[{key:'preview:reader.md',kind:'preview',file:'reader.md'}]},activePane:{[path]:'preview:reader.md'}});
view.render(<MarkdownPreview worktreePath={path} relPath="reader.md"/>);await tick();await tick();
check(document.querySelector('article h1')&&!document.querySelector('.editor-host'),'Markdown reading mounted source editor');
dispatchAppCommand('find');await tick();
const documentFind=document.querySelector('[aria-label="Find in document"] input');
check(documentFind&&document.activeElement===documentFind,'Document Find did not open and focus');
setInput(documentFind,'formatted phrase');await tick();
check(document.querySelector('.md-find [role="status"]').textContent==='1 of 2','Find missed text across inline Markdown formatting');
document.querySelector('[aria-label="Next match"]').click();await tick();
check(document.querySelector('.md-find [role="status"]').textContent==='2 of 2','Find next did not advance');
setInput(documentFind,'missing');await tick();check(document.querySelector('.md-find [role="status"]').textContent==='No matches','Find missing text had no feedback');
documentFind.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();
check(!document.querySelector('.md-find')&&document.activeElement===document.querySelector('.md-scroll'),'Find Escape did not return to reading');
view.render(null);await tick();

window.report({ok:true,checks:['Compact browser toolbar and secondary menu controls','Compact and comfortable tab heights','File and document-tab opening menus','Control automatic observation, contextual actions and interruption','Native folder selection and deduplication','Sole ACP session automatic selection','Scheduled menu keyboard focus and typeahead','Files compact toolbar and display popover','Tool panel side and resize direction','Narrow workspace uses full panel width','Worktree name focus and discovered branches','Memory pagination and filtered totals','Combined Projects and left tools, independent hide, direct navigation and panel selection','Attachment byte boundary, compact choices, exact subset and retained Back selection','Transcript paging cancellation and visible errors','Report selection clears stale results and preserves explicit comparison','Agent setup dialogs preserve drafts, searchable session filters, and compact details','Capture and browser-error shared icon scale','Layout keyboard focus and automatic browser targeting','Recent top-layer placement and keyboard dismissal','consistent button scale','readable media controls','compact Settings state','narrow Control form','replaced preview remains navigable','six native memory setup paths','media opening focus','nested dialog focus','review Escape retention and explicit discard','browser Stop supersedes late refresh','sidebar navigation','draft retention','same dock owner','pending completion','hide retention','close disposal','fresh reopen','all six tool transfers','Markdown tab action','parallel delayed completion','schedule delayed completion','handoff failure after remount','handoff acknowledged draft clearing','knowledge refresh preserves drafts and selections','knowledge save freezes submitted values','branch Escape and draft retention']});
}catch(error){window.report({ok:false,error:String(error),stack:error.stack})}})(); }`)
  await server.listen()
  await writeFile(join(temp, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('dragPanel',(from,to)=>ipcRenderer.invoke('drag-panel',from,to));contextBridge.exposeInMainWorld('report',value=>ipcRenderer.send('report',value));contextBridge.exposeInMainWorld('capture',name=>ipcRenderer.invoke('capture',name));`)
  await writeFile(join(temp, 'main.cjs'), `const {app,BrowserWindow,ipcMain}=require('electron');const {writeFileSync}=require('node:fs');app.setPath('userData',${JSON.stringify(join(temp, 'profile'))});
    const timer=setTimeout(()=>{console.error('Transfer test timed out');app.exit(1)},120000);
    ipcMain.once('report',(_event,result)=>{console.log(JSON.stringify(result));clearTimeout(timer);app.exit(result.ok?0:1)});
    app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,preload:${JSON.stringify(join(temp, 'preload.cjs'))}}});ipcMain.handle('drag-panel',async(_event,from,to)=>{const wc=win.webContents;wc.sendInputEvent({type:'mouseDown',x:from[0],y:from[1],button:'left',clickCount:1});await new Promise(r=>setTimeout(r,50));wc.sendInputEvent({type:'mouseMove',x:to[0],y:to[1],modifiers:['leftButtonDown']});await new Promise(r=>setTimeout(r,50));wc.sendInputEvent({type:'mouseUp',x:to[0],y:to[1],button:'left',clickCount:1})});ipcMain.handle('capture',async(_event,name)=>{const dir=${JSON.stringify(captureDir ?? '')};if(!dir)return;if(!/^[a-z-]+$/.test(name))throw new Error('Invalid capture name');writeFileSync(require('node:path').join(dir,name+'.png'),(await win.webContents.capturePage()).toPNG())});win.webContents.on('console-message',(_e,_level,message)=>console.error(message));win.loadURL(${JSON.stringify(server.resolvedUrls.local[0]+'__tool-transfer')})});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [join(temp, 'main.cjs')], { env, stdio: 'inherit' })
  const code = await new Promise((yes, no) => { child.once('exit', yes); child.once('error', no) })
  if (code !== 0) throw new Error(`Transfer regression failed: ${code}`)
} finally { await server.close(); await rm(temp, { recursive: true, force: true }) }
