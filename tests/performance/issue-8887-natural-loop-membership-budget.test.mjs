import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeGraph,
  CONTROLFLOW_ANALYSIS_DEFAULT_BUDGET,
  CONTROLFLOW_ANALYSIS_MAXIMUM_BUDGET,
} from '../../js/controlflow.js';

// #8887: `analyzeGraph()` materialized one full node Set per natural-loop header with
// no aggregate resource contract, so a Θ(N)-edge sparse graph could retain Θ(N²)
// loop state and terminate the process inside repository-supported CFG bounds.

function nestingFamily(n) {
  const succ = Array.from({ length: n }, () => []);
  for (let i = 0; i < n - 1; i++) succ[i].push(i + 1);
  for (let h = 0; h < n - 1; h++) succ[n - 1].push(h);
  return succ;
}

function retainedMemberships(graph) {
  let total = 0;
  for (const loop of graph.loops) total += loop.nodes.size;
  return total;
}

test('natural-loop analysis keeps exact membership, latches, and exits below the fence', () => {
  const graph = analyzeGraph([[1], [2], [1, 3], []], 0);
  assert.equal(graph.loopAnalysis.complete, true);
  assert.equal(graph.loopAnalysis.stopReason, null);
  assert.equal(graph.loops.length, 1);
  const [loop] = graph.loops;
  assert.equal(loop.header, 1);
  assert.deepEqual([...loop.latches], [2]);
  assert.deepEqual([...loop.nodes].sort((a, b) => a - b), [1, 2]);
  assert.deepEqual([...loop.exits], [3]);
  assert.equal(graph.loopAnalysis.retainedMemberships, 2);
  assert.equal(graph.loopAnalysis.loops, 1);
  assert.equal(graph.loopAnalysis.budget.maxLoopMemberships, CONTROLFLOW_ANALYSIS_DEFAULT_BUDGET.maxLoopMemberships);
});

