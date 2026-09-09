import assert from 'node:assert/strict';
import test from 'node:test';
import { enhanceSemanticDecompilation, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis } from './fixture.js';

const rule = 'select-address-load-store-operand';
const records = result => result.renderProvenance.ledger.filter(record => record.rule === rule);

function fixture({ bits = 32, moved = false, repeat = false, publicPipeline = false, mode = 'selected', onSymbol = null, options = {} } = {}) {
  const f = irFixture('address_load_history'); f.block(0);
  const input = onSymbol ? f.constant(4096n, bits) : f.opaque(bits);
  input.reg = 'x0'; input.signed = false;
  if (onSymbol) input.def.op = 'addr';
  const stored = moved ? f.copy(input, bits) : input;
  const store = f.store(stored, { locKind:'global', locKey:'global:32768' });
  const pointer = f.load(bits, { locKind:'global', locKey:'global:32768' });
  pointer.def.loc.address = 32768n;
  if (mode !== 'absent') pointer.def.reachingStore = mode === 'self' ? pointer.def : mode === 'copied' ? { ...store } : store;
  if (mode === 'precomputed') pointer.const = 4096n;
  const root = f.load(bits, { locKind:'field', addrBase:pointer, disp:0 });
  const repeated = repeat ? f.store(root, { locKind:'global', locKey:'global:32776' }) : null;
  f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => { inst.id = index + 200; inst.row = index; inst.address = 0x6000n + BigInt(index * 4); });
  ir.blocks[0].startRow = 0;
  const ret = ir.instructions.at(-1); ret.args = [{ value:root }]; root.uses.push(ret);
  const unrelated = { op:'ret', id:999, row:99, address:0x7000n, block:0, args:[{ value:pointer }] };
  ir.instructions.push(unrelated); ir.blocks[0].insts.push(unrelated);
  if (onSymbol) ir.values.reverse();
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:[repeated, ret, unrelated].filter(Boolean).map(inst => ({ kind:'stmt', indent:1,
      text:inst.op === 'ret' ? 'return old;' : 'old = value;', row:inst.row, addr:inst.address })),
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const canonical = structuredClone(ir), roots = Object.entries(ir);
  const result = (publicPipeline ? enhancePublic : enhanceSemanticDecompilation)(seed, { calls:[] }, { deterministicTransforms:true, ...options,
    ...(onSymbol ? { symbolFor:address => { if (address === 4096n) onSymbol({ ir, store, pointer, input }); return 'global_value'; } } : {}),
  });
  return { result, ir, canonical, roots, store, stored, pointer, root, input, ret };
}

function assertCanonical(f) {
  assert.deepEqual(structuredClone(f.ir), f.canonical);
  for (const [key, value] of f.roots) assert.equal(f.ir[key], value);
}

test('actual address-load selection retains the load, chosen store and input across eight widths', () => {
  for (const bits of [1, 2, 3, 4, 8, 16, 32, 64]) {
    const f = fixture({ bits }), result = applyPhase8Projection(f.result, analysis());
    const [record] = records(result);
    assert.equal(records(result).length, 1);
    assert.equal(record.valueId, f.root.id);
    assert.equal(record.proof, 'observed-address-load-selection-not-memory-equivalence');
    assert.equal(record.renderedBinding, 'producer-bound');
    assert.deepEqual(record.producedRefs, ['L0:stmt']);
    for (const inst of [f.pointer.def, f.store]) {
      assert.ok(record.originHistory.consumedRefs.includes(`ir:${inst.id}`));
      assert.ok(result.renderProvenance.reverse[`addr:${inst.address}`].includes('L0:stmt'));
    }
    assert.ok(record.originHistory.consumedRefs.includes(`ssa:def:${f.stored.id}`));
    assert.ok(record.originHistory.elidedRefs.includes(`ir:${f.pointer.def.id}`));
    assert.equal(f.pointer.def.extra.memoryAccess.volatility, 'unknown');
    assert.equal(f.result.cAst.body[1].semantic.expression.kind, 'load', 'value-mode use retains the original load');
    assert.ok(!result.renderProvenance.entities['L1:stmt'].recordRefs.some(index => result.renderProvenance.ledger[index].rule === rule));
    assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
    assertCanonical(f);
  }
});

test('nested MOV history follows the actual selected operand and repeated final consumers through replay', () => {
  const f = fixture({ moved:true, repeat:true });
  let result = applyPhase8Projection(f.result, analysis());
  const selected = result.renderProvenance.ledger.filter(record => record.valueId === f.root.id && [rule, 'select-mov-operand'].includes(record.rule));
  assert.equal(selected.length, 2);
  for (const record of selected) assert.deepEqual(record.producedRefs, ['L0:stmt', 'L1:stmt']);
  const ledger = result.renderProvenance.ledger;
  for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(result.renderProvenance.ledger, ledger);
  assertCanonical(f);
});

