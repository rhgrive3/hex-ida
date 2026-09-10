import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSemanticIrV2ToLegacyV1, readProjectedStateTransitions,
  projectedStateTransitionExpected } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import * as stateProjector from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { finalizeLegacyProjection } from '../../../js/semantics/compat/semantic-ir-v2-to-v1-finalize.js';
import { annotateValueRanges } from '../../../js/semantics/compat/legacy-value-ranges.js';
import { enhanceSemanticDecompilation, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { analysis } from './fixture.js';
import { BRANCH, loadRoadmapManifest, validateRoadmapInventory } from '../../../tools/validation/analysis-roadmap/ownership.mjs';

const clone = ir => structuredClone(Object.fromEntries(Object.entries(ir).filter(([, value]) => typeof value !== 'function')));
const rule = 'compact-public-state';

function fixture({ bits = 64, readBits = bits } = {}) {
  const origin = (role, address = 0x6000n, instructionId = 'same-instruction') => ({ instructionIds:[instructionId],
    operationIds:[`op:${role}`], virtualRanges:[{ start:address, end:address + 4n }], parentEntityIds:[`parent:${role}`] });
  const type = { kind:'bitvector', widthBits:bits }, readType = { kind:'bitvector', widthBits:readBits };
  const variable = { key:'physical-state:input', kind:'physical-state', scope:'function',
    physicalIdentity:{ kind:'register', registerId:'generic-input' } };
  const values = [
    { id:'read', kind:'definition', machineType:readType, definitionNodeId:'n_read', sourceEntityId:'n_read', variableKey:variable.key, origin:origin('read') },
    { id:'other', kind:'entry', machineType:readType, sourceEntityId:'state_history', origin:origin('other') },
    { id:'sum', kind:'definition', machineType:readType, definitionNodeId:'n_sum', sourceEntityId:'n_sum', origin:origin('sum') },
    { id:'again', kind:'definition', machineType:readType, definitionNodeId:'n_again', sourceEntityId:'n_again', variableKey:variable.key, origin:origin('again',0x6004n,'again') },
  ];
  const nodes = [
    { id:'n_read', kind:'state-read', blockId:'b0', inputs:[], outputs:['read'], variable, origin:origin('read') },
    { id:'n_sum', kind:'binary', operator:'add', blockId:'b0', inputs:['read','other'], outputs:['sum'], origin:origin('sum') },
    { id:'n_write', kind:'state-write', blockId:'b0', inputs:['sum'], outputs:[], variable, origin:origin('write') },
    { id:'n_again', kind:'state-read', blockId:'b0', inputs:[], outputs:['again'], variable, origin:origin('again',0x6004n,'again') },
    { id:'n_ret', kind:'return', blockId:'b0', inputs:['again'], outputs:[], origin:origin('return',0x6008n,'ret') },
    { id:'n_other', kind:'return', blockId:'b0', inputs:['other'], outputs:[], origin:origin('other-return',0x6008n,'other-ret') },
  ];
  const canonical = { schemaVersion:2, contractVersion:'2.0.0', functionId:'state_history', entryBlockId:'b0',
    blocks:[{ id:'b0', nodeIds:nodes.map(node => node.id), origin:origin('block') }], values, nodes,
    completeness:'complete', unknowns:[], origin:origin('function') };
  const proof = (kind, sourceSemanticValueId, machineType) => ({ kind, variableIdentity:variable, sourceSemanticValueId, machineType });
  const ssa = { contractVersion:'2.0.0', functionId:'state_history', definitions:[
    { definitionId:'entry', valueId:'entry-value', kind:'entry', blockId:null, variableKey:variable.key,
      sourceEntityId:'state_history', incoming:[], origin:origin('entry'), proof:proof('entry-seed',null,type) },
    ...['read','sum','again'].map(id => ({ definitionId:`scalar-${id}`, valueId:`ssa-${id}`, kind:'definition', blockId:'b0',
      variableKey:null, sourceEntityId:`n_${id}`, incoming:[], origin:origin(id),
      proof:{ kind:'semantic-value-definition', sourceSemanticValueId:id, machineType:readType } })),
    { definitionId:'written', valueId:'written-value', kind:'definition', blockId:'b0', variableKey:variable.key,
      sourceEntityId:'n_write', incoming:[], origin:origin('write'), proof:proof('renamed-definition','sum',readType) },
  ], uses:[{ useId:'input-use', valueId:'entry-value', blockId:'b0', sourceEntityId:'n_read', origin:origin('read'),
    proof:proof('renamed-use','read',readType) }] };
  const ir = projectSemanticIrV2ToLegacyV1(canonical, { ssa });
  return { ir, canonical, ssa, read:ir.instructions.find(inst => inst.semanticNodeId === 'n_again'),
    sum:ir.instructions.find(inst => inst.semanticNodeId === 'n_sum'), ret:ir.instructions.find(inst => inst.semanticNodeId === 'n_ret') };
}

test('state compaction privately records actual shadowing and original rewritten return/operand edges', () => {
  for (const bits of [8,16,32,64]) {
    const f = fixture({ bits });
    const record = readProjectedStateTransitions(f.ir, f.read);
    assert.ok(record, `${bits}`);
    assert.ok(record.events.some(event => event.kind === 'state-read-shadow'));
    const transition = readProjectedStateTransitions(f.ir, f.ret);
    assert.ok(transition);
    const event = transition.events.find(event => event.kind === 'resolve-state-alias');
    assert.equal(event.before, f.read.dst);
    assert.equal(event.after, f.ret.args[0].value);
    assert.notEqual(event.before, event.after);
    assert.equal(event.object, f.ret.args[0]);
    assert.equal(event.path, 'args:0');
    assert.ok(event.causes.some(cause => cause.source === f.read));
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.causes) && Object.isFrozen(event.beforeInputs));
  }
});

