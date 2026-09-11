import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeEscape, invalidatesNonEscapeProof } from '../../../js/analysis/summary/escape.js';

const local = (rootKey) => ({ top:false, targets:[{rootKey, rootKind:'rooted'}] });
function fixture(extra = [], options = {}) {
  const pointsToRun = {status:{completeness:'complete'}, pointsTo:new Map(['A','B','C','D','F'].map(id => [id,local(id)]))};
  pointsToRun.pointsTo.set('G', {top:false, targets:[{rootKey:'global',rootKind:'absolute'}]});
  const ir = {nodes:[{id:'observe',kind:'state-read',inputs:['A','B','C','D','F']}, ...extra]};
  return analyzeEscape(ir, {}, {}, pointsToRun, {allocationRootKeys:new Set(['A','B','C','D','F']),...options});
}
const store = (id, destination, value) => ({id,kind:'store',inputs:[destination,value],memory:{addressExpr:{valueId:destination}},origin:{instructionIds:[id]}});
const call = (id, args, inputs = [], targets = [], complete = true) => ({id,kind:'call',inputs,call:{arguments:args,targetValueIds:targets,completeness:complete?'complete':'partial'}});
const rootFacts = (run, id) => run.escapes.filter(r => r.rootKey === id);

test('#6146 a later stronger reason reaches already-escaped descendants', () => {
  const nodes=[store('ab','A','B'),store('bc','B','C'),store('publish','G','A'),call('known',['B'])];
  const result=fixture(nodes);
  assert.deepEqual(rootFacts(result,'C').map(x=>x.reason).sort(), ['passed-to-known-call','stored-to-global']);
  assert.ok(rootFacts(result,'C').some(invalidatesNonEscapeProof));
  assert.deepEqual(fixture([...nodes].reverse()).escapes,result.escapes);
});
test('#6146 cycles, diamonds and duplicate facts converge with all provenance', () => {
  const links=[store('ab','A','B'),store('ac','A','C'),store('bd','B','D'),store('cd','C','D'),store('da','D','A')];
  const result=fixture([...links,store('publish','G','A'),call('known',['B','B']),call('other',['C'])]);
  for(const id of ['A','B','C','D']) {
    const facts=rootFacts(result,id);
    assert.equal(facts.length,3);
    assert.deepEqual(facts.map(f=>f.siteId).sort(),['known','other','publish']);
    assert.deepEqual(facts.find(f=>f.siteId==='publish').evidenceIds,['publish']);
  }
  assert.deepEqual(fixture([...links].reverse().concat(call('other',['C']),call('known',['B']),store('publish','G','A'))).escapes,result.escapes);
});
test('#6146 same site and reason retain independently supplied evidence', () => {
  const result=fixture([store('ab','A','B')],{captureProviders:[()=>[
    {rootKey:'A',rootOrigin:'local-allocation',reason:'published-to-thread',boundary:'thread',siteId:'s',evidenceIds:['e1']},
    {rootKey:'A',rootOrigin:'local-allocation',reason:'published-to-thread',boundary:'thread',siteId:'s',evidenceIds:['e2']},
  ]]});
  assert.deepEqual(rootFacts(result,'B').map(r=>r.evidenceIds).sort(),[['e1'],['e2']]);
});
for(const generator of [false,true]) test(`#6212 cancellation inside a ${generator?'capture iterator':'provider'} never publishes a proof`,()=>{
  const controller=new AbortController(); let later=0;
  const cancel=()=>{controller.abort('capture-cancelled');};
  const first=generator ? function*(){cancel();yield {rootKey:'A',reason:'returned',boundary:'return'};} : ()=>{cancel();return [];};
  const result=fixture([],{signal:controller.signal,captureProviders:[first,()=>{later++;return [];} ]});
  assert.equal(result.status.completeness,'partial');assert.equal(result.status.stopReason,'cancelled');
  assert.equal(result.nonEscapingRoots.size,0);assert.deepEqual(result.escapes,[]);assert.equal(later,0);
});
test('#6212 pre-abort, successful capture and complete control',()=>{
  const controller=new AbortController();controller.abort();
  assert.equal(fixture([],{signal:controller.signal}).status.stopReason,'cancelled');
  assert.equal(fixture().status.completeness,'complete');
  assert.equal(fixture().nonEscapingRoots.size,5);
});
for(const complete of [true,false]) test(`#3814 call target is not an argument (${complete?'known':'unknown'})`,()=>{
  const result=fixture([call('c',[{valueId:'A'}],['F'],['F'],complete)]);
  assert.equal(rootFacts(result,'F').length,0);assert.equal(rootFacts(result,'A').length,1);
  if(complete) assert.ok(result.nonEscapingRoots.has('F'));
});
test('#3814 zero-argument indirect, legacy fallback, and explicit target-as-argument',()=>{
  assert.equal(fixture([call('c',[],['F'],['F'])]).escapes.length,0);
  for(const args of [undefined,[]]) assert.deepEqual(fixture([call('c',args,['F','A'],['F'])]).escapes.map(r=>r.rootKey),['A']);
  assert.deepEqual(fixture([call('c',['F'],['F'],['F'])]).escapes.map(r=>r.rootKey),['F']);
});
for(const value of [['A'],true,1,{},null,{valueId:['A']},{valueId:null}]) test(`#5783 malformed value identity ${JSON.stringify(value)} cannot select a root`,()=>{
  const result=fixture([call('c',[value])]);
  assert.equal(result.escapes.length,0);assert.equal(result.status.completeness,'partial');assert.equal(result.nonEscapingRoots.size,0);
});
test('#5783 custom coercion never runs, valid raw and structured IDs agree',()=>{
  const value={toString(){throw new Error('must not coerce');}};
  assert.equal(fixture([call('c',[value])]).status.completeness,'partial');
  assert.deepEqual(fixture([call('c',['A'])]).escapes,fixture([call('c',[{valueId:'A'}])]).escapes);
});

test('#3814 structured target ids stay out of the argument fallback', () => {
  const result = fixture([call('target-only', [], ['F'], [{ valueId: 'F' }])]);
  assert.equal(rootFacts(result, 'F').length, 0,
    'a structured target id must not be treated as a passed argument');
  assert.ok(result.nonEscapingRoots.has('F'),
    'the target-only local root remains proven non-escaping');
});
