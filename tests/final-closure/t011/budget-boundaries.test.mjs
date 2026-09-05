import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { expr } from '../../../js/decompiler/ast/nodes.js';
import {
  DEFAULT_PASS_BUDGET,
  PassManager,
} from '../../../js/decompiler/passes/manager.js';
import {
  DEFAULT_REWRITE_BUDGET,
  RewriteEngine,
} from '../../../js/decompiler/rewrite/engine.js';
import {
  exactLegacySameBlockStackStore as canonicalExactLegacySameBlockStackStore,
  materializeLegacyExactStackValues,
} from '../../../js/decompiler/legacy-exact-return-repair.js';
import {
  enhanceSemanticDecompilation as enhancePipeline,
  exactLegacySameBlockStackStore,
} from '../../../js/decompiler/pipeline.js';
import { recoverExactStackPhiExpressions } from '../../../js/decompiler/passes/stack-phi-recovery.js';
import { recoverExactStackReturn } from '../../../js/decompiler/passes/stack-return-recovery.js';
import {
  compilerTruthAccepted,
  compilerTruthGateResult,
} from './compiler-truth-gate.mjs';

function coerciveValue(counter) {
  return Object.defineProperties({}, {
    valueOf: { get() { counter.count += 1; return () => 1; } },
    [Symbol.toPrimitive]: { get() { counter.count += 1; return () => 1; } },
  });
}

function stackReturnFixture({ includeLoad = true, storeSize = 4, barrier = false, sourceId = 11, storeKind = 'stack' } = {}) {
  const key = 'stack:sp:e0:-16:s4';
  const value = { id:100 };
  const store = { id:10, op:'store', block:0, row:0, address:0x1000n, loc:{ kind:storeKind, key, size:storeSize }, args:[{ value }] };
  const load = { id:11, op:'load', block:0, row:2, address:0x1008n, loc:{ kind:'stack', key, size:4 }, args:[] };
  const unknown = { id:12, op:'unknown', block:0, row:1, address:0x1004n, args:[] };
  const ret = { id:13, op:'ret', block:0, row:3, address:0x100cn, args:[] };
  const instructions = [store, ...(barrier ? [unknown] : []), ...(includeLoad ? [load] : []), ret];
  const expression = expr.load({ kind:'stack', key }, 32, { row:load.row, address:load.address, ir:sourceId });
  return {
    semantic:true,
    ir:{ instructions, blocks:[{ index:0, startRow:0, endRow:3, pred:[], succ:[], insts:instructions }], idom:[-1] },
    semanticAst:{
      values:[{ valueId:value.id, expression:expr.constant(11n, 32, true) }],
      conditions:[],
      outputs:[{ name:'return', expression }],
    },
    cAst:{ body:[{
      kind:'stmt', indent:0, text:'return local_0;',
      semantic:{ op:'return', expression },
      source:{ rows:[ret.row], addresses:[ret.address], ir:[ret.id] },
    }] },
    rewriteProof:[],
    metrics:{ rewrittenExpressions:0 },
  };
}

function multiReturnFixture() {
  const key = 'stack:sp:e0:-16:s4';
  const instructions = [];
  const blocks = [];
  const values = [];
  const body = [];
  for (const [index, literal] of [[0, 11n], [1, 22n]]) {
    const value = { id:100 + index };
    const store = { id:10 + index * 3, op:'store', block:index, row:index * 3, address:0x1000n + BigInt(index * 12), loc:{ kind:'stack', key, size:4 }, args:[{ value }] };
    const load = { id:11 + index * 3, op:'load', block:index, row:index * 3 + 1, address:0x1004n + BigInt(index * 12), loc:{ kind:'stack', key, size:4 }, args:[] };
    const ret = { id:12 + index * 3, op:'ret', block:index, row:index * 3 + 2, address:0x1008n + BigInt(index * 12), args:[] };
    const expression = expr.load({ kind:'stack', key }, 32, { row:load.row, address:load.address, ir:load.id });
    instructions.push(store, load, ret);
    blocks.push({ index, startRow:store.row, endRow:ret.row, pred:[], succ:[], insts:[store, load, ret] });
    values.push({ valueId:value.id, expression:expr.constant(literal, 32, true) });
    body.push({
      kind:'stmt', indent:0, text:`return local_${index};`,
      semantic:{ op:'return', expression },
      source:{ rows:[ret.row], addresses:[ret.address], ir:[ret.id] },
    });
  }
  return {
    semantic:true,
    ir:{ compat:{ projection:'semantic-ir-v2-to-v1' }, instructions, blocks, idom:[-1, -1] },
    semanticAst:{ values, conditions:[], outputs:[{ name:'return', expression:body[1].semantic.expression }] },
    cAst:{ body },
    rewriteProof:[],
    metrics:{ rewrittenExpressions:0 },
  };
}