function render(f, options = {}, publicPipeline = false) {
  const returns = f.ir.instructions.filter(inst => inst.op === 'ret');
  const seed = { semantic:true, ir:f.ir, types:{ values:new Map(), locations:new Map() },
    lines:returns.map(inst => ({ kind:'stmt', indent:1, text:'return old;', row:inst.row, addr:inst.address })),
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  f.result = (publicPipeline ? enhancePublic : enhanceSemanticDecompilation)(seed, { calls:[] }, { deterministicTransforms:true, ...options });
  return f;
}

test('actual state-edge and shadow histories bind only to their rendered consumers', () => {
  for (const publicPipeline of [false,true]) {
    const f = render(fixture(), {}, publicPipeline), before = clone(f.ir);
    let result = applyPhase8Projection(f.result, analysis());
    const records = result.renderProvenance.ledger.filter(record => record.rule === rule);
    const edges = records.filter(record => record.before.startsWith('resolve-state-alias:') && record.producedRefs.includes('L0:stmt'));
    assert.ok(edges.length);
    assert.ok(records.some(record => record.before.startsWith('state-read-shadow:') && record.producedRefs.includes('L0:stmt')));
    for (const record of edges) {
      assert.equal(record.proof, 'observed-state-compaction-not-equivalence');
      assert.equal(record.renderedBinding, 'producer-bound');
      assert.ok(record.originHistory.consumedRefs.includes(`ir:${f.read.id}`));
      assert.ok(record.originHistory.consumedRefs.includes(`ssa:def:${f.read.dst.id}`));
    }
    assert.ok(result.renderProvenance.reverse[`ir:${f.read.id}`].includes('L0:stmt'));
    assert.ok(records.every(record => !record.producedRefs.includes('L1:stmt')), 'same-function unrelated input has no state-compaction history');
    const ledger = result.renderProvenance.ledger;
    for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger);
    assert.deepEqual(clone(f.ir), before);
  }
});

