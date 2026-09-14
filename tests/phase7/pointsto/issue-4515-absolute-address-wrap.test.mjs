import assert from 'node:assert/strict';
import test from 'node:test';

import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { addRange, createPointsToSet, createPointsToTarget, exactRange } from '../../../js/analysis/pointsto/lattice.js';

const status = createAnalysisStatus({
  snapshotId: 'issue-4515',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

function singleton(target) {
  return createPointsToSet({ targets: [target] });
}

function absoluteRange(rootEntityId, address, offsetRange, widthBits = 64) {
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'absolute',
    rootEntityId,
    address,
    offsetRange,
    widthBits,
  });
}

function absolute(rootEntityId, address, offset, widthBits = 64) {
  return absoluteRange(rootEntityId, address, exactRange(offset), widthBits);
}

function alias(left, right, options = {}) {
  return pointsToAlias(singleton(left), singleton(right), {
    status,
    widthBitsLeft: 64,
    widthBitsRight: 64,
    ...options,
  });
}

test('#4515 upper address wrap cannot produce a global NoAlias', () => {
  const shifted = addRange(exactRange(0n), 0x20n, 64);
  assert.equal(shifted.lost, null);
  const wrapped = alias(
    absoluteRange('A', '0xfffffffffffffff0', shifted.range),
    absolute('B', '0x10', 0n),
  );
  assert.equal(wrapped.relation, 'may');
  assert.ok(wrapped.reasonCodes.includes('provenance-lost'));
  assert.ok(!wrapped.reasonCodes.includes('disjoint-global-interval'));
});

test('#4515 lower address underflow cannot produce a global NoAlias', () => {
  const wrapped = alias(
    absolute('A', '0x0', -0x20n),
    absolute('B', '0x10', 0n),
  );
  assert.equal(wrapped.relation, 'may');
  assert.ok(wrapped.reasonCodes.includes('provenance-lost'));
  assert.ok(!wrapped.reasonCodes.includes('disjoint-global-interval'));
});

test('#4515 non-wrapping global intervals retain NoAlias and exact alias semantics', () => {
  const disjoint = alias(
    absolute('A', '0x1000', 0n),
    absolute('B', '0x2000', 0n),
  );
  assert.equal(disjoint.relation, 'no');
  assert.ok(disjoint.reasonCodes.includes('disjoint-global-interval'));

  const same = alias(
    absolute('A', '0x1000', 0n),
    absolute('B', '0x1000', 0n),
  );
  assert.equal(same.relation, 'must');
  assert.ok(same.reasonCodes.includes('identical-root-and-exact-offset'));
});

test('#4515 malformed target width cannot preserve a strong global interval', () => {
  const result = alias(
    absolute('A', '0x1000', 0n, null),
    absolute('B', '0x2000', 0n),
  );
  assert.equal(result.relation, 'may');
  assert.ok(!result.reasonCodes.includes('disjoint-global-interval'));
});
