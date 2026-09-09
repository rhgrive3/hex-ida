import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createPointsToSet, createPointsToTarget, exactRange } from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';

const complete = createAnalysisStatus({
  snapshotId:'snapshot_issue_4165',
  analyzerId:'pointsto-test',
  analyzerVersion:'1',
  completeness:'complete',
});

const target = (rootEntityId, address) => createPointsToTarget({
  addressSpace:'memory',
  rootKind:'absolute',
  rootEntityId,
  address,
  offsetRange:exactRange(0n),
});

const aliasOf = (left, right) => pointsToAlias(
  createPointsToSet({ targets:[left] }),
  createPointsToSet({ targets:[right] }),
  { status:complete, widthBitsLeft:64, widthBitsRight:64 },
);

test('blank concrete addresses degrade to unknown and cannot alias real zero strongly (#4165)', () => {
  for (const address of ['', '   ']) {
    const malformed = target(`malformed:${JSON.stringify(address)}`, address);
    const zero = target('real-zero', '0');
    assert.equal(malformed.address, null, 'blank address must not survive the canonical target boundary');
    const result = aliasOf(malformed, zero);
    assert.notEqual(result.relation, 'must');
    assert.ok(!result.reasonCodes.includes('identical-root-and-exact-offset'));
  }
});

test('blank addresses cannot manufacture disjoint-global-interval NoAlias (#4165)', () => {
  const malformed = target('malformed', '');
  const distant = target('distant', '4096');
  const result = aliasOf(malformed, distant);
  assert.notEqual(result.relation, 'no');
  assert.ok(!result.reasonCodes.includes('disjoint-global-interval'));
});

test('non-canonical address strings do not remain concrete evidence (#4165)', () => {
  for (const address of ['not-an-address', '0b10', '-1']) {
    const malformed = target(`malformed:${address}`, address);
    assert.equal(malformed.address, null);
    const result = aliasOf(malformed, target('real-zero', '0'));
    assert.notEqual(result.relation, 'must');
    assert.notEqual(result.relation, 'no');
  }
});

test('consumer rejects a forged blank address even if target construction is bypassed (#4165)', () => {
  const canonical = target('malformed', '1');
  const forged = Object.freeze({ ...canonical, address:'' });
  const zero = target('real-zero', '0');
  const left = Object.freeze({ top:false, targets:Object.freeze([forged]), lossReasons:Object.freeze([]) });
  const right = Object.freeze({ top:false, targets:Object.freeze([zero]), lossReasons:Object.freeze([]) });
  const result = pointsToAlias(left, right, {
    status:complete,
    widthBitsLeft:64,
    widthBitsRight:64,
  });
  assert.notEqual(result.relation, 'must');
  assert.ok(!result.reasonCodes.includes('identical-root-and-exact-offset'));

  const distant = target('distant', '4096');
  const distantSet = Object.freeze({ top:false, targets:Object.freeze([distant]), lossReasons:Object.freeze([]) });
  const separated = pointsToAlias(left, distantSet, {
    status:complete,
    widthBitsLeft:64,
    widthBitsRight:64,
  });
  assert.notEqual(separated.relation, 'no');
  assert.ok(!separated.reasonCodes.includes('disjoint-global-interval'));
});

test('raw malformed address presence cannot mint stack-vs-heap root separation (#4165)', () => {
  const stack = createPointsToTarget({
    addressSpace:'memory',
    rootKind:'stack-like',
    rootEntityId:'raw-stack',
    address:null,
    offsetRange:exactRange(0n),
  });
  const heapTemplate = createPointsToTarget({
    addressSpace:'memory',
    rootKind:'heap-like',
    rootEntityId:'raw-heap',
    address:'1',
    offsetRange:exactRange(0n),
  });

  for (const address of ['', '   ']) {
    const forgedHeap = Object.freeze({ ...heapTemplate, address });
    const left = Object.freeze({ top:false, targets:Object.freeze([stack]), lossReasons:Object.freeze([]) });
    const right = Object.freeze({ top:false, targets:Object.freeze([forgedHeap]), lossReasons:Object.freeze([]) });
    const result = pointsToAlias(left, right, {
      status:complete,
      widthBitsLeft:64,
      widthBitsRight:64,
    });
    assert.notEqual(result.relation, 'no');
    assert.ok(!result.reasonCodes.includes('distinct-proven-root'));
  }
});

test('valid zero, decimal, hex, bigint and safe-number addresses retain interval precision (#4165)', () => {
  const zeroString = target('zero-string', '0');
  const zeroBigInt = target('zero-bigint', 0n);
  assert.equal(zeroString.address, '0');
  assert.equal(zeroBigInt.address, '0');
  assert.equal(aliasOf(zeroString, zeroBigInt).relation, 'must');

  const decimal = target('decimal', '4096');
  const hex = target('hex', '0x1000');
  const numeric = target('numeric', 4096);
  assert.equal(decimal.address, '4096');
  assert.equal(hex.address, '0x1000');
  assert.equal(numeric.address, '4096');
  assert.equal(aliasOf(decimal, hex).relation, 'must');
  assert.equal(aliasOf(hex, numeric).relation, 'must');

  const disjoint = aliasOf(zeroString, hex);
  assert.equal(disjoint.relation, 'no');
  assert.ok(disjoint.reasonCodes.includes('disjoint-global-interval'));
});
