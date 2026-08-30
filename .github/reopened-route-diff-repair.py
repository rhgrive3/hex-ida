from pathlib import Path
import re


def read(path): return Path(path).read_text()
def write(path, text): Path(path).write_text(text)
def replace(path, old, new, count=1):
    text=read(path)
    if old not in text: raise SystemExit(f'missing pattern in {path}: {old[:180]!r}')
    write(path,text.replace(old,new,count))

def replace_section(path, start, end, transform):
    text=read(path); a=text.index(start); b=text.index(end,a); section=text[a:b]; next_section=transform(section); write(path,text[:a]+next_section+text[b:])

# #2623: child scopes clean parent listeners on replacement/completion teardown.
replace('js/ui/router.js',
"""export function createChildTaskScope(parentSignal) {
  let currentController = null;
  return {
    get signal() {
      return currentController?.signal ?? null;
    },
    spawn(reason = 'new-task-started') {
      currentController?.abort(reason);
      currentController = new AbortController();
      if (parentSignal) {
        if (parentSignal.aborted) {
          currentController.abort(parentSignal.reason);
        } else {
          const onParentAbort = () => {
            currentController?.abort(parentSignal.reason);
          };
          parentSignal.addEventListener('abort', onParentAbort, { once: true });
        }
      }
      return currentController.signal;
    },
    abort(reason = 'task-scope-aborted') {
      currentController?.abort(reason);
      currentController = null;
    },
  };
}""",
"""export function createChildTaskScope(parentSignal) {
  let currentController = null;
  let removeParentAbort = null;
  const detachParent = () => { removeParentAbort?.(); removeParentAbort = null; };
  return {
    get signal() { return currentController?.signal ?? null; },
    spawn(reason = 'new-task-started') {
      currentController?.abort(reason);
      detachParent();
      const controller = currentController = new AbortController();
      if (parentSignal) {
        if (parentSignal.aborted) controller.abort(parentSignal.reason);
        else {
          const onParentAbort = () => controller.abort(parentSignal.reason);
          parentSignal.addEventListener('abort', onParentAbort, { once:true });
          removeParentAbort = () => parentSignal.removeEventListener('abort', onParentAbort);
        }
      }
      return controller.signal;
    },
    abort(reason = 'task-scope-aborted') {
      currentController?.abort(reason);
      currentController = null;
      detachParent();
    },
  };
}""")

# Product consumes the router-owned lifecycle instead of manufacturing a separate
# parent controller per screen.
replace('js/ui/product.js', "import { ProductRouter } from './router.js';", "import { ProductRouter, createChildTaskScope } from './router.js';")
replace('js/ui/product.js', "function renderExplorer(app, router, route) {", "function renderExplorer(app, router, route, routeContext = {}) {")
replace('js/ui/product.js',
"""  let timer = 0;
  let queryController = null;
  let querySerial = 0;""",
"""  let timer = 0;
  let querySerial = 0;
  const fallbackRouteController = routeContext.signal ? null : new AbortController();
  const routeSignal = routeContext.signal || fallbackRouteController.signal;
  const queryScope = createChildTaskScope(routeSignal);""")
replace('js/ui/product.js',
"""    queryController?.abort();
    const controller = new AbortController();
    queryController = controller;
    const serial = ++querySerial;
    const current = () => !disposed && !controller.signal.aborted && serial === querySerial;""",
"""    const signal = queryScope.spawn('explorer-query-replaced');
    const serial = ++querySerial;
    const current = () => !disposed && !routeSignal.aborted && !signal.aborted && serial === querySerial;""")
# Only inside Explorer, migrate query calls to the child scope.
def explorer_transform(section):
    section=section.replace('controller.signal','signal')
    section=section.replace("dispose: () => { disposed = true; queryController?.abort(); clearTimeout(timer); virtual?.dispose(); },",
                            "dispose: () => { disposed = true; queryScope.abort('explorer-disposed'); fallbackRouteController?.abort('explorer-disposed'); clearTimeout(timer); virtual?.dispose(); },")
    return section
replace_section('js/ui/product.js','function renderExplorer(app, router, route, routeContext = {}) {','\nfunction codeViewState(app)',explorer_transform)

replace('js/ui/product.js', "function renderFunctionWorkspace(app, router, route) {", "function renderFunctionWorkspace(app, router, route, routeContext = {}) {")
# Replace the screen-private parent controller with the router signal; retain a
# fallback only for direct/non-router test invocation.
replace('js/ui/product.js',
"""  const routeController = new AbortController();
  const routeSignal = routeController.signal;""",
"""  const fallbackRouteController = routeContext.signal ? null : new AbortController();
  const routeSignal = routeContext.signal || fallbackRouteController.signal;""")
