import assert from 'node:assert/strict';
import test from 'node:test';

import { createBv } from '../../../js/symbolic/expr/factory.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { VERDICT } from '../../../js/symbolic/verify/query.js';
import { verifyBoundedEquivalence } from '../../../js/symbolic/verify/equivalence.js';

// Issue 6093: declared memoryRegions without an encoded memory-state
// comparison must never mint PROVED (fail-closed).
test('6093: non-empty memoryRegions with equal outputs is not PROVED', async () => {
  const res = await verifyBoundedEquivalence({
    beforeTarget: createBv(64, 0n),
    afterTarget: createBv(64, 0n),
    memoryRegions: [{ id: 'heap', start: 0x1000n, size: 8 }],
    backend: new ExhaustiveBvBackend(),
  });
  assert.notEqual(res.verdict, VERDICT.PROVED);
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.notEqual(res.completeness?.memoryEffects, 'complete');
  assert.notEqual(res.completeness?.queryScope, 'complete');
});

test('6093: direct Expr targets do not auto-complete the memory dimension', async () => {
  const res = await verifyBoundedEquivalence({
    beforeTarget: createBv(64, 0n),
    afterTarget: createBv(64, 0n),
    memoryRegions: [{ id: 'heap', start: 0x1000n, size: 8 }],
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(res.completeness?.memoryEffects, 'partial');
});

test('6093: output-only equivalence with empty memoryRegions still proves', async () => {
  const res = await verifyBoundedEquivalence({
    beforeTarget: createBv(64, 0n),
    afterTarget: createBv(64, 0n),
    memoryRegions: [],
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(res.verdict, VERDICT.PROVED);
});

test('6093: proofScope memoryRegions match the declared query scope', async () => {
  const memoryRegions = [{ id: 'heap', start: 0x1000n, size: 8 }];
  const res = await verifyBoundedEquivalence({
    beforeTarget: createBv(64, 0n),
    afterTarget: createBv(64, 0n),
    memoryRegions,
    backend: new ExhaustiveBvBackend(),
  });
  assert.deepEqual(res.query?.proofScope?.memoryRegions, memoryRegions);
  assert.deepEqual(res.query?.targetEntity?.memoryRegions, memoryRegions);
  // Scope claims memory but dimensions report it uncovered: contract holds.
  assert.notEqual(res.completeness?.queryScope, 'complete');
});
