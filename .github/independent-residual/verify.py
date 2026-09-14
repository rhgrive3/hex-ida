from pathlib import Path
import subprocess, os, json, time, signal, hashlib, sys
out=Path(os.environ['RUNNER_TEMP'])/'residual-evidence'
out.mkdir(exist_ok=True)
report={'schema':1,'expectedTree':'e415c7371bc17508c2460394642880209d2bf7d5','results':[],'complete':False}
def git(*args):
 return subprocess.check_output(['git',*args],text=True,timeout=30).strip()
def save():
 (out/'result.json').write_text(json.dumps(report,indent=2)+'\n')
def run(name,command,limit):
 start=time.monotonic();log=out/(name+'.log')
 with log.open('wb') as f:
  child=subprocess.Popen(command,stdout=f,stderr=subprocess.STDOUT,start_new_session=True,env={**os.environ,'CI':'true'})
  try: code=child.wait(timeout=limit);timed_out=False
  except subprocess.TimeoutExpired:
   os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5);code=124;timed_out=True
 item={'name':name,'command':command,'exit':code,'timeout':timed_out,'seconds':round(time.monotonic()-start,3)}
 if code:
  with log.open('rb') as f:
   f.seek(max(0,log.stat().st_size-12000));tail=f.read(12000).decode(errors='replace')
  lines=tail.splitlines()
  failure=next((i for i,line in enumerate(lines) if 'not ok' in line or 'AssertionError' in line or 'Error:' in line),max(0,len(lines)-6))
  item['firstFailureExcerpt']='\n'.join(lines[failure:failure+14])[:2000]
 report['results'].append(item);save()
 if code:raise RuntimeError(name+' failed; see small result.json')
 print(name+': PASS',flush=True)
 return log
try:
 report['sourceSha']=git('rev-parse','HEAD')
 report['sourceTree']=git('rev-parse','HEAD^{tree}')
 report['parents']=git('show','-s','--format=%P','HEAD').split()
 assert report['sourceTree']==report['expectedTree']
 assert report['parents']==['8d6c91824eee2fb81fdf1fcc71df2d5a0b133d3a','b4fec5df31e8dbb9d803aa3ba5ffc20d49280d44']
 assert not git('diff','--name-only','HEAD')
 report['node']=subprocess.check_output(['node','--version'],text=True,timeout=10).strip()
 report['esbuild']=json.loads(Path('node_modules/esbuild/package.json').read_text())['version']
 assert report['esbuild']=='0.28.2'
 save()
 run('lint',['npm','run','lint'],60)
 run('boundaries',['npm','run','module-boundaries:test'],60)
 run('evidence-contracts',['npm','run','evidence-writers:test'],60)
 run('core',['npm','run','core:test'],180)
 run('phase4',['node','tests/phase4/run.mjs'],180)
 run('architecture',['node','tests/issues-454-455-script-architecture.mjs'],45)
 run('binary',['npm','run','binary:test'],120)
 run('semantic',['npm','run','semantic:test'],120)
 generated=['userscript/hex.user.template.js','userscript/release-version.json','js/userscript/deployment-identity.generated.js']
 def hashes():return {p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in generated}
 run('build-one',['npm','run','userscript:build'],180);first=hashes()
 run('build-two',['npm','run','userscript:build'],180);second=hashes()
 assert first==second,'builds disagree'
 report['generatedHashes']=second;report['twoBuildsEqual']=True;save()
 run('userscript-chain',['npm','run','userscript:test'],480)
 assert hashes()==second,'userscript chain changed canonical projection'
 changed=git('diff','--name-only','HEAD').splitlines()
 assert set(changed)<=set(generated),changed
 assert git('write-tree')==report['expectedTree'],'index changed after validation'
 run('publish-candidate',['git','push','origin','HEAD:refs/heads/verify/independent-residual-candidate-20260914'],60)
 report['candidateBranch']='verify/independent-residual-candidate-20260914'
 report['complete']=True;report['generatedNotCommitted']=True
except BaseException as error:
 report['error']=str(error)[:2000]
 save();raise
finally:
 save()
 with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as f:
  f.write('## Residual repair exact-tree result\n```json\n'+json.dumps(report,indent=2)+'\n```\n')
