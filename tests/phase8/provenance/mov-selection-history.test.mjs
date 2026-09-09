import assert from 'node:assert/strict';
import test from 'node:test';
import { enhanceSemanticDecompilation, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { projectionFixture } from '../helpers/proof-fixtures.mjs';
import { optimizeSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { analysis } from './fixture.js';

const records = result => result.renderProvenance.ledger.filter(record => record.rule === 'select-mov-operand');

function fixture({ bits = 32, chain = false, nested = false, repeat = false, precomputed = false,
  memory = false, address = false, operand = {}, recursive = false, mutateOnSymbol = null, options = {} } = {}) {
  const f = irFixture('mov_selection_history'); f.block(0);
  const input = memory ? f.load(bits, { locKind:'global', locKey:'global:32768' }) : f.opaque(bits);
  input.reg = 'x0'; input.signed = false;
  const first = f.copy(input, bits), moved = chain ? f.copy(first, bits) : first;
  Object.assign(first.def.args[0], operand);
  if (precomputed) moved.const = 0n;
  const root = address ? f.load(bits, { locKind:'field', addrBase:moved, disp:0 })
    : nested ? f.binary('xor', moved, f.constant(0n, bits), bits) : moved;
  if (repeat) f.store(root, { locKind:'global', locKey:'global:32776' });
  f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => { inst.id = index + 100; inst.row = index; inst.address = 0x6000n + BigInt(index * 4); });
  ir.blocks[0].startRow = 0;
  const ret = ir.instructions.at(-1); ret.args = [{ value:root }]; root.uses.push(ret);
  const unrelated = { op:'ret', id:999, row:99, address:0x7000n, block:0, args:[{ value:input }] };
  ir.instructions.push(unrelated); ir.blocks[0].insts.push(unrelated);
  // Recursive-only construction lets a nested symbol callback run during MOV,
  // rather than while prebuilding its input earlier in the value array.
  if (recursive || mutateOnSymbol && memory) ir.values.reverse();
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:ir.instructions.filter(inst => ['store', 'ret'].includes(inst.op)).map(inst => ({
      kind:'stmt', indent:1, text:inst.op === 'ret' ? 'return old;' : 'old = value;', row:inst.row, addr:inst.address,
    })), warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const canonical = structuredClone(ir), roots = Object.entries(ir);
  const result = enhanceSemanticDecompilation(seed, { calls:[] }, { deterministicTransforms:true, ...options,
    ...(mutateOnSymbol ? { symbolFor:() => { mutateOnSymbol({ ir, first, moved, input }); return 'global_value'; } } : {}),
  });
  return { result, ir, canonical, roots, input, first, moved, root, ret, unrelated };
}

function assertCanonical(f) {
  assert.deepEqual(structuredClone(f.ir), f.canonical);
  for (const [key, value] of f.roots) assert.equal(f.ir[key], value);
}

test('MOV selection retains copy/input origins across eight widths and both direct and chained producers', () => {
  let cells = 0;
  for (const bits of [1, 2, 3, 4, 8, 16, 32, 64]) for (const chain of [false, true]) {
    const f = fixture({ bits, chain }), result = applyPhase8Projection(f.result, analysis());
    const history = records(result).filter(record => record.valueId === f.moved.id);
    assert.equal(history.length, chain ? 2 : 1, `${bits}/${chain}`);
    for (const record of history) {
      assert.equal(record.proof, 'observed-mov-view-selection-not-equivalence');
      assert.equal(record.renderedBinding, 'producer-bound');
      assert.deepEqual(record.producedRefs, ['L0:stmt']);
      assert.ok(record.originHistory.consumedRefs.includes(`ssa:def:${f.input.id}`));
    }
    for (const value of new Set([f.first, f.moved])) {
      assert.ok(history.some(record => record.originHistory.elidedRefs.includes(`ir:${value.def.id}`)));
      assert.ok(result.renderProvenance.reverse[`addr:${value.def.address}`].includes('L0:stmt'));
    }
    assert.ok(!result.renderProvenance.entities['L1:stmt'].recordRefs.some(index => result.renderProvenance.ledger[index].rule === 'select-mov-operand'));
    assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
    assertCanonical(f); cells++;
  }
  assert.equal(cells, 16, 'source-selection cells, not copy or memory equivalence theorems');
});

test('nested and repeated real consumers retain MOV histories without granting them to an equal input AST', () => {
  const f = fixture({ chain:true, nested:true, repeat:true });
  let result = applyPhase8Projection(f.result, analysis());
  for (const record of records(result).filter(record => record.valueId === f.root.id)) {
    assert.deepEqual(record.producedRefs, ['L0:stmt', 'L1:stmt']);
  }
  assert.equal(records(result).filter(record => record.valueId === f.root.id).length, 2);
  const ledger = result.renderProvenance.ledger;
  for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(result.renderProvenance.ledger, ledger);
  assertCanonical(f);
});

test('existing operand-width, shift and extension views are observed without changing their expression semantics', () => {
  for (const operand of [{ bits:8 }, { shift:{ op:'lsl', amount:2 } }, { shift:{ op:'sxtb', amount:1 } }]) {
    const f = fixture({ bits:64, operand }), result = applyPhase8Projection(f.result, analysis());
    const record = records(result).find(record => record.valueId === f.moved.id);
    assert.equal(record.renderedBinding, 'producer-bound');
    assert.match(record.after, /expression:(unary|binary)/);
    assert.ok(record.originHistory.elidedRefs.includes(`ir:${f.moved.def.id}`));
    assertCanonical(f);
  }
});

test('a copied unresolved memory load retains the load and does not claim memory forwarding', () => {
  const f = fixture({ memory:true }), result = applyPhase8Projection(f.result, analysis());
  const record = records(result).find(record => record.valueId === f.moved.id);
  assert.equal(record.renderedBinding, 'producer-bound');
  assert.equal(f.result.cAst.body[0].semantic.expression.kind, 'load');
  assert.ok(record.originHistory.consumedRefs.includes(`ir:${f.input.def.id}`));
  assert.ok(!record.originHistory.elidedRefs.includes(`ir:${f.input.def.id}`));
  assert.equal(f.input.def.extra.memoryAccess.volatility, 'unknown');
  assertCanonical(f);
});

test('address-mode MOV selection follows the actual load consumer separately from value-mode memoization', () => {
  const f = fixture({ address:true }), result = applyPhase8Projection(f.result, analysis());
  const history = records(result).filter(record => record.valueId === f.root.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].before, 'mov:address');
  assert.equal(history[0].renderedBinding, 'producer-bound');
  assert.deepEqual(history[0].producedRefs, ['L0:stmt']);
  assert.ok(result.renderProvenance.reverse[`addr:${f.moved.def.address}`].includes('L0:stmt'));
  assert.equal(f.result.cAst.body[0].semantic.expression.kind, 'load');
  assert.ok(records(result).filter(record => record.before === 'mov:value').every(record => record.producedRefs.length === 0));
  assertCanonical(f);
});