function legacyForgedReachingStoreFixture() {
  const key = 'stack:sp:e0:-16:s4';
  const source = { id:100 };
  const store = { id:10, op:'store', block:0, row:0, loc:{ kind:'stack', key, size:8 }, args:[{ value:source }] };
  const unknown = { id:11, op:'unknown', block:0, row:1 };
  const load = { id:12, op:'load', block:1, row:2, loc:{ kind:'stack', key, size:4 }, reachingStore:store, args:[] };
  return {
    ir:{ values:[source, { id:200, def:load }], instructions:[store, unknown, load], blocks:[
      { index:0, insts:[store, unknown] },
      { index:1, insts:[load] },
    ] },
    semanticAst:{ values:[
      { valueId:100, expression:expr.constant(11n, 32, true) },
      { valueId:200, expression:expr.load({ kind:'stack', key }, 32, { row:load.row, ir:load.id }) },
    ] },
  };
}

function legacyStaleReachingStoreFixture(writerRow = 1, writerKind = 'stack', writerHasKey = true) {
  const key = 'stack:sp:e0:-16:s4';
  const oldSource = { id:100 };
  const newSource = { id:101 };
  const oldStore = { id:10, op:'store', block:0, row:0, loc:{ kind:'stack', key, size:4 }, args:[{ value:oldSource }] };
  const newerStore = { id:11, op:'store', block:0, row:writerRow,
    loc:{ kind:writerKind, ...(writerHasKey ? { key } : {}), size:4 }, args:[{ value:newSource }] };
  const load = { id:12, op:'load', block:0, row:2, loc:{ kind:'stack', key, size:4 }, reachingStore:oldStore, args:[] };
  return {
    ir:{ values:[oldSource, newSource, { id:200, def:load }], instructions:[oldStore, newerStore, load], blocks:[
      { index:0, insts:[oldStore, newerStore, load] },
    ] },
    semanticAst:{ values:[
      { valueId:100, expression:expr.constant(11n, 32, true) },
      { valueId:101, expression:expr.constant(22n, 32, true) },
      { valueId:200, expression:expr.load({ kind:'stack', key }, 32, { row:load.row, ir:load.id }) },
    ] },
  };
}

function stackReturnWriterFixture(mode, writerRow = 1) {
  const key = 'stack:sp:e0:-16:s4';
  const oldValue = { id:100 };
  const newValue = { id:101 };
  const oldStore = { id:10, op:'store', block:0, row:0, address:0x1000n, loc:{ kind:'stack', key, size:4 }, args:[{ value:oldValue }] };
  const malformedRow = mode === 'malformed-row';
  const middle = mode === 'wrong-width'
    ? { id:11, op:'store', block:0, row:1, address:0x1004n, loc:{ kind:'stack', key, size:8 }, args:[{ value:newValue }] }
    : { id:12, op:'store', block:0, row:malformedRow ? writerRow : 2, address:0x1008n, loc:{ kind:'stack', key, size:4 }, args:[{ value:newValue }] };
  const load = mode === 'wrong-width'
    ? { id:13, op:'load', block:0, row:2, address:0x1008n, loc:{ kind:'stack', key, size:4 }, args:[] }
    : { id:11, op:'load', block:0, row:malformedRow ? 2 : 1, address:0x1004n, loc:{ kind:'stack', key, size:4 }, args:[] };
  const ret = { id:14, op:'ret', block:0, row:3, address:0x100cn, args:[] };
  const instructions = mode === 'wrong-width'
    ? [oldStore, middle, load, ret]
    : malformedRow ? [oldStore, middle, load, ret] : [oldStore, load, middle, ret];
  const expression = expr.load({ kind:'stack', key }, 32, { row:load.row, address:load.address, ir:load.id });
  return {
    semantic:true,
    ir:{ instructions, blocks:[{ index:0, startRow:0, endRow:ret.row, pred:[], succ:[], insts:instructions }], idom:[-1] },
    semanticAst:{
      values:[
        { valueId:oldValue.id, expression:expr.constant(11n, 32, true) },
        { valueId:newValue.id, expression:expr.constant(22n, 32, true) },
      ],
      conditions:[],
      outputs:[{ name:'return', expression }],
    },
    cAst:{ body:[{
      kind:'stmt', indent:0, text:'return local_0;',
      semantic:{ op:'return', expression },
      source:{ rows:[ret.row], addresses:[ret.address], ir:[ret.id] },
    }] },
    rewriteProof:[],
    metrics:{ rewrittenExpressions:0 },
  };
}

