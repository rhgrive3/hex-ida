import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { decompileSemantic, readSemanticControlRenderHistory, readSemanticControlLineHistory, INITIAL_CONTROL_RENDER_FORMS } from '../../../js/decompiler/semantic-core.js';
import { buildIR } from '../../../js/ir-core.js';
import { buildSemanticModel } from '../../../js/blocks.js';
import { enhanceSemanticDecompilation as enhanceCore } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { analysis } from './fixture.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { normalizeCompatibilityLine } from '../../../js/decompiler/switch.js';
import { BRANCH, validateRoadmapInventory } from '../../../tools/validation/analysis-roadmap/ownership.mjs';

const rules = map => map.ledger.filter(record => record.proof === 'observed-control-render-not-cfg-equivalence');
function fixture(kind, options = {}) {
  const f = irFixture('control_' + kind); f.block(0);
  const condition = f.opaque(1); condition.reg = 'x0';
  if (kind === 'one-sided') {
    f.conditionalBranch(condition, 1, 2); f.block(1); f.branch(2); f.block(2); f.ret();
  } else if (kind === 'if-else') {
    f.conditionalBranch(condition, 1, 2); f.block(1); f.branch(3); f.block(2); f.branch(3); f.block(3); f.ret();
  } else if (kind === 'loop') {
    f.branch(1); f.block(1); f.conditionalBranch(condition, 2, 3); f.block(2); f.branch(1); f.block(3); f.ret();
  } else if (kind === 'conditional-loop') {
    f.branch(1); f.block(1); f.conditionalBranch(condition, 2, 3); f.block(2); f.conditionalBranch(condition, 1, 3); f.block(3); f.ret();
  } else if (kind === 'changed-break') {
    f.branch(1);f.block(1);f.conditionalBranch(condition,2,5);f.block(2);f.conditionalBranch(condition,3,4);
    f.block(3);f.branch(1);f.block(4);f.branch(5);f.block(5);f.ret();
  } else if (kind === 'counted') {
    const init=f.constant(0n,32), limit=f.constant(4n,32);f.branch(1);f.block(1);
    const counter=f.phi([[0,init],[2,null]],32);counter.reg='x1';
    const predicate=f.binary('ult',counter,limit,1);f.conditionalBranch(predicate,2,3);f.block(2);
    const step=f.binary('add',counter,f.constant(1n,32),32);f.closePhi(counter,2,step);f.branch(1);f.block(3);f.ret();
  } else if (kind === 'branch-cycle') {
    f.branch(1);f.block(1);f.branch(0);
  } else if (kind === 'revisit') {
    f.conditionalBranch(condition,1,2);f.block(1);f.branch(2);f.block(2);f.conditionalBranch(condition,1,3);f.block(3);f.ret();
  } else if (kind === 'switch') {
    f.branch(1);f.block(1);f.branch(2);f.block(2);f.conditionalBranch(condition,0,1);
  } else if (kind === 'cfg-conditional') {
    f.conditionalBranch(condition,1,2);f.block(1);f.ret();f.block(2);f.ret();
  } else if (kind === 'faithful') {
    f.conditionalBranch(condition, 1, 2); f.block(1); f.branch(3); f.block(2); f.ret();f.block(3);f.ret();
  } else if (kind === 'unsupported') {
    f.unknown(32); f.ret();
  } else throw Error('unknown fixture');
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => {
    inst.id = 800 + index; inst.row = index; inst.address = 0x8000n + BigInt(index * 4);
    if (inst.op === 'unknown') inst.text = 'local_ab';
    if (inst.op === 'cbr' && kind !== 'faithful') inst.extra = { ...inst.extra, targetBlock:ir.blocks[inst.block].succ[0] };
  });
  for (const block of ir.blocks) { block.startRow=block.insts[0].row; block.endRow=block.insts.at(-1).row; }
  const model = { name:'control_' + kind, instructions:ir.instructions, calls:[] };
  const opts = { ir, deterministicTransforms:true, ...options };
  if (kind === 'switch') opts.switches=[{row:ir.instructions.at(-1).row,expr:'selector',cases:[{value:1,block:0}],defaultBlock:1}];
  if (kind === 'changed-break') opts.notes={nameOf() {
    // An actual supported callback changes the graph after its preimage was
    // observed. This rare break arm must emit normally but must NOT gain proof.
    const loop=ir.loops.find(loop=>loop.header===1);
    loop.nodes.add(4);loop.exits.delete(4);ir.ipdom[2]=3;return 'changed_break';
  }};
  const seed = decompileSemantic(model, opts);
  return { ir, model, opts, seed, condition };
}

