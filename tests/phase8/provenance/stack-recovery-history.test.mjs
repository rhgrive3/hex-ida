import assert from 'node:assert/strict';
import test from 'node:test';
import { expr, sourceOf, structuralKey } from '../../../js/decompiler/ast/nodes.js';
import { recoverExactStackPhiExpressions, readStackPhiHistoryConsumer } from '../../../js/decompiler/passes/stack-phi-recovery.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { analysis } from './fixture.js';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { readStackReturnHistoryConsumer, recoverExactStackReturn } from '../../../js/decompiler/passes/stack-return-recovery.js';

function fixture({ diamond = false, barrier = false, width = 8 } = {}) {
  const address = row => 0x8000n + BigInt(row * 4);
  const origin = inst => sourceOf({ row:inst.row, address:inst.address, ir:inst.id });
  const inst = (id, op, block, extra = {}) => ({ id, op, block, row:id, address:address(id), ...extra });
  const location = { kind:'stack', key:'stack:0:s8', size:8, text:'slot' };
  const a = { id:101, bits:64 }, b = { id:102, bits:64 };
  const aExpr = expr.variable('a', 64, false, { row:20, address:address(20), ssaDef:a.id });
  const bExpr = expr.variable('b', 64, false, { row:21, address:address(21), ssaDef:b.id });
  const branch = inst(0, 'cbr', 0, { extra:{ target:address(3) } });
  const first = inst(1, 'store', diamond ? 1 : 0, { loc:{ ...location, size:width }, args:[{ value:a }] });
  const second = inst(3, 'store', 2, { loc:location, args:[{ value:b }] });
  const call = inst(4, 'call', diamond ? 3 : 0);
  const load = inst(5, 'load', diamond ? 3 : 0, { loc:location });
  const ret = inst(6, 'ret', diamond ? 3 : 0, { args:[] });
  const tail = [...(barrier ? [call] : []), load, ret];
  const instructions = diamond ? [branch, first, second, ...tail] : [first, ...tail];
  const blocks = diamond ? [
    { index:0, startRow:0, endRow:0, pred:[], succ:[1, 2], insts:[branch] },
    { index:1, startRow:1, endRow:2, pred:[0], succ:[3], insts:[first], idom:0 },
    { index:2, startRow:3, endRow:3, pred:[0], succ:[3], insts:[second], idom:0 },
    { index:3, startRow:4, endRow:6, pred:[1, 2], succ:[], insts:tail, idom:0 },
  ] : [{ index:0, pred:[], succ:[], insts:instructions }];
  const expression = expr.load(location, 64, origin(load));
  const node = { kind:'stmt', indent:1, text:'return slot;', source:origin(ret),
    semantic:{ op:'return', expression, ir:ret.id } };
  const result = { semantic:true, ir:{ instructions, blocks, values:[a, b] },
    semanticAst:{ values:[{ valueId:a.id, expression:aExpr }, { valueId:b.id, expression:bExpr }],
      outputs:[{ name:'return', expression }], conditions:diamond ? [{ ir:branch.id,
        expression:expr.compare('ne', aExpr, expr.constant(0, 64), false, origin(branch)) }] : [] },
    cAst:{ body:[node] }, metrics:{} };
  const opts = { deterministicTransforms:true, rowOfAddress:value => Number((value - 0x8000n) / 4n) };
  return { result, opts, node, expression, first, second, branch, load, ret, aExpr };
}

for (const diamond of [false, true]) test(`C4-03 actual ${diamond ? 'two-arm phi' : 'stack forwarding'} recovery binds consumed evidence to its return`, () => {
  const f = fixture({ diamond });
  const canonical = structuredClone(f.result.ir), key = structuralKey(f.expression), source = structuredClone(f.expression.source);
  recoverExactStackPhiExpressions(f.result, f.opts);
  const record = f.result.rewriteProof.find(record => record.rule === 'exact-stack-phi-recovery');
  assert.ok(record.originHistory);
  assert.equal(f.node.semantic.expression.kind, diamond ? 'select' : 'var');
  const projected = applyPhase8Projection(f.result, analysis());
  const map = projected.renderProvenance, normalized = map.ledger.find(item => item.rule === record.rule);
  assert.equal(normalized.renderedBinding, 'producer-bound');
  assert.deepEqual(normalized.producedRefs, ['L0:stmt']);
  for (const inst of [f.first, f.load, f.ret, ...(diamond ? [f.second, f.branch] : [])]) {
    assert.deepEqual(map.reverse[`addr:${inst.address}`], ['L0:stmt']);
    assert.ok(normalized.originHistory.consumedRefs.includes(`ir:${inst.id}`));
  }
  assert.equal(validateRenderProvenance(map).state, 'complete');
  assert.deepEqual(f.result.ir, canonical);
  assert.equal(structuralKey(f.expression), key);
  assert.deepEqual(f.expression.source, source);
  let next = projected;
  for (let i = 0; i < 4; i++) next = applyPhase8Projection(next, analysis());
  assert.deepEqual(next.renderProvenance.reverse, map.reverse);
  assert.equal(next.renderProvenance.completeness, 'complete');
});

