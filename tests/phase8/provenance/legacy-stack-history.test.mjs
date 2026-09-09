import assert from 'node:assert/strict';
import test from 'node:test';
import { enhanceSemanticDecompilation as core } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as pipeline } from '../../../js/decompiler/pipeline.js';
import { recoverLegacySameBlockStackSpills, readLegacyStackHistoryConsumer } from '../../../js/decompiler/passes/legacy-stack-recovery.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { structuralKey } from '../../../js/decompiler/ast/nodes.js';
import { readLegacyStackValueHistory } from '../../../js/decompiler/legacy-exact-return-repair.js';
import { analysis } from './fixture.js';

function fixture({ nested = false, barrier = false, mismatch = false, compat = false, publicPipeline = false, options = {} } = {}) {
  const values = [], instructions = [];
  const value = (reg, kind = 'def') => {
    const result = { id:values.length + 1, reg, kind, bits:64, signed:false, uses:[], def:null, const:null };
    values.push(result); return result;
  };
  const inst = (op, dst, args, extra = {}) => {
    const row = instructions.length;
    const result = { id:row + 10, row, address:0x4000n + BigInt(row * 4), block:0, op, dst,
      args:args.map(value => ({ value })), ...extra };
    if (dst) dst.def = result;
    for (const value of args) value.uses.push(result);
    instructions.push(result); return result;
  };
  const input = value('x1', 'arg'), zero = value('x9'), sum = value('x2');
  zero.const = 0n;
  inst('const', zero, [], { extra:{ value:0n } });
  const add = inst('bin', sum, [input, zero], { sub:'add' });
  const location = { kind:'stack', key:'stack:16', disp:16n, size:8 };
  const firstStore = inst('store', null, [sum], { loc:{ ...location, size:mismatch ? 4 : 8 } });
  if (barrier) inst('unknown', null, []);
  const loaded = value(nested ? 'x3' : 'x0');
  const firstLoad = inst('load', loaded, [], { loc:location, reachingStore:firstStore });
  let returned = loaded, lastStore = firstStore, lastLoad = firstLoad;
  if (nested) {
    const outerLocation = { kind:'stack', key:'stack:24', disp:24n, size:8 };
    lastStore = inst('store', null, [loaded], { loc:outerLocation });
    returned = value('x0');
    lastLoad = inst('load', returned, [], { loc:outerLocation, reachingStore:lastStore });
  }
  const ret = inst('ret', null, [returned]);
  const unrelated = inst('ret', null, [input]);
  const ir = { values, instructions, args:new Map([['x1', input]]),
    blocks:[{ index:0, startRow:0, endRow:unrelated.row, pred:[], succ:[], insts:instructions }],
    ...(compat ? { compat:{ projection:'semantic-ir-v2-to-v1' } } : {}) };
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:[firstStore, ...(nested ? [lastStore] : []), ret, unrelated].map(inst => ({ kind:'stmt', indent:1,
      text:inst.op === 'ret' ? 'return old;' : 'old = value;', row:inst.row, addr:inst.address })),
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const opts = { deterministicTransforms:true, ...options };
  const result = (publicPipeline ? pipeline : core)(seed, { calls:[] }, opts);
  return { result, opts, firstStore, firstLoad, lastStore, lastLoad, add, ret, unrelated };
}

