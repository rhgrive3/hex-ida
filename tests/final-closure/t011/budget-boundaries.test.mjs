import assert from 'node:assert/strict';
import test from 'node:test';

import { expr } from '../../../js/decompiler/ast/nodes.js';
import {
  DEFAULT_PASS_BUDGET,
  PassManager,
} from '../../../js/decompiler/passes/manager.js';
import {
  DEFAULT_REWRITE_BUDGET,
  RewriteEngine,
} from '../../../js/decompiler/rewrite/engine.js';
import { materializeLegacyExactStackValues } from '../../../js/decompiler/legacy-exact-return-repair.js';
import { recoverExactStackPhiExpressions } from '../../../js/decompiler/passes/stack-phi-recovery.js';
import { recoverExactStackReturn } from '../../../js/decompiler/passes/stack-return-recovery.js';

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

function legacyStaleReachingStoreFixture() {
  const key = 'stack:sp:e0:-16:s4';
  const oldSource = { id:100 };
  const newSource = { id:101 };
  const oldStore = { id:10, op:'store', block:0, row:0, loc:{ kind:'stack', key, size:4 }, args:[{ value:oldSource }] };
  const newerStore = { id:11, op:'store', block:0, row:1, loc:{ kind:'stack', key, size:4 }, args:[{ value:newSource }] };
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

function stackReturnWriterFixture(mode) {
  const key = 'stack:sp:e0:-16:s4';
  const oldValue = { id:100 };
  const newValue = { id:101 };
  const oldStore = { id:10, op:'store', block:0, row:0, address:0x1000n, loc:{ kind:'stack', key, size:4 }, args:[{ value:oldValue }] };
  const middle = mode === 'wrong-width'
    ? { id:11, op:'store', block:0, row:1, address:0x1004n, loc:{ kind:'stack', key, size:8 }, args:[{ value:newValue }] }
    : { id:12, op:'store', block:0, row:2, address:0x1008n, loc:{ kind:'stack', key, size:4 }, args:[{ value:newValue }] };
  const load = mode === 'wrong-width'
    ? { id:13, op:'load', block:0, row:2, address:0x1008n, loc:{ kind:'stack', key, size:4 }, args:[] }
    : { id:11, op:'load', block:0, row:1, address:0x1004n, loc:{ kind:'stack', key, size:4 }, args:[] };
  const ret = { id:14, op:'ret', block:0, row:3, address:0x100cn, args:[] };
  const instructions = mode === 'wrong-width'
    ? [oldStore, middle, load, ret]
    : [oldStore, load, middle, ret];
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
