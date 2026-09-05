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
import { recoverExactStackPhiExpressions } from '../../../js/decompiler/passes/stack-phi-recovery.js';

function coerciveValue(counter) {
  return Object.defineProperties({}, {
    valueOf: { get() { counter.count += 1; return () => 1; } },
    [Symbol.toPrimitive]: { get() { counter.count += 1; return () => 1; } },
  });
}

function stackReturnFixture({ includeLoad = true, storeSize = 4, barrier = false, sourceId = 11 } = {}) {
  const key = 'stack:sp:e0:-16:s4';
  const value = { id:100 };
  const store = { id:10, op:'store', block:0, row:0, address:0x1000n, loc:{ kind:'stack', key, size:storeSize }, args:[{ value }] };
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