test('C4-03 failed width/barrier recovery publishes no applied transform or consumer', () => {
  for (const options of [{ width:4 }, { barrier:true }, { diamond:true, barrier:true }]) {
    const f = fixture(options);
    recoverExactStackPhiExpressions(f.result, f.opts);
    assert.equal(f.result.rewriteProof, undefined);
    assert.equal(f.node.semantic.expression, f.expression);
    assert.equal(readStackPhiHistoryConsumer(f.node.semantic, f.result.ir), null);
  }
});

test('C4-03 recovery bindings reject copies, replacement expressions and changed canonical evidence', () => {
  for (const mutate of [
    f => { f.node.semantic = { ...f.node.semantic }; },
    f => { f.node.semantic.expression = { ...f.node.semantic.expression }; },
    f => { f.result.ir = { ...f.result.ir }; },
    f => { f.first.loc.size = 4; },
    f => { f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record })); },
  ]) {
    const f = fixture();
    recoverExactStackPhiExpressions(f.result, f.opts);
    assert.ok(readStackPhiHistoryConsumer(f.node.semantic, f.result.ir));
    mutate(f);
    const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
    const record = map.ledger.find(record => record.rule === 'exact-stack-phi-recovery');
    assert.equal(record.renderedBinding, 'unresolved');
    assert.deepEqual(record.producedRefs, []);
  }
});

test('C4-03 recovery observation exhaustion is explicit and does not alter recovered code', () => {
  for (const budget of [{ maxConsumers:0 }, { maxEdges:0 }, { maxEdges:1 }]) {
    const f = fixture();
    recoverExactStackPhiExpressions(f.result, { ...f.opts, renderProvenanceBindingBudget:budget });
    assert.equal(f.node.text, 'return a;');
    assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
    const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
    assert.equal(map.completeness, 'incomplete');
    assert.equal(map.ledger[0].renderedBinding, 'unresolved');
  }
  const f = fixture();
  recoverExactStackPhiExpressions(f.result, { ...f.opts, shouldAbort:() => true });
  assert.equal(readStackPhiHistoryConsumer(f.node.semantic, f.result.ir), null);
  assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
});

test('C4-03 repeated successful recovery does not accumulate duplicate transforms', () => {
  const f = fixture({ diamond:true });
  recoverExactStackPhiExpressions(f.result, f.opts);
  const records = f.result.rewriteProof;
  recoverExactStackPhiExpressions(f.result, f.opts);
  assert.equal(f.result.rewriteProof, records);
  assert.equal(records.length, 1);
});

test('C4-03 each recovered return binds only its own reaching store and transform', () => {
  for (const maxConsumers of [4096, 1]) {
    const f = fixture();
    const store = { ...f.first, id:7, row:7, address:0x801cn, args:[{ value:f.result.ir.values[1] }] };
    const load = { ...f.load, id:8, row:8, address:0x8020n };
    const ret = { ...f.ret, id:9, row:9, address:0x8024n };
    const expression = expr.load(load.loc, 64, { ir:load.id, row:load.row, address:load.address });
    f.result.ir.instructions.push(store, load, ret);
    f.result.cAst.body.push({ kind:'stmt', indent:1, text:'return slot;',
      source:sourceOf({ ir:ret.id, row:ret.row, address:ret.address }),
      semantic:{ op:'return', ir:ret.id, expression } });
    recoverExactStackPhiExpressions(f.result, { ...f.opts, renderProvenanceBindingBudget:{ maxConsumers } });
    assert.equal(f.result.rewriteProof.length, 2);
    const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
    assert.deepEqual(map.ledger[0].producedRefs, ['L0:stmt']);
    assert.deepEqual(map.ledger[1].producedRefs, maxConsumers > 1 ? ['L1:stmt'] : []);
    assert.deepEqual(map.reverse[`addr:${f.first.address}`], ['L0:stmt']);
    assert.equal(map.completeness, maxConsumers > 1 ? 'complete' : 'incomplete');
  }
});