replace('js/ui/product.js',
"""  return { root: s.root, getState: () => ({ scrollTop: s.body.scrollTop }), restoreState: (state) => { if (state) s.body.scrollTop = Number(state.scrollTop) || 0; }, dispose: () => { disposed = true; routeController.abort(); } };""",
"""  return { root: s.root, getState: () => ({ scrollTop: s.body.scrollTop }), restoreState: (state) => { if (state) s.body.scrollTop = Number(state.scrollTop) || 0; }, dispose: () => { disposed = true; fallbackRouteController?.abort('function-workspace-disposed'); } };""")

# Runtime nested task uses the common child-scope helper; route abort reaches it
# structurally without per-click listener plumbing.
replace('js/ui/product.js',
"""  const renderRuntimeTab = () => {
    let activeRunController = null;""",
"""  const renderRuntimeTab = () => {
    const runScope = createChildTaskScope(routeSignal);""")
replace('js/ui/product.js',
"""      activeRunController?.abort();
      activeRunController = new AbortController();
      const runSignal = activeRunController.signal;
      const onRouteAbort = () => activeRunController?.abort();
      routeSignal.addEventListener('abort', onRouteAbort, { once: true });""",
"""      const runSignal = runScope.spawn('runtime-run-replaced');""")
replace('js/ui/product.js', "        routeSignal.removeEventListener('abort', onRouteAbort);\n        if (!disposed) run.disabled = false;", "        if (!disposed && !routeSignal.aborted) run.disabled = false;")

# #2598 + #2623: /diff owns a route child task, forwards signal to baseline
# loading and matcher, and refuses late publication after route leave.
replace('js/ui/product.js', "function renderDiff(app,router) {", "function renderDiff(app,router,routeContext = {}) {")
replace('js/ui/product.js',
"""  const host=h('div','ui-stack');s.body.append(host);
  if(!app.store.get('fileInfo'))""",
"""  const host=h('div','ui-stack');s.body.append(host);
  const fallbackRouteController=routeContext.signal?null:new AbortController();
  const routeSignal=routeContext.signal||fallbackRouteController.signal;
  const compareScope=createChildTaskScope(routeSignal);
  if(!app.store.get('fileInfo'))""")
replace('js/ui/product.js',
"""    const file=await pickOneFile();if(!file)return;host.replaceChildren(loadingState(text('比較元を解析しています…','Analysing baseline…')));
    try{await app.loadDiffBaseline(file);await app.runBinaryDiff();router.navigate('/diff',{replace:true});}
    catch(error){host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}""",
"""    const file=await pickOneFile();if(!file||routeSignal.aborted)return;
    const signal=compareScope.spawn('diff-baseline-replaced');
    host.replaceChildren(loadingState(text('比較元を解析しています…','Analysing baseline…')));
    try{
      await app.workspace.loadBaseline(file,{signal});
      await app.workspace.diff({signal});
      if(!signal.aborted&&!routeSignal.aborted)router.navigate('/diff',{replace:true});
    } catch(error){if(!signal.aborted&&!routeSignal.aborted)host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}""")
replace('js/ui/product.js',
"""  if(baseline)controls.append(uiButton(text('再比較','Compare again'),{onClick:async()=>{host.replaceChildren(loadingState(text('比較しています…','Comparing…')));try{await app.runBinaryDiff();router.navigate('/diff',{replace:true});}catch(error){host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}}}));""",
"""  if(baseline)controls.append(uiButton(text('再比較','Compare again'),{onClick:async()=>{
    const signal=compareScope.spawn('diff-rerun-replaced');
    host.replaceChildren(loadingState(text('比較しています…','Comparing…')));
    try{await app.workspace.diff({signal});if(!signal.aborted&&!routeSignal.aborted)router.navigate('/diff',{replace:true});}
    catch(error){if(!signal.aborted&&!routeSignal.aborted)host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}
  }}));""")
# Diff view itself owns cleanup; do not leave a worker after navigating away.
replace('js/ui/product.js', "  return {root:s.root};\n}\n\nfunction renderAdvanced(app) {", "  return {root:s.root,dispose:()=>{compareScope.abort('diff-route-disposed');fallbackRouteController?.abort('diff-route-disposed');}};\n}\n\nfunction renderAdvanced(app) {")

