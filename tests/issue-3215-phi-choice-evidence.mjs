import test from 'node:test';
import assert from 'node:assert/strict';

import { VERDICT } from '../js/symbolic/verify/query.js';
import { verifyGlobalEdgeReachability } from '../js/symbolic/verify/global-reachability.js';
import { FakeSolverBackend } from '../js/symbolic/solver/fake-backend.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { bvSort, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { createBv, createCompare, createFreshSymbol } from '../js/symbolic/expr/factory.js';

function baseScope() {
  const x = createFreshSymbol(bvSort(2), 'global_x');
  const incoming = createCompare(BV_COMPARE_OP.EQ, x, createBv(2, 1n));
  return {
    x,
    incoming,
    targetEdge: createCompare(BV_COMPARE_OP.EQ, x, createBv(2, 0n)),
    scope: {
      entryBlock: 0,
      targetBlock: 5,
      incomingPaths: [{ id: 'entry-path', fromBlock: 0, toBlock: 5, complete: true, condition: incoming }],
      phiChoices: [],
      phiInventory: { complete: true, count: 0 },
      loopBounds: { complete: true, bounds: [] },
      pathCoverageEvidence: { complete: true, coveredPaths: 1, totalPaths: 1 },
      entryPreconditions: [],
      branchPredicates: [],
    },
  };
}

async function verdict(fixture, backend) {
  return verifyGlobalEdgeReachability({
    entryBlock: 0,
    targetBlock: 5,
    targetEdge: fixture.targetEdge,
    pathCompleteness: 'complete',
    backend,
    globalScope: fixture.scope,
  });
}

test('#3215 { complete: true } phi placeholder is rejected as evidence', async () => {
  const fixture = baseScope();
  fixture.scope.phiChoices = [{ complete: true }];
  const res = await verdict(fixture, new FakeSolverBackend());
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'incomplete-phi-choices');
});

test('#3215 structured phi choices without predecessor/value identity are rejected', async () => {
  const fixture = baseScope();
  fixture.scope.phiChoices = [{ complete: true, phiId: 'phi_1', block: 5 }];
  const res = await verdict(fixture, new FakeSolverBackend());
  assert.equal(res.reasonCode, 'incomplete-phi-choices');
});

test('#3215 empty value identities are rejected', async () => {
  for (const valueId of ['', '   ']) {
    const fixture = baseScope();
    fixture.scope.phiChoices = [{
      complete: true, phiId: 'phi_1', block: 5, predecessorBlock: 0, valueId,
    }];
    const res = await verdict(fixture, new FakeSolverBackend());
    assert.equal(res.verdict, VERDICT.UNKNOWN);
    assert.equal(res.reasonCode, 'incomplete-phi-choices');
  }
});

test('#3215 phi choices must belong to the target block', async () => {
  const fixture = baseScope();
  fixture.scope.phiChoices = [{
    complete: true, phiId: 'phi_1', block: 2, predecessorBlock: 0, valueId: 'v1',
  }];
  const res = await verdict(fixture, new FakeSolverBackend());
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'incomplete-phi-choices');
});

test('#3215 phi choices must reference an enumerated incoming path source', async () => {
  const fixture = baseScope();
  fixture.scope.phiChoices = [{
    complete: true, phiId: 'phi_1', block: 5, predecessorBlock: 9, valueId: 'v1',
  }];
  const res = await verdict(fixture, new FakeSolverBackend());
  assert.equal(res.reasonCode, 'incomplete-phi-choices');
});

test('#3215 empty phi choices require independent zero-count inventory evidence', async () => {
  for (const phiInventory of [undefined, { complete: true }, { complete: true, count: 1 }]) {
    const fixture = baseScope();
    fixture.scope.phiInventory = phiInventory;
    const res = await verdict(fixture, new FakeSolverBackend());
    assert.equal(res.verdict, VERDICT.UNKNOWN);
    assert.equal(res.reasonCode, 'incomplete-phi-choices');
  }
});

test('#3215 fully identified target-block phi choice is admissible evidence', async () => {
  const fixture = baseScope();
  fixture.scope.phiChoices = [{
    complete: true, phiId: 'phi_1', block: 5, predecessorBlock: 0, valueId: 'v1',
  }];
  const res = await verdict(fixture, new ExhaustiveBvBackend());
  assert.equal(res.verdict, VERDICT.PROVED);
  assert.equal(res.evidence.proofAuthority, 'exact');
});

test('#3215 phi-free certificate with inventory evidence still proves', async () => {
  const fixture = baseScope();
  const res = await verdict(fixture, new ExhaustiveBvBackend());
  assert.equal(res.verdict, VERDICT.PROVED);
  assert.equal(res.evidence.proofAuthority, 'exact');
});