test('actual initial control emitters retain selected canonical graph origins', () => {
  for (const [kind, expected] of [['one-sided', 'one-sided-if'], ['if-else', 'if-else'], ['loop', 'while-loop'],
    ['faithful', 'cfg-label'], ['unsupported', 'unsupported-statement']]) {
    const f = fixture(kind), history = readSemanticControlRenderHistory(f.seed);
    assert.ok(history, kind); assert.deepEqual(history.reasons, [], kind);
    const map = buildRenderProvenance({ result:f.seed, snapshotId:'control' });
    assert.ok(rules(map).some(record => record.rule === 'render-initial-' + expected), JSON.stringify({ kind, rules:rules(map).map(record=>record.rule), lines:f.seed.lines.map(line=>line.text) }));
    assert.ok(rules(map).every(record => record.renderedBinding === 'producer-bound' && record.producedRefs.length === 1), kind);
    assert.deepEqual(validateRenderProvenance(map).reasons, [], JSON.stringify({kind,reasons:map.reasons}));
  }
});

test('loop, residual, switch and faithful forms retain their actual distinct emitter events', () => {
  for(const [kind,expected] of [['loop',['while-loop','loop-continue']],['counted',['for-loop']],
    ['branch-cycle',['residual-branch-goto']],['revisit',['revisit-goto']],
    ['conditional-loop',['residual-conditional-goto','residual-false-goto']],
    ['switch',['switch-header','switch-case-goto','switch-default-goto']],
    ['cfg-conditional',['cfg-conditional-goto','cfg-false-goto']],['faithful',['cfg-label','cfg-branch-goto']]]){
    const f=fixture(kind),map=buildRenderProvenance({result:f.seed,snapshotId:'control'});
    const found=rules(map).map(record=>record.rule);
    for(const form of expected)assert.ok(found.includes('render-initial-'+form),JSON.stringify({kind,form,found,lines:f.seed.lines.map(line=>line.text)}));
    assert.ok(rules(map).every(record=>record.producedRefs.length===1),kind);
    assert.deepEqual(validateRenderProvenance(map).reasons,[],JSON.stringify({kind,reasons:map.reasons}));
  }
});

test('core/public consumers and actual condition replacement retain initial history across replay', () => {
  let replacements = 0;
  for (const enhance of [enhanceCore, enhancePublic]) for (const kind of ['one-sided', 'if-else', 'loop', 'faithful', 'unsupported']) {
    const f = fixture(kind), enhanced = enhance(f.seed, f.model, f.opts);
    let result = applyPhase8Projection(enhanced, analysis());
    assert.equal(result.renderProvenance.completeness, 'complete', JSON.stringify({kind,reasons:result.renderProvenance.reasons,binding:enhanced.expressionHistoryBinding}));
    assert.ok(rules(result.renderProvenance).every(record=>record.producedRefs.length), kind);
    replacements += rules(result.renderProvenance).filter(record=>record.rule === 'replace-initial-control-condition').length;
    const ledger = result.renderProvenance.ledger;
    result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger, kind);
  }
  assert.ok(replacements > 0, 'at least one actual owned condition spelling transition must run');
});

test('copies and canonical graph mutations cannot reissue initial control ownership', () => {
  for (const mutate of [f=>{f.ir.blocks[0].succ.reverse();}, f=>{f.ir.ipdom[0]=-1;},
    f=>{f.ir.postDominators[0].index.tin[0]++;}, f=>{f.line.text+=' changed';}]) {
    const f=fixture('one-sided');f.line=f.seed.lines.find(line=>readSemanticControlLineHistory(line,f.ir));
    assert.ok(f.line); assert.ok(readSemanticControlLineHistory({...f.line},f.ir)===null);
    mutate(f);assert.ok(readSemanticControlLineHistory(f.line,f.ir)===null);
  }
});

