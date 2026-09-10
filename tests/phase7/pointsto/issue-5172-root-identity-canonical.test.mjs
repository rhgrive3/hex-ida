import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
  joinPointsTo,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const complete = createAnalysisStatus({
  snapshotId: 'snapshot_issue_5172',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

function target(rootIdentity, offset = 0) {
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootIdentity,
    rootEntityId: 'root',
    offsetRange: exactRange(offset),
    widthBits: 64,
  });
}

function singleton(value) {
  return createPointsToSet({ targets: [value] });
}

function alias(left, right) {
  return pointsToAlias(singleton(left), singleton(right), {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
    nonEscapingRoots: new Set(),
  });
}

test('#5172 lossy object members cannot become authoritative root identity', () => {
  for (const identity of [
    { source: undefined },
    { source() {} },
    { source: Symbol('root') },
    { source: NaN },
    { source: Infinity },
    { source: -Infinity },
  ]) {
    assert.throws(
      () => target(identity),
      /points-to-invalid-root-identity/,
      `lossy root identity ${String(identity.source)} must be rejected`,
    );
  }
});

test('#5172 root identity validation does not execute accessors', () => {
  let reads = 0;
  const identity = {};
  Object.defineProperty(identity, 'source', {
    enumerable: true,
    get() { reads += 1; return 'root'; },
  });
  assert.throws(() => target(identity), /points-to-invalid-root-identity/);
  assert.equal(reads, 0);
});

test('#5172 non-JSON identity forms that stringify like canonical data are rejected', () => {
  assert.throws(() => target(1n), /points-to-invalid-root-identity/);
  assert.throws(() => target(-0), /points-to-invalid-root-identity/);
  assert.throws(() => target(new Date('2026-09-10T00:00:00.000Z')), /points-to-invalid-root-identity/);
});

test('#5172 canonical identical roots still prove MustAlias', () => {
  const left = target({ kind: 'fixture-root', nested: ['a', 1, true, null] });
  const right = target({ nested: ['a', 1, true, null], kind: 'fixture-root' });
  assert.equal(left.rootKey, right.rootKey);
  const result = alias(left, right);
  assert.equal(result.relation, 'must');
  assert.ok(result.reasonCodes.includes('identical-root-and-exact-offset'));
});

test('#5172 same-root join still merges canonical targets', () => {
  const left = singleton(target({ id: 'same' }, 0));
  const right = singleton(target({ id: 'same' }, 8));
  const joined = joinPointsTo(left, right);
  assert.equal(joined.top, false);
  assert.equal(joined.targets.length, 1);
  assert.equal(joined.targets[0].offsetRange.min, 0n);
  assert.equal(joined.targets[0].offsetRange.max, 8n);
});

test('#5172 sparse and decorated arrays cannot collapse through JSON normalization', () => {
  const sparse = new Array(1);
  assert.throws(() => target(sparse), /points-to-invalid-root-identity/);
  const decorated = ['a'];
  decorated.extra = 'ignored-by-json-array';
  assert.throws(() => target(decorated), /points-to-invalid-root-identity/);
});
