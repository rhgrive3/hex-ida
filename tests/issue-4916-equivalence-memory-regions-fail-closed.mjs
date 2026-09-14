import assert from 'node:assert/strict';
import test from 'node:test';

import { createBv } from '../js/symbolic/expr/factory.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { COMPLETENESS_STATUS } from '../js/symbolic/translate/support-matrix.js';
import { VERDICT } from '../js/symbolic/verify/query.js';
import { verifyBoundedEquivalence } from '../js/symbolic/verify/equivalence.js';

const REGIONS = [{ base: 'obj', offset: 0x10, size: 4 }];

test('#4916 same output with declared memoryRegions cannot mint PROVED (fail closed)', async () => {
  const result = await verifyBoundedEquivalence({
    beforeTarget: createBv(32, 0n),
    afterTarget: createBv(32, 0n),
    memoryRegions: REGIONS,
    backend: new ExhaustiveBvBackend(),
  });
  assert.notEqual(result.verdict, VERDICT.PROVED);
  assert.equal(result.verdict, VERDICT.UNKNOWN);
  assert.equal(result.query.completeness.memoryEffects, COMPLETENESS_STATUS.PARTIAL);
  assert.equal(result.query.completeness.queryScope, COMPLETENESS_STATUS.PARTIAL);
});

test('#4916 differing outputs remain REFUTED even with declared memoryRegions', async () => {
  const result = await verifyBoundedEquivalence({
    beforeTarget: createBv(32, 0n),
    afterTarget: createBv(32, 1n),
    memoryRegions: REGIONS,
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(result.verdict, VERDICT.REFUTED);
});

test('#4916 multiple memoryRegions with only one declared still fail closed', async () => {
  const result = await verifyBoundedEquivalence({
    beforeTarget: createBv(32, 7n),
    afterTarget: createBv(32, 7n),
    memoryRegions: [REGIONS[0], { base: 'obj', offset: 0x20, size: 8 }],
    backend: new ExhaustiveBvBackend(),
  });
  assert.notEqual(result.verdict, VERDICT.PROVED);
  assert.equal(result.query.proofScope.memoryRegions.length, 2);
});

test('#4916 pure-output equivalence policy with empty memoryRegions is preserved', async () => {
  const result = await verifyBoundedEquivalence({
    beforeTarget: createBv(32, 5n),
    afterTarget: createBv(32, 5n),
    memoryRegions: [],
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(result.verdict, VERDICT.PROVED);
});

test('#4916 direct Expr targets never report complete memory scope for declared regions', async () => {
  const result = await verifyBoundedEquivalence({
    beforeTarget: createBv(32, 0n),
    afterTarget: createBv(32, 0n),
    memoryRegions: REGIONS,
    backend: new ExhaustiveBvBackend(),
  });
  const scope = result.query.completeness;
  assert.notEqual(scope.memoryEffects, COMPLETENESS_STATUS.COMPLETE);
  assert.notEqual(scope.queryScope, COMPLETENESS_STATUS.COMPLETE);
});