function detachedNestedLoadFixture() {
  const sourceKey = 'stack:sp:e0:-24:s4';
  const returnKey = 'stack:sp:e0:-16:s4';
  const literal = { id:100 };
  const nested = { id:101 };
  const sourceStore = { id:20, op:'store', block:0, row:0, address:0x2000n,
    loc:{ kind:'stack', key:sourceKey, size:4 }, args:[{ value:literal }] };
  const detachedLoad = { id:90, op:'load', block:0, row:1, address:0x2004n,
    loc:{ kind:'stack', key:sourceKey, size:4 }, args:[] };
  nested.def = detachedLoad;
  const returnStore = { id:21, op:'store', block:0, row:2, address:0x2008n,
    loc:{ kind:'stack', key:returnKey, size:4 }, args:[{ value:nested }] };
  const returnLoad = { id:22, op:'load', block:0, row:3, address:0x200cn,
    loc:{ kind:'stack', key:returnKey, size:4 }, args:[] };
  const ret = { id:23, op:'ret', block:0, row:4, address:0x2010n, args:[] };
  const instructions = [sourceStore, returnStore, returnLoad, ret];
  const expression = expr.load({ kind:'stack', key:returnKey }, 32, { ir:returnLoad.id, row:returnLoad.row });
  return {
    semantic:true,
    ir:{ instructions, blocks:[{ index:0, startRow:0, endRow:4, pred:[], succ:[], insts:instructions }], idom:[-1] },
    semanticAst:{
      values:[
        { valueId:literal.id, expression:expr.constant(11n, 32, true) },
        { valueId:nested.id, expression:expr.load({ kind:'stack', key:sourceKey }, 32) },
      ],
      conditions:[],
      outputs:[{ name:'return', expression }],
    },
    cAst:{ body:[{
      kind:'stmt', indent:0, text:'return local_0;',
      semantic:{ op:'return', expression },
      source:{ rows:[ret.row], addresses:[ret.address], ir:[ret.id] },
    }] },
    rewriteProof:[],
    metrics:{ rewrittenExpressions:0 },
    detachedLoad,
  };
}

test('T011 time budgets require primitive finite nonnegative numbers', () => {
  const counter = { count:0 };
  const malformed = [NaN, Infinity, -Infinity, -1, '40', 40n, new Number(40), coerciveValue(counter)];
  for (const value of malformed) {
    assert.equal(new PassManager([], { timeBudgetMs:value }).budget.timeBudgetMs, DEFAULT_PASS_BUDGET.timeBudgetMs);
    assert.equal(new RewriteEngine([], { timeBudgetMs:value }).budget.timeBudgetMs, DEFAULT_REWRITE_BUDGET.timeBudgetMs);
  }
  assert.equal(counter.count, 0);
  assert.equal(new PassManager([], { timeBudgetMs:0 }).budget.timeBudgetMs, 0);
  assert.equal(new RewriteEngine([], { timeBudgetMs:1.5 }).budget.timeBudgetMs, 1.5);
});

test('T011 pass-local malformed time budgets use the bounded default before the total cap', () => {
  const counter = { count:0 };
  let observed = null;
  new PassManager([{
    name:'local-budget',
    budget:{ timeBudgetMs:coerciveValue(counter) },
    run(state, budget) { observed = budget.timeBudgetMs; return state; },
  }], { timeBudgetMs:100 }).run({ opts:{ deterministicTransforms:true } });
  assert.equal(observed, DEFAULT_PASS_BUDGET.timeBudgetMs);
  assert.equal(counter.count, 0);
});

