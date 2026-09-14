import assert from 'node:assert/strict';
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
