/** Same current-source cases in Node and a browser; not a device/CI certificate. */
import * as S from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { identity, scalarFixture } from '../taint/fixtures.mjs';
import { machineIR } from '../memory/main-fixtures.mjs';
import { createTaintFlow } from '../../../js/symbolic/taint/flow.js';
import { runAnalysisBrowserCases as prior } from './hardening-cases.mjs';
const check = (value, reason) => { if (!value) throw new Error(reason); };
export async function runAnalysisBrowserCases() {
  const cases = await prior();
  async function run(name, action) { const started=performance.now(),metrics=await action();cases.push({name,status:'PASS',milliseconds:performance.now()-started,metrics}); }
  await run('async-proof-submission-is-immutable',async()=>{
    const E=S.expr,x=E.createFreshSymbol(E.bvSort(3),'browser-async'),zero=E.createBv(3,0n);
    const condition=E.createCompare('eq',x,zero),preconditions=[condition],original=new AbortController();
    const request={candidateId:'browser-review',beforeValueId:'b',afterValueId:'a',before:x,after:zero,identity,preconditions,signal:original.signal,memoryObservables:[],effectObservables:[]};
    const pending=S.verifyDeobfuscationCandidate(request);preconditions.length=0;request.signal=new AbortController().signal;
    const result=await pending;check(result.eligible,result.reason);
    check(!S.isAdoptableCandidate(result),'lost proof precondition');
    check(S.isAdoptableCandidate(result,{preconditions:[condition]}),'submitted scope was not retained');
    original.abort();check(!S.isAdoptableCandidate(result,{preconditions:[condition]}),'cancellation signal was replaced');
    return {verdict:result.verdict};
  });
  await run('memory-invalidation-is-irreversible',()=>{
    const memory=S.createByteMemory({identity});memory.store(0n,1,42n);memory.barrier('unknown-call');memory.barrier('');
    const result=memory.load(0n,1);check(result.status==='unknown'&&!result.expression,'barrier was erased');return memory.metrics();
  });
  await run('literal-payload-is-bound-to-snapshot',()=>{
    const ir=scalarFixture(),inst=ir.blocks[0].insts[0];inst.op=OP.CONST;inst.args=[];inst.extra={value:37n};
    const result=S.symbolicExecute(ir,{captureValues:true,byteMemory:{identity}});check(result.status==='complete',result.reason);
    check(result.paths[0].returnValue.value===37n,'constant metadata ignored');inst.extra.value=38n;
    const translated=S.translate.translateSemanticIR(inst,{ir,identity,executionSnapshot:result.paths[0].snapshot});
    check(translated.status==='unsupported','stale constant remained exact');return result.metrics;
  });
  await run('missing-data-flow-is-top-not-clean',()=>{
    const models=S.createTaintModels({id:'browser-missing',version:'1',provenance:'review',sinks:[{id:'sink',valueId:'out'}]});
    const flow=createTaintFlow({identity,models});flow.value('out',[undefined],'data');const result=flow.solve();
    check(result.sinks[0].taint.kind==='top','missing dependency became clean');return flow.metrics();
  });
  await run('machine-division-policy-reaches-production-execution',()=>{
    const ir=machineIR(['udiv w0, w1, w2','ret']),inst=ir.instructions.find(i=>i.sub==='udiv');
    const result=S.symbolicExecute(ir,{captureValues:true,symbolicArgs:{x1:4n,x2:0n},byteMemory:{identity}});
    check(result.status==='complete',result.reason);
    const translated=S.translate.translateSemanticIR(inst,{ir,identity,executionSnapshot:result.paths[0].snapshot});
    check(translated.expression?.value===0n,'declared division policy was dropped');return result.metrics;
  });
  return cases;
}