test('T011 rewrite work limits require primitive nonnegative safe integers', () => {
  const counter = { count:0 };
  const malformed = [NaN, Infinity, -Infinity, -1, 1.5, '12', 12n, new Number(12), coerciveValue(counter)];
  for (const key of ['maxIterations', 'nodeBudget', 'maxApplications']) {
    for (const value of malformed) {
      assert.equal(new RewriteEngine([], { [key]:value }).budget[key], DEFAULT_REWRITE_BUDGET[key]);
    }
    assert.equal(new RewriteEngine([], { [key]:0 }).budget[key], 0);
  }
  assert.equal(counter.count, 0);
});

test('T011 deterministic rewrite mode disables only the deadline', () => {
  const increment = {
    name:'increment',
    phase:'test',
    match(node) { return node?.kind === 'const' ? {} : null; },
    rewrite(node) { return expr.constant(node.value + 1n); },
    proof() { return { reason:'deterministic-budget-regression' }; },
  };
  const engine = new RewriteEngine([increment], {
    deterministic:true,
    timeBudgetMs:0,
    maxIterations:1,
    nodeBudget:4,
    maxApplications:1,
  });
  const result = engine.rewrite(expr.constant(0n));
  assert.equal(result.root.value, 1n);
  assert.equal(result.stats.applications, 1);
  assert.equal(result.stats.budgetExceeded, false);
  assert.deepEqual(engine.budget, {
    deterministic:true,
    timeBudgetMs:0,
    maxIterations:1,
    nodeBudget:4,
    maxApplications:1,
  });
});

test('T011 stack return requires a width-bound physical LOAD and its source provenance', () => {
  const exact = stackReturnFixture();
  recoverExactStackPhiExpressions(exact, { decompilerTimeBudgetMs:50 });
  assert.equal(exact.cAst.body[0].text, 'return 11;');
  assert.equal(exact.metrics.rewrittenExpressions, 1);

  for (const options of [
    { includeLoad:false },
    { storeSize:8 },
    { barrier:true },
    { sourceId:13 },
  ]) {
    const ambiguous = stackReturnFixture(options);
    recoverExactStackPhiExpressions(ambiguous, { decompilerTimeBudgetMs:50 });
    assert.equal(ambiguous.cAst.body[0].text, 'return local_0;');
    assert.equal(ambiguous.metrics.rewrittenExpressions, 0);
  }
});

test('T011 composed PHI then return recovery preserves each physical return', () => {
  const result = multiReturnFixture();
  recoverExactStackPhiExpressions(result, { decompilerTimeBudgetMs:50 });
  assert.deepEqual(result.cAst.body.map((node) => node.text), ['return 11;', 'return 22;']);
  recoverExactStackReturn(result);
  assert.deepEqual(result.cAst.body.map((node) => node.text), ['return 11;', 'return 22;']);
  assert.equal(result.metrics.rewrittenExpressions, 2);
});

test('T011 PHI recovery binds the expression width to the physical LOAD', () => {
  const result = stackReturnFixture();
  result.cAst.body[0].semantic.expression.bits = 64;
  recoverExactStackPhiExpressions(result, { deterministicTransforms:true });
  assert.equal(result.cAst.body[0].text, 'return local_0;');
  assert.equal(result.metrics.rewrittenExpressions, 0);
});

test('T011 PHI recovery reads the slot at LOAD time, before a later writer', () => {
  const result = stackReturnWriterFixture('after-load');
  recoverExactStackPhiExpressions(result, { deterministicTransforms:true });
  assert.equal(result.cAst.body[0].text, 'return 11;');
  assert.equal(result.metrics.rewrittenExpressions, 1);
});

