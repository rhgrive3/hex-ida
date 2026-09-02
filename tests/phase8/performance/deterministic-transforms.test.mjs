import assert from 'node:assert/strict';

import { expr } from '../../../js/decompiler/ast/nodes.js';
import { PassManager } from '../../../js/decompiler/passes/manager.js';
import { RewriteEngine } from '../../../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../../../js/decompiler/rewrite/rules.js';

const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
let tick = 0;
Object.defineProperty(globalThis, 'performance', {
  configurable: true,
  value: { now: () => ++tick },
});

try {
  const skipped = [];
  new PassManager([
    { name: 'optional-a', run: (state) => { skipped.push('a'); return state; } },
    { name: 'optional-b', run: (state) => { skipped.push('b'); return state; } },
  ], { timeBudgetMs: 0 }).run({ opts: {} });
  assert.deepEqual(skipped, [], 'production wall-clock exhaustion must still skip optional passes');

  const completed = [];
  const deterministicState = new PassManager([
    { name: 'optional-a', run: (state, budget) => { completed.push(['a', budget]); return state; } },
    { name: 'optional-b', run: (state, budget) => { completed.push(['b', budget]); return state; } },
  ], { timeBudgetMs: 0 }).run({ opts: { deterministicTransforms: true } });
  assert.deepEqual(completed.map(([name]) => name), ['a', 'b']);
  assert.ok(completed.every(([, budget]) => budget.deterministic === true
    && budget.deadline === Infinity && budget.shouldAbort() === false));
  assert.equal(deterministicState.degraded, undefined);
  assert.ok(deterministicState.passMetrics.every((metric) => metric.skipped !== true));

  const input = expr.binary('add', expr.variable('x', 32, true), expr.constant(0, 32, true), 32, true);
  const timed = new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: 0 }).rewrite(input);
  assert.equal(timed.stats.budgetExceeded, true);
  assert.equal(timed.root.kind, 'binary');

  const deterministic = new RewriteEngine(DEFAULT_RULES, {
    timeBudgetMs: 0,
    deterministic: true,
  }).rewrite(input);
  assert.equal(deterministic.stats.budgetExceeded, false);
  assert.equal(deterministic.root.kind, 'var');
  assert.equal(deterministic.root.name, 'x');
} finally {
  if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor);
  else delete globalThis.performance;
}

console.log('phase8 deterministic transform wall-clock isolation: PASS');