test('post-seal source, original-input, edge-slot and root mutations revoke state history', () => {
  for (const mutate of [
    f => { f.ret.args[0] = { ...f.ret.args[0] }; },
    f => { f.ret.args[0].value = f.read.dst; },
    f => { f.read.dst.compatDerived = 'forged-shadow'; },
    f => { f.read.args[0].value.bits = 32; },
    f => { f.ir.values = [...f.ir.values]; },
    f => { f.ir.instructions = [...f.ir.instructions]; },
    f => { f.ir.blocks[0].insts = [...f.ir.blocks[0].insts]; },
  ]) {
    const f = fixture();
    assert.ok(readProjectedStateTransitions(f.ir,f.ret));
    mutate(f);
    assert.equal(readProjectedStateTransitions(f.ir,f.ret),null);
    assert.equal(projectedStateTransitionExpected(f.ir,f.ret),true);
  }
});

test('copied producer/roots and getters cannot carry private state authority', () => {
  const f = fixture();
  assert.equal(readProjectedStateTransitions({...f.ir},f.ret),null);
  assert.equal(readProjectedStateTransitions(f.ir,{...f.ret}),null);
  let reads = 0;
  Object.defineProperty(f.ret.args[0],'value',{enumerable:true,configurable:true,get:()=>{reads++;return f.read.dst;}});
  assert.equal(readProjectedStateTransitions(f.ir,f.ret),null);
  assert.equal(reads,0);
});

test('actual range handoff preserves state histories, manual range edits cannot', () => {
  const f = fixture();
  annotateValueRanges(f.ir);
  assert.ok(readProjectedStateTransitions(f.ir,f.ret));
  f.read.dst.range = { min:0n,max:10n,bits:64 };
  assert.equal(readProjectedStateTransitions(f.ir,f.ret),null);
});

test('pre-render mutation withholds state histories and later mutation revokes their consumer', () => {
  const f = fixture();
  f.read.dst.bits = 32;
  const result = applyPhase8Projection(render(f).result,analysis());
  assert.deepEqual(result.renderProvenance.ledger.filter(record=>record.rule===rule),[]);
  assert.equal(result.renderProvenance.completeness,'incomplete');
  const g = render(fixture()), semantic = g.result.cAst.body[0].semantic;
  assert.ok(readExpressionHistoryConsumer(semantic,g.ir));
  g.ret.args[0].value = g.read.dst;
  assert.equal(readExpressionHistoryConsumer(semantic,g.ir),null);
});

test('state history budgets and cancellation preserve pseudocode while withholding completeness', () => {
  const baseline = render(fixture()).result.pseudocode;
  for (const options of [
    {renderProvenanceBudget:{maxTransformRecords:0}},
    {renderProvenanceBindingBudget:{maxEdges:0}},
    {renderProvenanceBindingBudget:{maxConsumers:0}},
    {shouldAbort:()=>true},
  ]) {
    const f=render(fixture(),options);
    assert.equal(f.result.pseudocode,baseline);
    assert.equal(applyPhase8Projection(f.result,analysis()).renderProvenance.completeness,'incomplete');
  }
});

test('canonical construction validates its shared state producer a bounded number of times', () => {
  const f = fixture(), descriptor = Object.getOwnPropertyDescriptor;
  let producerRootChecks = 0;
  Object.getOwnPropertyDescriptor = (object, key) => {
    if (object === f.ir && key === 'compat') producerRootChecks++;
    return descriptor(object, key);
  };
  try { render(f); } finally { Object.getOwnPropertyDescriptor = descriptor; }
  // One initial/final construction check plus fresh actual consumer checks.
  // This is an operation-count regression, independent of machine speed.
  assert.ok(producerRootChecks > 0 && producerRootChecks <= 8, `producer root checks: ${producerRootChecks}`);
  const result = applyPhase8Projection(f.result, analysis());
  assert.ok(result.renderProvenance.ledger.some(record => record.rule === rule && record.renderedBinding === 'producer-bound'));
});