test('T011 PHI recovery does not infer missing or malformed STORE widths from a stack key', () => {
  for (const storeSize of [undefined, null, '4', 4n, new Number(4), NaN, Infinity]) {
    const result = stackReturnFixture({ storeSize });
    result.ir.instructions[0].loc.size = storeSize;
    recoverExactStackPhiExpressions(result, { deterministicTransforms:true });
    assert.equal(result.cAst.body[0].text, 'return local_0;');
    assert.equal(result.metrics.rewrittenExpressions, 0);
  }
  const instructionWidth = stackReturnFixture();
  delete instructionWidth.ir.instructions[0].loc.size;
  instructionWidth.ir.instructions[0].size = 4;
  recoverExactStackPhiExpressions(instructionWidth, { deterministicTransforms:true });
  assert.equal(instructionWidth.cAst.body[0].text, 'return 11;');
});

test('T011 direct PHI recovery rejects malformed STORE rows, including throwing getters', () => {
  for (const row of ['1', 1.5, 1n, new Number(1), null, undefined]) {
    const result = stackReturnFixture();
    result.ir.instructions[0].row = row;
    recoverExactStackPhiExpressions(result, { deterministicTransforms:true });
    assert.equal(result.cAst.body[0].text, 'return local_0;', String(row));
    assert.equal(result.metrics.rewrittenExpressions, 0, String(row));
  }
  const counter = { count:0 };
  const result = stackReturnFixture();
  Object.defineProperty(result.ir.instructions[0], 'row', {
    configurable:true,
    get() { counter.count += 1; throw new Error('row getter must not run'); },
  });
  recoverExactStackPhiExpressions(result, { deterministicTransforms:true });
  assert.equal(result.cAst.body[0].text, 'return local_0;');
  assert.equal(result.metrics.rewrittenExpressions, 0);
  assert.equal(counter.count, 0);
});

test('T011 PHI recovery requires a physical nested LOAD instead of detached value.def metadata', () => {
  const result = detachedNestedLoadFixture();
  recoverExactStackPhiExpressions(result, { deterministicTransforms:true });
  assert.equal(result.cAst.body[0].text, 'return local_0;');
  assert.equal(result.metrics.rewrittenExpressions, 0);
});

test('T011 return fallback rejects width, LOAD, and location-kind ambiguity', () => {
  for (const options of [
    { name:'wrong-width', options:{ storeSize:8 } },
    { name:'missing-physical-load', options:{ includeLoad:false } },
    { name:'non-stack-key-collision', options:{ storeKind:'field' } },
  ]) {
    const result = stackReturnFixture(options.options);
    recoverExactStackPhiExpressions(result, { decompilerTimeBudgetMs:50 });
    recoverExactStackReturn(result);
    assert.equal(result.cAst.body[0].text, 'return local_0;', options.name);
    assert.equal(result.metrics.rewrittenExpressions, 0, options.name);
  }
});

test('T011 legacy reachingStore metadata cannot cross width, block, or unknown barriers', () => {
  const result = legacyForgedReachingStoreFixture();
  materializeLegacyExactStackValues(result);
  const expression = result.semanticAst.values.find((entry) => entry.valueId === 200).expression;
  assert.equal(expression.kind, 'load');
});

test('T011 legacy reachingStore metadata cannot skip a newer same-slot writer', () => {
  const result = legacyStaleReachingStoreFixture();
  materializeLegacyExactStackValues(result);
  const expression = result.semanticAst.values.find((entry) => entry.valueId === 200).expression;
  assert.equal(expression.kind, 'load');
});

test('T011 legacy malformed same-slot writer rows fail closed', () => {
  for (const writerRow of ['1', 1.5, new Number(1)]) {
    const result = legacyStaleReachingStoreFixture(writerRow);
    materializeLegacyExactStackValues(result);
    const expression = result.semanticAst.values.find((entry) => entry.valueId === 200).expression;
    assert.equal(expression.kind, 'load', String(writerRow));
  }
});

test('T011 legacy materialization forwards active cancellation before publication', () => {
  const result = legacyStaleReachingStoreFixture(1);
  let calls = 0;
  materializeLegacyExactStackValues(result, {
    shouldAbort() { calls += 1; return calls >= 2; },
  });
  const expression = result.semanticAst.values.find((entry) => entry.valueId === 200).expression;
  assert.equal(expression.kind, 'load');
  assert.ok(calls >= 2);
});