for (const nested of [false, true]) test(`C4-03 legacy ${nested ? 'nested' : 'single'} spill histories bind only the actual recovered return`, () => {
  const f = fixture({ nested });
  const returnNode = f.result.cAst.body.find(node => node.semantic?.ir === f.ret.id);
  const before = returnNode.semantic.expression, key = structuralKey(before), source = structuredClone(before.source);
  const canonical = structuredClone(f.result.ir);
  const initialValues = f.result.semanticAst.values.map(item => ({ id:item.valueId, key:structuralKey(item.expression) }));
  recoverLegacySameBlockStackSpills(f.result, f.opts);
  const binding = readLegacyStackHistoryConsumer(returnNode.semantic, f.result.ir);
  assert.ok(binding);
  assert.ok(binding.records.some(record => record.rule === 'legacy-stack-spill-forwarding'));
  assert.ok(binding.records.some(record => record.rule === 'add-zero-right'), JSON.stringify({
    message:'carry the observed stored-value producer history',
    records:binding.records.map(record => ({ rule:record.rule, before:record.before, after:record.after })),
    text:f.result.pseudocode,
    initialValues,
  }));
  let projected = applyPhase8Projection(f.result, analysis());
  const map = projected.renderProvenance, returnRef = `L${nested ? 2 : 1}:stmt`;
  const forwarded = map.ledger.filter(record => ['legacy-stack-spill-forwarding', 'legacy-stack-value-materialization'].includes(record.rule) && record.renderedBinding === 'producer-bound');
  assert.ok(forwarded.length >= (nested ? 2 : 1));
  assert.ok(forwarded.every(record => record.producedRefs.length === 1 && record.producedRefs[0] === returnRef));
  assert.ok(map.reverse[`addr:${f.firstLoad.address}`].includes(returnRef));
  assert.ok(map.reverse[`addr:${f.add.address}`].includes(returnRef));
  assert.ok(!map.reverse[`addr:${f.add.address}`].includes(`L${nested ? 3 : 2}:stmt`), 'shared input is not the add consumer');
  assert.deepEqual(f.result.ir, canonical);
  assert.equal(structuralKey(before), key);
  assert.deepEqual(before.source, source);
  for (let i = 0; i < 4; i++) projected = applyPhase8Projection(projected, analysis());
  assert.equal(projected.renderProvenance.completeness, 'complete');
  assert.deepEqual(projected.renderProvenance.reverse, map.reverse);
});

test('C4-03 public pipeline carries legacy recovery history through later return projection', () => {
  const f = fixture({ nested:true, publicPipeline:true });
  assert.ok(f.result.rewriteProof.some(record => record.rule === 'legacy-stack-spill-forwarding'));
  const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
  assert.ok(map.ledger.some(record => record.rule === 'legacy-stack-spill-forwarding' && record.renderedBinding === 'producer-bound'));
  assert.ok(map.reverse[`addr:${f.firstLoad.address}`].includes('L2:stmt'), JSON.stringify({
    text:f.result.pseudocode, reverse:map.reverse[`addr:${f.firstLoad.address}`],
    records:map.ledger.map(record => ({ rule:record.rule, produced:record.producedRefs })),
  }));
});

test('C4-03 legacy history cannot weaken existing width, barrier or canonical-v2 ownership gates', () => {
  for (const options of [{ mismatch:true }, { barrier:true }, { compat:true }]) {
    const f = fixture(options);
    const before = f.result.cAst.body.find(node => node.semantic?.ir === f.ret.id).semantic.expression;
    recoverLegacySameBlockStackSpills(f.result, f.opts);
    assert.ok(!f.result.rewriteProof.some(record => record.rule === 'legacy-stack-spill-forwarding'));
    assert.equal(f.result.cAst.body.find(node => node.semantic?.ir === f.ret.id).semantic.expression, before);
  }
});

test('C4-03 legacy bindings reject copied descriptors, changed canonical stores and changed expressions', () => {
  for (const mutate of [
    (f, node) => { node.semantic = { ...node.semantic }; },
    (f, node) => { node.semantic.expression = { ...node.semantic.expression }; },
    f => { f.firstStore.loc.size = 4; },
    f => { f.result.ir.instructions = [...f.result.ir.instructions]; },
  ]) {
    const f = fixture();
    recoverLegacySameBlockStackSpills(f.result, f.opts);
    const node = f.result.cAst.body.find(node => node.semantic?.ir === f.ret.id);
    assert.ok(readLegacyStackHistoryConsumer(node.semantic, f.result.ir));
    mutate(f, node);
    assert.equal(readLegacyStackHistoryConsumer(node.semantic, f.result.ir), null);
    const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
    assert.ok(map.ledger.filter(record => record.rule === 'legacy-stack-spill-forwarding')
      .every(record => record.renderedBinding === 'unresolved'));
  }
});