test('each callback boundary withholds stale state bindings, including previously constructed frames', () => {
  let callbacks = 0;
  render(fixture(), { shouldAbort:() => { callbacks++; return false; } });
  assert.ok(callbacks > 2);
  for (let target = 1; target <= callbacks; target++) {
    const f = fixture();
    let calls = 0, changed = false;
    render(f, { shouldAbort:() => {
      if (++calls === target) { f.read.extra.callbackMutation = target; changed = true; }
      return false;
    } });
    assert.equal(changed, true, `callback ${target} reached`);
    assert.equal(readProjectedStateTransitions(f.ir, f.ret), null);
    const result = applyPhase8Projection(f.result, analysis());
    assert.deepEqual(result.renderProvenance.ledger.filter(record => record.rule === rule && record.renderedBinding === 'producer-bound'), [],
      `callback ${target} must invalidate even earlier completed frames`);
  }
});

test('candidate batches expose descriptions but never bypass current validation or issue copied authority', () => {
  const f = fixture(), candidates = stateProjector.projectedStateTransitionCandidates(f.ir);
  const record = candidates.get(f.ret);
  assert.ok(Object.isFrozen(candidates) && Object.isFrozen(record));
  assert.equal(record.isCurrent(), true);
  assert.equal(candidates.get({ ...f.ret }), null);
  assert.equal(stateProjector.projectedStateTransitionCandidates({ ...f.ir }), null);
  f.read.extra.changedAfterCandidateRead = true;
  assert.equal(candidates.get(f.ret), record, 'description identity is not a current certificate');
  assert.equal(record.isCurrent(), false);
  assert.equal(readProjectedStateTransitions(f.ir, f.ret), null);
});

function unfinalizedEdges() {
  const value = (id,kind='def') => ({id,kind,reg:'r',bits:64,version:0,stateKey:'state:r',const:null,range:null,uses:[],def:null});
  const input=value(0,'arg'), read=value(1), output=value(2);
  const source={id:0,op:'mov',sub:null,block:0,row:0,dst:read,args:[{value:input}],
    extra:{stateRead:{},localPhysicalViewProjection:true}};
  read.def=source;
  const consumer={id:1,op:'bin',sub:'add',block:0,row:1,dst:output,args:[{value:read}],conditionValue:read,
    addr:{base:read,index:read},loc:{kind:'unknown',key:'local',base:read},incoming:[{value:read}]};
  output.def=consumer;
  const mapped={key:'mapped',kind:'unknown',base:read};
  const ir={instructions:[source,consumer],values:[input,read,output],blocks:[{index:0,phis:[],insts:[source,consumer]}],locations:new Map([['mapped',mapped]])};
  return {ir,input,read,source,consumer,mapped};
}

test('all seven actual alias-reference slots retain original values and real creating operations', () => {
  const f=unfinalizedEdges(), observer={records:[],expected:new WeakSet(),unavailable:new WeakSet()};
  finalizeLegacyProjection(f.ir,null,observer);
  const edges=observer.records.filter(event=>event.kind==='resolve-state-alias');
  assert.deepEqual(edges.map(event=>event.path).sort(),['args:0','conditionValue','addr:base','addr:index','loc:base','incoming:0','locations:base'].sort());
  for (const event of edges) {
    assert.equal(event.before,f.read);
    assert.equal(event.after,f.input);
    assert.equal(event.object[event.key],f.input);
    assert.equal(event.causes[0].source,f.source);
    assert.ok(event.causes[0].ordinal<event.ordinal);
    assert.equal(readProjectedStateTransitions(f.ir,event.source || event.object),null,'public finalization is not the owning projector');
  }
});

