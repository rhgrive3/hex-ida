import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort } from '../js/symbolic/expr/kinds.js';
import { createBv } from '../js/symbolic/expr/factory.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { VERDICT } from '../js/symbolic/verify/query.js';
import { verifyBoundedEquivalence } from '../js/symbolic/verify/equivalence.js';

test('#6093 memoryRegions in proof scope cannot reach PROVED without memory comparison', async () => {
  const result = await verifyBoundedEquivalence({
    beforeTarget: createBv(64, 0n),
    afterTarget: createBv(64, 0n),
    memoryRegions: [{ id: 'heap', start: 0x1000n, size: 8 }],
    backend: new ExhaustiveBvBackend(),
  });
  assert.notEqual(
    result.verdict,
    VERDICT.PROVED,
    'declared memory regions with zero encoded memory constraints must not mint a PROVED equivalence',
  );
});

test('#6093 identical outputs without memoryRegions still prove (no regression)', async () => {
  const result = await verifyBoundedEquivalence({
    beforeTarget: createBv(64, 0n),
    afterTarget: createBv(64, 0n),
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(result.verdict, VERDICT.PROVED);
});

test('#6093 memoryRegions fail-closed verdict reports the unencoded memory scope', async () => {
  const result = await verifyBoundedEquivalence({
    beforeTarget: createBv(64, 0n),
    afterTarget: createBv(64, 0n),
    memoryRegions: [{ id: 'heap', start: 0x1000n, size: 8 }],
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(result.verdict, VERDICT.UNKNOWN);
  assert.match(result.proofStatement, /memoryEffects|queryScope|incomplete-scope/i);
  assert.equal(result.query.proofScope.memoryRegions.length, 1, 'proof scope keeps the declared regions');
});