test('a break emitted after an actual callback alters loop/join facts has no current producer binding', () => {
  const f=fixture('changed-break'),history=readSemanticControlRenderHistory(f.seed);
  assert.ok(f.seed.lines.some(line=>line.text==='break;'));
  assert.ok(history.records.some(record=>record.rule==='render-initial-loop-break'));
  assert.ok(history.reasons.includes('initial-control-binding-unavailable'));
  const map=buildRenderProvenance({result:f.seed,snapshotId:'control'});
  assert.equal(map.completeness,'incomplete');
  assert.ok(rules(map).filter(record=>record.rule==='render-initial-loop-break').every(record=>record.producedRefs.length===0));
});

test('loop membership and switch descriptors remain live inputs to their initial producer', () => {
  for(const kind of ['loop','switch']){
    const f=fixture(kind),line=f.seed.lines.find(line=>readSemanticControlLineHistory(line,f.ir));
    assert.ok(line);
    if(kind==='loop')f.ir.loops[0].nodes.delete(2);else f.opts.switches[0].cases[0].value=9;
    assert.ok(readSemanticControlLineHistory(line,f.ir)===null);
  }
});

test('budget and cancellation failures retain emitted output but withhold control bindings', () => {
  const baseline=fixture('one-sided').seed.lines.map(line=>line.text);
  for(const options of [{renderProvenanceBudget:{maxTransformRecords:0}},{renderProvenanceBindingBudget:{maxConsumers:0}},
    {renderProvenanceBindingBudget:{maxEdges:0}},{shouldAbort:()=>true}]){
    const f=fixture('one-sided',options);
    assert.deepEqual(f.seed.lines.map(line=>line.text),baseline);
    assert.equal(f.seed.semanticControlRenderHistory.completeness,'incomplete');
    assert.ok(f.seed.lines.every(line=>readSemanticControlLineHistory(line,f.ir)===null));
  }
});

test('copied result metadata cannot issue initial control history', () => {
  const f=fixture('one-sided'),result={...f.seed,lines:f.seed.lines.map(line=>({...line}))};
  assert.ok(readSemanticControlRenderHistory(result)===null);
  const map=buildRenderProvenance({result,snapshotId:'control'});
  assert.ok(map.reasons.includes('unavailable-initial-control-history'));
  assert.equal(rules(map).length,0);
});

test('the owned condition handoff rejects any extra callback write beside its exact text replacement', () => {
  const f=fixture('one-sided'),enhanced=enhanceCore(f.seed,f.model,f.opts);
  const node=enhanced.cAst.body.find(node=>node.semantic?.op==='control-render'),before=node.text;
  let changed=false;
  const result=applyPhase8Projection(enhanced,analysis(),{shouldAbort(){
    if(!changed&&node.text!==before){node.indent++;changed=true;}return false;
  }});
  assert.equal(changed,true,'callback must run after the actual owned text write');
  assert.equal(result.renderProvenance.completeness,'incomplete');
  assert.ok(result.phase8Projection.history.reasons.includes('initial-control-handoff-unavailable'));
});

test('later replay cannot forget a mutation to the original emitter line or structural inputs', () => {
  for(const mutate of [f=>{f.line.text+=' changed';},f=>{f.ir.ipdom[0]=-1;}]){
    const f=fixture('one-sided');f.line=f.seed.lines.find(line=>readSemanticControlLineHistory(line,f.ir));
    let result=applyPhase8Projection(enhancePublic(f.seed,f.model,f.opts),analysis());
    assert.equal(result.renderProvenance.completeness,'complete');
    mutate(f);result=applyPhase8Projection(result,analysis());
    assert.equal(result.renderProvenance.completeness,'incomplete');
    assert.ok(result.phase8Projection.history.reasons.includes('unavailable-prior-projection-history'));
  }
});

test('query navigation binds an actual initial switch target and rejects stale snapshots', async () => {
  const f=fixture('switch'),result=applyPhase8Projection(enhancePublic(f.seed,f.model,f.opts),analysis());
  let epoch=1;
  const api=new AnalysisQueryAPI({currentIdentity:async()=>({binaryId:'control',projectRevision:1,analysisEpoch:epoch,artifactVersions:{}}),
    decompile:async()=>({value:{lines:result.lines,pseudocode:result.pseudocode,renderProvenance:result.renderProvenance},status:{completeness:'complete'}})});
  const query=await api.decompile(await api.snapshot(),'function');
  const navigation=createDecompilerNavigation(query,{currentSnapshot:()=>api.snapshot()});
  const selected=await navigation.selectOrigin('ir',String(f.ir.instructions[0].id));
  assert.equal(selected.state,'ready');assert.ok(selected.entities.length>0);
  assert.ok(selected.transforms.some(record=>record.rule==='render-initial-switch-case-goto'));
  epoch++;assert.equal((await navigation.selectOrigin('ir',String(f.ir.instructions[0].id))).reason,'stale-query-snapshot');
});