test('a precomputed constant bypasses MOV selection and cannot invent its unvisited event', () => {
  const f = fixture({ precomputed:true });
  assert.equal(f.result.cAst.body[0].semantic.expression.kind, 'const');
  assert.deepEqual(records(applyPhase8Projection(f.result, analysis())), []);
  assertCanonical(f);
});

test('changed definitions, operand views, roots and copied public consumers cannot forge MOV lineage', () => {
  for (const mutate of [
    f => { f.first.def.args[0].bits = 1; },
    f => { f.first.def.args[0].value = f.moved; },
    f => { f.ir.values = [...f.ir.values]; },
    f => { f.ir.instructions = [...f.ir.instructions]; },
    f => { f.ir.blocks[0].insts.reverse(); },
    f => { f.result.cAst.body[0].semantic = { ...f.result.cAst.body[0].semantic }; },
    f => { f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record })); },
  ]) {
    const f = fixture(); mutate(f);
    const history = records(applyPhase8Projection(f.result, analysis()));
    assert.ok(history.length > 0);
    assert.ok(history.every(record => record.renderedBinding === 'unresolved' && record.producedRefs.length === 0));
  }
});

test('replacing a canonical root by a getter cannot replay MOV producer authority', () => {
  const f = fixture(), semantic = f.result.cAst.body[0].semantic;
  assert.ok(readExpressionHistoryConsumer(semantic, f.ir));
  const original = f.ir.values;
  let reads = 0;
  Object.defineProperty(f.ir, 'values', { enumerable:true, configurable:true, get:() => { reads++; return original; } });
  assert.equal(readExpressionHistoryConsumer(semantic, f.ir), null);
  assert.equal(reads, 0, 'authority check must not invoke the replacement getter');
});

