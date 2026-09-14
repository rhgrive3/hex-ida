import assert from 'node:assert/strict';
import {
  createOffsetRange,
  createPointsToTarget,
  createPointsToSet,
  createRootDescriptorSeparatedTarget,
  exactRange,
  joinPointsTo,
  provenSeparationAuthority,
  widenPointsTo,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const status = createAnalysisStatus({
  snapshotId: 'snapshot_issue_5261',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

// #5261: separation proof metadata is evidence ABOUT a root, not its storage
// identity. The same allocation observed through a producing path that carries
// the proof and one that does not must share one rootKey.
function baseInput() {
  return {
    addressSpace: 'memory',
    rootKind: 'heap-like',
    rootIdentity: 'alloc-1',
    rootEntityId: 'alloc-1',
    offsetRange: exactRange(0),
  };
}

function singleton(target) {
  return createPointsToSet({ targets: [target] });
}

function canonicalProof(rootEntityId, separationClass = 'heap-like') {
  const valueId = `proof-${separationClass}-${rootEntityId}`;
  const proof = deriveCanonicalAddressProof({
    functionId: 'issue-5261-canonical-proof',
    values: [{
      id: valueId,
      kind: 'entry',
      variableKey: `root-${rootEntityId}`,
      machineType: { kind: 'address', widthBits: 64 },
      metadata: {
        canonicalRoot: {
          kind: separationClass,
          rootEntityId,
          baseOffset: 0,
          addressSpace: 'memory',
          linearOffsets: true,
        },
      },
    }],
    nodes: [],
    blocks: [],
  }, valueId, { addressSpace: 'memory' });
  assert.equal(proof.kind, 'rooted');
  return proof;
}

{
  const plain = createPointsToTarget(baseInput());
  // Note: raw separationAuthority options are unproven self-claims (#6066) and
  // are stripped at the boundary; only separationClass survives as a passive
  // descriptor annotation. Both spellings must land on one rootKey.
  const annotated = createPointsToTarget({ ...baseInput(), separationClass: 'heap-like', separationAuthority: 'root-descriptor' });
  assert.equal(annotated.rootKey, plain.rootKey,
    'proof metadata must not fork the root identity key');

  // Passive metadata has no authority. Once rootKey ignores it, a same-root
  // join must not let operand order choose whether that annotation survives.
  const plainFirst = joinPointsTo(singleton(plain), singleton(annotated));
  const annotatedFirst = joinPointsTo(singleton(annotated), singleton(plain));
  assert.equal(plainFirst.targets[0].separationClass, null);
  assert.equal(annotatedFirst.targets[0].separationClass, null);
  assert.equal(provenSeparationAuthority(plainFirst.targets[0]), null);
  assert.equal(provenSeparationAuthority(annotatedFirst.targets[0]), null);
}

// A genuine canonical proof is root-level evidence and must survive a join with
// an unproven observation of the same storage regardless of operand order.
{
  const proof = canonicalProof('join-root');
  const proven = createRootDescriptorSeparatedTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'join-root',
    offsetRange: exactRange(0),
    widthBits: 64,
    evidenceIds: ['proven'],
  }, proof);
  const plain = createPointsToTarget({
    addressSpace: proven.addressSpace,
    rootKind: proven.rootKind,
    rootIdentity: proven.rootIdentity,
    rootEntityId: proven.rootEntityId,
    address: proven.address,
    offsetRange: exactRange(8),
    widthBits: 64,
    evidenceIds: ['plain'],
  });
  assert.equal(plain.rootKey, proven.rootKey, 'plain/proven observations must share storage identity');

  const forward = joinPointsTo(singleton(plain), singleton(proven));
  const reverse = joinPointsTo(singleton(proven), singleton(plain));
  for (const [label, joined] of [['plain→proven', forward], ['proven→plain', reverse]]) {
    assert.equal(joined.top, false, `${label}: same-root join must remain finite`);
    assert.equal(joined.targets.length, 1, `${label}: same-root join must remain one target`);
    const target = joined.targets[0];
    assert.equal(target.rootKey, proven.rootKey, `${label}: root identity must stay canonical`);
    assert.equal(target.offsetRange.min, 0n);
    assert.equal(target.offsetRange.max, 8n);
    assert.equal(target.widthBits, 64);
    assert.deepEqual(target.evidenceIds, ['plain', 'proven']);
    assert.equal(target.separationClass, 'heap-like');
    assert.equal(target.separationAuthority, 'root-descriptor');
    assert.equal(provenSeparationAuthority(target), 'root-descriptor',
      `${label}: canonical proof brand must survive same-root merge`);
  }

  // The proof merge must not weaken the lattice's target-cap fail-closed rule.
  const other = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootIdentity: 'other-root',
    rootEntityId: 'other-root',
    offsetRange: exactRange(0),
  });
  const capped = joinPointsTo(singleton(proven), singleton(other), { maxTargetsPerSet: 1 });
  assert.equal(capped.top, true, 'distinct roots beyond target cap must still collapse to TOP');
  assert.ok(capped.lossReasons.includes('target-cap'));

  // Widening remains conservative and keeps a genuine brand carried by the
  // next-state target while widening the moving bound to infinity.
  const widenPrevious = singleton(createRootDescriptorSeparatedTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'join-root',
    offsetRange: exactRange(0),
  }, proof));
  const widenNext = singleton(createRootDescriptorSeparatedTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'join-root',
    offsetRange: createOffsetRange(0, 8),
  }, proof));
  const widened = widenPointsTo(widenPrevious, widenNext);
  assert.equal(widened.top, false);
  assert.equal(widened.targets.length, 1);
  assert.equal(widened.targets[0].offsetRange.min, 0n);
  assert.equal(widened.targets[0].offsetRange.max, null);
  assert.equal(provenSeparationAuthority(widened.targets[0]), 'root-descriptor');
  assert.ok(widened.lossReasons.includes('widened'));
}

// The alias consequence: with one target's (forked) rootKey listed as proven
// non-escaping, main produced a false strong `no`. With one shared key the
// same storage at the same exact offset aliases identically.
{
  const a = createPointsToSet({ targets: [createPointsToTarget(baseInput())] });
  const b = createPointsToSet({ targets: [createPointsToTarget({ ...baseInput(), separationClass: 'heap-like' })] });
  const forkedKey = b.targets[0].rootKey;
  const rel = pointsToAlias(a, b, {
    status,
    widthBitsLeft: 64,
    widthBitsRight: 64,
    nonEscapingRoots: new Set([forkedKey]),
  });
  assert.equal(rel.relation, 'must',
    'identical storage at identical exact offset must not become a false NoAlias via a forked root key');
  assert.deepEqual(rel.reasonCodes, ['identical-root-and-exact-offset']);
}

// Genuinely distinct roots stay distinct (identity still in the key).
{
  const a = createPointsToSet({ targets: [createPointsToTarget(baseInput())] });
  const other = createPointsToSet({ targets: [createPointsToTarget({ ...baseInput(), rootEntityId: 'alloc-2', rootIdentity: 'alloc-2' })] });
  assert.notEqual(a.targets[0].rootKey, other.targets[0].rootKey);
}

// Offset differences still keep one root while separating exact ranges.
{
  const zero = createPointsToTarget(baseInput());
  const eight = createPointsToTarget({ ...baseInput(), offsetRange: exactRange(8) });
  assert.equal(zero.rootKey, eight.rootKey, 'offset is not part of the root key');
}

console.log('phase7 pointsto issue-5261 root-key proof-metadata fork: PASS');