test('initial control history has one exact path in the canonical provenance runner subtree', () => {
  const files=['tests/phase8/provenance/control-render-history.test.mjs'];
  assert.deepEqual(validateRoadmapInventory(BRANCH,'phase8',files),files);
  assert.throws(()=>validateRoadmapInventory(BRANCH,'phase8',['tests/phase8/provenance/unowned-control-history.test.mjs']));
});

test('the initial control class denominator covers seventeen current producers and the invalidated break path', () => {
  const observed=new Set(),current=new Set();
  for(const kind of ['one-sided','if-else','loop','conditional-loop','counted','branch-cycle','revisit','switch','cfg-conditional','faithful','unsupported','changed-break']){
    const f=fixture(kind),history=readSemanticControlRenderHistory(f.seed);
    for(const record of history.records)if(record.phase==='initial-semantic-render')observed.add(record.rule.slice('render-initial-'.length));
    for(const line of f.seed.lines)for(const record of readSemanticControlLineHistory(line,f.ir)?.records||[])if(record.phase==='initial-semantic-render')current.add(record.rule.slice('render-initial-'.length));
  }
  assert.equal(INITIAL_CONTROL_RENDER_FORMS.length,18);
  assert.deepEqual([...observed].sort(),[...INITIAL_CONTROL_RENDER_FORMS].sort());
  assert.deepEqual([...current].sort(),INITIAL_CONTROL_RENDER_FORMS.filter(form=>form!=='loop-break').sort());
});

test('normal decoded branch and loop paths retain initial history through the public pipeline', () => {
  for(const input of [
    ['cbnz w0, #0x10000000c','mov w0, #0','ret','mov w1, #1','b #0x100000004'],
    ['mov w0, #0','cmp w0, #3','b.ge #0x100000014','add w0, w0, #1','b #0x100000004','ret'],
    ['cmp x0, #2','b.eq #0x100000010','mov x0, #1','b #0x100000014','mov x0, #2','ret'],
  ]){
    const rows=input.map((text,row)=>{const split=text.indexOf(' ');return{row,address:0x100000000n+BigInt(row*4),mn:split<0?text:text.slice(0,split),ops:split<0?'':text.slice(split+1)};});
    const rowOfAddress=address=>rows.find(row=>row.address===BigInt(address))?.row??null;
    const model=buildSemanticModel(rows,{rowOfAddress,startRow:0,endRow:rows.length-1});
    const ir=buildIR(model,{rowOfAddress,returnType:'int32',semanticMigrationMode:'semantic-v2-compat'});
    const opts={ir,rowOfAddress,deterministicTransforms:true};
    const seed=decompileSemantic(model,opts),history=readSemanticControlRenderHistory(seed);
    assert.ok(history.records.length>0);assert.deepEqual(history.reasons,[]);
    const result=applyPhase8Projection(enhancePublic(seed,model,opts),analysis());
    assert.equal(result.renderProvenance.completeness,'complete',JSON.stringify({input,reasons:result.renderProvenance.reasons}));
    assert.ok(rules(result.renderProvenance).length>0);
    assert.ok(rules(result.renderProvenance).every(record=>record.producedRefs.length>0));
  }
});

test('owned compatibility normalization retains an unsupported statement producer and its canonical preimage', () => {
  const f=fixture('unsupported'),line=f.seed.lines.find(line=>readSemanticControlLineHistory(line,f.ir));
  const original=readSemanticControlLineHistory(line,f.ir);assert.match(line.text,/local_ab/);
  normalizeCompatibilityLine(line,f.ir);assert.match(line.text,/var_AB/);
  assert.equal(readSemanticControlLineHistory(line,f.ir).records,original.records);
  f.ir.instructions.find(inst=>inst.op==='unknown').text='changed';
  assert.ok(readSemanticControlLineHistory(line,f.ir)===null);
});