test('a callback inside the selected input cannot certify a MOV whose operand changed during construction', () => {
  let calls = 0;
  const f = fixture({ memory:true, mutateOnSymbol:({ first }) => { calls++; first.def.args[0].bits = 8; } });
  assert.ok(calls > 0);
  const result = applyPhase8Projection(f.result, analysis());
  assert.ok(records(result).every(record => record.renderedBinding === 'unresolved'));
  assert.ok(f.result.expressionHistoryBinding.reasons.includes('mov-selection-observation-unavailable'));
  assert.equal(result.renderProvenance.completeness, 'incomplete');
});

test('MOV history caps and cancellation retain display output but explicitly withhold complete provenance', () => {
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

test('deadline-skipped mandatory representation fallback carries actual MOV build histories', () => {
  const f = fixture({ options:{ deterministicTransforms:false, decompilerTimeBudgetMs:1e-12 } });
  assert.equal(f.result.passMetrics.find(pass => pass.name === 'semantic-rewrite')?.skipped, true);
  assert.ok(records(applyPhase8Projection(f.result, analysis())).some(record => record.renderedBinding === 'producer-bound' && record.producedRefs.includes('L0:stmt')));
  assertCanonical(f);
});

test('a last free MOV history slot is reserved before recursive construction and is not refilled on memo reuse', () => {
  const f = fixture({ chain:true, nested:true, repeat:true, recursive:true,
    options:{ renderProvenanceBudget:{ maxTransformRecords:1 } } });
  const selections = f.result.rewriteProof.filter(record => record.rule === 'select-mov-operand');
  assert.equal(new Set(selections.map(record => record.originHistory)).size, 1);
  assert.ok(f.result.expressionHistoryBinding.reasons.includes('mov-selection-history-budget'));
  assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
  assertCanonical(f);
});

test('query navigation reaches the selected-away MOV at the actual return and refuses a stale query', async () => {
  const f = fixture(), result = applyPhase8Projection(f.result, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'mov-selection-history', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', f.moved.def.address);
  assert.equal(selected.state, 'ready');
  assert.deepEqual(selected.entities.map(entity => entity.lineIndex), [0]);
  assert.ok(selected.transforms.some(record => record.rule === 'select-mov-operand'));
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.moved.def.address)).reason, 'stale-query-snapshot');
});

test('public no-op stack recovery preserves MOV history through real proved replacement and replay', async () => {
  const f = projectionFixture();
  assert.equal(f.result.expressionHistoryBinding.completeness, 'complete');
  assert.ok(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir));
  const canonical = structuredClone(f.ir);
  const first = await optimizeSemanticDecompilation(f.result, f.options);
  assert.equal(first.proofOptimization.status, 'complete');
  assert.ok(first.proofOptimization.adopted > 0);
  assert.ok(records(first).some(record => record.renderedBinding === 'producer-bound' && record.producedRefs.includes('L0:stmt')));
  const replay = await optimizeSemanticDecompilation(first, f.options);
  assert.equal(replay.proofOptimization.status, 'complete');
  assert.equal(replay.proofOptimization.adopted, 0);
  assert.equal(replay.renderProvenance.completeness, 'complete');
  assert.deepEqual(records(replay), records(first));
  assert.deepEqual(structuredClone(f.ir), canonical);
  assert.ok(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir), 'owned proof clone must preserve the original producer too');
});