# Route context is now a first-class first-party renderer input.
replace('js/ui/product.js', "    onRoute: (route) => {", "    onRoute: (route, routeContext = {}) => {")
replace('js/ui/product.js', "if (route.route.id === 'investigate') view = renderInvestigate(app, router);", "if (route.route.id === 'investigate') view = renderInvestigate(app, router, routeContext);")
replace('js/ui/product.js', "else if (route.route.id === 'explorer') view = renderExplorer(app, router, route);", "else if (route.route.id === 'explorer') view = renderExplorer(app, router, route, routeContext);")
replace('js/ui/product.js', "else if (route.route.id === 'function') view = renderFunctionWorkspace(app, router, route);", "else if (route.route.id === 'function') view = renderFunctionWorkspace(app, router, route, routeContext);")
replace('js/ui/product.js', "else if (route.route.id === 'diff') view = renderDiff(app, router);", "else if (route.route.id === 'diff') view = renderDiff(app, router, routeContext);")
replace('js/ui/product.js', "else view = renderSecondaryRoute(app, router, route);", "else view = renderSecondaryRoute(app, router, route, routeContext);")

# #2598 worker boundary. Abort terminates the worker immediately; matcher budgets
# and 350k inputs are unchanged.
Path('js/diff/runtime.js').write_text(r'''let sequence = 1;
function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason == null ? 'Binary diff cancelled' : String(signal.reason));
  error.name='AbortError'; error.code='ABORT_ERR'; return error;
}
function cloneOptions(options) {
  const matchBudget={...(options.matchBudget||{})}; delete matchBudget.signal;
  return { mode:options.mode||'fast', threshold:options.threshold, matchBudget };
}
export function runDiffInWorker(before, after, options = {}) {
  const signal=options.signal??null;
  if(signal?.aborted)return Promise.reject(abortError(signal));
  const workerFactory=options.workerFactory||(()=>new Worker(new URL('./worker.js',import.meta.url),{type:'module'}));
  const worker=workerFactory(); const id=sequence++;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',onAbort);try{worker.terminate();}catch{}fn(value);};
    const onAbort=()=>finish(reject,abortError(signal));
    signal?.addEventListener('abort',onAbort,{once:true});
    worker.onmessage=(event)=>{const msg=event.data||{};if(msg.id!==id)return;if(msg.ok)finish(resolve,msg.result);else{const error=new Error(msg.error?.message||'Binary diff worker failed');error.name=msg.error?.name||'Error';if(msg.error?.code)error.code=msg.error.code;finish(reject,error);}};
    worker.onerror=(event)=>finish(reject,event?.error||new Error(event?.message||'Binary diff worker failed'));
    worker.onmessageerror=(event)=>finish(reject,event?.error||new Error('Binary diff worker message failed'));
    try{worker.postMessage({t:'diff',id,before,after,options:cloneOptions(options)});}catch(error){finish(reject,error);}
  });
}
''')
Path('js/diff/worker.js').write_text(r'''import { diffFunctions } from './index.js';
self.onmessage=(event)=>{
  const msg=event.data||{};if(msg.t!=='diff'||msg.id==null)return;
  try{const result=diffFunctions(msg.before||[],msg.after||[],msg.options||{});self.postMessage({id:msg.id,ok:true,result});}
  catch(error){self.postMessage({id:msg.id,ok:false,error:{name:error?.name||'Error',code:error?.code||null,message:error?.message||String(error)}});}
};
''')
replace('js/workspace.js', "import { diffFunctions } from './diff/index.js';", "import { runDiffInWorker } from './diff/runtime.js';")
# local cancellation helper
replace('js/workspace.js', "function staleWorkspaceError(){const error=new Error('workspace-binding-changed');error.code='HEX_WORKSPACE_STALE';return error;}", "function staleWorkspaceError(){const error=new Error('workspace-binding-changed');error.code='HEX_WORKSPACE_STALE';return error;}\nfunction throwIfAborted(signal){if(!signal?.aborted)return;if(signal.reason instanceof Error)throw signal.reason;const error=new Error(signal.reason==null?'Operation aborted':String(signal.reason));error.name='AbortError';error.code='ABORT_ERR';throw error;}")
replace('js/workspace.js', "  async loadBaseline(file,{backend=null}={}){", "  async loadBaseline(file,{backend=null,signal=null}={}){")
replace('js/workspace.js',
"""    const ownedBackend=!backend, other=backend||this.backendFactory();
    try{
      const info=await other.open(file);assertCurrent();""",
"""    const ownedBackend=!backend, other=backend||this.backendFactory();
    const onAbort=()=>{if(ownedBackend)other?.dispose?.();};
    if(signal?.aborted)throwIfAborted(signal);
    signal?.addEventListener('abort',onAbort,{once:true});
    try{
      const info=await other.open(file);throwIfAborted(signal);assertCurrent();""")