test('C4-03 truncated recovery origins cannot assert elision or complete provenance', () => {
  const f = fixture();
  f.expression.source = sourceOf({ rows:Array.from({ length:600 }, (_, index) => index + 100), ir:f.load.id });
  recoverExactStackPhiExpressions(f.result, f.opts);
  const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
  assert.equal(map.completeness, 'incomplete');
  assert.equal(map.ledger[0].originHistory.completeness, 'incomplete');
  assert.deepEqual(map.ledger[0].originHistory.elidedRefs, []);
});

function publicResult(options = {}, booleanReturn = false) {
  const f = fixture({ diamond:true });
  const [a, b] = f.result.ir.values;
  Object.assign(a, { kind:'arg', reg:'x1', uses:[], def:null });
  Object.assign(b, { kind:'arg', reg:'x2', uses:[], def:null });
  const loaded = { id:103, kind:'def', reg:'x0', bits:64, uses:[f.ret], def:f.load };
  f.result.ir.values.push(loaded);
  f.result.ir.args = new Map([['x1', a], ['x2', b]]);
  f.load.dst = loaded;
  f.load.args = [];
  f.ret.args = [{ value:loaded }];
  f.branch.extra.kind = 'cbnz';
  f.branch.args = [{ value:a }];
  if (booleanReturn) {
    const zero = { id:104, kind:'const', bits:64, const:0n, uses:[f.first] };
    const one = { id:105, kind:'const', bits:64, const:1n, uses:[f.second] };
    f.result.ir.values.push(zero, one);
    f.first.args = [{ value:zero }];
    f.second.args = [{ value:one }];
  }
  const result = enhanceSemanticDecompilation({ semantic:true, ir:f.result.ir,
    types:{ values:new Map(), locations:new Map() },
    lines:[{ kind:'stmt', indent:1, text:'return slot;', row:f.ret.row, addr:f.ret.address }],
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' }, { calls:[] }, { ...f.opts, ...options });
  return { f, result };
}

test('C4-03 the public semantic pipeline retains the actual CFG recovery binding', () => {
  const { f, result } = publicResult();
  assert.ok(result.rewriteProof.some(record => record.rule === 'exact-stack-phi-recovery'),
    'must exercise recovery in the production pipeline, not only a prepared AST');
  assert.ok(readStackReturnHistoryConsumer(result.cAst.body[0].semantic, result.ir), JSON.stringify({
    disposition:result.expressionHistoryBinding, rules:result.rewriteProof.map(record => record.rule),
    projection:result.phase8Projection?.history, text:result.pseudocode,
  }));
  let projected = applyPhase8Projection(result, analysis());
  const map = projected.renderProvenance;
  assert.equal(map.ledger.find(record => record.rule === 'exact-stack-phi-recovery').renderedBinding, 'producer-bound');
  assert.equal(map.ledger.find(record => record.rule === 'exact-stack-return-recovery').renderedBinding, 'producer-bound');
  assert.deepEqual(map.reverse[`addr:${f.load.address}`], ['L0:stmt']);
  for (let i = 0; i < 4; i++) projected = applyPhase8Projection(projected, analysis());
  assert.equal(projected.renderProvenance.ledger.filter(record => record.renderedBinding === 'producer-bound').length, 2);
});

test('C4-03 the final return transition rejects copied descriptors and stale CFG/value evidence', () => {
  for (const mutate of [
    ({ result }) => { result.cAst.body[0].semantic = { ...result.cAst.body[0].semantic }; },
    ({ result }) => { result.cAst.body[0].semantic.expression = { ...result.cAst.body[0].semantic.expression }; },
    ({ result }) => { result.ir.instructions = [...result.ir.instructions]; },
    ({ result }) => { result.ir.blocks[3].pred.reverse(); },
    ({ f }) => { f.first.args[0].value.bits = 32; },
  ]) {
    const state = publicResult();
    mutate(state);
    const { result } = state;
    assert.equal(readStackReturnHistoryConsumer(result.cAst.body[0].semantic, result.ir), null);
    const map = applyPhase8Projection(result, analysis()).renderProvenance;
    assert.ok(map.ledger.every(record => record.renderedBinding !== 'producer-bound'));
  }
});

test('C4-03 recovery binding limits remain incomplete through the final public return transition', () => {
  const { result } = publicResult({ renderProvenanceBindingBudget:{ maxEdges:0 } });
  assert.ok(result.rewriteProof.some(record => record.rule === 'exact-stack-return-recovery'));
  const map = applyPhase8Projection(result, analysis()).renderProvenance;
  assert.equal(map.completeness, 'incomplete');
  assert.ok(map.ledger.every(record => record.renderedBinding === 'unresolved'));
});

test('C4-03 canonical-root getters cannot replay recovery bindings or run during validation', () => {
  for (const final of [false, true]) {
    const f = final ? publicResult() : fixture();
    const result = f.result;
    if (!final) recoverExactStackPhiExpressions(result, f.opts);
    const instructions = result.ir.instructions;
    let reads = 0;
    Object.defineProperty(result.ir, 'instructions', { configurable:true, enumerable:true,
      get() { reads++; return instructions; } });
    const read = final ? readStackReturnHistoryConsumer : readStackPhiHistoryConsumer;
    assert.equal(read(result.cAst.body[0].semantic, result.ir), null);
    assert.equal(reads, 0);
  }
});

function simplifyingFixture() {
  const f = fixture({ diamond:true });
  const inner = expr.binary('add', f.aExpr, expr.constant(0, 64), 64, false,
    { ir:901, row:901, address:0xa000n });
  const expression = expr.binary('add', inner, expr.constant(0, 64), 64, false,
    { ir:902, row:902, address:0xa004n });
  f.result.semanticAst.values[0].expression = expression;
  f.result.semanticAst.conditions[0].expression.left = expression;
  f.branch.extra.kind = 'cbnz';
  f.branch.args = [{ value:f.result.ir.values[0] }];
  return f;
}

for (const recover of [recoverExactStackPhiExpressions, recoverExactStackReturn]) {
  test(`C4-03 ${recover.name} publishes real internal simplifications bound to the recovered output`, () => {
    const f = simplifyingFixture(), canonical = structuredClone(f.result.ir);
    recover(f.result, f.opts);
    const records = f.result.rewriteProof.filter(record => record.rule === 'add-zero-right');
    assert.ok(records.length >= 2, 'must actually simplify the nested additions');
    assert.ok(records.every(record => Object.isFrozen(record) && record.originHistory));
    let projected = applyPhase8Projection(f.result, analysis());
    const normalized = projected.renderProvenance.ledger.filter(record => record.rule === 'add-zero-right');
    assert.equal(normalized.length, records.length);
    assert.ok(normalized.every(record => record.renderedBinding === 'producer-bound'));
    assert.ok(normalized.every(record => record.producedRefs.length === 1 && record.producedRefs[0] === 'L0:stmt'));
    assert.deepEqual(projected.renderProvenance.reverse['addr:40960'], ['L0:stmt']);
    assert.deepEqual(projected.renderProvenance.reverse['addr:40964'], ['L0:stmt']);
    assert.deepEqual(f.result.ir, canonical);
    for (let i = 0; i < 4; i++) projected = applyPhase8Projection(projected, analysis());
    assert.equal(projected.renderProvenance.ledger.filter(record => record.rule === 'add-zero-right').length, records.length);
    assert.equal(projected.renderProvenance.completeness, 'complete');
  });

  test(`C4-03 ${recover.name} bounds internal history without changing recovered pseudocode`, () => {
    const normal = simplifyingFixture(), limited = simplifyingFixture();
    recover(normal.result, normal.opts);
    recover(limited.result, { ...limited.opts, renderProvenanceBudget:{ maxTransformRecords:1 } });
    assert.equal(limited.result.pseudocode, normal.result.pseudocode);
    assert.equal(limited.result.rewriteProof.filter(record => record.rule === 'add-zero-right').length, 1);
    assert.ok(limited.result.expressionHistoryBinding.reasons.includes('recovery-rewrite-history-budget'));
    const projected = applyPhase8Projection(limited.result, analysis());
    assert.equal(projected.renderProvenance.completeness, 'incomplete');
    assert.equal(applyPhase8Projection(projected, analysis()).renderProvenance.completeness, 'incomplete');
  });
}

test('C4-03 public pipeline retains boolean-select simplifications across phi and return recovery', () => {
  const { result } = publicResult({}, true);
  const records = result.rewriteProof.filter(record => record.rule === 'select-bool-materialize');
  assert.equal(records.length, 2, 'both actual recovery passes simplify their reconstructed select');
  const binding = readStackReturnHistoryConsumer(result.cAst.body[0].semantic, result.ir);
  assert.ok(records.every(record => binding.records.includes(record)), 'retain the actual engine record objects');
  const map = applyPhase8Projection(result, analysis()).renderProvenance;
  const normalized = map.ledger.filter(record => record.rule === 'select-bool-materialize');
  assert.equal(normalized.length, 2);
  assert.ok(normalized.every(record => record.renderedBinding === 'producer-bound'));
  assert.equal(map.completeness, 'complete');
});

test('C4-03 rejected recovery does not spend history capacity or leak transforms into another return', () => {
  const f = fixture({ diamond:true });
  f.result.semanticAst.values[0].expression = expr.unary('zext', f.aExpr, 128, false);
  f.second.loc = { ...f.second.loc, size:4 }; // First arm simplifies, but the other arm cannot prove the load width.
  const store = { ...f.first, id:8, row:8, address:0x8020n, block:4 };
  const load = { ...f.load, id:9, row:9, address:0x8024n, block:4 };
  const ret = { ...f.ret, id:10, row:10, address:0x8028n, block:4 };
  f.result.ir.instructions.push(store, load, ret);
  f.result.ir.blocks.push({ index:4, pred:[], succ:[], insts:[store, load, ret] });
  f.result.cAst.body.push({ kind:'stmt', indent:1, text:'return other;', source:sourceOf({ ir:ret.id, row:ret.row, address:ret.address }),
    semantic:{ op:'return', ir:ret.id, expression:expr.load(load.loc, 64, { ir:load.id, row:load.row, address:load.address }) } });
  recoverExactStackPhiExpressions(f.result, { ...f.opts, renderProvenanceBudget:{ maxTransformRecords:1 } });
  assert.equal(f.node.semantic.expression, f.expression, 'failed return remains unchanged');
  assert.deepEqual(f.result.rewriteProof.map(record => record.rule), ['trunc-after-zext-to-source-width', 'exact-stack-phi-recovery']);
  assert.notEqual(f.result.expressionHistoryBinding?.completeness, 'incomplete');
  const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
  assert.deepEqual(map.ledger[0].producedRefs, ['L1:stmt']);
  assert.ok(map.ledger[0].originHistory.consumedRefs.includes('ir:8'));
  assert.ok(!map.ledger[0].originHistory.consumedRefs.includes('ir:1'));
  assert.equal(map.completeness, 'complete');
});

test('C4-03 failed nested condition recovery rolls back tentative histories while the outer return succeeds', () => {
  const f = fixture({ diamond:true });
  const location = { kind:'stack', key:'stack:condition:s8', size:8 };
  const input = { id:106, bits:128 };
  f.result.ir.values.push(input);
  f.result.semanticAst.values.push({ valueId:input.id, expression:expr.unary('zext', f.aExpr, 128, false) });
  const first = { id:41, row:2, address:0x9000n, op:'store', block:1, loc:location, args:[{ value:input }] };
  const second = { id:42, row:3, address:0x9004n, op:'store', block:2, loc:{ ...location, size:4 }, args:[{ value:input }] };
  const load = { id:40, row:4, address:0x9008n, op:'load', block:3, loc:location };
  f.result.ir.instructions.push(first, second, load);
  f.result.ir.blocks[1].insts.push(first);
  f.result.ir.blocks[2].insts.push(second);
  f.result.ir.blocks[3].insts.unshift(load);
  f.result.semanticAst.conditions[0].expression = expr.compare('ne',
    expr.load(location, 64, { ir:load.id, row:load.row, address:load.address }), expr.constant(0, 64), false);
  recoverExactStackPhiExpressions(f.result, { ...f.opts, renderProvenanceBudget:{ maxTransformRecords:1 } });
  assert.deepEqual(f.result.rewriteProof.map(record => record.rule), ['exact-stack-phi-recovery']);
  assert.equal(f.node.semantic.expression.kind, 'select');
  assert.equal(f.node.semantic.expression.condition.left.kind, 'load', 'unproven condition load survives');
  const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
  assert.equal(map.completeness, 'complete');
  assert.ok(map.ledger[0].originHistory.producedRefs.includes('ir:40'));
  assert.ok(!map.ledger[0].originHistory.consumedRefs.includes('ir:41'));
  assert.ok(!map.ledger[0].originHistory.consumedRefs.includes('ir:42'));
});