test('T011 malformed unknown/no-key STORE rows fail closed through legacy and pipeline helpers', () => {
  const result = legacyStaleReachingStoreFixture('1', 'unknown', false);
  materializeLegacyExactStackValues(result);
  const expression = result.semanticAst.values.find((entry) => entry.valueId === 200).expression;
  assert.equal(expression.kind, 'load');
  const load = result.ir.instructions.find((instruction) => instruction.op === 'load');
  assert.equal(exactLegacySameBlockStackStore(load, result.ir), null);
});

test('T011 pipeline legacy helper cannot skip a newer same-slot writer', () => {
  assert.equal(exactLegacySameBlockStackStore, canonicalExactLegacySameBlockStackStore);
  const key = 'stack:sp:e0:-16:s4';
  const oldStore = { id:10, op:'store', block:0, row:0, loc:{ kind:'stack', key, size:4 } };
  const newerStore = { id:11, op:'store', block:0, row:1, loc:{ kind:'stack', key, size:4 } };
  const load = { id:12, op:'load', block:0, row:2, reachingStore:oldStore, loc:{ kind:'stack', key, size:4 } };
  assert.equal(exactLegacySameBlockStackStore(load, {
    blocks:[{ index:0, insts:[oldStore, newerStore, load] }],
  }), null);
});

test('T011 stack-return fallback stops at the authenticated physical LOAD', () => {
  const result = stackReturnWriterFixture('post-load');
  recoverExactStackReturn(result);
  assert.equal(result.cAst.body[0].text, 'return 11;');
  assert.equal(result.metrics.rewrittenExpressions, 1);
});

test('T011 malformed same-slot STORE is a barrier to older stack values', () => {
  const result = stackReturnWriterFixture('wrong-width');
  recoverExactStackReturn(result);
  assert.equal(result.cAst.body[0].text, 'return local_0;');
  assert.equal(result.metrics.rewrittenExpressions, 0);
});

test('T011 malformed same-slot STORE rows fail closed as barriers', () => {
  for (const writerRow of ['1', 1.5, new Number(1)]) {
    const result = stackReturnWriterFixture('malformed-row', writerRow);
    recoverExactStackReturn(result);
    assert.equal(result.cAst.body[0].text, 'return local_0;', String(writerRow));
    assert.equal(result.metrics.rewrittenExpressions, 0, String(writerRow));
  }
});

test('T011 stack recoveries forward early and mid-scan cancellation without partial publication', () => {
  for (const recover of [recoverExactStackPhiExpressions, recoverExactStackReturn]) {
    const early = stackReturnFixture();
    let earlyCalls = 0;
    recover(early, { deterministicTransforms:true, shouldAbort() { earlyCalls += 1; return true; } });
    assert.equal(early.cAst.body[0].text, 'return local_0;');
    assert.equal(early.metrics.rewrittenExpressions, 0);
    assert.ok(earlyCalls > 0);

    const mid = stackReturnFixture();
    const { instructions, blocks } = mid.ir;
    const load = instructions.find((instruction) => instruction.op === 'load');
    const ret = instructions.find((instruction) => instruction.op === 'ret');
    load.row = 64;
    ret.row = 65;
    blocks[0].endRow = ret.row;
    const nops = Array.from({ length:32 }, (_item, index) => ({
      id:1000 + index, op:'nop', block:0, row:1 + index, args:[],
    }));
    mid.ir.instructions = [instructions[0], ...nops, load, ret];
    blocks[0].insts = mid.ir.instructions;
    let midCalls = 0;
    recover(mid, { deterministicTransforms:true, shouldAbort() { midCalls += 1; return midCalls >= 4; } });
    assert.equal(mid.cAst.body[0].text, 'return local_0;');
    assert.equal(mid.metrics.rewrittenExpressions, 0);
    assert.ok(midCalls >= 4);
  }

  const multi = multiReturnFixture();
  let sawFirstPublication = false;
  recoverExactStackPhiExpressions(multi, {
    deterministicTransforms:true,
    shouldAbort() {
      if (multi.cAst.body[0].text === 'return 11;') sawFirstPublication = true;
      return sawFirstPublication;
    },
  });
  assert.deepEqual(multi.cAst.body.map((node) => node.text), ['return local_0;', 'return local_1;']);
  assert.equal(multi.metrics.rewrittenExpressions, 0);
});