replace('js/workspace.js', "      const hash=await other.ensureContentHash();assertCurrent();\n      const result=await other.analyze(sliceIndex);assertCurrent();", "      const hash=await other.ensureContentHash(null,signal);throwIfAborted(signal);assertCurrent();\n      const result=await other.analyze(sliceIndex,{signal});throwIfAborted(signal);assertCurrent();")
replace('js/workspace.js', "    }catch(error){if(ownedBackend)other?.dispose?.();throw error;}\n  }\n  async diff(options={}){", "    }catch(error){if(ownedBackend)other?.dispose?.();throw error;}\n    finally{signal?.removeEventListener('abort',onAbort);}\n  }\n  async diff(options={}){")
replace('js/workspace.js',
"""      try{await this.app.ensureRecognition?.({maxFunctions:MAX_DIFF_FUNCTIONS,knowledgeLimit:0});}catch{/* symbol fallback remains valid */}
      assertCurrent();
      const current=currentDiffFunctions(this.app), before=baseline.functions;
      const result=diffFunctions(before,current,{mode:'fast',signal:options.signal,threshold:options.threshold??0.62,matchBudget:options.matchBudget||{maxCandidateEvaluations:1500000,maxEdges:300000,maxComponentNodes:4096,maxComponentEdges:65536}});""",
"""      throwIfAborted(options.signal);
      try{await this.app.ensureRecognition?.({maxFunctions:MAX_DIFF_FUNCTIONS,knowledgeLimit:0,signal:options.signal});}catch(error){if(options.signal?.aborted)throwIfAborted(options.signal);/* symbol fallback remains valid */}
      throwIfAborted(options.signal);assertCurrent();
      const current=currentDiffFunctions(this.app), before=baseline.functions;
      const result=await runDiffInWorker(before,current,{mode:'fast',signal:options.signal,threshold:options.threshold??0.62,matchBudget:options.matchBudget||{maxCandidateEvaluations:1500000,maxEdges:300000,maxComponentNodes:4096,maxComponentEdges:65536}});""")

Path('tests/reopened-route-diff-contracts.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createChildTaskScope } from '../js/ui/router.js';
import { runDiffInWorker } from '../js/diff/runtime.js';

// Common child scope: replacement and parent abort are structural.
const parent=new AbortController();const scope=createChildTaskScope(parent.signal);
const first=scope.spawn();const second=scope.spawn();assert.equal(first.aborted,true);assert.equal(second.aborted,false);parent.abort('route-left');assert.equal(second.aborted,true);

// Worker boundary preserves full inputs/options and abort terminates worker.
let posted=null,terminated=0;
class FakeWorker{postMessage(m){posted=m;queueMicrotask(()=>this.onmessage?.({data:{id:m.id,ok:true,result:{changes:[],truncated:false}}}));}terminate(){terminated++;}}
const before=Array.from({length:32},(_,i)=>({address:BigInt(i),name:`a${i}`}));
const after=Array.from({length:32},(_,i)=>({address:BigInt(i+100),name:`b${i}`}));
const result=await runDiffInWorker(before,after,{threshold:0.62,matchBudget:{maxCandidateEvaluations:1500000,maxEdges:300000,maxComponentNodes:4096,maxComponentEdges:65536},workerFactory:()=>new FakeWorker()});
assert.equal(result.truncated,false);assert.equal(posted.before.length,32);assert.equal(posted.after.length,32);assert.equal(posted.options.threshold,0.62);assert.equal(posted.options.matchBudget.maxCandidateEvaluations,1500000);assert.equal(terminated,1);
let abortTerminated=0;class HangingWorker{postMessage(){}terminate(){abortTerminated++;}}
const abortController=new AbortController();const pending=runDiffInWorker(before,after,{signal:abortController.signal,workerFactory:()=>new HangingWorker()});abortController.abort('navigate-away');await assert.rejects(pending,(e)=>e?.name==='AbortError'||e?.code==='ABORT_ERR');assert.equal(abortTerminated,1);

const product=fs.readFileSync(new URL('../js/ui/product.js',import.meta.url),'utf8');
const workspace=fs.readFileSync(new URL('../js/workspace.js',import.meta.url),'utf8');
assert.match(product,/onRoute: \(route, routeContext = \{\}\) =>/);
assert.match(product,/renderExplorer\(app, router, route, routeContext\)/);
assert.match(product,/renderFunctionWorkspace\(app, router, route, routeContext\)/);
assert.match(product,/renderDiff\(app, router, routeContext\)/);
assert.match(product,/app\.workspace\.loadBaseline\(file,\{signal\}\)/);
assert.match(product,/app\.workspace\.diff\(\{signal\}\)/);
assert.doesNotMatch(product,/const routeController = new AbortController\(\)/);
assert.match(workspace,/await runDiffInWorker\(before,current/);
assert.doesNotMatch(workspace,/const result=diffFunctions\(/);
assert.match(workspace,/maxCandidateEvaluations:1500000/);
assert.match(workspace,/MAX_DIFF_FUNCTIONS=350000/);
console.log('reopened route/diff contracts: ok');
''')