test('nested and multi-latch loops still union exactly, and irreducible side entries stay excluded', () => {
  const nested = analyzeGraph([[1], [2], [3, 4], [1], [2]], 0);
  assert.equal(nested.loopAnalysis.complete, true);
  const outer = nested.loopByHeader.get(1);
  const inner = nested.loopByHeader.get(2);
  assert.deepEqual([...inner.nodes].sort((a, b) => a - b), [2, 4]);
  assert.deepEqual([...inner.exits], [3]);
  assert.deepEqual([...outer.nodes].sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(outer.exits.size, 0);
  assert.equal(nested.loopAnalysis.retainedMemberships, 6);

  const irreducible = analyzeGraph([[1], [2, 3], [4], [4], [2]], 0);
  assert.equal(irreducible.loopAnalysis.complete, true);
  assert.equal(irreducible.backEdges.length, 0);
  assert.equal(irreducible.loops.length, 0);
  assert.equal(irreducible.components.length, 4);

  const shared = analyzeGraph([[1], [2, 3], [1], [1]], 0);
  assert.deepEqual([...shared.loopByHeader.get(1).latches].sort((a, b) => a - b), [2, 3]);
  assert.deepEqual([...shared.loopByHeader.get(1).nodes].sort((a, b) => a - b), [1, 2, 3]);
});

test('the Θ(N²) nesting family stops at the configured fence instead of OOMing', () => {
  const n = 2600;
  const before = process.memoryUsage().rss;
  const graph = analyzeGraph(nestingFamily(n), 0);
  const growthMiB = (process.memoryUsage().rss - before) / 1048576;
  assert.equal(graph.loops.length, 0);
  assert.equal(graph.loopByHeader.size, 0);
  assert.equal(graph.loopAnalysis.complete, false);
  assert.equal(graph.loopAnalysis.stopReason, 'loop-membership-budget');
  assert.equal(graph.loopAnalysis.retainedMemberships, 0);
  assert.ok(graph.loopAnalysis.walkSteps <= graph.loopAnalysis.budget.maxLoopWalkSteps);
  assert.ok(graph.loopAnalysis.walkSteps
    <= graph.loopAnalysis.budget.maxLoopMemberships + n,
  `walk ran past the fence: ${graph.loopAnalysis.walkSteps}`);
  assert.ok(growthMiB < 256, `loop analysis retained ${growthMiB.toFixed(0)} MiB of RSS growth`);
  assert.equal(graph.backEdges.length, n - 1);
  assert.equal(graph.loopAnalysis.nodes, n);
  assert.equal(graph.loopAnalysis.edges, 2 * (n - 1));
  assert.equal(graph.postDominators.length, n);
  assert.equal(graph.dominators[0].has(0), true);
});

test('a configured-small budget rejects before over-budget retained state exists', () => {
  const graph = analyzeGraph(nestingFamily(60), 0, null, { budget: { maxLoopMemberships: 200 } });
  assert.equal(graph.loopAnalysis.complete, false);
  assert.equal(graph.loopAnalysis.stopReason, 'loop-membership-budget');
  assert.equal(graph.loopAnalysis.loops, 0);
  assert.equal(retainedMemberships(graph), 0);
});

test('predecessor-walk and exit-scan work are charged to the same contract', () => {
  const walked = analyzeGraph(nestingFamily(60), 0, null, { budget: { maxLoopWalkSteps: 40 } });
  assert.equal(walked.loopAnalysis.complete, false);
  assert.equal(walked.loopAnalysis.stopReason, 'loop-walk-budget');
  assert.equal(walked.loopAnalysis.loops, 0);
  assert.ok(walked.loopAnalysis.walkSteps > 0);
});

test('node/edge over-admission is rejected before graph-wide analysis', () => {
  assert.throws(
    () => analyzeGraph(nestingFamily(50), 0, null, { budget: { maxNodes: 20 } }),
    (error) => error instanceof RangeError && error.message === 'controlflow-graph-node-budget',
  );
  assert.throws(
    () => analyzeGraph(nestingFamily(50), 0, null, { budget: { maxEdges: 20 } }),
    (error) => error instanceof RangeError && error.message === 'controlflow-graph-edge-budget',
  );
  // Raw duplicate/invalid edge slots are admission work too; filtering must not
  // let a hostile row spend unbounded normalization work while canonical edges stay tiny.
  const duplicateHeavy = [[...Array(21).fill(1)], []];
  assert.throws(
    () => analyzeGraph(duplicateHeavy, 0, null, { budget: { maxEdges: 20 } }),
    (error) => error instanceof RangeError && error.message === 'controlflow-graph-edge-budget',
  );
});

test('the contract cannot be bypassed by a caller-supplied budget', () => {
  assert.throws(() => analyzeGraph(nestingFamily(8), 0, null, { budget: { maxLoopMemberships: CONTROLFLOW_ANALYSIS_MAXIMUM_BUDGET.maxLoopMemberships + 1 } }),
    (error) => error instanceof TypeError && error.message === 'controlflow-invalid-budget:maxLoopMemberships');
  assert.throws(() => analyzeGraph(nestingFamily(8), 0, null, { budget: { maxLoopMemberships: Infinity } }),
    (error) => error.message === 'controlflow-invalid-budget:maxLoopMemberships');
  assert.throws(() => analyzeGraph(nestingFamily(8), 0, null, { budget: { unbounded: true } }),
    (error) => error.message === 'controlflow-invalid-budget:unbounded');
  assert.throws(() => analyzeGraph(nestingFamily(8), 0, null, { budget: { maxNodes: 0 } }),
    (error) => error.message === 'controlflow-invalid-budget:maxNodes');
  const graph = analyzeGraph(nestingFamily(60), 0, null, { budget: { maxLoopMemberships: CONTROLFLOW_ANALYSIS_MAXIMUM_BUDGET.maxLoopMemberships } });
  assert.equal(graph.loopAnalysis.complete, true);
  assert.equal(graph.loops.length, 59);
});

test('a linear 6,000-block acyclic chain is still accepted and completes', () => {
  const n = 6000;
  const succ = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : []));
  const graph = analyzeGraph(succ, 0);
  assert.equal(graph.loopAnalysis.complete, true);
  assert.equal(graph.loops.length, 0);
  assert.equal(graph.loopAnalysis.nodes, n);
  assert.equal(graph.reachable.size, n);
});