test('T011 stack recoveries honor an expired deadline and RewriteEngine rolls back mid-rewrite cancellation', () => {
  for (const recover of [recoverExactStackPhiExpressions, recoverExactStackReturn]) {
    const result = stackReturnFixture();
    recover(result, { deadline:0 });
    assert.equal(result.cAst.body[0].text, 'return local_0;');
    assert.equal(result.metrics.rewrittenExpressions, 0);
  }

  const increment = {
    name:'increment-once',
    phase:'test',
    match(node) { return node?.kind === 'const' ? {} : null; },
    rewrite(node) { return expr.constant(node.value + 1n, node.bits, node.signed); },
    proof() { return { reason:'mid-rewrite-cancellation-regression' }; },
  };
  const root = expr.binary('add', expr.constant(0n, 32, true), expr.constant(1n, 32, true), 32, true);
  const engine = new RewriteEngine([increment], {
    deterministic:true,
    maxIterations:2,
    nodeBudget:32,
    maxApplications:8,
  });
  let calls = 0;
  const result = engine.rewrite(root, {
    deterministicTransforms:true,
    shouldAbort() { calls += 1; return calls >= 6; },
  });
  assert.ok(result.stats.applications >= 1);
  assert.ok(calls >= 6);
  assert.equal(result.root, root);
  assert.equal(result.proof.length, 0);
});

test('T011 stack recoveries honor zero budgets and forward deterministic mode', () => {
  for (const recover of [recoverExactStackPhiExpressions, recoverExactStackReturn]) {
    for (const options of [{ decompilerNodeBudget:0 }, { decompilerTimeBudgetMs:0 }]) {
      const result = stackReturnFixture();
      recover(result, options);
      assert.equal(result.cAst.body[0].text, 'return local_0;');
      assert.equal(result.metrics.rewrittenExpressions, 0);
    }
  }
  const deterministic = stackReturnFixture();
  deterministic.semanticAst.values[0].expression.bits = 64;
  recoverExactStackPhiExpressions(deterministic, {
    decompilerTimeBudgetMs:0,
    deterministicTransforms:true,
  });
  assert.equal(deterministic.cAst.body[0].text, 'return 11;');
  assert.equal(deterministic.metrics.rewrittenExpressions, 1);

  const counter = { count:0 };
  const malformed = stackReturnFixture();
  Object.defineProperty(malformed, 'decompilerTimeBudgetMs', {
    configurable:true,
    get() { counter.count += 1; return 0; },
  });
  // The option object is separate from the result; this descriptor exercises
  // the same coercion boundary without allowing a getter to execute.
  const options = {};
  Object.defineProperty(options, 'decompilerTimeBudgetMs', {
    configurable:true,
    get() { counter.count += 1; return 0; },
  });
  recoverExactStackPhiExpressions(malformed, options);
  assert.equal(counter.count, 0);
  assert.equal(malformed.cAst.body[0].text, 'return 11;');

  for (const key of ['decompilerNodeBudget', 'decompilerTimeBudgetMs']) {
    for (const [index, value] of ['0', 0n, new Number(0), NaN, coerciveValue(counter)].entries()) {
      for (const recover of [recoverExactStackPhiExpressions, recoverExactStackReturn]) {
        const result = stackReturnFixture();
        recover(result, { [key]:value });
        assert.equal(result.cAst.body[0].text, 'return 11;', `${key}:case-${index}`);
        assert.equal(result.metrics.rewrittenExpressions, 1, `${key}:case-${index}`);
      }
    }
  }
  assert.equal(counter.count, 0);
});

test('T011 public pipeline rejects coercive and zero decompiler budgets before core passes', () => {
  const counter = { count:0 };
  const coercive = coerciveValue(counter);
  const base = {
    semantic:true,
    ir:{ instructions:[], blocks:[], values:[] },
    semanticAst:{ values:[], conditions:[], outputs:[] },
    cAst:{ body:[] },
  };
  for (const value of [coercive, '0', 0n, new Number(0), NaN]) {
    const result = structuredClone(base);
    assert.doesNotThrow(() => enhancePipeline(result, null, { decompilerNodeBudget:value }));
    assert.deepEqual(result.cAst.body, []);
  }
  for (const options of [
    { decompilerNodeBudget:0 },
    { decompilerTimeBudgetMs:0 },
    { decompilerIterationCap:0 },
  ]) {
    const result = structuredClone(base);
    const returned = enhancePipeline(result, null, options);
    assert.equal(returned, result);
    assert.deepEqual(result.cAst.body, []);
  }
  assert.equal(counter.count, 0);
});

