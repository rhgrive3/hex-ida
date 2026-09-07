import test from 'node:test';
import assert from 'node:assert/strict';
import * as symbolic from '../../../js/symbolic/index.js';
import {OP} from '../../../js/ir-base.js';
import {identity,scalarFixture,integrationFixture} from './fixtures.mjs';
const models=()=>symbolic.createTaintModels({id:'analysis',version:'1',provenance:'owned:test',sources:[{id:'input',valueId:'input'}],sinks:[{id:'out',valueId:'out'}]});
function fixture() {
 const ir=scalarFixture(),inst=ir.blocks[0].insts[0];inst.op=OP.BIN;inst.sub='xor';inst.args.push(inst.args[0]);
 return {ir,target:inst.dst};
}
const run=({ir,target}=fixture(),extra={})=>symbolic.querySymbolicAnalysis(ir,{identity,models:models(),memory:{addressBits:8},targets:[target],...extra});
test('one public query executes taint, translates actual IR, verifies candidates, and projects evidence',async()=>{
 const {ir,target}=fixture();const r=await run({ir,target});
 assert.equal(r.status,'complete',r.reason);assert.equal(r.targets.length,1);
 const c=r.targets[0].candidates.find(c=>c.rule==='xor-self');assert.ok(c);
 assert.equal(c.eligible,true,c.verification.reason);assert.equal(symbolic.isAdoptableCandidate(c.verification),true);
 assert.ok(r.taint.evidence);assert.deepEqual(r.taint.sinks[0].taint.sources,['input']);
 assert.equal(r.scope,'analysis-and-pure-candidates');assert.equal(r.irMutated,false);
 assert.ok(symbolic.isSymbolicAnalysisResult(r));
});
test('source -> symbolic memory -> sink evidence and a separate pure proof share the production query',async()=>{
 const ir=integrationFixture(),ptr=ir.blocks[0].insts[0].addr.base;
 const target={id:'pure-pointer',bits:8};const xor={id:'pure-xor',op:OP.BIN,sub:'xor',dst:target,args:[{value:ptr},{value:ptr}],row:0,address:0n};target.def=xor;
 ir.blocks[0].insts.unshift(xor);ir.instructions.unshift(xor);
 const r=await run({ir,target},{memory:{addressBits:8,wrapping:'modular'},models:symbolic.createTaintModels({id:'path',version:'1',provenance:'test',sources:[{id:'p',valueId:'ptr'},{id:'b',valueId:'byte'}],sinks:[{id:'s',valueId:'final'}]})});
 assert.equal(r.status,'complete',r.reason);assert.deepEqual(r.taint.sinks[0].taint.sources,['b','p']);
 assert.ok(r.targets[0].candidates.some(c=>c.eligible));
});
test('a caller clone of the target is not an issued IR target',async()=>{
 const f=fixture();const r=await run(f,{targets:[{...f.target}]});
 assert.equal(r.status,'partial');assert.deepEqual(r.targets,[]);
 assert.equal(r.reason,'target-not-bound-to-execution');
});
test('memory-derived targets do not acquire an ordinary pure-expression adoption receipt',async()=>{
 const ir=integrationFixture(),target=ir.blocks[0].insts[2].dst;
 const r=await run({ir,target},{memory:{addressBits:8,wrapping:'modular'}});
 assert.equal(r.status,'partial');assert.deepEqual(r.targets,[]);
 assert.equal(r.reason,'non-pure-target-handoff');
});
test('IR or model changes revoke the combined result and its proof consumer eligibility',async()=>{
 const f=fixture();let currentModel;const m=models();currentModel=m.modelIdentity;
 const r=await run(f,{models:m,getCurrentModelIdentity:()=>currentModel});
 const c=r.targets[0].candidates.find(c=>c.eligible);assert.ok(c);
 currentModel='changed';assert.equal(symbolic.isSymbolicAnalysisResult(r),false);assert.equal(symbolic.isAdoptableCandidate(c.verification),false);
 const second=await run(f);f.target.def.sub='or';assert.equal(symbolic.isSymbolicAnalysisResult(second),false);
 assert.equal(symbolic.isAdoptableCandidate(second.targets[0].candidates[0].verification),false);
});
test('late cancellation and target budget overflow publish neither earlier proof nor taint evidence',async()=>{
 const ac=new AbortController();const promise=run(fixture(),{signal:ac.signal});ac.abort();
 const r=await promise;assert.equal(r.status,'partial');assert.equal(r.taint,null);assert.deepEqual(r.targets,[]);
 const limit=await run(fixture(),{analysisLimits:{targets:0}});assert.equal(limit.status,'partial');assert.deepEqual(limit.targets,[]);
});
test('stale derived constants are not used by the static translator to prove the wrong SSA expression',async()=>{
 const f=fixture();f.target.const=99n;
 const r=await run(f);assert.equal(r.status,'partial');assert.deepEqual(r.targets,[]);
 assert.equal(r.reason,'derived-constant-translation-handoff');
});
test('legacy opcode identity and mixed-width casts reach the proof consumer unchanged',async()=>{
 const f=fixture(),input=f.target.def.args[0].value;
 input.bits=4;
 const cast={id:'cast',bits:8};
 const castInst={id:'cast-inst',op:OP.UN,sub:'zext',dst:cast,args:[{value:input}],row:0,address:0n};cast.def=castInst;
 f.ir.blocks[0].insts.unshift(castInst);f.ir.instructions.unshift(castInst);
 f.target.def.args=[{value:cast},{value:cast}];
 const r=await run(f);assert.equal(r.status,'complete',r.reason);
 const expression=r.targets[0].expression;
 assert.equal(expression.op,'xor');assert.equal(expression.left.op,'zext');assert.equal(expression.left.arg.sort.width,4);
 assert.equal(r.targets[0].candidates.find(c=>c.rule==='xor-self')?.eligible,true);
 for(let n=0;n<16;n++) assert.equal(symbolic.expr.evaluateExpr(expression,{arg_x0:BigInt(n)}).value,0n);
});
test('execution argument specialization is not laundered into a universal pure proof',async()=>{
 const f=fixture();f.target.def.sub='add';
 const r=await run(f,{execution:{symbolicArgs:{0:3n}}});
 assert.equal(r.status,'complete',r.reason);
 assert.equal(r.targets[0].expression.kind,'binary');assert.equal(r.targets[0].expression.op,'add');
 assert.equal(symbolic.expr.evaluateExpr(r.targets[0].expression,{arg_x0:9n}).value,18n);
 assert.equal(r.targets[0].candidates[0].eligible,true);
});
test('combined queries refuse unbound path, conditional and memory-effect scopes',async()=>{
 for(const extra of [{executionSnapshot:{}},{preconditions:[symbolic.expr.createBool(false)]},{memoryObservables:[{id:'memory'}]},{effectObservables:[{id:'call'}]}]) {
  const r=await run(fixture(),extra);assert.equal(r.status,'partial');assert.equal(r.taint,null);assert.deepEqual(r.targets,[]);
 }
});
