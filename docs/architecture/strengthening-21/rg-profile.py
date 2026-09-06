import tempfile,pathlib,subprocess,time,json,shutil,hashlib
root=pathlib.Path(tempfile.mkdtemp(prefix='donwells21-rg-profile-')); report={'samples':{},'method':'native rg first match; interleaved thread counts; same deterministic 100k fixture; uncontrolled user workloads'}
try:
 subprocess.run(['git','init','-q',str(root)],check=True);seed=16161
 for g in range(100):
  d=root/f'group-{g}';d.mkdir();(d/'.gitignore').write_text('*.ignored.txt\n')
  for f in range(1000):
   seed=(seed*1664525+1013904223)&0xffffffff
   name=f'{f}.ts' if f<700 else f'{f}.ignored.txt' if f<800 else f'.hidden-{f}.txt' if f<900 else f'{f}.bin'
   content=f'{chr(0) if f>=900 else "/"} fixture {seed}\nscopedneedle {g}:{f}\n'+('rareonlyneedle\n' if g==73 and f==619 else '')
   (d/name).write_text(content.ljust(1024,'x'))
 for n in range(20):
  for threads in [0,1,4,8]:
   start=time.perf_counter();first=None
   p=subprocess.Popen(['/opt/homebrew/bin/rg','--no-config','--json','--line-buffered','--fixed-strings','--line-number','--color','never','--no-follow','--glob','!.git','--threads',str(threads),'--','rareonlyneedle','.'],cwd=root,stdout=subprocess.PIPE)
   for line in p.stdout:
    if json.loads(line).get('type')=='match' and first is None:first=(time.perf_counter()-start)*1000
   assert p.wait()==0 and first is not None
   report['samples'].setdefault(str(threads),[]).append(first)
  print('round',n+1,flush=True)
finally:
 shutil.rmtree(root);report['cleaned']=True
 for t,v in report['samples'].items():report.setdefault('stats',{})[t]={'median':sorted(v)[len(v)//2],'p95':sorted(v)[int(len(v)*.95)-1]}
 pathlib.Path('/tmp/donwells21-rg-profile.json').write_text(json.dumps(report,indent=2))