test('C4-03 limited legacy observation/history stays incomplete without changing the recovered code', () => {
  const normal = fixture({ nested:true });
  recoverLegacySameBlockStackSpills(normal.result, normal.opts);
  for (const options of [
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { renderProvenanceBudget:{ maxTransformRecords:1 } },
    { shouldAbort:() => true },
  ]) {
    const f = fixture({ nested:true });
    recoverLegacySameBlockStackSpills(f.result, { ...f.opts, ...options });
    assert.equal(f.result.pseudocode, normal.result.pseudocode);
    assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
    const projected = applyPhase8Projection(f.result, analysis());
    assert.equal(projected.renderProvenance.completeness, 'incomplete');
    assert.equal(applyPhase8Projection(projected, analysis()).renderProvenance.completeness, 'incomplete');
  }
});

test('C4-03 earlier semantic-value materialization retains its actual nested producer records', () => {
  const f = fixture({ nested:true });
  const entry = f.result.semanticAst.values.find(item => item.valueId === f.lastLoad.dst.id);
  const binding = readLegacyStackValueHistory(entry, f.result.ir);
  assert.ok(binding);
  const materializations = binding.records.filter(record => record.rule === 'legacy-stack-value-materialization');
  assert.deepEqual(materializations.map(record => record.valueId), [f.firstLoad.dst.id, f.lastLoad.dst.id]);
  assert.ok(binding.records.some(record => record.rule === 'add-zero-right'));
  assert.ok(binding.records.every(record => f.result.rewriteProof.includes(record)));
  assert.ok(materializations.every(record => Object.isFrozen(record) && Object.isFrozen(record.originHistory)));
});

test('C4-03 semantic-value history rejects copied entries, changed values and canonical-root accessors', () => {
  for (const mode of ['copy', 'value-id', 'expression', 'root-accessor']) {
    const f = fixture({ nested:true });
    let entry = f.result.semanticAst.values.find(item => item.valueId === f.lastLoad.dst.id);
    assert.ok(readLegacyStackValueHistory(entry, f.result.ir));
    let reads = 0;
    if (mode === 'copy') entry = { ...entry };
    if (mode === 'value-id') entry.valueId = 999;
    if (mode === 'expression') entry.expression = { ...entry.expression };
    if (mode === 'root-accessor') {
      const instructions = f.result.ir.instructions;
      Object.defineProperty(f.result.ir, 'instructions', { configurable:true, enumerable:true,
        get() { reads++; return instructions; } });
    }
    assert.equal(readLegacyStackValueHistory(entry, f.result.ir), null);
    assert.equal(reads, 0);
  }
  assert.equal(readLegacyStackValueHistory(undefined, undefined), null);
});

test('C4-03 core materialization exhaustion stays incomplete through the full public pipeline', () => {
  for (const options of [
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { renderProvenanceBudget:{ maxTransformRecords:1 } },
  ]) {
    const f = fixture({ nested:true, publicPipeline:true, options });
    const entry = f.result.semanticAst.values.find(item => item.valueId === f.lastLoad.dst.id);
    assert.equal(entry.expression.kind, 'var', 'materialization still runs when history is bounded');
    const materializations = f.result.rewriteProof.filter(record => record.rule === 'legacy-stack-value-materialization');
    if (options.renderProvenanceBudget) {
      assert.equal(materializations.length, 0, 'the single history slot already contains the inherited core rewrite');
      assert.ok(f.result.expressionHistoryBinding.reasons.includes('legacy-value-history-budget'));
    } else assert.ok(materializations.length > 0);
    assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
    const projected = applyPhase8Projection(f.result, analysis());
    assert.equal(projected.renderProvenance.completeness, 'incomplete');
  }
});

test('C4-03 no-op legacy reruns retain bindings without manufacturing new transformations', () => {
  const f = fixture({ nested:true });
  recoverLegacySameBlockStackSpills(f.result, f.opts);
  const records = f.result.rewriteProof;
  const node = f.result.cAst.body.find(node => node.semantic?.ir === f.ret.id);
  const binding = readLegacyStackHistoryConsumer(node.semantic, f.result.ir);
  recoverLegacySameBlockStackSpills(f.result, f.opts);
  assert.equal(f.result.rewriteProof, records);
  assert.equal(readLegacyStackHistoryConsumer(node.semantic, f.result.ir), binding);
});