test('exhausted descriptions do not change alias resolution or allow invented producer history', () => {
  const f=unfinalizedEdges(), observer={records:new Array(1024),expected:new WeakSet(),unavailable:new WeakSet()};
  finalizeLegacyProjection(f.ir,null,observer);
  assert.equal(f.consumer.args[0].value,f.input);
  assert.equal(f.mapped.base,f.input);
  assert.equal(observer.records.length,1024);
  assert.equal(observer.expected.has(f.source),true);
  assert.equal(observer.unavailable.has(f.source),true);
  assert.equal(observer.unavailable.has(f.consumer),true,'missing alias cause does not become an unobserved edge');
});

test('transitive alias selection retains earlier creating operations after the resolver shortcuts their values', () => {
  const f=unfinalizedEdges();
  const second={...f.read,id:3,uses:[],def:null};
  const source={...f.source,id:3,row:1,dst:second,args:[{value:f.read}],extra:{...f.source.extra}};
  second.def=source;
  f.ir.values.push(second);f.ir.instructions.splice(1,0,source);f.ir.blocks[0].insts=f.ir.instructions;
  f.consumer.args[0].value=second;
  const observer={records:[],expected:new WeakSet(),unavailable:new WeakSet()};
  finalizeLegacyProjection(f.ir,null,observer);
  const first=observer.records.find(event=>event.source===f.source && event.identity);
  const next=observer.records.find(event=>event.source===source && event.identity);
  const edge=observer.records.find(event=>event.source===f.consumer && event.path==='args:0');
  assert.ok(first && next && edge);
  assert.deepEqual(next.causes,[first]);
  assert.deepEqual(edge.causes,[next]);
  assert.equal(edge.after,f.input);
  assert.ok(edge.beforeInputs.includes(f.read),'shortcutting the alias map must retain the earlier value');
});

test('state-write source/address shadow branches retain original public identities', () => {
  for (const address of [false,true]) {
    const f=unfinalizedEdges();
    f.source.extra={stateWrite:{},publicStateIdentity:'r'};
    f.input.kind='def';
    const producer={id:2,op:'mov',sub:null,block:0,row:0,dst:f.input,args:[],extra:{}};
    f.input.def=producer;
    f.ir.instructions.unshift(producer);f.ir.blocks[0].insts=f.ir.instructions;
    if (!address) {
      delete f.consumer.addr;delete f.consumer.loc;f.ir.locations.clear();
    }
    const observer={records:[],expected:new WeakSet(),unavailable:new WeakSet()};
    finalizeLegacyProjection(f.ir,null,observer);
    const event=observer.records.find(event=>event.kind===`state-write-${address?'address':'source'}-shadow`);
    assert.ok(event);
    assert.equal(event.before.reg,'r');
    assert.equal(event.after.reg,null);
    assert.equal(event.output,address?f.read:f.input);
  }
});

test('actual missing-state-key transfer retains the original and assigned key without changing later version normalization', () => {
  const f=unfinalizedEdges();
  f.source.extra={stateWrite:{},publicStateIdentity:'r'};
  f.input.kind='def';f.input.stateKey=null;
  const producer={id:2,op:'mov',sub:null,block:0,row:0,dst:f.input,args:[],extra:{}};
  f.input.def=producer;f.ir.instructions.unshift(producer);f.ir.blocks[0].insts=f.ir.instructions;
  const observer={records:[],expected:new WeakSet(),unavailable:new WeakSet()};
  finalizeLegacyProjection(f.ir,null,observer);
  const event=observer.records.find(event=>event.kind==='state-key-transfer');
  assert.ok(event);
  assert.equal(event.before.stateKey,null);
  assert.equal(event.after.stateKey,'state:r');
  assert.deepEqual(event.identityFields,['stateKey']);
  assert.equal(f.input.stateKey,'state:r');
  assert.equal(f.input.version,1,'existing version normalization still runs after compaction');
});

