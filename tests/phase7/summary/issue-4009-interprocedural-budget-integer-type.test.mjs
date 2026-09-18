import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSummaryGraph } from '../corpus/summaries.mjs';
import {
  condenseCallGraph,
  solveInterproceduralSummaries,
} from '../../../js/analysis/summary/interprocedural.js';

const GRAPH_KEYS = ['maxComponents', 'maxNodes', 'maxEdges'];
const SOLVE_KEYS = ['maxComponents', 'maxNodes', 'maxEdges', 'maxIterationsPerComponent', 'maxEffectsPerSummary'];

function runGraphBudget(key, value) {
  return condenseCallGraph(['fn-A'], () => [], { [key]: value });
}

function runSolveBudget(key, value) {
  return solveInterproceduralSummaries({
    roots: ['fn_self'],
    localSummaries: buildSummaryGraph('self-recursive'),
    budget: { [key]: value },
  });
}

function invalidValues(validNumber) {
  let coercions = 0;
  const coercible = { valueOf() { coercions += 1; return validNumber; } };
  return {
    count: () => coercions,
    values: [
      String(validNumber),
      [String(validNumber)],
      [validNumber],
      true,
      false,
      {},
      [validNumber, validNumber],
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      coercible,
    ],
  };
}

test('#4009 condenseCallGraph rejects structured and boolean graph budgets', () => {
  for (const key of GRAPH_KEYS) {
    const candidates = invalidValues(10);
    for (const value of candidates.values) {
      assert.throws(
        () => runGraphBudget(key, value),
        (error) => error instanceof TypeError && error.message === `interprocedural-invalid-budget-${key}`,
        `${key} must reject ${Object.prototype.toString.call(value)}`,
      );
    }
    assert.equal(candidates.count(), 0, `${key} must not run user-controlled coercion`);
  }
});

test('#4009 solver rejects structured and boolean iteration and effect budgets', () => {
  for (const key of SOLVE_KEYS) {
    const candidates = invalidValues(4);
    for (const value of candidates.values) {
      assert.throws(
        () => runSolveBudget(key, value),
        (error) => error instanceof TypeError && error.message === `interprocedural-invalid-budget-${key}`,
        `${key} must reject ${Object.prototype.toString.call(value)}`,
      );
    }
    assert.equal(candidates.count(), 0, `${key} must not run user-controlled coercion`);
  }
});

test('#4009 malformed budget never truncates a normal one-node graph', () => {
  assert.throws(() => runGraphBudget('maxComponents', ['0']), TypeError);
  assert.throws(() => runGraphBudget('maxNodes', ['1']), TypeError);
  assert.throws(() => runGraphBudget('maxEdges', true), TypeError);
  assert.throws(() => runSolveBudget('maxIterationsPerComponent', ['0']), TypeError);
  assert.throws(() => runSolveBudget('maxComponents', '0'), TypeError);
});

test('#4009 nullish budgets keep documented defaults', () => {
  const graph = condenseCallGraph(['A', 'B'], () => [], {
    maxComponents: null,
    maxNodes: undefined,
    maxEdges: null,
  });
  assert.equal(graph.truncated, false);
  assert.deepEqual(graph.components, [['A'], ['B']]);

  const solved = solveInterproceduralSummaries({
    roots: ['fn_self'],
    localSummaries: buildSummaryGraph('self-recursive'),
    budget: { maxIterationsPerComponent: null, maxEffectsPerSummary: undefined, maxComponents: null },
  });
  assert.equal(solved.summaries.get('fn_self').status.completeness, 'complete');
});

test('#4009 primitive non-negative safe integers keep existing limit semantics', () => {
  const filled = condenseCallGraph(['A'], () => [], { maxComponents: 1, maxNodes: 10, maxEdges: 10 });
  assert.equal(filled.truncated, false);
  const overflow = condenseCallGraph(['A', 'B'], () => [], { maxComponents: 1, maxNodes: 10, maxEdges: 10 });
  assert.equal(overflow.truncated, true);
  const zeroNodes = condenseCallGraph(['A'], () => [], { maxComponents: 4, maxNodes: 0 });
  assert.equal(zeroNodes.truncated, true);
  const zeroEffects = solveInterproceduralSummaries({
    roots: ['fn_self'],
    localSummaries: buildSummaryGraph('self-recursive'),
    budget: { maxEffectsPerSummary: 0 },
  });
  assert.ok(zeroEffects.summaries.get('fn_self').memoryWriteRegions.length >= 1);
});

test('#4009 maxIterationsPerComponent 0 still forces immediate non-convergence', () => {
  const solved = solveInterproceduralSummaries({
    roots: ['fn_self'],
    localSummaries: buildSummaryGraph('self-recursive'),
    budget: { maxIterationsPerComponent: 0 },
  });
  const summary = solved.summaries.get('fn_self');
  assert.ok(summary);
  assert.notEqual(summary.status.completeness, 'complete');
  assert.ok(summary.unknownCallEffects.some((effect) => effect.reason === 'recursion-unconverged'));
});

test('#4009 recursive component iteration budget regression stays bounded', () => {
  const converged = solveInterproceduralSummaries({
    roots: ['fn_self'],
    localSummaries: buildSummaryGraph('self-recursive'),
    budget: { maxIterationsPerComponent: 16 },
  });
  const starved = solveInterproceduralSummaries({
    roots: ['fn_self'],
    localSummaries: buildSummaryGraph('self-recursive'),
    budget: { maxIterationsPerComponent: 1 },
  });
  assert.equal(converged.iterations, 2);
  assert.equal(starved.iterations, 1);
  assert.ok(starved.summaries.get('fn_self').unknownCallEffects
    .some((effect) => effect.reason === 'recursion-unconverged'));
});
