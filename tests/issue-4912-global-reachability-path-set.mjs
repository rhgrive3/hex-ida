import test from 'node:test';
import assert from 'node:assert/strict';

import { VERDICT } from '../js/symbolic/verify/query.js';
import { verifyGlobalEdgeReachability } from '../js/symbolic/verify/global-reachability.js';
import { FakeSolverBackend } from '../js/symbolic/solver/fake-backend.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { bvSort, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { createBv, createCompare, createFreshSymbol } from '../js/symbolic/expr/factory.js';

function block(index, pred = [], succ = []) {
  return { index, pred, succ };
}

function eq(x, value) {
  return createCompare(BV_COMPARE_OP.EQ, x, createBv(2, BigInt(value)));
}

function twoPathIr() {
  return {
    blocks: [
      block(0, [], [{ to: 1 }, { to: 2 }]),
      block(1, [{ from: 0 }], [{ to: 5 }]),
      block(2, [{ from: 0 }], [{ to: 5 }]),
      block(5, [{ from: 1 }, { from: 2 }], []),
    ],
  };
}

function singlePathIr(source) {
  return {
    blocks: [
      block(0, [], [{ to: source }]),
      block(source, [{ from: 0 }], [{ to: 5 }]),
      block(5, [{ from: source }], []),
    ],
  };
}

function pathOf(id, fromBlock, condition) {
  return { complete: true, pathId: id, fromBlock, toBlock: 5, condition };
}

function scopeFor(incomingPaths, extra = {}) {
  return {
    entryBlock: 0,
    targetBlock: 5,
    incomingPaths,
    phiChoices: [],
    phiInventory: { complete: true, count: 0 },
    loopBounds: { complete: true, bounds: [] },
    pathCoverageEvidence: { complete: true, coveredPaths: incomingPaths.length, totalPaths: incomingPaths.length },
    entryPreconditions: [],
    branchPredicates: [],
    ...extra,
  };
}

async function proveOrUnknown({ ir = null, paths, extra = {}, backend }) {
  const x = createFreshSymbol(bvSort(2), 'g4912_x');
  const globalScope = scopeFor(paths(x), extra);
  return verifyGlobalEdgeReachability({
    ir,
    entryBlock: 0,
    targetBlock: 5,
    targetEdge: eq(x, 0),
    pathCompleteness: 'complete',
    backend: backend || new FakeSolverBackend(),
    globalScope,
  });
}

test('#4912 single incoming path derived from CFG still proves', async () => {
  const res = await proveOrUnknown({
    ir: singlePathIr(1),
    paths: (x) => [pathOf('p1', 1, eq(x, 1))],
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(res.verdict, VERDICT.PROVED);
  assert.equal(res.evidence.proofAuthority, 'exact');
});

test('#4912 both enumerated CFG paths prove', async () => {
  const res = await proveOrUnknown({
    ir: twoPathIr(),
    paths: (x) => [pathOf('p1', 1, eq(x, 1)), pathOf('p2', 2, eq(x, 2))],
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(res.verdict, VERDICT.PROVED);
  assert.equal(res.evidence.proofAuthority, 'exact');
});

test('#4912 omitted real CFG path is rejected (counts cannot be self-authority)', async () => {
  const res = await proveOrUnknown({
    ir: twoPathIr(),
    paths: (x) => [pathOf('p1', 1, eq(x, 1))],
    extra: { pathCoverageEvidence: { complete: true, coveredPaths: 1, totalPaths: 1 } },
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'missing-incoming-cfg-path');
});

test('#4912 fabricated CFG path source is rejected', async () => {
  const res = await proveOrUnknown({
    ir: singlePathIr(1),
    paths: (x) => [pathOf('p1', 9, eq(x, 1))],
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'unknown-incoming-cfg-path');
});

test('#4912 duplicate enumerated path is rejected', async () => {
  const res = await proveOrUnknown({
    ir: twoPathIr(),
    paths: (x) => [pathOf('p1', 1, eq(x, 1)), pathOf('p1', 1, eq(x, 1))],
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'duplicate-incoming-cfg-path');
});

test('#4912 reachable-path counterexample never reaches GLOBAL PROVED', async () => {
  const res = await proveOrUnknown({
    ir: twoPathIr(),
    paths: (x) => [pathOf('p1', 1, eq(x, 1))],
    extra: { pathCoverageEvidence: { complete: true, coveredPaths: 1, totalPaths: 1 } },
    backend: new ExhaustiveBvBackend(),
  });
  assert.notEqual(res.verdict, VERDICT.PROVED);
  assert.equal(res.verdict, VERDICT.UNKNOWN);
});

test('#4912 #3215 phi placeholder still rejected without a CFG', async () => {
  const res = await proveOrUnknown({
    paths: (x) => [pathOf('entry', 0, eq(x, 1))],
    extra: { phiChoices: [{ complete: true }], phiInventory: undefined },
  });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'incomplete-phi-choices');
});

test('#4912 loop-bound certificate identity is checked against the path set', async () => {
  const ir = {
    blocks: [
      block(0, [], [{ to: 1 }]),
      block(1, [{ from: 0 }, { from: 2 }], [{ to: 2 }]),
      block(2, [{ from: 1 }], [{ to: 1 }, { to: 5 }]),
      block(5, [{ from: 2 }], []),
    ],
  };
  const bogus = await proveOrUnknown({
    ir,
    paths: (x) => [pathOf('p2', 2, eq(x, 2))],
    extra: { loopBounds: { complete: true, bounds: [{ pathId: 'not-in-path-set' }] } },
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(bogus.verdict, VERDICT.UNKNOWN);
  assert.equal(bogus.reasonCode, 'loop-bound-path-identity-mismatch');

  const consistent = await proveOrUnknown({
    ir,
    paths: (x) => [pathOf('p2', 2, eq(x, 2))],
    extra: { loopBounds: { complete: true, bounds: [{ pathId: 'p2' }] } },
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(consistent.verdict, VERDICT.PROVED);
});