test('state compaction test ownership is exact and neighboring files remain forbidden', () => {
  const manifest=loadRoadmapManifest(),files=Object.values(manifest.owners).flat();
  assert.ok(manifest.owners.phase8.includes('tests/phase8/provenance/state-compaction-history.test.mjs'));
  for (const phase of ['phase7','phase8']) {
    assert.doesNotThrow(()=>validateRoadmapInventory(BRANCH,phase,files));
    assert.throws(()=>validateRoadmapInventory(BRANCH,phase,[...files,'js/semantics/compat/unreviewed-state.js']),/undeclared/);
  }
});

test('snapshot-bound query navigation reaches the original aliased state and rejects stale queries', async () => {
  const f=render(fixture()), result=applyPhase8Projection(f.result,analysis());
  const value={lines:result.lines,pseudocode:result.pseudocode,renderProvenance:result.renderProvenance};
  let epoch=1;
  const api=new AnalysisQueryAPI({currentIdentity:async()=>({binaryId:'state-history',projectRevision:1,analysisEpoch:epoch,artifactVersions:{}}),
    decompile:async()=>({value,status:{completeness:'complete'}})});
  const snapshot=await api.snapshot(), query=await api.decompile(snapshot,'function');
  const navigation=createDecompilerNavigation(query,{currentSnapshot:()=>api.snapshot()});
  const selected=await navigation.selectOrigin('ir',f.read.id);
  assert.equal(selected.state,'ready');
  assert.ok(selected.entities.some(entity=>entity.lineIndex===0));
  assert.ok(selected.transforms.some(record=>record.rule===rule));
  epoch++;
  assert.equal((await navigation.selectLine(0)).reason,'stale-query-snapshot');
});

test('canonical state reads and unchanged unrelated consumers do not invent local alias operations', () => {
  const f=fixture();
  for (const id of ['n_read','n_other']) {
    const source=f.ir.instructions.find(inst=>inst.semanticNodeId===id);
    assert.equal(projectedStateTransitionExpected(f.ir,source),false);
    assert.equal(readProjectedStateTransitions(f.ir,source),null);
  }
});

test('mandatory representation fallback retains the actually consumed state-alias history', () => {
  const f=render(fixture(),{deterministicTransforms:false,decompilerTimeBudgetMs:1e-12});
  const result=applyPhase8Projection(f.result,analysis());
  assert.ok(result.renderProvenance.ledger.some(record=>record.rule===rule && record.renderedBinding==='producer-bound'
    && record.producedRefs.includes('L0:stmt')));
});

test('an actual store binds its replaced operand edge to the store consumer, not only to a value expression', () => {
  const f=fixture(), input=structuredClone(f.canonical);
  input.values.find(value=>value.id==='other').machineType={kind:'address',widthBits:64,addressSpace:'memory'};
  const store=input.nodes.find(node=>node.id==='n_ret');
  store.kind='store';store.inputs=['other','again'];
  store.memory={addressSpace:'memory',addressExpr:{valueId:'other'},widthBits:64,endian:'little',alignment:8,
    volatility:false,atomic:false,ordering:'unknown',faults:[]};
  const ir=projectSemanticIrV2ToLegacyV1(input,{ssa:f.ssa});
  const inst=ir.instructions.find(source=>source.semanticNodeId==='n_ret');
  assert.ok(readProjectedStateTransitions(ir,inst)?.events.some(event=>event.path==='args:0'));
  const seed={semantic:true,ir,types:{values:new Map(),locations:new Map()},
    lines:[{kind:'stmt',indent:1,text:'memory = old;',row:inst.row,addr:inst.address}],warnings:[],evidence:[],coverage:{mode:'structured'},summary:''};
  const result=applyPhase8Projection(enhanceSemanticDecompilation(seed,{calls:[]},{deterministicTransforms:true}),analysis());
  assert.ok(result.renderProvenance.ledger.some(record=>record.rule===rule && record.before.startsWith('resolve-state-alias:')
    && record.renderedBinding==='producer-bound' && record.producedRefs.includes('L0:stmt')));
});