test('T011 row, block, and provenance values are noncoercive', () => {
  const malformed = [
    result => { result.ir.instructions.find((instruction) => instruction.op === 'load').row = '2'; },
    result => { result.ir.instructions.find((instruction) => instruction.op === 'load').block = '0'; },
    result => { result.ir.instructions.find((instruction) => instruction.op === 'ret').row = new Number(3); },
    result => { result.semanticAst.outputs[0].expression.source.ir = [null]; },
    result => { result.cAst.body[0].source.rows = [null]; },
    result => { result.cAst.body[0].source.ir = [{}]; },
  ];
  for (const mutate of malformed) {
    for (const recover of [recoverExactStackPhiExpressions, recoverExactStackReturn]) {
      const result = stackReturnFixture();
      mutate(result);
      recover(result, { deterministicTransforms:true });
      assert.equal(result.cAst.body[0].text, 'return local_0;');
      assert.equal(result.metrics.rewrittenExpressions, 0);
    }
  }
});

test('T011 stack-return proof keeps scalar widths and rows type-strict', () => {
  const malformed = [
    result => { result.semanticAst.outputs[0].expression.bits = '32'; },
    result => { result.semanticAst.outputs[0].expression.bits = NaN; },
    result => { result.ir.instructions.find((inst) => inst.op === 'load').row = '2'; },
    result => { result.ir.instructions.find((inst) => inst.op === 'load').row = NaN; },
  ];
  for (const mutate of malformed) {
    const result = stackReturnFixture();
    mutate(result);
    recoverExactStackReturn(result);
    assert.equal(result.cAst.body[0].text, 'return local_0;');
    assert.equal(result.metrics.rewrittenExpressions, 0);
  }
});

test('T011 deterministic PassManager mode does not report a disabled deadline', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let tick = 0;
  Object.defineProperty(globalThis, 'performance', { configurable:true, value:{ now:() => ++tick } });
  try {
    const state = new PassManager([
      { name:'deterministic', run:innerState => innerState },
    ], { timeBudgetMs:0 }).run({ opts:{ deterministicTransforms:true } });
    assert.equal(state.degraded, undefined);
    assert.equal(state.passDeadlineExceeded, false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'performance', descriptor);
    else delete globalThis.performance;
  }
});

test('T011 compiler truth requires every real C, extended, C++, and Objective-C denominator', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(testDirectory, '../../..');
  const gate = compilerTruthGateResult({ repositoryRoot });
  assert.equal(gate.status, 0, String(gate.stderr || gate.stdout || 'compiler-truth command failed').slice(-4000));
  assert.equal(gate.accepted, true, 'empty, skipped, or incomplete compiler truth must not pass T011');

  // The canonical suites historically exited zero with clang unavailable and
  // reported zero executed cases. Run that real path with a missing compiler;
  // the T011 gate must reject the resulting 0-of-0 summaries.
  const unavailable = compilerTruthGateResult({
    repositoryRoot,
    env: { ...process.env, CLANG:'/definitely/missing/t011-clang' },
  });
  assert.equal(unavailable.status, 0, 'unavailable compiler should still produce canonical diagnostics');
  assert.equal(unavailable.summaries.core?.clangAvailable, false);
  assert.equal(unavailable.summaries.core?.executed, 0);
  assert.equal(unavailable.accepted, false, 'unavailable/0-of-0 compiler truth must fail T011');

  // Keep the pure evaluator negative for a missing or truncated output, too.
  assert.equal(compilerTruthAccepted({
    core:{ clangAvailable:false, executed:0, expectedCases:0, hardFailures:0, results:[] },
    extended:{ clangAvailable:false, executed:0, results:[] },
    languages:{
      cpp:{ status:'skipped', executed:0, semanticChecks:0, rows:[] },
      objc:{ status:'skipped', executed:0, semanticChecks:0, rows:[] },
    },
  }), false);
  assert.equal(compilerTruthAccepted({ core:null, extended:null, languages:null }), false);
});
