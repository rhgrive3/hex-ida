import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { buildMemorySsa } from '../../../js/semantics/memoryssa/build.js';
import { projectSemanticIrV2ToLegacyV1, readProjectedConstantTransitions,
  projectedConstantTransitionExpected } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { propagateScalarConstants, finalizeLegacyProjection } from '../../../js/semantics/compat/semantic-ir-v2-to-v1-finalize.js';
import { BRANCH, loadRoadmapManifest, validateRoadmapInventory } from '../../../tools/validation/analysis-roadmap/ownership.mjs';
import { enhanceSemanticDecompilation, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { analysis } from './fixture.js';
import { annotateValueRanges } from '../../../js/semantics/compat/legacy-value-ranges.js';
import { captureProjectionIrData, PROJECTION_LIMITS } from '../../../js/core/identity/live-data.js';

const clone = ir => structuredClone(Object.fromEntries(Object.entries(ir).filter(([, value]) => typeof value !== 'function')));

function fixture({ bits = 32, preMemory = false, unknown = false } = {}) {
  const functionId = 'compat_constant_history';
  const origin = (id, i) => ({ instructionIds:[id], virtualRanges:[{ start:0x5000n+BigInt(i*4), end:0x5004n+BigInt(i*4) }] });
  const type = { kind:'bitvector', widthBits:bits };
  const nodes = [
    ...(!unknown ? [{ id:'n_a', kind:'const', blockId:'b0', inputs:[], outputs:['a'], attributes:{ value:2 }, origin:origin('a', 0) }] : []),
    { id:'n_b', kind:'const', blockId:'b0', inputs:[], outputs:['b'], attributes:{ value:3 }, origin:origin('b', 1) },
    { id:'n_sum', kind:'binary', operator:'add', blockId:'b0', inputs:['a', 'b'], outputs:['sum'], origin:origin('sum', 2) },
    { id:'n_neg', kind:'unary', operator:'neg', blockId:'b0', inputs:['sum'], outputs:['neg'], origin:origin('neg', 3) },
    { id:'n_ret', kind:'return', blockId:'b0', inputs:['neg'], outputs:[], origin:origin('ret', 4) },
    { id:'n_other', kind:'return', blockId:'b0', inputs:['b'], outputs:[], origin:origin('other', 5) },
  ];
  const values = ['a', 'b', 'sum', 'neg'].map((id, i) => unknown && id === 'a'
    ? { id, kind:'entry', machineType:type, sourceEntityId:functionId, origin:origin(id, i) }
    : { id, kind:'definition', machineType:type, definitionNodeId:`n_${id}`, sourceEntityId:`n_${id}`, origin:origin(id, i) });
  const canonical = createSemanticIrFunction({ schemaVersion:2, contractVersion:'2.0.0', functionId, entryBlockId:'b0',
    blocks:[{ id:'b0', nodeIds:nodes.map(node => node.id), origin:origin('block', 0) }], values, nodes,
    completeness:'complete', unknowns:[], origin:origin('function', 0) });
  const cfg = createSemanticCfg({ functionId, entryBlockId:'b0', blocks:[{ id:'b0', successors:[] }] });
  const ir = projectSemanticIrV2ToLegacyV1(canonical, preMemory ? { cfg, memorySsa:buildMemorySsa(canonical, cfg) } : {});
  return { ir, canonical, sum:ir.instructions.find(inst => inst.semanticNodeId === 'n_sum'),
    neg:ir.instructions.find(inst => inst.semanticNodeId === 'n_neg') };
}

test('actual scalar writes are privately finalized in both propagation stages at five widths', () => {
  let cells = 0;
  for (const bits of [1, 8, 16, 32, 64]) for (const preMemory of [false, true]) {
    const f = fixture({ bits, preMemory }), before = clone(f.ir);
    const stage = preMemory ? 'pre-memory-scalar-constants' : 'finalize-constants';
    for (const source of [f.sum, f.neg]) {
      assert.equal(projectedConstantTransitionExpected(f.ir, source), true);
      const record = readProjectedConstantTransitions(f.ir, source);
      assert.ok(record, `${bits}/${stage}/${source.sub}`);
      assert.equal(record.events.length, 1, 'unchanged later rounds/stages do not invent writes');
      const [event] = record.events;
      assert.equal(event.stage, stage);
      assert.equal(event.round, 0);
      assert.equal(event.beforeConstant, null);
      assert.equal(event.afterConstant, source.dst.const);
      assert.equal(event.output, source.dst);
      assert.equal(event.bits, bits);
      assert.equal(event.source, source);
      assert.equal(event.inputs[0].value, source.args[0].value);
      assert.equal(event.inputs[0].definition, source.args[0].value.def);
      assert.equal(event.inputs[0].constant, source.args[0].value.const);
      assert.ok(Object.isFrozen(record) && Object.isFrozen(record.events) && Object.isFrozen(event)
        && Object.isFrozen(event.inputs) && event.inputs.every(Object.isFrozen));
    }
    assert.equal(f.neg.dst.const, BigInt.asUintN(bits, -5n));
    assert.ok(readProjectedConstantTransitions(f.ir, f.sum).events[0].ordinal
      < readProjectedConstantTransitions(f.ir, f.neg).events[0].ordinal);
    assert.deepEqual(clone(f.ir), before, 'reading observations never changes projected IR');
    cells++;
  }
  assert.equal(cells, 10, 'actual observed stage/width cells, not equivalence proofs');
});

test('unchanged literal and unknown computations have no fabricated folding event', () => {
  const f = fixture({ unknown:true });
  for (const source of [f.sum, f.neg, f.ir.instructions.find(inst => inst.semanticNodeId === 'n_b')]) {
    assert.equal(readProjectedConstantTransitions(f.ir, source), null);
    assert.equal(projectedConstantTransitionExpected(f.ir, source), false);
  }
  assert.equal(f.neg.dst.const, null);
});

test('MOV, unary, binary and bitfield folding classes retain the actual written value and original operands', () => {
  const cases = [
    ['copy', null, ['a'], 2n],
    ['unary', 'neg', ['a'], 4294967294n], ['unary', 'not', ['a'], 4294967293n],
    ['unary', 'is-zero', ['a'], 0n], ['unary', 'sext', ['a'], 2n],
    ['binary', 'add', ['a','b'], 5n], ['binary', 'sub', ['a','b'], 4294967295n],
    ['binary', 'mul', ['a','b'], 6n], ['binary', 'and', ['a','b'], 2n],
    ['binary', 'or', ['a','b'], 3n], ['binary', 'xor', ['a','b'], 1n],
    ['binary', 'shl', ['a','b'], 16n], ['binary', 'lshr', ['a','b'], 0n],
    ['binary', 'ashr', ['a','b'], 0n], ['binary', 'ror', ['a','b'], 1073741824n],
    ['binary', 'eq', ['a','b'], 0n],
    ['intrinsic', 'extract-bit', ['a'], 1n],
  ];
  for (const [kind, operator, inputs, expected] of cases) {
    const input = structuredClone(fixture().canonical), node = input.nodes.find(node => node.id === 'n_sum');
    Object.assign(node, { kind, operator, inputs });
    if (kind === 'intrinsic') {
      node.attributes = { machineEffects:{ operationMetadata:{ bit:1 } } };
      node.intrinsic = { inputs, outputs:['sum'], stateReads:[], stateWrites:[],
        memoryRead:{ scope:'none' }, memoryWrite:{ scope:'none' }, controlEffects:[],
        determinism:'input-dependent', symbolicDetail:'summary-only' };
    }
    const ir = projectSemanticIrV2ToLegacyV1(input), source = ir.instructions.find(inst => inst.semanticNodeId === 'n_sum');
    assert.equal(source.dst.const, expected, `${kind}/${operator}`);
    const record = readProjectedConstantTransitions(ir, source);
    assert.ok(record, `${kind}/${operator}`);
    assert.equal(record.events.length, 1);
    assert.equal(record.events[0].afterConstant, expected);
    assert.deepEqual(record.events[0].inputs.map(input => input.constant), inputs.map(id => id === 'a' ? 2n : 3n));
  }
  assert.equal(cases.length, 17, 'observed scalar branch fixtures, not a compiler or equivalence denominator');
});

test('constant observations reject post-finalization scalar, dependency, descriptor and position changes', () => {
  for (const mutate of [
    f => { f.neg.dst.const = 7n; },
    f => { f.sum.args[0].value.const = 9n; },
    f => { f.neg.sub = 'not'; },
    f => { f.neg.args[0] = { ...f.neg.args[0] }; },
    f => { f.neg.dst = { ...f.neg.dst }; },
    f => { f.ir.values = [...f.ir.values]; },
    f => { f.ir.instructions = [...f.ir.instructions]; },
    f => { f.ir.blocks[0].insts = [...f.ir.blocks[0].insts]; },
    f => { f.ir.blocks[0].index++; },
  ]) {
    const f = fixture();
    assert.ok(readProjectedConstantTransitions(f.ir, f.neg));
    mutate(f);
    assert.equal(readProjectedConstantTransitions(f.ir, f.neg), null);
    assert.equal(projectedConstantTransitionExpected(f.ir, f.neg), true, 'unavailable is not unobserved');
  }
});

test('source getters are rejected without invocation and copied roots cannot transfer authority', () => {
  const f = fixture(), other = fixture();
  assert.equal(readProjectedConstantTransitions({ ...f.ir }, f.neg), null);
  assert.equal(readProjectedConstantTransitions(other.ir, f.neg), null);
  assert.equal(readProjectedConstantTransitions(f.ir, { ...f.neg }), null);
  let reads = 0;
  Object.defineProperty(f.neg.dst, 'const', { enumerable:true, configurable:true, get:() => { reads++; return 0n; } });
  assert.equal(readProjectedConstantTransitions(f.ir, f.neg), null);
  assert.equal(reads, 0);
});

test('exported propagation/finalization helpers describe real writes but cannot register projector authority', () => {
  const f = fixture(), ir = clone(f.ir), source = ir.instructions.find(inst => inst.semanticNodeId === 'n_neg');
  const observer = { records:[], expected:new WeakSet(), unavailable:new WeakSet() };
  source.dst.const = null;
  propagateScalarConstants(ir, observer);
  assert.equal(observer.records.length, 1);
  assert.equal(observer.records[0].source, source);
  assert.equal(source.dst.const, f.neg.dst.const);
  assert.equal(readProjectedConstantTransitions(ir, source), null);
  source.dst.const = null;
  assert.equal(finalizeLegacyProjection(ir, observer), ir);
  assert.equal(observer.records.length, 2);
  assert.equal(observer.records[1].stage, 'finalize-constants');
  assert.equal(readProjectedConstantTransitions(ir, source), null);
});

test('exhausted operation-description allowance preserves results and marks the real source unavailable', () => {
  const f = fixture(), ir = clone(f.ir), source = ir.instructions.find(inst => inst.semanticNodeId === 'n_neg');
  source.dst.const = null;
  const observer = { records:new Array(1024), expected:new WeakSet(), unavailable:new WeakSet() };
  propagateScalarConstants(ir, observer);
  assert.equal(source.dst.const, f.neg.dst.const);
  assert.equal(observer.records.length, 1024);
  assert.equal(observer.expected.has(source), true);
  assert.equal(observer.unavailable.has(source), true);
  assert.equal(readProjectedConstantTransitions(ir, source), null);
});

test('constant producer ownership names only the actual finalizer and provenance test', () => {
  const manifest = loadRoadmapManifest(), files = Object.values(manifest.owners).flat();
  assert.ok(manifest.owners.semanticCompat.includes('js/semantics/compat/semantic-ir-v2-to-v1-finalize.js'));
  assert.ok(manifest.owners.semanticCompat.includes('js/semantics/compat/legacy-value-ranges.js'));
  assert.ok(manifest.owners.semanticCompat.includes('js/ir-base.js'));
  assert.ok(manifest.owners.phase8.includes('tests/phase8/provenance/compat-constant-history.test.mjs'));
  for (const phase of ['phase7', 'phase8']) {
    assert.doesNotThrow(() => validateRoadmapInventory(BRANCH, phase, files));
    assert.throws(() => validateRoadmapInventory(BRANCH, phase, [...files, 'js/semantics/compat/unreviewed-fold.js']), /undeclared/);
  }
});

test('actual range annotation carries the original fold observation across repeated owned writes', () => {
  const f = fixture(), record = readProjectedConstantTransitions(f.ir, f.neg);
  assert.equal(f.neg.dst.range, null);
  for (let i = 0; i < 3; i++) {
    assert.equal(annotateValueRanges(f.ir), f.ir);
    assert.ok(f.neg.dst.range);
    assert.equal(readProjectedConstantTransitions(f.ir, f.neg), record);
    assert.equal(record.isCurrent(), true);
  }
});

test('range handoff cannot authorize forged writes, changed source facts or a copied owner', () => {
  for (const mutate of [
    f => { f.neg.dst.range = { min:1n, max:1n, bits:32 }; },
    f => { f.sum.dst.const = 11n; annotateValueRanges(f.ir); },
    f => { annotateValueRanges({ ...f.ir }); },
    f => { annotateValueRanges(f.ir); f.neg.dst.range.min = 1n; },
    f => { annotateValueRanges(f.ir); f.neg.dst.range = { ...f.neg.dst.range }; annotateValueRanges(f.ir); },
  ]) {
    const f = fixture();
    assert.ok(readProjectedConstantTransitions(f.ir, f.neg));
    mutate(f);
    assert.equal(readProjectedConstantTransitions(f.ir, f.neg), null);
  }
});

test('plain-data write-chain matching stays non-authoritative and default observations stay strict', () => {
  const value = { range:null, constant:1n }, observed = captureProjectionIrData([value]);
  const first = { min:1n, max:1n }, second = { ...first };
  value.range = second;
  const writes = [{ object:value, key:'range', before:null, after:first },
    { object:value, key:'range', before:first, after:second }];
  assert.equal(observed.matches(), false);
  assert.equal(observed.matchesThroughWrites(writes), true, 'data comparison alone grants no projector authority');
  assert.equal(observed.matchesThroughWrites([writes[1]]), false);
  assert.equal(observed.matchesThroughWrites([writes[0], { ...writes[1], before:{} }]), false);
  assert.equal(observed.matchesThroughWrites(new Array(PROJECTION_LIMITS.nodes+1)), false);
  let reads = 0;
  assert.equal(observed.matchesThroughWrites([{ get object() { reads++; return value; } }]), false);
  assert.equal(reads, 0);
  value.constant = 2n;
  assert.equal(observed.matchesThroughWrites(writes), false, 'unlisted semantic changes remain stale');
});

test('range observation exhaustion leaves computed ranges intact without authorizing a successor', () => {
  const f = fixture();
  f.ir.values.push(...Array.from({ length:PROJECTION_LIMITS.nodes }, () => ({ const:1n, bits:32, range:null })));
  annotateValueRanges(f.ir);
  assert.ok(f.neg.dst.range);
  assert.equal(f.ir.values.at(-1).range.min, 1n);
  assert.equal(readProjectedConstantTransitions(f.ir, f.neg), null);
});

const foldRecords = result => result.renderProvenance.ledger.filter(record => record.rule === 'fold-compatibility-constant');
function render(f, options = {}, publicPipeline = false) {
  const before = clone(f.ir), returns = f.ir.instructions.filter(inst => inst.op === 'ret');
  const seed = { semantic:true, ir:f.ir, types:{ values:new Map(), locations:new Map() },
    lines:returns.map(inst => ({ kind:'stmt', indent:1, text:'return old;', row:inst.row, addr:inst.address })),
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const result = (publicPipeline ? enhancePublic : enhanceSemanticDecompilation)(seed, { calls:[] }, { deterministicTransforms:true, ...options });
  assert.deepEqual(clone(f.ir), before);
  return { ...f, result };
}

test('precomputed rendering retains both actual folding producers and excludes an unrelated literal consumer', () => {
  for (const preMemory of [false, true]) {
    const f = render(fixture({ preMemory }));
    const result = applyPhase8Projection(f.result, analysis());
    const records = foldRecords(result);
    assert.equal(records.length, 3, 'two neg-consumer records and the separate sum semantic-value consumer');
    assert.equal(new Set(records.map(record => record.before)).size, 2, 'only two actual folding operations');
    const rendered = records.filter(record => record.producedRefs.includes('L0:stmt'));
    assert.equal(rendered.length, 2);
    for (const record of rendered) {
      assert.equal(record.proof, 'observed-compat-constant-write-not-equivalence');
      assert.equal(record.renderedBinding, 'producer-bound');
      assert.deepEqual(record.producedRefs, ['L0:stmt']);
      assert.match(record.before, preMemory ? /^pre-memory-scalar-constants:/ : /^finalize-constants:/);
    }
    for (const source of [f.sum, f.neg]) {
      assert.ok(foldRecords(result).some(record => record.originHistory.consumedRefs.includes(`ir:${source.id}`)));
      assert.ok(result.renderProvenance.reverse[`addr:${source.address}`].includes('L0:stmt'));
    }
    assert.deepEqual(result.renderProvenance.entities['L1:stmt'].recordRefs, []);
    assert.ok(result.renderProvenance.ledger.some(record => record.rule === 'select-precomputed-value'));
    assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
  }
});

test('public rendering and repeated projections preserve actual fold events without inventing later rounds', () => {
  const f = render(fixture(), {}, true);
  let result = applyPhase8Projection(f.result, analysis());
  const ledger = result.renderProvenance.ledger;
  assert.equal(foldRecords(result).length, 3);
  for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(result.renderProvenance.ledger, ledger);
});

test('mutation before rendering withholds upstream history even if a precomputed value remains available', () => {
  const f = fixture();
  f.sum.args[0].value.const = 13n;
  const result = applyPhase8Projection(render(f).result, analysis());
  assert.deepEqual(foldRecords(result), []);
  assert.equal(result.renderProvenance.completeness, 'incomplete');
});

test('mutation after rendering revokes the observed expression consumer and cannot be repaired by public copies', () => {
  for (const mutate of [
    f => { f.sum.dst.const = 11n; },
    f => { f.ir.values = [...f.ir.values]; },
    f => { f.result.cAst.body[0].semantic = { ...f.result.cAst.body[0].semantic }; },
  ]) {
    const f = render(fixture());
    assert.ok(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir));
    mutate(f);
    assert.equal(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir), null);
    assert.ok(foldRecords(applyPhase8Projection(f.result, analysis())).every(record => record.renderedBinding === 'unresolved'));
  }
});

test('fold history budgets and cancellation preserve pseudocode and leave unavailable mappings incomplete', () => {
  const baseline = render(fixture()).result.pseudocode;
  for (const options of [
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { shouldAbort:() => true },
  ]) {
    const f = render(fixture(), options);
    assert.equal(f.result.pseudocode, baseline);
    assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
  }
});