test('the public pipeline retains the address-load producer through compatibility recovery and final projection', () => {
  const f = fixture({ moved:true, publicPipeline:true });
  const result = applyPhase8Projection(f.result, analysis());
  assert.equal(records(result).length, 1);
  assert.equal(records(result)[0].renderedBinding, 'producer-bound');
  assert.deepEqual(records(result)[0].producedRefs, ['L0:stmt']);
  assert.equal(result.renderProvenance.completeness, 'complete');
  assertCanonical(f);
});

test('absent/self reaching stores and precomputed constants do not invent an unvisited address-load event', () => {
  for (const mode of ['absent', 'self', 'precomputed']) {
    const f = fixture({ mode });
    assert.deepEqual(records(applyPhase8Projection(f.result, analysis())), []);
    assertCanonical(f);
  }
});

test('a copied nonmember store cannot issue an observed canonical selection even with equal IDs and text', () => {
  const f = fixture({ mode:'copied' }), result = applyPhase8Projection(f.result, analysis());
  assert.deepEqual(records(result), []);
  assert.ok(f.result.expressionHistoryBinding.reasons.includes('address-load-selection-observation-unavailable'));
  assert.equal(result.renderProvenance.completeness, 'incomplete');
  assertCanonical(f);
});

test('edited load/store/input roots and public consumers lose the address-load lineage', () => {
  for (const mutate of [
    f => { f.pointer.def.reachingStore = { ...f.store }; },
    f => { f.store.args[0].value = f.pointer; },
    f => { f.store.args[0].bits = 1; },
    f => { f.ir.instructions = [...f.ir.instructions]; },
    f => { f.ir.blocks[0].insts = [...f.ir.blocks[0].insts]; },
    f => { f.result.cAst.body[0].semantic = { ...f.result.cAst.body[0].semantic }; },
    f => { f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record })); },
  ]) {
    const f = fixture(); mutate(f);
    const history = records(applyPhase8Projection(f.result, analysis()));
    assert.ok(history.length > 0);
    assert.ok(history.every(record => record.renderedBinding === 'unresolved' && record.producedRefs.length === 0));
  }
});

test('a replacement store-position getter cannot replay private address-load authority', () => {
  const f = fixture(), semantic = f.result.cAst.body[0].semantic;
  assert.ok(readExpressionHistoryConsumer(semantic, f.ir));
  let reads = 0;
  const index = f.ir.blocks[0].insts.indexOf(f.store);
  Object.defineProperty(f.ir.blocks[0].insts, index, { enumerable:true, configurable:true, get:() => { reads++; return f.store; } });
  assert.equal(readExpressionHistoryConsumer(semantic, f.ir), null);
  assert.equal(reads, 0);
});

test('a symbol callback inside the selected store operand cannot bind changed input views', () => {
  let calls = 0;
  const f = fixture({ onSymbol:({ store }) => { calls++; store.args[0].bits = 8; } });
  assert.ok(calls > 0);
  const result = applyPhase8Projection(f.result, analysis());
  assert.ok(records(result).every(record => record.renderedBinding === 'unresolved'));
  assert.ok(f.result.expressionHistoryBinding.reasons.includes('address-load-selection-observation-unavailable'));
  assert.equal(result.renderProvenance.completeness, 'incomplete');
});

test('bounded/cancelled address-load history preserves existing output while remaining explicitly incomplete', () => {
  const baseline = fixture().result.pseudocode;
  for (const options of [
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { shouldAbort:() => true },
  ]) {
    const f = fixture({ options });
    assert.equal(f.result.pseudocode, baseline);
    assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
    assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
    assertCanonical(f);
  }
});

test('mandatory representation fallback retains address-load selection without running optional rewrites', () => {
  const f = fixture({ options:{ deterministicTransforms:false, decompilerTimeBudgetMs:1e-12 } });
  assert.equal(f.result.passMetrics.find(pass => pass.name === 'semantic-rewrite')?.skipped, true);
  assert.ok(records(applyPhase8Projection(f.result, analysis())).some(record => record.renderedBinding === 'producer-bound'));
  assertCanonical(f);
});

test('MOV and address-load producers share the same reserved selection-history allowance', () => {
  const f = fixture({ moved:true, repeat:true, options:{ renderProvenanceBudget:{ maxTransformRecords:1 } } });
  const selected = f.result.rewriteProof.filter(record => [rule, 'select-mov-operand'].includes(record.rule));
  assert.equal(new Set(selected.map(record => record.originHistory)).size, 1);
  assert.ok(f.result.expressionHistoryBinding.reasons.includes('address-load-selection-history-budget'));
  assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
  assertCanonical(f);
});

test('query reverse navigation resolves the selected load and store to the real consumer and rejects stale snapshots', async () => {
  const f = fixture(), result = applyPhase8Projection(f.result, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'address-load-history', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  for (const inst of [f.store, f.pointer.def]) {
    const selected = await navigation.selectOrigin('addr', inst.address);
    assert.equal(selected.state, 'ready');
    assert.ok(selected.entities.some(entity => entity.lineIndex === 0));
    assert.ok(selected.transforms.some(record => record.rule === rule));
  }
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.store.address)).reason, 'stale-query-snapshot');
});
